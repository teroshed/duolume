import { Graphics } from 'pixi.js';
import { Effect } from '../../src/Effect';
import { approach, clamp, mixColor } from '../../src/math';
import type { EffectContext, TickContext, TimedContext, Vector3 } from '../../src/types';
import type { IvyContext } from '../contracts';
import { Border, makeBorderPoint, type BorderPoint } from '../Field/border';
import { FieldSet, type Field } from '../Field/FieldSet';
import { layTendril, TENDRIL_POINTS } from './tendril';

export interface IvyOptions {
    /** How far a full-grown tendril reaches from the element's edge, in px, 10..200. Default `REACH` (56). */
    reach?: number;
    /** Scales how many tendrils an element gets (one for about every 40 px of its edge, 4 to 12), 0.2..3. Default `DENSITY` (1). */
    density?: number;
}

const MAX_TENDRILS = 12;

interface Plant {
    width: number;
    height: number;
    radius: number;
    count: number;
    /** Every tendril's points, element pixels. */
    points: Float32Array;
    /** How far each has grown, 0..1, and how fast it follows. */
    grown: Float32Array;
    pace: Float32Array;
    /** -1..1: how far the wind is pushing the tips. */
    sway: number;
    /** A shiver after a press, 1 easing to 0. */
    shake: number;
    time: number;
}

/**
 * Ivy that grows out of a page element: tendrils leave the edge of every element tagged `ivy`
 * and creep outward over the page, curling, with leaves. Switched off they draw back in. It is
 * all outside the element, on the canvas behind the page, so it shows where the page round the
 * control is see-through.
 *
 * What it listens to: the element's state in its tags (on grows it, off draws it back, a
 * slider's value is how far it has grown), the force field (wind sways the tips), and presses,
 * which make it shiver.
 * It tells the others how many tendrils are out (its context). No events, no forces, no keys.
 */
export class Ivy extends Effect<IvyContext> {
    public effectName = 'ivy';

    public static readonly REACH = 56;
    public static readonly DENSITY = 1;

    private readonly reach: number;
    private readonly density: number;
    private readonly plants: FieldSet<Plant>;
    private readonly context: IvyContext = { fields: 0, active: 0, tendrils: 0 };
    private readonly point: BorderPoint = makeBorderPoint();
    private readonly border = new Border();
    private readonly force: Vector3 = { x: 0, y: 0 };
    private view: Graphics | undefined;

    constructor(options: IvyOptions = {}) {
        super();
        this.reach = clamp(options.reach ?? Ivy.REACH, 10, 200);
        this.density = clamp(options.density ?? Ivy.DENSITY, 0.2, 3);
        this.plants = new FieldSet<Plant>('ivy', () => ({
            width: -1,
            height: -1,
            radius: -1,
            count: 0,
            points: new Float32Array(MAX_TENDRILS * TENDRIL_POINTS * 2),
            grown: new Float32Array(MAX_TENDRILS),
            pace: new Float32Array(MAX_TENDRILS),
            sway: 0,
            shake: 0,
            time: 0,
        }));
    }

    public initialize(): void {
        this.view = new Graphics();
        this.host.pixi.addChild(this.view);
    }

    public onTick(tick: TickContext): EffectContext<IvyContext> {
        this.plants.update(tick);
        const dt = Math.min(tick.timeDelta, 100);
        let active = 0;
        let out = 0;
        for (const field of this.plants.fields) {
            const plant = field.data;
            this.fit(plant, field);
            plant.time = tick.time;
            if (field.active) {
                active++;
            }
            if (field.pressed) {
                plant.shake = 1;
            }
            plant.shake = approach(plant.shake, 0, 4, dt);
            tick.forces.sample(field.x + field.width / 2, field.y - 10, this.force);
            plant.sway = approach(plant.sway, clamp(this.force.x / 0.0011, -1, 1), 3, dt);
            // Off draws it all the way back; a slider leaves it part-grown.
            const wanted = field.presence * (0.35 + 0.65 * field.level);
            for (let i = 0; i < plant.count; i++) {
                plant.grown[i] = approach(plant.grown[i], wanted, plant.pace[i], dt);
                if (plant.grown[i] > 0.08) {
                    out++;
                }
            }
        }
        this.context.fields = this.plants.fields.length;
        this.context.active = active;
        this.context.tendrils = out;
        return this.publish(this.context);
    }

