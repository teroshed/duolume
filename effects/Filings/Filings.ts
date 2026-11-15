import { Effect } from '../../src/Effect';
import { clamp, mixColor, smoothstep } from '../../src/math';
import type { EffectContext, TickContext, TimedContext, Vector3 } from '../../src/types';
import type { FilingsContext } from '../contracts';
import { FieldLayer } from '../Field/FieldLayer';
import { FieldSet, type Field } from '../Field/FieldSet';
import { Needles, makeDrive, type Drive } from './Needles';

export interface FilingsOptions {
    /** Pixels between neighbouring needles; larger is sparser. Default `SPACING` (5.5). */
    spacing?: number;
    /** How far from an element the pointer is still felt, in pixels. Default `REACH` (90). */
    reach?: number;
    /** Whether the scene's force field (wind, shock rings, pulls) turns the needles. Default `true`. */
    scene?: boolean;
}

/** What the effect keeps for one element. */
interface Grain {
    needles: Needles;
    drive: Drive;
    width: number;
    height: number;
    lastOn: boolean;
    /** Text sits in the middle band: the needles are dimmer there. */
    textual: boolean;
    /** Needles simulated and drawn this tick (the budget thins them). */
    shown: number;
    bucket: Uint8Array;
}

/**
 * Iron filings under glass. An input is filled with tiny needles that each turn to show the
 * field they are in. A switch has a field of its own that flips when you flip it, so the whole
 * grain turns over in a wave from where the knob was; the pointer is a magnet, felt from up to
 * `reach` pixels outside the element: over it the needles run in circles round the pointer,
 * from outside they point at it. The needles feel the scene's force field too, so every input
 * on the page becomes a small instrument for the wind, a pull or a passing shock ring. A press
 * spins the needles near it, like a tap on the glass.
 *
 * Any element tagged `filings` is filled. Its tags say what it is: `on`/`off` (a switch, which
 * also has `knob`), `value:0.6` (a slider or bar), neither (a button or text field: a calm
 * field with a slow wave in it), `focus`, `disabled`.
 *
 * What it listens to:
 *   - elements tagged `filings`, the pointer near them, and presses on them.
 *   - the force field: `tick.forces.sample` at six points of each element.
 * It tells the others how many needles it draws, and nothing else: no forces, no events.
 * It has no keys.
 */
export class Filings extends Effect<FilingsContext> {
    public effectName = 'filings';

    public static readonly SPACING = 5.5;
    public static readonly REACH = 90;
    /** Most needles in one element. */
    private static readonly CAP = 400;
    /** Scene acceleration (px/ms²) to field weight: the wind's hand-push (0.0011) swings the needles right over. */
    private static readonly SCENE_GAIN = 2800;

    private readonly spacing: number;
    private readonly reach: number;
    private readonly scene: boolean;
    private readonly fields: FieldSet<Grain>;
    private readonly context: FilingsContext = { fields: 0, active: 0, needles: 0 };
    private readonly force: Vector3 = { x: 0, y: 0, z: 0 };
    private layer: FieldLayer | undefined;

    constructor(options: FilingsOptions = {}) {
        super();
        this.spacing = clamp(options.spacing ?? Filings.SPACING, 3, 30);
        this.reach = clamp(options.reach ?? Filings.REACH, 0, 600);
        this.scene = options.scene ?? true;
        this.fields = new FieldSet<Grain>('filings', (field) => this.open(field));
    }

    public initialize(): void {
        this.layer = new FieldLayer(this.host.pixi);
    }

