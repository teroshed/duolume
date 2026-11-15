import { describe, expect, test } from 'bun:test';
import { Surface } from '../effects/Liquid/Surface';

const TICK = 1000 / 60;

function allFinite(values: Float32Array): boolean {
    for (const v of values) {
        if (!Number.isFinite(v)) return false;
    }
    return true;
}

describe('Liquid Surface', () => {
    test('columns every 4 to 6 px, the last at the far end, at least six', () => {
        for (const length of [32, 60, 182, 216, 222]) {
            const s = new Surface(length);
            expect(s.count).toBeGreaterThanOrEqual(Surface.MIN_COLUMNS);
            expect(s.spacing).toBeGreaterThanOrEqual(4);
            expect(s.spacing).toBeLessThanOrEqual(6);
            expect(s.columnAt(s.count - 1)).toBeCloseTo(length, 5);
        }
        expect(new Surface(10).count).toBe(Surface.MIN_COLUMNS);
        expect(new Surface(0).count).toBe(Surface.MIN_COLUMNS);
        expect(new Surface(Number.NaN).count).toBe(Surface.MIN_COLUMNS);
    });

    test('a poke spreads to the neighbours, the same both ways', () => {
        const s = new Surface(200);
        const mid = Math.floor(s.count / 2);
        s.poke(s.columnAt(mid), -0.3, 6);
        expect(s.velocities[mid + 6]).toBe(0);
        for (let i = 0; i < 12; i++) s.step(TICK);
        expect(Math.abs(s.heights[mid + 6])).toBeGreaterThan(0.01);
        expect(s.heights[mid - 6]).toBeCloseTo(s.heights[mid + 6], 4);
    });

    test('a tilt sloshes: the ends move opposite ways', () => {
        const s = new Surface(60);
        s.tilt(0.1);
        for (let i = 0; i < 3; i++) s.step(TICK);
        expect(s.heights[s.count - 1]).toBeGreaterThan(0.5);
        expect(s.heights[0]).toBeLessThan(-0.5);
    });

    test('the energy dies away in about a second', () => {
        const s = new Surface(60);
        s.poke(20, -0.4, 10);
        s.step(TICK);
        const start = s.energy();
        expect(start).toBeGreaterThan(0);
        for (let i = 0; i < 60; i++) s.step(TICK);
        expect(s.energy()).toBeLessThan(start * 0.02);
        for (let i = 0; i < 60 * 4; i++) s.step(TICK);
        expect(s.energy()).toBeLessThan(start * 1e-6);
    });

    test('lower stiffness settles more slowly', () => {
        const firm = new Surface(60, 12, 1);
        const sloppy = new Surface(60, 12, 0.3);
        firm.poke(20, -0.4, 10);
        sloppy.poke(20, -0.4, 10);
        for (let i = 0; i < 40; i++) {
            firm.step(TICK);
            sloppy.step(TICK);
        }
        expect(sloppy.energy()).toBeGreaterThan(firm.energy() * 2);
    });

    test('stays finite and within its limit whatever is thrown at it', () => {
        const s = new Surface(222, 8);
        for (let t = 0; t < 3000; t++) {
            s.poke((t * 37) % 240, t % 2 ? 5 : -5, 80);
            s.tilt(t % 3 ? 3 : -3);
            s.heave(t % 5 ? -2 : 2);
            s.poke(Number.NaN, 1);
            s.tilt(Number.POSITIVE_INFINITY);
            s.step(t % 7 === 0 ? 400 : TICK);
        }
        expect(allFinite(s.heights)).toBe(true);
        expect(allFinite(s.velocities)).toBe(true);
        for (const h of s.heights) expect(Math.abs(h)).toBeLessThanOrEqual(8);
        for (const v of s.velocities) expect(Math.abs(v)).toBeLessThanOrEqual(Surface.MAX_VELOCITY);
        for (let i = 0; i < 60 * 10; i++) s.step(TICK);
        expect(s.energy()).toBeLessThan(1e-6);
    });

    test('a resize keeps it valid and keeps its shape', () => {
        const s = new Surface(60);
        s.tilt(0.1);
        for (let i = 0; i < 3; i++) s.step(TICK);
        const end = s.heightAt(60);
        s.resize(120);
        expect(s.velocities.length).toBe(s.count);
        expect(s.columnAt(s.count - 1)).toBeCloseTo(120, 5);
        expect(s.heightAt(120)).toBeCloseTo(end, 3);
        expect(allFinite(s.heights)).toBe(true);
        s.resize(0);
        expect(s.count).toBe(Surface.MIN_COLUMNS);
        s.poke(0, 1, 10);
        for (let i = 0; i < 30; i++) s.step(TICK);
        expect(allFinite(s.heights)).toBe(true);
        s.resize(40);
        expect(s.heightAt(-5)).toBe(s.heights[0]);
        expect(s.heightAt(1e6)).toBe(s.heights[s.count - 1]);
        expect(s.heightAt(Number.NaN)).toBe(s.heights[0]);
    });
});