    public onRender(timed: TimedContext): void {
        const g = this.view;
        if (!g) {
            return;
        }
        g.clear();
        const theme = timed.theme;
        const stem = mixColor(theme.accent, theme.bgBottom, 0.35);
        const leaf = theme.accent;
        const last = TENDRIL_POINTS - 1;
        for (const field of this.plants.fields) {
            const plant = field.data;
            for (let i = 0; i < plant.count; i++) {
                const grown = plant.grown[i];
                if (grown < 0.03) {
                    continue;
                }
                const base = i * TENDRIL_POINTS * 2;
                const reached = grown * last;
                const whole = Math.floor(reached);
                const part = reached - whole;
                // The further along, the more the wind and a shiver move it.
                const drift = plant.sway * 9 + plant.shake * 3 * Math.sin(plant.time * 0.05 + i);
                let x = field.x + plant.points[base];
                let y = field.y + plant.points[base + 1];
                g.moveTo(x, y);
                let tipX = x;
                let tipY = y;
                let dirX = 0;
                let dirY = -1;
                for (let k = 1; k <= Math.min(last, whole + 1); k++) {
                    const along = k / last;
                    let nx = field.x + plant.points[base + k * 2] + drift * along * along;
                    let ny = field.y + plant.points[base + k * 2 + 1];
                    if (k === whole + 1) {
                        // The growing end: only part of this step is there yet.
                        nx = x + (nx - x) * part;
                        ny = y + (ny - y) * part;
                    }
                    g.lineTo(nx, ny);
                    dirX = nx - x;
                    dirY = ny - y;
                    x = nx;
                    y = ny;
                    tipX = nx;
                    tipY = ny;
                }
                g.stroke({ width: 1.3, color: stem, alpha: 0.9 });

                // A leaf at every second point that has grown, on alternate sides, opening as it is passed.
                for (let k = 2; k <= whole; k += 2) {
                    const along = k / last;
                    const lx = field.x + plant.points[base + k * 2] + drift * along * along;
                    const ly = field.y + plant.points[base + k * 2 + 1];
                    const px = plant.points[base + k * 2] - plant.points[base + (k - 1) * 2];
                    const py = plant.points[base + k * 2 + 1] - plant.points[base + (k - 1) * 2 + 1];
                    const length = Math.hypot(px, py) || 1;
                    const side = (k / 2) % 2 === 0 ? 1 : -1;
                    const open = clamp(reached - k, 0, 1);
                    // Out to the side and a little forward.
                    const ax = ((-py / length) * side * 0.85 + (px / length) * 0.5) * 6 * open;
                    const ay = ((px / length) * side * 0.85 + (py / length) * 0.5) * 6 * open;
                    const wx = (-ay / 6) * 2;
                    const wy = (ax / 6) * 2;
                    g.moveTo(lx, ly);
                    g.lineTo(lx + ax * 0.5 + wx, ly + ay * 0.5 + wy);
                    g.lineTo(lx + ax, ly + ay);
                    g.lineTo(lx + ax * 0.5 - wx, ly + ay * 0.5 - wy);
                    g.closePath();
                    g.fill({ color: leaf, alpha: 0.75 });
                }

                // A bud on the tip of one that is nearly full-grown.
                if (grown > 0.9) {
                    const length = Math.hypot(dirX, dirY) || 1;
                    g.circle(tipX + (dirX / length) * 1.5, tipY + (dirY / length) * 1.5, 1.9);
                    g.fill({ color: theme.accentAlt, alpha: clamp((grown - 0.9) * 10, 0, 1) });
                }
            }
        }
    }

    public cleanup(): void {
        this.view?.destroy();
        this.view = undefined;
        this.plants.clear();
        this.context.fields = this.context.active = this.context.tendrils = 0;
    }

    /** Plant the tendrils again when the element's size changes: each from its own place on the edge. */
    private fit(plant: Plant, field: Field<Plant>): void {
        if (plant.width === field.width && plant.height === field.height && plant.radius === field.radius) {
            return;
        }
        plant.width = field.width;
        plant.height = field.height;
        plant.radius = field.radius;
        const border = this.border;
        border.set(field.width, field.height, field.radius, 0);
        plant.count = clamp(Math.round((border.length / 40) * this.density), 4, MAX_TENDRILS);
        for (let i = 0; i < plant.count; i++) {
            border.pointAt(((i + 0.2 + Math.random() * 0.6) / plant.count) * border.length, this.point);
            const reach = this.reach * (0.55 + Math.random() * 0.45);
            layTendril(plant.points, i * TENDRIL_POINTS * 2, this.point.x, this.point.y, this.point.nx, this.point.ny, reach, field.width, field.height);
            plant.pace[i] = 1.1 + Math.random() * 1.6;
        }
    }
}
