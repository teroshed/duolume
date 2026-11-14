import { describe, expect, test } from 'bun:test';
import {
    angleDelta,
    bodyWidth,
    distanceToSegment,
    followChain,
    orbitPoint,
    segmentSpacing,
    turnRate,
} from '../effects/Serpent/steering';

describe('serpent steering', () => {
    test('angleDelta is the shortest signed turn, across the wrap, and in -pi..pi', () => {
        expect(angleDelta(0, 1)).toBeCloseTo(1);
        expect(angleDelta(1, 0)).toBeCloseTo(-1);
        // 350 degrees to 10 degrees is a 20 degree turn the positive way, not -340.
        expect(angleDelta((350 * Math.PI) / 180, (10 * Math.PI) / 180)).toBeCloseTo((20 * Math.PI) / 180);
        expect(angleDelta((10 * Math.PI) / 180, (350 * Math.PI) / 180)).toBeCloseTo((-20 * Math.PI) / 180);
        for (let from = -20; from <= 20; from += 0.7) {
            for (let to = -20; to <= 20; to += 0.9) {
                const d = angleDelta(from, to);
                expect(Math.abs(d)).toBeLessThanOrEqual(Math.PI + 1e-9);
                // Turning by it really arrives at the target heading.
                expect(Math.cos(from + d)).toBeCloseTo(Math.cos(to), 9);
                expect(Math.sin(from + d)).toBeCloseTo(Math.sin(to), 9);
            }
        }
    });

    test('turnRate is limited to maxRate in either direction, and proportional below it', () => {
        expect(turnRate(0, 3, 0.004, 0.0015)).toBe(0.0015);
        expect(turnRate(0, -3, 0.004, 0.0015)).toBe(-0.0015);
        expect(turnRate(0, 0.1, 0.004, 0.0015)).toBeCloseTo(0.0004);
        expect(turnRate(0.5, 0.5, 0.004, 0.0015)).toBe(0);
        // It takes the short way round the wrap.
        expect(turnRate(3, -3, 0.001, 1)).toBeGreaterThan(0);
        expect(turnRate(-3, 3, 0.001, 1)).toBeLessThan(0);
    });

    test('turning at the rate toward a target reduces the angle to it, without overshoot in small steps', () => {
        let heading = 2.5;
        const want = -2.8;
        let previous = Math.abs(angleDelta(heading, want));
        for (let i = 0; i < 400; i++) {
            heading += turnRate(heading, want, 0.004, 0.0015) * 16;
            const now = Math.abs(angleDelta(heading, want));
            expect(now).toBeLessThanOrEqual(previous + 1e-12);
            previous = now;
        }
        expect(previous).toBeLessThan(0.05);
    });

    test('followChain leaves the head, and puts each segment exactly its spacing behind the one in front', () => {
        const n = 6;
        const x = new Float32Array([100, 0, 0, 0, 0, 0]);
        const y = new Float32Array([100, 100, 100, 100, 100, 100]);
        const z = new Float32Array(n);
        const spacing = new Float32Array(n).fill(10);
        followChain(x, y, z, n, spacing);
        expect(x[0]).toBe(100);
        expect(y[0]).toBe(100);
        for (let i = 1; i < n; i++) {
            const d = Math.hypot(x[i - 1] - x[i], y[i - 1] - y[i], z[i - 1] - z[i]);
            expect(d).toBeCloseTo(spacing[i], 3);
        }
        // They trail out along the line they were pulled in from.
        expect(x[1]).toBeCloseTo(90, 3);
        expect(x[5]).toBeCloseTo(50, 3);
        // Too close is pushed out to the spacing as well, and depth counts.
        const x2 = new Float32Array([0, 1]);
        const y2 = new Float32Array([0, 0]);
        const z2 = new Float32Array([0, 1]);
        followChain(x2, y2, z2, 2, new Float32Array([0, 8]));
        expect(Math.hypot(x2[0] - x2[1], y2[0] - y2[1], z2[0] - z2[1])).toBeCloseTo(8, 3);
    });

    test('degenerate input stays finite: stacked segments, a single segment, zero spacing', () => {
        const x = new Float32Array(4);
        const y = new Float32Array(4);
        const z = new Float32Array(4);
        followChain(x, y, z, 4, new Float32Array(4).fill(10));
        followChain(x, y, z, 1, new Float32Array(4));
        followChain(x, y, z, 0, new Float32Array(4));
        for (const a of [x, y, z]) for (const v of a) expect(Number.isFinite(v)).toBe(true);
        const p = new Float32Array([5, 9]);
        followChain(p, new Float32Array(2), new Float32Array(2), 2, new Float32Array(2));
        expect(p[1]).toBeCloseTo(5, 5);

        expect(distanceToSegment(3, 4, 0, 0, 0, 0)).toBeCloseTo(5);
        const out = { x: 0, y: 0 };
        orbitPoint(50, 50, 50, 50, 100, 1, 0.7, out);
        expect(Number.isFinite(out.x) && Number.isFinite(out.y)).toBe(true);
        for (const t of [-5, 0, 0.5, 1, 5]) {
            expect(Number.isFinite(bodyWidth(t))).toBe(true);
            expect(Number.isFinite(segmentSpacing(t))).toBe(true);
        }
    });

    test('the body is slim at the neck, fullest about a fifth along, thin at the tail; spacing shrinks', () => {
        let widest = 0;
        let widestAt = 0;
        for (let i = 0; i <= 100; i++) {
            const w = bodyWidth(i / 100);
            expect(w).toBeGreaterThanOrEqual(4 - 1e-9);
            if (w > widest) {
                widest = w;
                widestAt = i / 100;
            }
        }
        expect(widestAt).toBeGreaterThan(0.1);
        expect(widestAt).toBeLessThan(0.3);
        expect(bodyWidth(0)).toBeCloseTo(4);
        expect(bodyWidth(1)).toBeCloseTo(4);
        expect(widest).toBeGreaterThan(bodyWidth(0.9) * 2);
        // Out-of-range t is clamped.
        expect(bodyWidth(-3)).toBe(bodyWidth(0));
        expect(bodyWidth(7)).toBe(bodyWidth(1));
        for (let i = 1; i <= 10; i++) {
            expect(segmentSpacing(i / 10)).toBeLessThan(segmentSpacing((i - 1) / 10));
        }
        expect(segmentSpacing(-1)).toBe(segmentSpacing(0));
        expect(segmentSpacing(2)).toBe(segmentSpacing(1));
    });

    test('orbitPoint lies on the circle, leads in the given direction; distanceToSegment measures to the nearest part', () => {
        const out = { x: 0, y: 0 };
        // From the far right of the circle, going clockwise on screen (+y is down) means moving down.
        orbitPoint(500, 300, 300, 300, 100, 1, 0.5, out);
        expect(Math.hypot(out.x - 300, out.y - 300)).toBeCloseTo(100);
        expect(out.y).toBeGreaterThan(300);
        orbitPoint(500, 300, 300, 300, 100, -1, 0.5, out);
        expect(out.y).toBeLessThan(300);
        // From inside the circle it still lands on the circle.
        expect(orbitPoint(310, 300, 300, 300, 100, 1, 0.7, out)).toBe(out);
        expect(Math.hypot(out.x - 300, out.y - 300)).toBeCloseTo(100);

        expect(distanceToSegment(5, 3, 0, 0, 10, 0)).toBeCloseTo(3);
        expect(distanceToSegment(-4, 3, 0, 0, 10, 0)).toBeCloseTo(5);
        expect(distanceToSegment(14, 3, 0, 0, 10, 0)).toBeCloseTo(5);
        expect(distanceToSegment(5, 0, 0, 0, 10, 0)).toBe(0);
    });
});
