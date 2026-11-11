import { clamp, randomNumber } from '../../src/math';
import type { TickContext, Vector3 } from '../../src/types';

export interface RibbonOptions {
    anchor: Vector3;
    amplitude: number;
    frequency: number;
    speed: number;
    thickness: number;
    wobble: number;
    phase: number;
    hueShift: number;
}

/** Largest push wind may add to a ribbon's drift, in px/ms. */
const MAX_WIND_DRIFT = 0.5;

export class Ribbon {
    /** Anchor point that drifts; the ribbon is generated relative to this. */
    public anchor: Vector3;
    /** Max vertical displacement. */
    public readonly amplitude: number;
    private readonly frequency: number;
    /** Horizontal drift speed in px/ms. */
    private readonly speed: number;
    /** Visual thickness of the core, in px. */
    public readonly thickness: number;
    private readonly wobble: number;
    private readonly phase: number;
    /** Where in the colour cycle this ribbon starts (the original's per-ribbon colour wiggle). */
    public readonly hueShift: number;

    // ripple pulse state
    private pulseTime = 0;
    private pulseStrength = 1;
    private readonly pulseOrigin: Vector3 = { x: 0, y: 0 };

    /** The original placed anchors at 100..500 px; that range is now 12%..55% of the stage height. */
    static random(stageHeight = 900): Ribbon {
        const anchor: Vector3 = { x: randomNumber(-50, 50), y: randomNumber(stageHeight * 0.12, stageHeight * 0.55) };
        return new Ribbon({
            anchor,
            amplitude: randomNumber(20, 100),
            frequency: randomNumber(0.004, 0.012),
            speed: randomNumber(0.03, 0.12),
            thickness: randomNumber(4, 10),
            wobble: randomNumber(0.0007, 0.002),
            phase: randomNumber(0, Math.PI * 2),
            hueShift: randomNumber(-2, 2),
        });
    }

    constructor(opts: RibbonOptions) {
        this.anchor = opts.anchor;
        this.amplitude = opts.amplitude;
        this.frequency = opts.frequency;
        this.speed = opts.speed;
        this.thickness = opts.thickness;
        this.wobble = opts.wobble;
        this.phase = opts.phase;
        this.hueShift = opts.hueShift;
    }

    /** `windX` is the horizontal acceleration sampled from the force field at the anchor, in px/ms². */
    update(tick: TickContext, windX: number): void {
        const t = tick.time * 0.001; // seconds, simulation clock
        const dt = tick.timeDelta;
        const wind = clamp(windX * dt * 40, -MAX_WIND_DRIFT, MAX_WIND_DRIFT);
        this.anchor.x += (this.speed + wind) * dt; // drift horizontally

        // slow vertical float
        this.anchor.y += Math.sin(t * 0.2 + this.phase) * 0.02 * dt;

        // decay pulse over time
        this.pulseTime = Math.max(0, this.pulseTime - dt * 0.005);
    }

    pulse(origin: Vector3, strength = 1): void {
        this.pulseOrigin.x = origin.x;
        this.pulseOrigin.y = origin.y;
        this.pulseStrength = strength;
        this.pulseTime = 1; // start a 0..1 pulse that decays in update()
    }

    private computeY(x: number, t: number): number {
        // base sin wave + micro wobble + optional radial pulse
        const base = Math.sin(x * this.frequency + t + this.phase) * this.amplitude;
        const micro = Math.sin(x * this.wobble + t * 2.3 + this.phase * 0.5) * (this.amplitude * 0.2);

        let pulse = 0;
        if (this.pulseTime > 0) {
            const dx = x - this.pulseOrigin.x;
            const dist = Math.abs(dx);
            const wave = Math.sin(dist * 0.04 - this.pulseTime * 10);
            const falloff = Math.max(0, 1 - dist / 600);
            pulse = wave * falloff * (this.amplitude * 0.5) * this.pulseTime * this.pulseStrength;
        }

        return base + micro + pulse;
    }

    /**
     * Writes the ribbon's path into `points` (x from -2 steps to the stage width + 2 steps),
     * sampled exactly as the original draw() did. `timeMs` is the simulation clock.
     */
    layout(points: { x: number; y: number }[], stageWidth: number, timeMs: number): void {
        const t = timeMs * 0.001;
        const step = stageWidth / (points.length - 5);
        for (let i = 0; i < points.length; i++) {
            const x = (i - 2) * step;
            const p = points[i];
            p.x = x;
            p.y = this.anchor.y + this.computeY(x * 0.6 + this.anchor.x, t);
        }
    }
}
