import { Effect } from '../../src/Effect';
import { clamp, mixColor } from '../../src/math';
import type { EffectContext, TickContext, TimedContext, Vector3 } from '../../src/types';
import type { SandContext } from '../contracts';
import { FieldLayer } from '../Field/FieldLayer';
import { FieldSet, type Field } from '../Field/FieldSet';
import { Pile } from './Pile';

export interface SandOptions {
    /** Share of the element's area the sand fills, 0..0.8. Default `AMOUNT` (0.3). Low elements with text in them keep a lower layer. */
    amount?: number;
    /** The steepest slope the sand holds, in degrees (5..70). Default `REPOSE_DEGREES` (34). */
    repose?: number;
    /** Loose grains hopping over the surface while the sand flows. Default true. */
    grains?: boolean;
}

/** How the sand behaves in one element. */
type Kind = 'tip' | 'value' | 'level';

/** What the effect keeps for one element. */
interface Tray {
    kind: Kind;
    pile: Pile | undefined;
    builtWidth: number;
    builtHeight: number;
    /** 1 just after the switch was turned, falling to 0: the sand is tipped hard while it pours. */
    pour: number;
    lastValue: number;
    /** The surface heaving up, in px, and its speed (px/ms): a spring. */
    heave: number;
    heaveV: number;
    /** A passing push that leans the sand for a moment, -1..1. */
    kick: number;
    /** The force felt at the centre last tick, to catch the onset of a shock. */
    lastForce: number;
    lastPointerX: number;
    /** Loose grains, structure of arrays, in the element's pixels with y measured up from the bottom. */
    gx: Float32Array;
    gy: Float32Array;
    gvx: Float32Array;
    gvy: Float32Array;
    glife: Float32Array;
    gn: number;
    cap: number;
}

/**
 * Sand in a page element: a switch is something you tip. The input holds a little sand, and
 * the sand goes where the switch says. Turn it on and the sand pours across to the knob's end
 * and piles up against it; turn it off and it runs back. A slider or progress bar is a vessel
 * whose sand heaps under its value. A text field or a button holds a level layer along its
 * bottom edge, under the text.
 *
 * The pile is a row of columns (`Pile`), one every 2.5 px, that slides wherever it is steeper
 * than the angle of repose; tipping lowers that angle on the far side, so the heap flows over
 * in about half a second. While it flows, loose grains hop along the surface. The amount of
 * sand never changes and it never leaves the element. It is drawn as a filled, stippled body
 * with a lighter top edge, dim while the switch is off and lit while it is on.
 *
 *     <span class="track" data-fx-anchor="sand-switch" data-fx-tags="sand knob on"></span>
 *
 * What it listens to:
 *   - elements tagged `sand` and their state words (`on`, `off`, `focus`, `knob`, `value:`;
 *     `attachFieldTags()` keeps them current): which end the sand lies at, or where it heaps.
 *   - the pointer: a press throws a puff of grains and dents the pile; moving through the sand
 *     ploughs a furrow. Presses on the controls count (they are what the sand is in).
 *   - the element moving (dragged, scrolled): the sand lags against the movement.
 *   - the force field at each element's centre: wind leans the sand, a shock ring makes the
 *     surface jump.
 *   - the focus arriving: a little shiver.
 * It tells the others how many elements hold sand, how many are on, and how many grains are in
 * the air. No forces, no events. It has no keys.
 */
export class Sand extends Effect<SandContext> {
    public effectName = 'sand';

    public static readonly TAG = 'sand';
    public static readonly AMOUNT = 0.3;
    public static readonly REPOSE_DEGREES = 34;
    /** Milliseconds the sand stays tipped hard after a switch turns. */
    public static readonly POUR = 700;
    /**
     * Pull toward the resting place (see `Pile.pull`): it sets the slope the sand rests at
     * against the end, here about 0.45, so the heap leans out from behind the knob.
     */
    private static readonly PULL = 0.85;
    /** How much faster the sand runs while it pours (see `Pile.speed`). */
    private static readonly POUR_SPEED = 3;
    /** Highest a level layer stands, as a share of the element's inner height: it keeps under the text. */
    private static readonly LEVEL_CAP = 0.2;
    /** Grain gravity, px/ms². */
    private static readonly GRAVITY = 0.0005;
    /** A force at the centre above this (px/ms²) is a shove worth jumping for. */
    private static readonly SHOVE = 0.0012;
    /** Warm sand, tinted by the theme. */
    private static readonly SAND = 0xc9a874;

