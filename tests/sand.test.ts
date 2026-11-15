import { describe, expect, test } from 'bun:test';
import { Pile } from '../effects/Sand/Pile';

const TICK = 1000 / 60;

function allFinite(values: Float32Array): boolean {
    for (const v of values) {
        if (!Number.isFinite(v)) return false;
    }
    return true;
}

function maxSlope(p: Pile): number {
    let m = 0;
    for (let i = 0; i < p.count - 1; i++) {
        m = Math.max(m, Math.abs(p.heights[i] - p.heights[i + 1]) / p.spacing);
    }
    return m;
}

describe('Pile', () => {
    test('one column every SPACING px, at least two, empty at first', () => {
        const p = new Pile(60, 26);
        expect(p.count).toBe(Math.ceil(60 / Pile.SPACING) + 1);
        expect(p.total).toBe(0);
        expect(new Pile(0, 10).count).toBe(2);
        expect(new Pile(Number.NaN, Number.NaN).count).toBe(2);
    });

    test('a heap is poured with the area asked for, under the ceiling', () => {
        const p = new Pile(180, 16);
        p.fillHeap(400, 100);
        expect(p.total).toBeCloseTo(400, 1);
        for (const h of p.heights) expect(h).toBeLessThanOrEqual(16 + 1e-4);
        const level = new Pile(200, 30);
        level.fillLevel(1000);
        expect(level.total).toBeCloseTo(1000, 1);
    });

    test('a spike slumps to the angle of repose and the total is conserved', () => {
        const p = new Pile(100, 1000);
        const mid = Math.floor(p.count / 2);
        p.heights[mid] = 60;
        const start = p.total;
        for (let i = 0; i < 600; i++) p.step(TICK);
        expect(p.total).toBeCloseTo(start, 2);
        expect(maxSlope(p)).toBeLessThanOrEqual(p.repose * 1.05);
        // It spread out rather than staying a spike.
        expect(p.heights[mid]).toBeLessThan(30);
        expect(p.heights[mid + 3]).toBeGreaterThan(0);
    });

    test('a tilt carries the centre of mass to that side and keeps the sand in bounds', () => {
        const p = new Pile(60, 26);
        p.fillHeap(500, 10);
        const start = p.total;
        const before = p.centre();
        p.tilt = 1;
        for (let i = 0; i < 90; i++) p.step(TICK);
        expect(p.centre()).toBeGreaterThan(before + 20);
        expect(p.total).toBeCloseTo(start, 2);
        for (const h of p.heights) {
            expect(h).toBeGreaterThanOrEqual(0);
            expect(h).toBeLessThanOrEqual(26 + 1e-4);
        }
        // And back.
        p.tilt = -1;
        for (let i = 0; i < 90; i++) p.step(TICK);
        expect(p.centre()).toBeLessThan(30);
    });

    test('a target gathers the heap under it', () => {
        const p = new Pile(180, 16);
        p.fillHeap(300, 110);
        p.target = 30;
        p.pull = 1.3;
        for (let i = 0; i < 240; i++) p.step(TICK);
        expect(Math.abs(p.centre() - 30)).toBeLessThan(12);
        expect(p.total).toBeCloseTo(300, 1);
    });

    test('a dent is dug, refills, and the total is conserved', () => {
        const p = new Pile(220, 90);
        p.fillLevel(220 * 15);
        const start = p.total;
        const moved = p.dig(110, 8, 8);
        expect(moved).toBeGreaterThan(0);
        expect(p.surface(110)).toBeLessThan(10);
        expect(p.total).toBeCloseTo(start, 2);
        p.creep = 3;
        for (let i = 0; i < 300; i++) p.step(TICK);
        expect(p.surface(110)).toBeGreaterThan(12.5);
        expect(p.total).toBeCloseTo(start, 2);
    });

    test('it stays finite under silly input', () => {
        const p = new Pile(60, 26, 89);
        p.fillHeap(1e6, 30);
        p.tilt = 50;
        p.pull = -3;
        p.target = 1e9;
        p.creep = 1e9;
        for (let i = 0; i < 200; i++) p.step(i % 3 === 0 ? 1000 : TICK);
        p.dig(-50, 1e6, 1e6);
        p.step(Number.NaN);
        expect(allFinite(p.heights)).toBe(true);
        expect(Number.isFinite(p.total)).toBe(true);
    });
});
