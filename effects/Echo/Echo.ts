import { Graphics } from 'pixi.js';
import { Effect } from '../../src/Effect';
import { clamp } from '../../src/math';
import type { EffectContext, TickContext, TimedContext } from '../../src/types';
import type { EchoContext } from '../contracts';
import { FieldSet } from '../Field/FieldSet';

export interface EchoOptions {
    /** How far a ring travels out from the element's edge, in px, 4..200. Default `REACH` (30). */
    reach?: number;
    /** How long a ring lives, in ms, 100..5000. Default `LIFE_MS` (900). */
    life?: number;
}

const RINGS = 6;

interface Rings {
    /** Age of each ring in ms; at or past its life it is free. */
    age: Float32Array;
    /** How strong each ring started, 0..1. */
    power: Float32Array;
    /** The level the last value ring was sent at. */
    sentLevel: number;
    /** Milliseconds until the next ring of a focused element. */
    beat: number;
}

/**
 * Rings of an element's own outline that leave it: each one starts on the edge of an element
 * tagged `echo`, grows outward keeping its corners, and fades. Drawn on the canvas behind the
 * page, so it shows where the page round the control is see-through.
 *
 * What it listens to: the element. A press sends a strong ring, switching it on or off a
 * softer one, a slider sends one as its value moves, and an element with the keyboard focus
 * sends a quiet one every second and a half.
 * It tells the others how many rings are travelling (its context). No events, no forces, no keys.
 */
export class Echo extends Effect<EchoContext> {
    public effectName = 'echo';

    public static readonly REACH = 30;
    public static readonly LIFE_MS = 900;

    private readonly reach: number;
    private readonly life: number;
    private readonly sets: FieldSet<Rings>;
    private readonly context: EchoContext = { fields: 0, active: 0, rings: 0 };
    private view: Graphics | undefined;

    constructor(options: EchoOptions = {}) {
        super();
        this.reach = clamp(options.reach ?? Echo.REACH, 4, 200);
        this.life = clamp(options.life ?? Echo.LIFE_MS, 100, 5000);
        this.sets = new FieldSet<Rings>('echo', (field) => ({
            age: new Float32Array(RINGS).fill(Infinity),
            power: new Float32Array(RINGS),
            sentLevel: field.level,
            beat: 600,
        }));
    }

    public initialize(): void {
        this.view = new Graphics();
        this.host.pixi.addChild(this.view);
    }

    public onTick(tick: TickContext): EffectContext<EchoContext> {
        this.sets.update(tick);
        const dt = Math.min(tick.timeDelta, 100);
        let active = 0;
        let travelling = 0;
        for (const field of this.sets.fields) {
            const rings = field.data;
            if (field.active) {
                active++;
            }
            for (let i = 0; i < RINGS; i++) {
                rings.age[i] += dt;
            }
            if (field.pressed) {
                this.send(rings, 1);
            } else if (field.turnedOn) {
                this.send(rings, 0.85);
            } else if (field.turnedOff) {
                this.send(rings, 0.5);
            }
            // A slider sends one as its value moves. A switch has said what it had to say already.
            if (field.words.value !== undefined && Math.abs(field.level - rings.sentLevel) > 0.07) {
                rings.sentLevel = field.level;
                this.send(rings, 0.6);
            }
            if (field.words.focus && field.active) {
                rings.beat -= dt;
                if (rings.beat <= 0) {
                    rings.beat = 1500;
                    this.send(rings, 0.45);
                }
            } else {
                rings.beat = 600;
            }
            for (let i = 0; i < RINGS; i++) {
                if (rings.age[i] < this.life) {
                    travelling++;
                }
            }
        }
        this.context.fields = this.sets.fields.length;
        this.context.active = active;
        this.context.rings = travelling;
        return this.publish(this.context);
    }

    public onRender(timed: TimedContext): void {
        const g = this.view;
        if (!g) {
            return;
        }
        g.clear();
        const theme = timed.theme;
        for (const field of this.sets.fields) {
            const rings = field.data;
            for (let i = 0; i < RINGS; i++) {
                const t = rings.age[i] / this.life;
                if (!(t < 1)) {
                    continue;
                }
                // Fast off the edge, slowing as it goes.
                const out = 1.5 + this.reach * (1 - (1 - t) * (1 - t));
                g.roundRect(field.x - out, field.y - out, field.width + out * 2, field.height + out * 2, field.radius + out);
                g.stroke({ width: 1.6 - t * 0.8, color: i % 2 === 0 ? theme.accent : theme.accentAlt, alpha: clamp(rings.power[i] * (1 - t) * (1 - t), 0, 1) });
            }
        }
    }

    public cleanup(): void {
        this.view?.destroy();
        this.view = undefined;
        this.sets.clear();
        this.context.fields = this.context.active = this.context.rings = 0;
    }

    /** Start a ring in the slot that has been free, or travelling, the longest. */
    private send(rings: Rings, power: number): void {
        let slot = 0;
        for (let i = 1; i < RINGS; i++) {
            if (rings.age[i] > rings.age[slot]) {
                slot = i;
            }
        }
        rings.age[slot] = 0;
        rings.power[slot] = power;
    }
}