    private readonly amount: number;
    private readonly repose: number;
    private readonly showGrains: boolean;
    private readonly trays = new FieldSet<Tray>(Sand.TAG, (field) => this.open(field));
    private readonly context: SandContext = { fields: 0, active: 0, grains: 0 };
    private readonly force: Vector3 = { x: 0, y: 0, z: 0 };
    private layer: FieldLayer | undefined;

    constructor(options: SandOptions = {}) {
        super();
        this.amount = clamp(Number.isFinite(options.amount) ? (options.amount as number) : Sand.AMOUNT, 0, 0.8);
        this.repose = clamp(Number.isFinite(options.repose) ? (options.repose as number) : Sand.REPOSE_DEGREES, 5, 70);
        this.showGrains = options.grains ?? true;
    }

    public initialize(): void {
        this.layer = new FieldLayer(this.host.pixi);
    }

    public onTick(tick: TickContext): EffectContext<SandContext> {
        this.trays.update(tick);
        const dt = Math.min(tick.timeDelta, 100);
        let active = 0;
        let grains = 0;
        for (const field of this.trays.fields) {
            if (field.active) {
                active++;
            }
            this.simulate(field, tick, dt);
            grains += field.data.gn;
        }
        this.context.fields = this.trays.fields.length;
        this.context.active = active;
        this.context.grains = grains;
        return this.publish(this.context);
    }

    public onRender(timed: TimedContext): void {
        const layer = this.layer;
        if (!layer) {
            return;
        }
        const theme = timed.theme;
        const sand = mixColor(Sand.SAND, theme.accentAlt, 0.22);
        const body = mixColor(sand, theme.bgBottom, 0.28);
        const dark = mixColor(sand, theme.bgBottom, 0.62);
        const light = mixColor(sand, theme.ink, 0.45);
        const edge = mixColor(sand, theme.ink, 0.3);

        for (const field of this.trays.fields) {
            const g = layer.draw(field);
            const tray = field.data;
            const pile = tray.pile;
            if (!pile) {
                continue;
            }
            // Lit while on, dim while off; low elements with text in them stay modest.
            const lit = tray.kind === 'level' ? 0.5 + 0.12 * field.presence : 0.34 + 0.56 * field.presence;
            const bottom = field.height - 1;
            const heights = pile.heights;
            const n = pile.count;
            const sp = pile.spacing;
            const tallest = Math.max(1, pile.ceiling);
            const heave = tray.heave;
            const top = (i: number): number => {
                const h = heights[i];
                return h > 0.05 ? bottom - h - heave * (0.4 + (0.6 * h) / tallest) : bottom;
            };

            // The body.
            g.moveTo(1, bottom);
            for (let i = 0; i < n; i++) {
                g.lineTo(1 + Math.min(i * sp, pile.width), top(i));
            }
            g.lineTo(1 + pile.width, bottom);
            g.closePath();
            g.fill({ color: body, alpha: 0.72 * lit });

            // Stipple fixed to the sand: dots at set depths below each column's surface.
            for (let pass = 0; pass < 2; pass++) {
                let dots = 0;
                for (let i = 0; i < n; i++) {
                    const h = heights[i];
                    if (h < 2) {
                        continue;
                    }
                    const surface = top(i);
                    const rows = Math.floor(h / 3.2);
                    for (let j = 0; j < rows; j++) {
                        const r = hash(i * 31 + j * 7 + 11);
                        if ((r < 0.5) !== (pass === 0) || hash(i * 13 + j * 17 + 3) > 0.42) {
                            continue;
                        }
                        const y = Math.floor(surface + 1.6 + (j + hash(i * 7 + j * 29)) * 3.2);
                        if (y >= bottom) {
                            continue;
                        }
                        g.rect(Math.floor(1 + i * sp + r * 2), y, 1, 1);
                        dots++;
                    }
                }
                if (dots > 0) {
                    g.fill({ color: pass === 0 ? dark : light, alpha: (pass === 0 ? 0.85 : 0.7) * lit });
                }
            }

            // The 1 px lighter top edge, where there is sand.
            let open = false;
            for (let i = 0; i < n; i++) {
                if (heights[i] > 0.4) {
                    const x = 1 + Math.min(i * sp, pile.width);
                    const y = top(i) + 0.5;
                    if (open) {
                        g.lineTo(x, y);
                    } else {
                        g.moveTo(x, y);
                        open = true;
                    }
                } else {
                    open = false;
                }
            }
            g.stroke({ width: 1, color: edge, alpha: 0.85 * lit });

            // Loose grains.
            if (tray.gn > 0) {
                for (let k = 0; k < tray.gn; k++) {
                    const s = k % 3 === 0 ? 1.5 : 1;
                    g.rect(1 + tray.gx[k] - s / 2, bottom - tray.gy[k] - heave - s, s, s);
                }
                g.fill({ color: light, alpha: Math.min(1, 0.95 * lit + 0.1) });
            }
        }
        layer.sweep();
    }

