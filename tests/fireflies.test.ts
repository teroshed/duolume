import { describe, expect, test } from 'bun:test';
import { createSwarm, orderParameter, stepSwarm } from '../effects/Fireflies/sync';

/** A small deterministic generator, so the runs are repeatable. */
function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function randomSwarm(n: number, seed: number) {
    const random = rng(seed);
    const swarm = createSwarm(n);
    for (let i = 0; i < n; i++) {
        swarm.phase[i] = random();
        swarm.period[i] = 2200 * (0.9 + random() * 0.2);
    }
    return swarm;
}

describe('orderParameter', () => {
    test('identical phases give 1', () => {
        expect(orderParameter(new Float32Array(20).fill(0.37), 20)).toBeCloseTo(1, 5);
    });

    test('evenly spread phases give about 0', () => {
        const phases = new Float32Array(40);
        for (let i = 0; i < 40; i++) phases[i] = i / 40;
        expect(orderParameter(phases, 40)).toBeLessThan(0.001);
    });

    test('counts only the first `count` phases, and 0 for none', () => {
        const phases = Float32Array.from([0.2, 0.2, 0.7, 0.7]);
        expect(orderParameter(phases, 2)).toBeCloseTo(1, 5);
        expect(orderParameter(phases, 0)).toBe(0);
    });
});

describe('stepSwarm', () => {
    test('a lone oscillator flashes once per period and restarts', () => {
        const swarm = createSwarm(1);
        swarm.period[0] = 1000;
        let flashes = 0;
        for (let t = 0; t < 3000; t += 10) flashes += stepSwarm(swarm, 1, 10, 0.1, 100, 0.15);
        expect(flashes).toBeGreaterThanOrEqual(2);
        expect(flashes).toBeLessThanOrEqual(3);
    });

    test('a flash nudges a neighbour in reach, the more the further along it is, and not one out of reach', () => {
        const swarm = createSwarm(4);
        swarm.phase.set([0.999, 0.2, 0.8, 0.8]);
        swarm.x.set([0, 50, 50, 900]);
        stepSwarm(swarm, 4, 10, 0.1, 100, 0.15);
        expect(swarm.fired[0]).toBe(1);
        expect(swarm.phase[0]).toBe(0);
        const gainNear = swarm.phase[1] - (0.2 + 10 / 1000);
        const gainFar = swarm.phase[2] - (0.8 + 10 / 1000);
        expect(gainFar).toBeGreaterThan(gainNear);
        expect(swarm.phase[3]).toBeCloseTo(0.8 + 10 / 1000, 3);
    });

    test('a resting oscillator ignores the nudge', () => {
        const swarm = createSwarm(2);
        swarm.phase.set([0.999, 0.5]);
        swarm.rest[1] = 500;
        stepSwarm(swarm, 2, 10, 0.5, 100, 0.15);
        expect(swarm.phase[1]).toBeCloseTo(0.5 + 0.01, 4);
    });

    test('a fully connected swarm with coupling falls into step', () => {
        const n = 40;
        const swarm = randomSwarm(n, 5);
        let order = 0;
        for (let k = 0; k < 60 * 120 && order <= 0.9; k++) {
            stepSwarm(swarm, n, 1000 / 60, 0.1, Infinity, 0.15);
            order = orderParameter(swarm.phase, n);
        }
        expect(order).toBeGreaterThan(0.9);
    });

    test('with no coupling it never does', () => {
        const n = 40;
        const swarm = randomSwarm(n, 5);
        let best = 0;
        for (let k = 0; k < 60 * 120; k++) {
            stepSwarm(swarm, n, 1000 / 60, 0, Infinity, 0.15);
            if (k > 600) best = Math.max(best, orderParameter(swarm.phase, n));
        }
        expect(best).toBeLessThan(0.9);
    });

    test('oscillators beyond `active` neither flash nor take part', () => {
        const swarm = createSwarm(3);
        swarm.phase.set([0.5, 0.5, 0.999]);
        expect(stepSwarm(swarm, 2, 10, 0.1, Infinity, 0.15)).toBe(0);
        expect(swarm.phase[2]).toBeCloseTo(0.999, 5);
    });
});
