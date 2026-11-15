import { describe, expect, test } from 'bun:test';
import { Border, makeBorderPoint } from '../effects/Fuse/border';

/** Signed distance from (x, y) to the rounded rectangle [l, l+w] x [t, t+h] with corner radius r. */
function sdf(x: number, y: number, l: number, t: number, w: number, h: number, r: number): number {
    const qx = Math.abs(x - (l + w / 2)) - (w / 2 - r);
    const qy = Math.abs(y - (t + h / 2)) - (h / 2 - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function analytic(width: number, height: number, radius: number, inset: number): number {
    const w = width - 2 * inset;
    const h = height - 2 * inset;
    const r = Math.max(0, Math.min(radius - inset, w / 2, h / 2));
    return 2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * Math.PI * r;
}

const SHAPES: [number, number, number][] = [
    [60, 28, 14], // a switch: a pill
    [216, 40, 8],
    [110, 38, 10],
    [222, 98, 0], // a rectangle
    [40, 40, 20], // a circle
];

describe('Border', () => {
    test('length equals the analytic perimeter', () => {
        for (const [w, h, r] of SHAPES) {
            expect(new Border(w, h, r, 2.5).length).toBeCloseTo(analytic(w, h, r, 2.5), 6);
        }
    });

    test('every point lies on the inset rounded rectangle', () => {
        const p = makeBorderPoint();
        for (const [w, h, r] of SHAPES) {
            const border = new Border(w, h, r, 2.5);
            const pr = Math.min(Math.max(0, r - 2.5), (w - 5) / 2, (h - 5) / 2);
            for (let i = 0; i <= 400; i++) {
                border.pointAt((i / 400) * border.length, p);
                expect(Math.abs(sdf(p.x, p.y, 2.5, 2.5, w - 5, h - 5, pr))).toBeLessThan(1e-6);
            }
        }
    });

    test('starts at the middle of the left side and runs clockwise', () => {
        const border = new Border(100, 40, 8, 2.5);
        const p = makeBorderPoint();
        border.pointAt(0, p);
        expect(p.x).toBeCloseTo(2.5);
        expect(p.y).toBeCloseTo(20);
        // The first stretch goes up the left side, then along the top to the right.
        border.pointAt(5, p);
        expect(p.y).toBeCloseTo(15);
        border.pointAt(border.length * 0.25, p);
        expect(p.y).toBeCloseTo(2.5, 5);
        expect(p.x).toBeGreaterThan(30);
        expect(p.x).toBeLessThan(70);
    });

    test('distances wrap', () => {
        const border = new Border(216, 40, 8);
        const a = makeBorderPoint();
        const b = makeBorderPoint();
        for (const d of [0, 13.7, 100, 333.3]) {
            border.pointAt(d, a);
            border.pointAt(d + border.length, b);
            expect(b.x).toBeCloseTo(a.x, 6);
            expect(b.y).toBeCloseTo(a.y, 6);
            border.pointAt(d - 3 * border.length, b);
            expect(b.x).toBeCloseTo(a.x, 5);
            expect(b.y).toBeCloseTo(a.y, 5);
        }
        border.pointAt(-1, a);
        border.pointAt(border.length - 1, b);
        expect(a.x).toBeCloseTo(b.x, 6);
        expect(a.y).toBeCloseTo(b.y, 6);
    });

    test('the path is continuous: neighbouring samples are one step apart', () => {
        const p = makeBorderPoint();
        const q = makeBorderPoint();
        for (const [w, h, r] of SHAPES) {
            const border = new Border(w, h, r);
            for (let d = 0; d < border.length; d += 0.5) {
                border.pointAt(d, p);
                border.pointAt(d + 0.5, q);
                expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeLessThan(0.5 + 1e-6);
            }
        }
    });

    test('normals and tangents are unit length, normals point outward, tangents go with the path', () => {
        const p = makeBorderPoint();
        const q = makeBorderPoint();
        for (const [w, h, r] of SHAPES) {
            const border = new Border(w, h, r);
            for (let i = 0; i < 300; i++) {
                const d = (i / 300) * border.length + 0.01;
                border.pointAt(d, p);
                expect(Math.hypot(p.nx, p.ny)).toBeCloseTo(1, 9);
                expect(Math.hypot(p.tx, p.ty)).toBeCloseTo(1, 9);
                expect(p.nx * p.tx + p.ny * p.ty).toBeCloseTo(0, 9);
                // A step outward along the normal leaves the shape; one inward stays inside.
                const pr = Math.min(Math.max(0, r - 2.5), (w - 5) / 2, (h - 5) / 2);
                expect(sdf(p.x + p.nx * 0.5, p.y + p.ny * 0.5, 2.5, 2.5, w - 5, h - 5, pr)).toBeGreaterThan(0);
                expect(sdf(p.x - p.nx * 0.5, p.y - p.ny * 0.5, 2.5, 2.5, w - 5, h - 5, pr)).toBeLessThan(0);
                // The tangent is the direction of travel.
                border.pointAt(d + 0.01, q);
                expect((q.x - p.x) * p.tx + (q.y - p.y) * p.ty).toBeGreaterThan(0.0099);
            }
        }
    });

    test('a pill and a rectangle both work', () => {
        const pill = new Border(60, 28, 14, 2.5);
        // Radius 11.5 on a 23 px high path: two 25 px runs and a full circle.
        expect(pill.length).toBeCloseTo(2 * (55 - 23) + 2 * Math.PI * 11.5, 6);
        const box = new Border(100, 50, 0, 2.5);
        expect(box.length).toBeCloseTo(2 * 95 + 2 * 45, 6);
        const p = makeBorderPoint();
        box.pointAt(box.length * 0.25 + 0.0001, p);
        expect(Math.abs(p.nx) + Math.abs(p.ny)).toBeCloseTo(1, 6);
    });

    test('a radius larger than the shape allows is clamped; nonsense does not throw', () => {
        const huge = new Border(60, 28, 500);
        expect(huge.length).toBeCloseTo(analytic(60, 28, 14 + 2.5, 2.5), 6);
        const p = makeBorderPoint();
        for (const b of [new Border(0, 0, 0), new Border(3, 3, 0), new Border(Number.NaN, 10, 4)]) {
            b.pointAt(1.5, p);
            expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        }
    });

    test('nearest finds the distance of the closest point', () => {
        const border = new Border(100, 40, 8, 2.5);
        const p = makeBorderPoint();
        // Beside the middle of the right side.
        const d = border.nearest(100, 20, 1);
        border.pointAt(d, p);
        expect(p.x).toBeCloseTo(97.5, 0);
        expect(Math.abs(p.y - 20)).toBeLessThan(1.5);
    });
});
