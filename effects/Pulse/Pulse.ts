import { Effect } from '../../src/Effect';
import { approach, clamp, lerp, mixColor } from '../../src/math';
import type { EffectContext, TickContext, TimedContext } from '../../src/types';
import type { PulseContext } from '../contracts';
import { FieldLayer } from '../Field/FieldLayer';
import { FieldSet, type Field } from '../Field/FieldSet';
import { BEAT_DURATION, complex, Rhythm, startle, wander } from './heart';

export interface PulseOptions {
    /** Beats per minute at rest, for an element that is on. A slider runs from about 0.6 to 2.3 times this as its value goes from 0 to 1. Default `RATE` (66). */
    rate?: number;
    /** How fast the line travels across an element, in px/ms. Default `SWEEP` (0.06). */
    sweep?: number;
    /** How much the baseline wanders, as a share of the element's height. Default `NOISE` (0.04). */
    noise?: number;
}

/** One beat in progress: when it began (ms), how tall it is (1 is a normal beat) and its shape. */
interface Beat {
    start: number;
    amp: number;
    startled: boolean;
}

/** What the effect keeps for one element. */
interface Trace {
    /** Displacement of each sample from the baseline, in px, up positive. A ring: the newest is at `head`. */
    samples: Float32Array;
    spacing: number;
    head: number;
    /** Pixels the sweep has moved since the last sample was written. */
    travelled: number;
    rhythm: Rhythm;
    /** The beat in progress and the one before it (they can overlap when beats come fast). */
    beats: [Beat, Beat];
    /** When the single long flattening after switching off starts (ms), or far in the past. */
    flatAt: number;
    busyMix: number;
    invalidMix: number;
    /** Makes each trace wander differently. */
    seed: number;
}

const NEVER = -1e9;
/** How long the flattening after switching off takes, ms. */
const FLATTEN = 700;
/** Age bands the line is drawn in: one stroke each. */
const BANDS = 6;
/** Samples cleared just ahead of the sweep, in px. */
const GAP = 7;

/**
 * A heart monitor in every input: a trace runs across the element and says what state it is in.
 * A steady beat while it is on (or focused, or an always-on field), a flat dim line while it is
 * off, a racing one while it is busy, an irregular one with skipped and early beats while what was
 * typed is invalid. A press is a big beat; a slider sets the rate; hovering quickens it a little.
 * The sweep is the classic monitor's: the newest sample is drawn at the sweep position, older ones
 * stay behind it and fade, and a small gap of cleared line runs ahead. In a switch the sweep
 * crosses only the part the knob leaves free. In a text field or a button the trace runs in the
 * lower third and its spike stays short, so the words stay readable.
 *
 * Any element tagged `pulse` is a monitor (`data-fx-tags="pulse"`; `attachFieldTags()` keeps the
 * state words current).
 *
 * What it listens to:
 *   - elements tagged `pulse`, their state words (`on`, `off`, `focus`, `disabled`, `invalid`,
 *     `busy`, `knob`, `value:`), the pointer over them and presses on them.
 *   - `lightning:strike` events: every active trace jumps once, as a single tall spike.
 * It tells the others how many monitors it is drawing in, how many are active, and how many
 * beats there have been across all of them since it started (`beats`). No forces, no events.
 * It has no keys.
 */
export class Pulse extends Effect<PulseContext> {
    public effectName = 'pulse';

    public static readonly TAG = 'pulse';
    public static readonly RATE = 66;
    public static readonly SWEEP = 0.06;
    public static readonly NOISE = 0.04;

    private readonly rate: number;
    private readonly sweep: number;
    private readonly noise: number;
    private readonly traces = new FieldSet<Trace>(Pulse.TAG, () => Pulse.makeTrace());
    private readonly context: PulseContext = { fields: 0, active: 0, beats: 0 };
    private layer: FieldLayer | undefined;
    private beatCount = 0;
    private seeds = 0;

    constructor(options: PulseOptions = {}) {
        super();
        this.rate = clamp(options.rate ?? Pulse.RATE, 0, 220);
        this.sweep = clamp(options.sweep ?? Pulse.SWEEP, 0.005, 0.5);
        this.noise = clamp(options.noise ?? Pulse.NOISE, 0, 0.3);
    }

