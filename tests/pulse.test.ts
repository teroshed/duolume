import { describe, expect, test } from 'bun:test';
import { BEAT_DURATION, complex, MAX_RATE, Rhythm, startle, wander } from '../effects/Pulse/heart';

function seeded(seed: number): () => number {
    let a = seed;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function countBeats(rhythm: Rhythm, seconds: number, bpm: number, irregularity: number): number {
    let beats = 0;
    for (let i = 0; i < seconds * 60; i++) {
        if (rhythm.step(1000 / 60, bpm, irregularity)) beats++;
    }
    return beats;
}

describe('complex', () => {
    test('starts and ends at 0', () => {
        expect(complex(0)).toBe(0);
        expect(complex(-5)).toBe(0);
        expect(complex(BEAT_DURATION)).toBe(0);
        expect(complex(BEAT_DURATION + 100)).toBe(0);
        expect(Math.abs(complex(BEAT_DURATION - 1))).toBeLessThan(0.01);
    });

    test('peaks inside its window, with a down-going Q and S around the R', () => {
        let peak = 0;
        let at = 0;
        let low = 0;
        for (let t = 0; t <= BEAT_DURATION; t++) {
            const v = complex(t);
            expect(Number.isFinite(v)).toBe(true);
            if (v > peak) { peak = v; at = t; }
            if (v < low) low = v;
        }
        expect(peak).toBeGreaterThan(0.9);
        expect(at).toBeGreaterThan(60);
        expect(at).toBeLessThan(160);
        expect(low).toBeLessThan(-0.1);
        expect(complex(40)).toBeGreaterThan(0.05);
        expect(complex(190)).toBeGreaterThan(0.2);
    });

    test('the startle is one tall spike that returns to 0', () => {
        let peak = 0;
        for (let t = 0; t < 120; t++) peak = Math.max(peak, startle(t));
        expect(peak).toBeGreaterThan(0.9);
        expect(startle(0)).toBe(0);
        expect(startle(500)).toBe(0);
    });

    test('the wander stays within -1..1', () => {
        for (let t = 0; t < 20000; t += 37) expect(Math.abs(wander(t, 1.7))).toBeLessThanOrEqual(1);
    });
});

describe('Rhythm', () => {
    test('60 bpm beats once a second over many seconds', () => {
        const beats = countBeats(new Rhythm(seeded(1)), 120, 60, 0);
        expect(beats).toBeGreaterThanOrEqual(119);
        expect(beats).toBeLessThanOrEqual(121);
    });

    test('irregularity changes the intervals but keeps the average rate', () => {
        const rhythm = new Rhythm(seeded(5));
        const times: number[] = [];
        for (let i = 0; i < 600 * 60; i++) {
            if (rhythm.step(1000 / 60, 60, 1)) times.push(i / 60);
        }
        const gaps = times.slice(1).map((t, i) => t - times[i]);
        expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(0.5);
        expect(times.length).toBeGreaterThan(600 * 0.9);
        expect(times.length).toBeLessThan(600 * 1.1);
        expect(Math.max(...gaps)).toBeGreaterThan(1.6);
    });

    test('rate 0 never beats; bad numbers never beat or throw', () => {
        const rhythm = new Rhythm(seeded(2));
        expect(countBeats(rhythm, 60, 0, 0)).toBe(0);
        expect(rhythm.step(16, -10, 0)).toBe(false);
        expect(rhythm.step(16, Number.NaN, 0)).toBe(false);
        expect(rhythm.step(Number.NaN, 60, 0)).toBe(false);
        expect(Number.isFinite(rhythm.phase)).toBe(true);
    });

    test('a faster rate beats more often, capped at MAX_RATE; it stays finite', () => {
        const slow = countBeats(new Rhythm(seeded(3)), 60, 40, 0);
        const fast = countBeats(new Rhythm(seeded(3)), 60, 150, 0);
        expect(fast).toBeGreaterThan(slow * 3);
        const crazy = countBeats(new Rhythm(seeded(3)), 60, 1e9, 0.5);
        expect(crazy).toBeLessThanOrEqual(MAX_RATE + 2);
        expect(Number.isFinite(new Rhythm(seeded(3)).phase)).toBe(true);
    });

    test('restart makes the next beat a whole interval away', () => {
        const rhythm = new Rhythm(seeded(4));
        rhythm.restart();
        let first = -1;
        for (let i = 0; i < 120 && first < 0; i++) if (rhythm.step(1000 / 60, 60, 0)) first = i;
        expect(first).toBeGreaterThanOrEqual(58);
        expect(first).toBeLessThanOrEqual(61);
    });
});