    public cleanup(): void {
        this.trays.clear();
        this.layer?.destroy();
        this.layer = undefined;
        this.context.fields = 0;
        this.context.active = 0;
        this.context.grains = 0;
    }

    private open(field: Field<Tray>): Tray {
        const words = field.words;
        const kind: Kind = words.value !== undefined ? 'value' : words.knob || words.on || words.off ? 'tip' : 'level';
        const cap = 60;
        return {
            kind,
            pile: undefined,
            builtWidth: -1,
            builtHeight: -1,
            pour: 0,
            lastValue: field.value,
            heave: 0,
            heaveV: 0,
            kick: 0,
            lastForce: 0,
            lastPointerX: field.pointerX,
            gx: new Float32Array(cap),
            gy: new Float32Array(cap),
            gvx: new Float32Array(cap),
            gvy: new Float32Array(cap),
            glife: new Float32Array(cap),
            gn: 0,
            cap: 0,
        };
    }

    /** A fresh pile for the element's size, with the sand where its state says. */
    private build(field: Field<Tray>, tray: Tray): Pile {
        const width = Math.max(0, field.width - 2);
        const ceiling = Math.max(0, field.height - 2);
        const pile = new Pile(width, ceiling, this.repose);
        const area = this.amount * width * ceiling;
        if (tray.kind === 'level') {
            pile.fillLevel(Math.min(area, Sand.LEVEL_CAP * ceiling * width));
        } else if (tray.kind === 'value') {
            // A heap with its peak a little under the top, not a block.
            const peak = ceiling * 0.8;
            pile.fillHeap(Math.min(area, (peak * peak) / pile.repose), field.level * width);
        } else {
            pile.fillHeap(area, field.value > 0.5 ? width : 0);
            pile.target = field.value > 0.5 ? width + 8 : -8;
            pile.pull = Sand.PULL;
            pile.speed = 4;
            for (let i = 0; i < 300; i++) {
                pile.step(1000 / 60);
            }
        }
        tray.builtWidth = field.width;
        tray.builtHeight = field.height;
        // Grains in the air: 20 to 60 by size.
        tray.cap = Math.round(clamp(Math.sqrt(field.width * field.height) / 2.4, 20, 60));
        tray.gn = 0;
        return pile;
    }