    public initialize(): void {
        this.layer = new FieldLayer(this.host.pixi);
    }

    public onTick(tick: TickContext): EffectContext<PulseContext> {
        this.traces.update(tick);
        const now = tick.time;
        const dt = tick.timeDelta;
        const startled = tick.events('lightning:strike').length > 0;

        let active = 0;
        for (const field of this.traces.fields) {
            const trace = field.data;
            const words = field.words;
            this.fit(trace, field);
            if (field.active) {
                active++;
            }

            // Colour moods ease in and out.
            trace.busyMix = approach(trace.busyMix, words.busy && field.active ? 1 : 0, 5, dt);
            trace.invalidMix = approach(trace.invalidMix, words.invalid && !words.disabled ? 1 : 0, 5, dt);

            // The rhythm.
            let bpm = 0;
            let irregularity = 0;
            if (field.active) {
                bpm = words.value !== undefined ? this.rate * lerp(0.6, 2.27, field.level) : this.rate;
                if (words.busy) {
                    bpm *= 2.2;
                }
                if (field.hover) {
                    bpm *= 1.15;
                }
                if (words.invalid) {
                    irregularity = 1;
                }
            }

            if (field.turnedOn) {
                this.beat(trace, now, 1.35, false);
                trace.rhythm.restart();
            } else if (field.pressed && field.active) {
                this.beat(trace, now, 1.7, false);
                trace.rhythm.restart();
            } else if (trace.rhythm.step(dt, bpm, irregularity)) {
                this.beat(trace, now, 1, false);
            }
            if (startled && field.active) {
                this.beat(trace, now, 1.5, true);
            }
            if (field.turnedOff) {
                // The beat in progress finishes, then one long flattening.
                const rest = trace.beats[0].start + BEAT_DURATION - now;
                trace.flatAt = now + Math.max(0, rest);
            }

            // The sweep: write the signal at the head, one sample per `spacing` px travelled.
            trace.travelled += this.sweep * dt;
            let steps = 0;
            while (trace.travelled >= trace.spacing && steps < trace.samples.length) {
                trace.travelled -= trace.spacing;
                steps++;
                trace.head = (trace.head + 1) % trace.samples.length;
                trace.samples[trace.head] = this.signal(trace, field, now);
            }
            if (steps >= trace.samples.length) {
                trace.travelled = 0;
            }
        }

        this.context.fields = this.traces.fields.length;
        this.context.active = active;
        this.context.beats = this.beatCount;
        return this.publish(this.context);
    }

    public onRender(timed: TimedContext): void {
        const layer = this.layer;
        if (!layer) {
            return;
        }
        const theme = timed.theme;
        for (const field of this.traces.fields) {
            const g = layer.draw(field);
            const trace = field.data;
            const n = trace.samples.length;
            if (n < 3) {
                continue;
            }
            const { base, low } = Pulse.layout(field);
            // Off is a visible, dim flatline; disabled is dimmer; in text the trace stays quiet.
            const bright = (field.words.disabled ? 0.22 : lerp(0.4, 1, field.presence)) * (low ? 0.8 : 1);
            let colour = mixColor(theme.accent, theme.accentAlt, trace.busyMix);
            colour = mixColor(colour, mixColor(theme.accentAlt, theme.ink, 0.5), trace.invalidMix);

            const shown = Math.max(2, n - Math.ceil(GAP / trace.spacing));
            const span = field.freeWidth;
            const xOf = (i: number): number => field.freeX + (i / (n - 1)) * span;
            const head = trace.head;

            // Newest to oldest, in age bands; a stroke per band. The line breaks where the ring wraps.
            let band = -1;
            let prevX = 0;
            let prevY = 0;
            let prevI = -1;
            for (let j = 0; j < shown; j++) {
                const i = (head - j + n) % n;
                const x = xOf(i);
                const y = base - trace.samples[i];
                const b = Math.min(BANDS - 1, Math.floor((j / shown) * BANDS));
                if (b !== band) {
                    if (band >= 0) {
                        g.stroke({ width: band === 0 ? 1.5 : 1, color: colour, alpha: bright * (1 - 0.8 * ((band + 0.5) / BANDS)) });
                    }
                    band = b;
                    g.moveTo(prevI >= 0 && Math.abs(prevI - i) === 1 ? prevX : x, prevI >= 0 && Math.abs(prevI - i) === 1 ? prevY : y);
                    if (prevI >= 0 && Math.abs(prevI - i) === 1) {
                        g.lineTo(x, y);
                    }
                } else if (Math.abs(prevI - i) === 1) {
                    g.lineTo(x, y);
                } else {
                    g.moveTo(x, y);
                }
                prevX = x;
                prevY = y;
                prevI = i;
            }
            if (band >= 0) {
                g.stroke({ width: band === 0 ? 1.5 : 1, color: colour, alpha: bright * (1 - 0.8 * ((band + 0.5) / BANDS)) });
            }
            // The bright dot at the sweep head.
            g.circle(xOf(head), base - trace.samples[head], 1).fill({ color: mixColor(colour, theme.ink, 0.5), alpha: bright });
        }
        layer.sweep();
    }

