import { describe, expect, test } from 'bun:test';
import { DEFAULT_RULES, edgeSteer, integrate, steer } from '../effects/Flock/boids';

// The flock's steering rules, without a renderer: each test builds a few birds by hand.
function birds(list: [number, number, number, number][]) {
    const n = list.length;
    const px = new Float32Array(n);
    const py = new Float32Array(n);
    const vx = new Float32Array(n);
    const vy = new Float32Array(n);
    list.forEach(([x, y, u, v], i) => {
        px[i] = x;
        py[i] = y;
        vx[i] = u;
        vy[i] = v;
    });
    return { px, py, vx, vy, n };
}

describe('boids', () => {
    test('two birds closer than the separation distance are steered apart', () => {
        const b = birds([
            [100, 100, 0.1, 0],
            [110, 100, 0.1, 0],
        ]);
        const out = { x: 0, y: 0 };
        steer(0, b.px, b.py, b.vx, b.vy, b.n, DEFAULT_RULES, out);
        expect(out.x).toBeLessThan(0);
        steer(1, b.px, b.py, b.vx, b.vy, b.n, DEFAULT_RULES, out);
        expect(out.x).toBeGreaterThan(0);
    });

    test('a bird near a group is drawn to its middle', () => {
        const b = birds([
            [100, 100, 0.1, 0],
            [100, 150, 0.1, 0],
            [110, 160, 0.1, 0],
            [90, 160, 0.1, 0],
        ]);
        const out = { x: 0, y: 0 };
        const n = steer(0, b.px, b.py, b.vx, b.vy, b.n, DEFAULT_RULES, out);
        expect(n).toBe(3);
        expect(out.y).toBeGreaterThan(0);
        expect(Math.abs(out.x)).toBeLessThan(1e-9);
    });

    test('a lone bird far from the others is steered toward them', () => {
        const b = birds([
            [0, 0, 0.1, 0],
            [500, 500, 0.1, 0],
            [520, 500, 0.1, 0],
        ]);
        const out = { x: 0, y: 0 };
        expect(steer(0, b.px, b.py, b.vx, b.vy, b.n, DEFAULT_RULES, out)).toBe(0);
        expect(out.x).toBeGreaterThan(0);
        expect(out.y).toBeGreaterThan(0);
        expect(Math.hypot(out.x, out.y)).toBeCloseTo(DEFAULT_RULES.lonely);
    });

    test('a bird alone in the sky feels nothing', () => {
        const b = birds([[0, 0, 0.1, 0]]);
        const out = { x: 1, y: 1 };
        expect(steer(0, b.px, b.py, b.vx, b.vy, b.n, DEFAULT_RULES, out)).toBe(0);
        expect(out).toEqual({ x: 0, y: 0 });
    });

    test('a bird among neighbours heading one way is turned toward that heading', () => {
        // Bird 0 flies right; its neighbours (spread evenly around it, so cohesion cancels) fly down.
        const b = birds([
            [200, 200, 0.12, 0],
            [240, 200, 0, 0.12],
            [160, 200, 0, 0.12],
            [200, 240, 0, 0.12],
            [200, 160, 0, 0.12],
        ]);
        const out = { x: 0, y: 0 };
        steer(0, b.px, b.py, b.vx, b.vy, b.n, DEFAULT_RULES, out);
        expect(out.y).toBeGreaterThan(0);
        expect(out.x).toBeLessThan(0);
        const v = { x: 0, y: 0 };
        integrate(b.vx[0], b.vy[0], out.x, out.y, 16, DEFAULT_RULES, 1, v);
        expect(v.y).toBeGreaterThan(0);
    });

    test('birds marked as skipped are not neighbours', () => {
        const b = birds([
            [100, 100, 0.1, 0],
            [105, 100, 0.1, 0],
        ]);
        const out = { x: 0, y: 0 };
        expect(steer(0, b.px, b.py, b.vx, b.vy, b.n, DEFAULT_RULES, out, new Uint8Array([0, 1]))).toBe(0);
    });

    test('speed stays within limits after a step', () => {
        const v = { x: 0, y: 0 };
        // A huge push forward is capped at the top speed…
        integrate(0.15, 0, 1, 0, 16, DEFAULT_RULES, 1, v);
        expect(Math.hypot(v.x, v.y)).toBeCloseTo(DEFAULT_RULES.maxSpeed);
        // …a brake leaves the bird at the bottom of the band, still heading the same way…
        integrate(0.1, 0, -0.005, 0, 16, DEFAULT_RULES, 1, v);
        expect(v.x).toBeGreaterThan(0);
        expect(Math.hypot(v.x, v.y)).toBeCloseTo(DEFAULT_RULES.minSpeed);
        // …and a boost raises the cap.
        integrate(0.15, 0, 1, 0, 16, DEFAULT_RULES, 1.5, v);
        expect(Math.hypot(v.x, v.y)).toBeCloseTo(DEFAULT_RULES.maxSpeed * 1.5);
    });

    test('a hard sideways push turns the heading by at most the turn limit', () => {
        const v = { x: 0, y: 0 };
        integrate(0.1, 0, 0, 0.05, 10, DEFAULT_RULES, 1, v);
        const turned = Math.atan2(v.y, v.x);
        expect(turned).toBeGreaterThan(0);
        expect(turned).toBeLessThanOrEqual(DEFAULT_RULES.maxTurn * 10 + 1e-9);
    });

    test('edges push back inward, and not in the middle', () => {
        const out = { x: 0, y: 0 };
        edgeSteer(10, 400, 1000, 800, 80, 0.001, out);
        expect(out.x).toBeGreaterThan(0);
        expect(out.y).toBe(0);
        const mid = { x: 0, y: 0 };
        edgeSteer(500, 400, 1000, 800, 80, 0.001, mid);
        expect(mid).toEqual({ x: 0, y: 0 });
    });
});