    private simulate(field: Field<Tray>, tick: TickContext, dt: number): void {
        const tray = field.data;
        if (!tray.pile || Math.abs(field.width - tray.builtWidth) > 1 || Math.abs(field.height - tray.builtHeight) > 1) {
            tray.pile = this.build(field, tray);
        }
        const pile = tray.pile;
        if (pile.width <= 0 || pile.ceiling <= 0) {
            return;
        }
        const width = pile.width;

        // Where the sand belongs.
        if (tray.kind === 'tip') {
            if (Math.abs(field.value - tray.lastValue) > 0.02) {
                tray.pour = 1;
                tray.heaveV += 0.012;
            }
            pile.target = field.value > 0.5 ? width + 8 : -8;
            pile.pull = Sand.PULL;
            pile.speed = 1 + (Sand.POUR_SPEED - 1) * tray.pour;
            pile.creep = 0;
        } else if (tray.kind === 'value') {
            const target = field.level * width;
            const miss = Math.abs(pile.centre() - target) / Math.max(1, width * 0.06);
            pile.target = target;
            pile.pull = Sand.PULL;
            pile.speed = 1 + (Sand.POUR_SPEED - 1) * Math.min(1, miss);
            pile.creep = 0;
        } else {
            pile.target = Number.NaN;
            pile.pull = 0;
            pile.speed = 1;
            pile.creep = 3;
        }
        tray.lastValue = field.value;
        tray.pour = Math.max(0, tray.pour - dt / Sand.POUR);

        // The scene: wind leans the sand, the onset of a shove makes it jump.
        const f = tick.forces.sample(field.x + field.width / 2, field.y + field.height / 2, this.force, this.effectName);
        const strength = Math.hypot(f.x, f.y);
        const wind = clamp(f.x / 0.0025, -1, 1) * 0.7;
        if (strength > Sand.SHOVE && strength > tray.lastForce * 1.5 + 0.0002) {
            tray.heaveV += Math.min(0.06, strength * 12);
            tray.kick = clamp(tray.kick + Math.sign(f.x) * 0.8, -1, 1);
            this.puff(tray, pile, Number.NaN, Math.round(4 + (tray.cap * Math.min(1, strength / 0.004)) / 2), tick);
        }
        tray.lastForce = strength;

        // The element moving: the sand lags behind.
        if (field.movedX !== 0 || field.movedY !== 0) {
            tray.kick = clamp(tray.kick - field.movedX * 0.08, -1, 1);
            if (field.movedY < -0.5) {
                tray.heaveV += Math.min(0.02, -field.movedY * 0.002);
            }
        }
        tray.kick *= Math.exp(-dt / 260);
        pile.tilt = tray.kick + wind;

        // A press: a puff of grains thrown up at the pointer, and a dent.
        if (field.pressed) {
            const x = clamp(field.pointerX - 1, 0, width);
            const radius = clamp(width * 0.05, 4, 9);
            const depth = Math.max(1.5, pile.surface(x) * 0.45);
            pile.dig(x, depth, radius);
            tray.heaveV += 0.01;
            this.puff(tray, pile, x, Math.round(6 + tray.cap * 0.3), tick);
        }
        // The pointer moving through the sand ploughs a furrow.
        if (field.hover && field.pointerKnown) {
            const x = field.pointerX - 1;
            const moved = x - tray.lastPointerX;
            const height = field.height - 1 - field.pointerY;
            if (Math.abs(moved) > 0.6 && x >= 0 && x <= width && height <= pile.surface(x) + 2) {
                pile.dig(x, Math.min(1.6, Math.abs(moved) * 0.25), 3);
                if (this.showGrains && Math.random() < Math.min(0.8, Math.abs(moved) * 0.15)) {
                    this.spawn(tray, pile, x, pile.surface(x), Math.sign(moved) * 0.03, 0.04, tick);
                }
            }
        }
        tray.lastPointerX = field.pointerX - 1;
        // The focus arriving: a little shiver.
        if (field.turnedOn && tray.kind === 'level') {
            tray.heaveV += 0.008;
            this.puff(tray, pile, Number.NaN, 5, tick);
        }

        pile.step(dt);

        // The surface heave: a stiff spring back to rest.
        tray.heaveV += (-tray.heave * 0.0009 - tray.heaveV * 0.012) * dt;
        tray.heave = clamp(tray.heave + tray.heaveV * dt, -1, 4);

        this.flowGrains(tray, pile, tick);
        this.moveGrains(tray, pile, dt, f.x);
    }