    public onTick(tick: TickContext): EffectContext<FilingsContext> {
        this.fields.update(tick);
        const share = clamp(tick.budget.budget, 0.2, 1);
        let active = 0;
        let total = 0;

        for (const field of this.fields.fields) {
            let grain = field.data;
            if (Math.abs(field.width - grain.width) > 1 || Math.abs(field.height - grain.height) > 1) {
                grain = field.data = this.open(field);
            }
            const drive = grain.drive;
            const words = field.words;
            drive.time = tick.time;
            drive.width = field.width;
            drive.height = field.height;
            drive.mode = words.value !== undefined ? 2 : words.on || words.off ? 1 : 0;
            drive.level = field.level;

            // A switch flipped: the wave starts where the knob was.
            if (words.on !== grain.lastOn) {
                grain.lastOn = words.on;
                drive.fromD = drive.toD;
                drive.toD = words.on ? 1 : -1;
                drive.flipAt = tick.time;
                drive.originX = words.on ? 0 : field.width;
            }

            // The pointer, felt from outside too.
            const px = field.pointerX;
            const py = field.pointerY;
            const outX = Math.max(-px, 0, px - field.width);
            const outY = Math.max(-py, 0, py - field.height);
            const dist = Math.hypot(outX, outY);
            drive.pointerOn = field.pointerKnown && !words.disabled && dist < this.reach;
            drive.pointerX = px;
            drive.pointerY = py;
            drive.pointerDist = dist;
            drive.pointerFade = drive.pointerOn ? 1 - smoothstep(this.reach * 0.3, this.reach, dist) : 0;

            // The scene, six samples, not one per needle.
            const sx = drive.sceneX;
            const sy = drive.sceneY;
            if (this.scene) {
                for (let row = 0; row < 2; row++) {
                    for (let col = 0; col < 3; col++) {
                        tick.forces.sample(field.x + (col * field.width) / 2, field.y + (0.25 + row * 0.5) * field.height, this.force);
                        sx[row * 3 + col] = this.force.x * Filings.SCENE_GAIN;
                        sy[row * 3 + col] = this.force.y * Filings.SCENE_GAIN;
                    }
                }
            } else {
                sx.fill(0);
                sy.fill(0);
            }

            const needles = grain.needles;
            grain.shown = Math.ceil(needles.count * share);
            if (field.pressed) {
                needles.kick(px, py, 0.03);
            }
            needles.step(tick.timeDelta, drive, grain.shown);

            if (field.active) {
                active++;
            }
            total += grain.shown;
        }

        this.context.fields = this.fields.fields.length;
        this.context.active = active;
        this.context.needles = total;
        return this.publish(this.context);
    }

    public onRender(timed: TimedContext): void {
        const layer = this.layer;
        if (!layer) {
            return;
        }
        const theme = timed.theme;
        const mainColor = mixColor(theme.accent, theme.ink, 0.35);
        for (const field of this.fields.fields) {
            const g = layer.draw(field);
            const grain = field.data;
            const needles = grain.needles;
            const n = grain.shown;
            const brightness = field.words.disabled ? 0.15 : 0.3 + 0.7 * field.presence;
            const base = 0.75 * brightness;
            const half = Math.min(4, this.spacing * 0.72) / 2;
            const h = field.height;
            let present = 0;
            for (let i = 0; i < n; i++) {
                let a = base * (1 + 0.35 * Math.min(1, Math.abs(needles.vel[i]) * 40));
                if (grain.textual) {
                    const band = smoothstep(0.12 * h, 0.34 * h, Math.abs(needles.y[i] - h / 2));
                    a *= 0.5 + 0.5 * band;
                }
                const q = Math.min(6, Math.round(a / 0.15));
                if (q <= 0) {
                    grain.bucket[i] = 0;
                    continue;
                }
                const id = q * 2 + needles.alt[i];
                grain.bucket[i] = id;
                present |= 1 << id;
            }
            for (let id = 2; id < 14; id++) {
                if ((present & (1 << id)) === 0) {
                    continue;
                }
                for (let i = 0; i < n; i++) {
                    if (grain.bucket[i] !== id) {
                        continue;
                    }
                    const angle = needles.angle[i];
                    const dx = Math.cos(angle) * half;
                    const dy = Math.sin(angle) * half;
                    const x = needles.x[i];
                    const y = needles.y[i];
                    g.moveTo(Math.round(x - dx - 0.5) + 0.5, Math.round(y - dy - 0.5) + 0.5);
                    g.lineTo(Math.round(x + dx - 0.5) + 0.5, Math.round(y + dy - 0.5) + 0.5);
                }
                g.stroke({ width: 1, color: id & 1 ? theme.accentAlt : mainColor, alpha: (id >> 1) * 0.15 });
            }
        }
        layer.sweep();
    }

    public cleanup(): void {
        this.fields.clear();
        this.layer?.destroy();
        this.layer = undefined;
        this.context.fields = 0;
        this.context.active = 0;
        this.context.needles = 0;
    }

    private open(field: Field<Grain>): Grain {
        const needles = new Needles();
        needles.seed(0, field.width, field.height, this.spacing, Filings.CAP);
        const drive = makeDrive();
        const on = field.words.on;
        drive.toD = drive.fromD = on ? 1 : -1;
        return {
            needles,
            drive,
            width: field.width,
            height: field.height,
            lastOn: on,
            textual: !field.words.knob && field.words.value === undefined && !field.words.on && !field.words.off && field.height < 60 && field.width >= 60,
            shown: needles.count,
            bucket: new Uint8Array(needles.count),
        };
    }
}
