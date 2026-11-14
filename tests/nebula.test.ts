import { describe, expect, test } from 'bun:test';
import { CloudLights, LIGHT_THRESHOLD } from '../effects/Nebula/CloudLights';

const FRAME = 1000 / 60;

function lit(lights: CloudLights): number {
    return lights.slots.filter((s) => s.intensity > 0).length;
}

describe('CloudLights', () => {
    test('a new light takes a free slot and leaves the lit ones alone', () => {
        const lights = new CloudLights(4);
        const a = lights.add(10, 20, 0xff0000, 0.9, 300, 600);
        const b = lights.add(30, 40, 0x00ff00, 0.5, 200, 600);
        expect(a).not.toBe(b);
        expect(lit(lights)).toBe(2);
        expect(a.intensity).toBe(0.9);
        expect(a.x).toBe(10);
        expect(a.color).toBe(0xff0000);
        expect(b.y).toBe(40);
        // The pool never grows.
        expect(lights.slots.length).toBe(4);
    });

    test('with the pool full, the weakest light is the one replaced', () => {
        const lights = new CloudLights(3);
        const strong = lights.add(0, 0, 1, 1, 100, 600);
        const weak = lights.add(1, 0, 1, 0.1, 100, 600);
        const middle = lights.add(2, 0, 1, 0.5, 100, 600);
        const fresh = lights.add(9, 9, 2, 0.3, 100, 600);
        expect(fresh).toBe(weak);
        expect(fresh.x).toBe(9);
        expect(strong.intensity).toBe(1);
        expect(middle.intensity).toBe(0.5);
        expect(lights.slots.length).toBe(3);
    });

    test('the intensity halves every halfLife milliseconds', () => {
        const lights = new CloudLights(2);
        const light = lights.add(0, 0, 0xffffff, 1, 100, 500);
        lights.step(500);
        expect(light.intensity).toBeCloseTo(0.5, 6);
        lights.step(500);
        expect(light.intensity).toBeCloseTo(0.25, 6);
        // Many small steps agree with one big one.
        const other = new CloudLights(1);
        const o = other.add(0, 0, 0xffffff, 1, 100, 500);
        for (let i = 0; i < 60; i++) other.step(1000 / 60);
        expect(o.intensity).toBeCloseTo(0.25, 3);
    });

    test('lights fade to nothing, then their slot is free and they are no longer counted', () => {
        const lights = new CloudLights(3);
        lights.add(0, 0, 1, 1, 100, 100);
        const kept = lights.add(1, 0, 1, 1, 100, 100000);
        expect(lights.step(FRAME)).toBe(2);
        let glowing = 2;
        for (let i = 0; i < 600 && glowing === 2; i++) glowing = lights.step(FRAME);
        expect(glowing).toBe(1);
        expect(lit(lights)).toBe(1);
        expect(kept.intensity).toBeGreaterThan(LIGHT_THRESHOLD);
        // The dead light is exactly 0 (not a lingering 0.019), so it is the free slot the next add takes.
        const dead = lights.slots.find((s) => s !== kept && s.x === 0);
        expect(dead?.intensity).toBe(0);
        const next = lights.add(5, 5, 1, 0.2, 100, 100);
        expect(next).not.toBe(kept);
        expect(kept.intensity).toBeGreaterThan(0.5);
    });

    test('intensity never goes negative or NaN, and silly arguments are clamped', () => {
        const lights = new CloudLights(3);
        const a = lights.add(0, 0, 1, -5, -10, -10);
        expect(a.intensity).toBe(0);
        expect(a.radius).toBeGreaterThanOrEqual(1);
        expect(a.halfLife).toBeGreaterThanOrEqual(1);
        lights.add(0, 0, 1, 1, 0, 0, -50, 0.5);
        lights.add(0, 0, 1, 2, 100, 1e-9);
        for (const dt of [0, 0, 1, 16, 1e6, 0.001]) {
            lights.step(dt);
            for (const s of lights.slots) {
                expect(Number.isNaN(s.intensity)).toBe(false);
                expect(s.intensity).toBeGreaterThanOrEqual(0);
            }
        }
        // dt of 0 changes nothing.
        const b = lights.add(0, 0, 1, 0.7, 100, 300);
        expect(lights.step(0)).toBeGreaterThan(0);
        expect(b.intensity).toBeCloseTo(0.7, 9);
    });

    test('a flickering light dims fast, comes back once at flickerTo, then fades normally', () => {
        const lights = new CloudLights(2);
        const bolt = lights.add(0, 0, 1, 1, 400, 350, 120, 0.8);
        let low = 1;
        let t = 0;
        while (t + FRAME < 120) {
            lights.step(FRAME);
            t += FRAME;
            low = Math.min(low, bolt.intensity);
        }
        // Dimmer than a plain light would be by now (four times the pace).
        expect(bolt.intensity).toBeLessThan(Math.pow(0.5, t / 350));
        expect(bolt.flickerIn).toBeGreaterThan(0);
        lights.step(FRAME * 2);
        expect(bolt.flickerIn).toBe(0);
        expect(bolt.intensity).toBeCloseTo(0.8, 6);
        // After that it decays at the ordinary rate.
        const after = bolt.intensity;
        lights.step(350);
        expect(bolt.intensity).toBeCloseTo(after / 2, 6);
    });

    test('clear puts every light out', () => {
        const lights = new CloudLights(3);
        lights.add(0, 0, 1, 1, 100, 600, 100, 1);
        lights.add(0, 0, 1, 1, 100, 600);
        lights.clear();
        expect(lit(lights)).toBe(0);
        expect(lights.step(FRAME)).toBe(0);
        expect(lights.slots.every((s) => s.flickerIn === 0)).toBe(true);
    });

    // A NaN would never fall below the threshold: the light would hold its slot and count as glowing for ever.
    test('a NaN intensity does not make a light that never goes out', () => {
        const lights = new CloudLights(1);
        lights.add(0, 0, 1, Number.NaN, 100, 100);
        expect(lights.step(FRAME)).toBe(0);
    });

    // With halfLife 20 the dip takes it under the threshold long before flickerIn (120 ms) runs out.
    // It must wait for its flicker all the same: the eighth step (133.6 ms) is the one that brings it back.
    test('a short-lived flickering light still flickers', () => {
        const lights = new CloudLights(1);
        const light = lights.add(0, 0, 1, 1, 100, 20, 120, 0.8);
        for (let i = 0; i < 7; i++) {
            expect(lights.step(FRAME)).toBe(1);
        }
        lights.step(FRAME);
        expect(light.intensity).toBeCloseTo(0.8, 5);
        expect(light.flickerIn).toBe(0);
    });
});