    /** Loose grains at the flowing front, hopping the way the sand goes. */
    private flowGrains(tray: Tray, pile: Pile, tick: TickContext): void {
        if (!this.showGrains) {
            return;
        }
        const flux = pile.flux;
        for (let b = 0; b < flux.length; b++) {
            const q = flux[b];
            const a = q < 0 ? -q : q;
            if (a < 0.05 || Math.random() > a * 0.35) {
                continue;
            }
            const dir = q > 0 ? 1 : -1;
            const from = dir > 0 ? b : b + 1;
            const x = pile.columnX(from) + Math.random() * pile.spacing * dir;
            this.spawn(tray, pile, x, pile.heights[from] + 0.5, dir * (0.02 + Math.random() * 0.05), 0.02 + Math.random() * 0.05, tick);
        }
    }

    /** A puff of grains thrown up from the surface: at x, or all along it when x is NaN. */
    private puff(tray: Tray, pile: Pile, x: number, count: number, tick: TickContext): void {
        if (!this.showGrains) {
            return;
        }
        for (let k = 0; k < count; k++) {
            const at = Number.isFinite(x) ? clamp(x + (Math.random() - 0.5) * 6, 0, pile.width) : Math.random() * pile.width;
            if (pile.surface(at) < 0.5) {
                continue;
            }
            this.spawn(tray, pile, at, pile.surface(at), (Math.random() - 0.5) * 0.12, 0.05 + Math.random() * 0.07, tick);
        }
    }

    private spawn(tray: Tray, pile: Pile, x: number, y: number, vx: number, vy: number, tick: TickContext): void {
        const cap = Math.max(4, Math.round(tray.cap * clamp(tick.budget.budget, 0, 1)));
        if (tray.gn >= Math.min(cap, tray.gx.length)) {
            return;
        }
        const k = tray.gn++;
        tray.gx[k] = clamp(x, 0, pile.width);
        tray.gy[k] = clamp(y, 0, pile.ceiling - 1);
        tray.gvx[k] = vx;
        tray.gvy[k] = vy;
        tray.glife[k] = 0;
    }

    /** Short ballistic hops; a grain that lands on the surface is gone (it is part of the pile again). */
    private moveGrains(tray: Tray, pile: Pile, dt: number, push: number): void {
        const g = Sand.GRAVITY;
        for (let k = tray.gn - 1; k >= 0; k--) {
            tray.gvx[k] += clamp(push, -0.003, 0.003) * dt * 0.5;
            tray.gvy[k] -= g * dt;
            let x = tray.gx[k] + tray.gvx[k] * dt;
            let y = tray.gy[k] + tray.gvy[k] * dt;
            if (x < 0 || x > pile.width) {
                x = clamp(x, 0, pile.width);
                tray.gvx[k] *= -0.4;
            }
            if (y > pile.ceiling - 1) {
                y = pile.ceiling - 1;
                tray.gvy[k] = 0;
            }
            tray.gx[k] = x;
            tray.gy[k] = y;
            tray.glife[k] += dt;
            if ((tray.gvy[k] < 0 && y <= pile.surface(x)) || tray.glife[k] > 1500) {
                const last = --tray.gn;
                tray.gx[k] = tray.gx[last];
                tray.gy[k] = tray.gy[last];
                tray.gvx[k] = tray.gvx[last];
                tray.gvy[k] = tray.gvy[last];
                tray.glife[k] = tray.glife[last];
            }
        }
    }
}

/** A fixed pseudo-random number in 0..1 for an integer: the stipple's pattern. */
function hash(n: number): number {
    let h = (n | 0) * 374761393 + 668265263;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}
