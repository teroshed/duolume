/**
 * The two pure pieces of the Pulse effect: the shape of one heartbeat and the rhythm that decides
 * when the next one starts. No pixi, no three: `tests/pulse.test.ts` runs them as they are.
 */

/** How long one beat's complex lasts, in milliseconds. After it the signal is exactly 0. */
export const BEAT_DURATION = 260;

/** A raised-cosine bump of half-width `w` ms around `c`, height `a`. Exactly 0 outside `c ± w`. */
function bump(t: number, c: number, w: number, a: number): number {
    const d = t - c;
    return d <= -w || d >= w ? 0 : a * 0.5 * (1 + Math.cos((Math.PI * d) / w));
}

/**
 * The displacement, at `t` ms into a beat, of an ECG-like complex: a small bump (P), a sharp
 * down-up-down spike (QRS) that peaks at about 1, and a rounded bump after it (T). Positive is up.
 * 0 at `t <= 0` and at `t >= BEAT_DURATION`.
 */
export function complex(t: number): number {
    if (!(t > 0) || t >= BEAT_DURATION) {
        return 0;
    }
    return bump(t, 40, 28, 0.14) + bump(t, 92, 12, -0.18) + bump(t, 108, 14, 1) + bump(t, 124, 12, -0.3) + bump(t, 190, 44, 0.3);
}

/** How long a startle spike lasts, in milliseconds. */
export const STARTLE_DURATION = 90;

/** One single tall spike, up and back: what a lightning strike does to a trace. Peaks at 1. */
export function startle(t: number): number {
    return t > 0 && t < STARTLE_DURATION ? bump(t, 28, 28, 1) + bump(t, 62, 28, -0.25) : 0;
}

/**
 * A slow wandering of the baseline, roughly -1..1, a smooth function of time. `seed` makes two
 * traces wander differently.
 */
export function wander(timeMs: number, seed: number): number {
    return 0.5 * (Math.sin(timeMs * 0.0027 + seed) + Math.sin(timeMs * 0.0071 + seed * 2.3));
}

/** The longest a rhythm will beat: no faster than this many beats per minute, whatever it is told. */
export const MAX_RATE = 240;

/**
 * Says when the next beat starts. Step it with the elapsed time, the rate in beats per minute and
 * an irregularity from 0 (a metronome) to 1 (skipped beats, early beats). It keeps a phase, so a
 * change of rate takes effect at once; each beat draws the length of the next interval, so the
 * average rate stays the rate whatever the irregularity.
 */
export class Rhythm {
    /** How far through the current interval it is, 0..1. */
    public phase: number;
    /** How long the current interval is, as a multiple of the steady one. */
    private multiple = 1;
    /** Chance, at full irregularity, that a beat is skipped. */
    private static readonly SKIP = 0.18;

    public constructor(private readonly random: () => number = Math.random) {
        this.phase = 0.4 + 0.5 * random();
    }

    /** Advance by `dtMs`. True when a beat starts in this step. Rate 0 (or less, or not a number) never beats. */
    public step(dtMs: number, bpm: number, irregularity: number): boolean {
        if (!(bpm > 0) || !(dtMs > 0) || !Number.isFinite(dtMs)) {
            return false;
        }
        const rate = Math.min(bpm, MAX_RATE);
        this.phase += (dtMs * rate) / 60000 / this.multiple;
        if (this.phase < 1) {
            return false;
        }
        this.phase = this.phase % 1;
        const irr = Math.min(1, Math.max(0, Number.isFinite(irregularity) ? irregularity : 0));
        if (irr === 0) {
            this.multiple = 1;
        } else {
            const skip = Rhythm.SKIP * irr;
            const raw = this.random() < skip ? 2 : 1 + irr * (2 * this.random() - 1) * 0.55;
            this.multiple = Math.max(0.3, raw / (1 + skip));
        }
        return true;
    }

    /** Begin a fresh steady interval now (after a press or a start): the next beat is a whole one away. */
    public restart(): void {
        this.phase = 0;
        this.multiple = 1;
    }
}
