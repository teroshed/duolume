/**
 * The oscillator maths of the fireflies, with no renderer in it: a swarm of pulse-coupled
 * oscillators (Mirollo and Strogatz). Each one has a phase that runs 0 to 1 over its own period.
 * At 1 it flashes and starts again from 0, and every other oscillator within reach that is not
 * resting gets its phase pushed forward by `coupling × phase`: the further along it already is,
 * the bigger the push. Repeated, that pulls the swarm into step.
 */

/** Structure-of-arrays state for up to `capacity` oscillators. Positions are the caller's to keep current. */
export interface Swarm {
    capacity: number;
    /** 0..1 position in each oscillator's cycle. */
    phase: Float32Array;
    /** Milliseconds per cycle, one value per oscillator. */
    period: Float32Array;
    /** Milliseconds left in which the oscillator ignores nudges. */
    rest: Float32Array;
    /** 1 for the oscillators that flashed in the last `stepSwarm`, 0 for the others. */
    fired: Uint8Array;
    x: Float32Array;
    y: Float32Array;
}

export function createSwarm(capacity: number): Swarm {
    return {
        capacity,
        phase: new Float32Array(capacity),
        period: new Float32Array(capacity).fill(1000),
        rest: new Float32Array(capacity),
        fired: new Uint8Array(capacity),
        x: new Float32Array(capacity),
        y: new Float32Array(capacity),
    };
}

/**
 * Advance the first `active` oscillators by `dt` milliseconds. Returns how many flashed; `swarm.fired`
 * says which. `reach` is in the same unit as the positions (Infinity connects everyone);
 * `restShare` is the part of a period after a flash in which nudges are ignored.
 */
export function stepSwarm(swarm: Swarm, active: number, dt: number, coupling: number, reach: number, restShare: number): number {
    const n = Math.min(active, swarm.capacity);
    const { phase, period, rest, fired, x, y } = swarm;
    let flashes = 0;

    for (let i = 0; i < n; i++) {
        fired[i] = 0;
        if (rest[i] > 0) {
            rest[i] -= dt;
        }
        phase[i] += dt / period[i];
        if (phase[i] >= 1) {
            fired[i] = 1;
            flashes++;
        }
    }
    for (let i = n; i < swarm.capacity; i++) {
        fired[i] = 0;
    }
    if (flashes === 0) {
        return 0;
    }

    const reachSq = reach * reach;
    for (let i = 0; i < n; i++) {
        if (fired[i] === 0) {
            continue;
        }
        phase[i] = 0;
        rest[i] = restShare * period[i];
        if (coupling <= 0) {
            continue;
        }
        for (let j = 0; j < n; j++) {
            if (j === i || fired[j] === 1 || rest[j] > 0) {
                continue;
            }
            const dx = x[j] - x[i];
            const dy = y[j] - y[i];
            if (dx * dx + dy * dy > reachSq) {
                continue;
            }
            phase[j] = Math.min(1, phase[j] + coupling * phase[j]);
        }
    }
    return flashes;
}

/** Kuramoto order parameter of the first `count` phases: 1 when all are equal, near 0 when spread evenly. */
export function orderParameter(phases: ArrayLike<number>, count: number): number {
    const n = Math.min(count, phases.length);
    if (n <= 0) {
        return 0;
    }
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
        const angle = phases[i] * Math.PI * 2;
        re += Math.cos(angle);
        im += Math.sin(angle);
    }
    return Math.hypot(re, im) / n;
}