    public cleanup(): void {
        this.traces.clear();
        this.layer?.destroy();
        this.layer = undefined;
        this.beatCount = 0;
        this.seeds = 0;
        this.context.fields = 0;
        this.context.active = 0;
        this.context.beats = 0;
    }

    private static makeTrace(): Trace {
        return {
            samples: new Float32Array(0),
            spacing: 2,
            head: 0,
            travelled: 0,
            rhythm: new Rhythm(),
            beats: [
                { start: NEVER, amp: 1, startled: false },
                { start: NEVER, amp: 1, startled: false },
            ],
            flatAt: NEVER,
            busyMix: 0,
            invalidMix: 0,
            seed: 0,
        };
    }

    /**
     * Where the baseline sits and how far a spike may go. In a switch, a bar or a pad it is the
     * middle; in a text field or a button the lower third, with a short spike up and room below.
     */
    private static layout(field: Field<Trace>): { base: number; up: number; down: number; low: boolean } {
        const h = field.height;
        const low = !field.words.knob && field.words.value === undefined && h < 60;
        if (low) {
            const base = h * 0.8;
            return { base, up: Math.max(2, h * 0.2 - 1), down: Math.max(2, h - base - 3), low };
        }
        const half = Math.max(2, h / 2 - 2.5);
        return { base: h / 2, up: half * 0.7, down: half * 0.7, low };
    }

    /** Size the ring to the free width, starting afresh when that changes. */
    private fit(trace: Trace, field: Field<Trace>): void {
        const spacing = field.freeWidth < 80 ? 1 : 1.5;
        const n = Math.max(0, Math.ceil(field.freeWidth / spacing) + 1);
        if (trace.samples.length !== n || trace.spacing !== spacing) {
            trace.samples = new Float32Array(n);
            trace.spacing = spacing;
            trace.head = 0;
            trace.travelled = 0;
            if (trace.seed === 0) {
                trace.seed = 1 + this.seeds++ * 1.7;
            }
        }
    }

    private beat(trace: Trace, now: number, amp: number, startled: boolean): void {
        const [first, second] = trace.beats;
        second.start = first.start;
        second.amp = first.amp;
        second.startled = first.startled;
        first.start = now;
        first.amp = amp;
        first.startled = startled;
        if (!startled) {
            this.beatCount++;
        }
    }

    /** The displacement in px at the sweep head now: baseline, beat, flattening, noise. */
    private signal(trace: Trace, field: Field<Trace>, now: number): number {
        const { up, down } = Pulse.layout(field);
        let v = 0;
        for (const beat of trace.beats) {
            const t = now - beat.start;
            v += (beat.startled ? startle(t) : complex(t)) * beat.amp;
        }
        const sag = (now - trace.flatAt) / FLATTEN;
        if (sag > 0 && sag < 1) {
            v -= 0.3 * Math.sin(Math.PI * sag);
        }
        let dy = v >= 0 ? v * up : v * down;
        dy = clamp(dy, -down, up * 1.45);

        const words = field.words;
        const mood = !field.active ? 0.15 : words.invalid ? 3.5 : words.busy ? 1.5 : 1;
        const wobble = wander(now, trace.seed) * this.noise * Math.min(field.height, 40) * mood;
        const fizz = (Math.random() - 0.5) * this.noise * Math.min(field.height, 40) * 0.1 * mood;
        return clamp(dy + wobble + fizz, -down, up * 1.45);
    }
}
