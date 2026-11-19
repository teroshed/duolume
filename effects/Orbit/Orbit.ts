import { Graphics } from 'pixi.js';
import { Effect } from '../../src/Effect';
import { approach, clamp, mixColor } from '../../src/math';
import type { EffectContext, TickContext, TimedContext } from '../../src/types';
import type { OrbitContext } from '../contracts';
import { Border, makeBorderPoint, type BorderPoint } from '../Field/border';
import { FieldSet, type Field } from '../Field/FieldSet';

export interface OrbitOptions {
    /** How far outside the element's edge the moons travel, in px, 2..40. Default `GAP` (9). */
    gap?: number;
    /** How fast they travel along the edge at full speed, in px per ms, 0..1. Default `SPEED` (0.05). */
    speed?: number;
    /** Scales how many moons an element gets (one for about every 46 px of its edge, 3 to 14), 0.2..3. Default `MOONS` (1). */
    moons?: number;
}

const MAX_MOONS = 14;
const TRAIL = 4;

interface Ring {
    border: Border;
    width: number;
    height: number;
    radius: number;
    count: number;
    /** Each moon: distance along the path, extra distance out, its own pace and size. */
    d: Float32Array;
    lane: Float32Array;
    pace: Float32Array;
    size: Float32Array;
    /** How fast the ring turns now, 0..about 2, eased. */
    spin: number;
    /** 1 right after a press, easing to 0: the moons are flung outward and come back. */
    kick: number;
}

/**
 * Moons that circle a page element, outside it: small points with short tails that travel
 * round every element tagged `orbit`, a few pixels off its edge, following its corners. They are
 * drawn on the canvas behind the page, so they show round a control that sits on a see-through
 * surface, and pass behind whatever the page paints solid.
 *
 * What it listens to: the element's state in its tags. Off, the moons fall back into the edge
 * and go out; on, they come out and turn. A slider's value sets their speed, the pointer over the
 * element and the keyboard focus speed them up, and a press flings them outward.
 * It tells the others how many moons are out (its context). No events, no forces, no keys.
 */
export class Orbit extends Effect<OrbitContext> {
    public effectName = 'orbit';

    public static readonly GAP = 9;
    public static readonly SPEED = 0.05;
    public static readonly MOONS = 1;

    private readonly gap: number;
    private readonly speed: number;
    private readonly moons: number;
    private readonly rings: FieldSet<Ring>;
    private readonly context: OrbitContext = { fields: 0, active: 0, moons: 0 };
    private readonly point: BorderPoint = makeBorderPoint();
    private view: Graphics | undefined;

    constructor(options: OrbitOptions = {}) {
        super();
        this.gap = clamp(options.gap ?? Orbit.GAP, 2, 40);
        this.speed = clamp(options.speed ?? Orbit.SPEED, 0, 1);
        this.moons = clamp(options.moons ?? Orbit.MOONS, 0.2, 3);
        this.rings = new FieldSet<Ring>('orbit', () => ({
            border: new Border(),
            width: -1,
            height: -1,
            radius: -1,
            count: 0,
            d: new Float32Array(MAX_MOONS),
            lane: new Float32Array(MAX_MOONS),
            pace: new Float32Array(MAX_MOONS),
            size: new Float32Array(MAX_MOONS),
            spin: 0,
            kick: 0,
        }));
    }

    public initialize(): void {
        this.view = new Graphics();
        this.host.pixi.addChild(this.view);
    }

    public onTick(tick: TickContext): EffectContext<OrbitContext> {
        this.rings.update(tick);
        const dt = Math.min(tick.timeDelta, 100);
        let active = 0;
        let out = 0;
        for (const field of this.rings.fields) {
            const ring = field.data;
            this.fit(ring, field);
            if (field.active) {
                active++;
                out += ring.count;
            }
            if (field.pressed) {
                ring.kick = 1;
            } else if (field.turnedOn) {
                ring.kick = Math.max(ring.kick, 0.6);
            }
            ring.kick = approach(ring.kick, 0, 3.5, dt);
            const wanted = field.presence * (0.3 + 0.7 * field.level) * (field.hover ? 1.6 : 1) * (field.words.focus ? 1.3 : 1);
            ring.spin = approach(ring.spin, wanted, 3, dt);
            const step = this.speed * dt * ring.spin;
            for (let i = 0; i < ring.count; i++) {
                ring.d[i] += step * ring.pace[i];
            }
        }
        this.context.fields = this.rings.fields.length;
        this.context.active = active;
        this.context.moons = out;
        return this.publish(this.context);
    }

    public onRender(timed: TimedContext): void {
        const g = this.view;
        if (!g) {
            return;
        }
        g.clear();
        const theme = timed.theme;
        const point = this.point;
        for (const field of this.rings.fields) {
            const shown = field.presence;
            if (shown < 0.02) {
                continue;
            }
            const ring = field.data;
            for (let i = 0; i < ring.count; i++) {
                const color = i % 3 === 0 ? theme.accentAlt : theme.accent;
                // Coming on, a moon rises out of the edge; a press throws it further out, each a little differently.
                const reach = ring.lane[i] - (1 - shown) * this.gap + ring.kick * (10 + 8 * Math.sin(i * 2.4));
                for (let k = TRAIL; k >= 0; k--) {
                    ring.border.pointAt(ring.d[i] - k * 4.5 * Math.min(1.5, ring.spin + 0.2), point);
                    const x = field.x + point.x + point.nx * reach;
                    const y = field.y + point.y + point.ny * reach;
                    const fade = 1 - k / (TRAIL + 1);
                    g.circle(x, y, Math.max(0.6, ring.size[i] * (0.45 + 0.55 * fade)));
                    g.fill({ color: k === 0 ? mixColor(color, theme.ink, 0.45) : color, alpha: clamp(shown * fade * fade * 0.9, 0, 1) });
                }
            }
        }
    }

    public cleanup(): void {
        this.view?.destroy();
        this.view = undefined;
        this.rings.clear();
        this.context.fields = this.context.active = this.context.moons = 0;
    }

    /** Re-shape the path and deal out the moons when the element's size changes. */
    private fit(ring: Ring, field: Field<Ring>): void {
        if (ring.width === field.width && ring.height === field.height && ring.radius === field.radius) {
            return;
        }
        ring.width = field.width;
        ring.height = field.height;
        ring.radius = field.radius;
        ring.border.set(field.width, field.height, field.radius, -this.gap);
        const count = clamp(Math.round((ring.border.length / 46) * this.moons), 3, MAX_MOONS);
        if (count !== ring.count) {
            ring.count = count;
            for (let i = 0; i < count; i++) {
                ring.d[i] = ((i + Math.random() * 0.5) / count) * ring.border.length;
                ring.lane[i] = Math.random() * 5;
                ring.pace[i] = 0.75 + Math.random() * 0.5;
                ring.size[i] = 1.3 + Math.random() * 1.1;
            }
        }
    }
}
