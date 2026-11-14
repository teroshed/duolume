import { describe, expect, test } from 'bun:test';
import { WaterSurface } from '../effects/Tide/WaterSurface';

function allFinite(values: Float32Array): boolean {
    for (const v of values) {
        if (!Number.isFinite(v)) return false;
    }
    return true;
}

describe('WaterSurface', () => {
    test('one column every SPACING px across the width, at least two', () => {
        const s = new WaterSurface(900);
        expect(s.count).toBe(Math.ceil(900 / WaterSurface.SPACING) + 1);
        expect(s.columnX(s.count - 1)).toBeGreaterThanOrEqual(900);
        expect(new WaterSurface(0).count).toBe(2);
        expect(new WaterSurface(Number.NaN).count).toBe(2);
    });

    test('a disturbance spreads to the neighbours', () => {
        const s = new WaterSurface(900);
        const mid = Math.floor(s.count / 2);
        const x = s.columnX(mid);
        s.disturb(x, -0.2, 10);
        const far = mid + 10;
        expect(s.heights[far]).toBe(0);
        for (let i = 0; i < 20; i++) s.step(1000 / 60);
        expect(Math.abs(s.heights[far])).toBeGreaterThan(0.01);
        expect(Math.abs(s.heights[mid - 10])).toBeCloseTo(Math.abs(s.heights[far]), 3);
    });

    test('the energy dies away to near zero', () => {
        const s = new WaterSurface(900);
        s.disturb(450, -0.5, 40);
        s.step(1000 / 60);
        const start = s.energy();
        expect(start).toBeGreaterThan(0);
        for (let i = 0; i < 60 * 2; i++) s.step(1000 / 60);
        expect(s.energy()).toBeLessThan(start * 0.05);
        for (let i = 0; i < 60 * 6; i++) s.step(1000 / 60);
        expect(s.energy()).toBeLessThan(start * 1e-6);
    });

    test('stays finite and bounded under many large disturbances', () => {
        const s = new WaterSurface(1280);
        for (let t = 0; t < 3000; t++) {
            s.disturb((t * 97) % 1300, t % 2 ? 50 : -50, 200);
            s.disturb(Number.NaN, 1, 10);
            s.step(t % 7 === 0 ? 400 : 1000 / 60);
        }
        expect(allFinite(s.heights)).toBe(true);
        expect(allFinite(s.velocities)).toBe(true);
        for (const h of s.heights) expect(Math.abs(h)).toBeLessThanOrEqual(WaterSurface.MAX_HEIGHT);
        for (let i = 0; i < 60 * 20; i++) s.step(1000 / 60);
        expect(s.energy()).toBeLessThan(1e-3);
    });

    test('a resize keeps the surface valid and its shape', () => {
        const s = new WaterSurface(900);
        s.disturb(450, -0.4, 60);
        for (let i = 0; i < 10; i++) s.step(1000 / 60);
        const before = s.heightAt(450);
        s.resize(1800);
        expect(s.count).toBe(Math.ceil(1800 / WaterSurface.SPACING) + 1);
        expect(s.velocities.length).toBe(s.count);
        expect(allFinite(s.heights)).toBe(true);
        expect(s.heightAt(900)).toBeCloseTo(before, 0);
        s.resize(30);
        expect(s.count).toBeGreaterThanOrEqual(2);
        s.resize(0);
        expect(s.count).toBe(2);
        s.disturb(5, 1, 50);
        for (let i = 0; i < 30; i++) s.step(1000 / 60);
        expect(allFinite(s.heights)).toBe(true);
        expect(s.heightAt(-10)).toBe(s.heights[0]);
        expect(s.heightAt(1e6)).toBe(s.heights[s.count - 1]);
    });
});
