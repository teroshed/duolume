import { describe, expect, test } from 'bun:test';
import { fuseDelay, slideDirection, touch, type Box, type Contact } from '../effects/Bubbles/ledge';

const BOX: Box = { x: 100, y: 100, width: 200, height: 50 };

function contact(): Contact {
    return { nx: 0, ny: 0, depth: 0, x: 0, y: 0 };
}

describe('bubble ledge contact', () => {
    test('a bubble that does not reach the rectangle is left alone', () => {
        const out = { nx: 7, ny: 7, depth: 7, x: 7, y: 7 };
        expect(touch(200, 200, 40, BOX, out)).toBe(false); // 50 below, radius 40
        expect(touch(200, 190, 40, BOX, out)).toBe(false); // exactly touching is not overlap
        expect(touch(20, 20, 30, BOX, out)).toBe(false);
        // A miss does not write to the contact.
        expect(out).toEqual({ nx: 7, ny: 7, depth: 7, x: 7, y: 7 });
        expect(touch(200, 125, 0, BOX, out)).toBe(false); // no radius, nothing to overlap
    });

    test('from underneath: normal points down, depth is the overlap, contact is on the underside', () => {
        const out = contact();
        expect(touch(200, 170, 30, BOX, out)).toBe(true);
        expect(out.nx).toBeCloseTo(0);
        expect(out.ny).toBeCloseTo(1);
        expect(out.depth).toBeCloseTo(10);
        expect(out.x).toBe(200);
        expect(out.y).toBe(150);
    });

    test('from each side the normal points away from the element', () => {
        const out = contact();
        expect(touch(300 + 20, 125, 30, BOX, out)).toBe(true);
        expect(out.nx).toBeCloseTo(1);
        expect(out.ny).toBeCloseTo(0);
        expect(out.depth).toBeCloseTo(10);
        expect(touch(100 - 20, 125, 30, BOX, out)).toBe(true);
        expect(out.nx).toBeCloseTo(-1);
        expect(out.depth).toBeCloseTo(10);
        expect(touch(200, 100 - 20, 30, BOX, out)).toBe(true);
        expect(out.ny).toBeCloseTo(-1); // on top of it
        expect(out.depth).toBeCloseTo(10);
    });

    test('past a corner the push turns smoothly: along the diagonal, from the corner point', () => {
        const out = contact();
        // 12 left of and 16 below the bottom-left corner (100, 150): distance 20.
        expect(touch(88, 166, 25, BOX, out)).toBe(true);
        expect(out.nx).toBeCloseTo(-0.6);
        expect(out.ny).toBeCloseTo(0.8);
        expect(out.depth).toBeCloseTo(5);
        expect(out.x).toBe(100);
        expect(out.y).toBe(150);
        expect(Math.hypot(out.nx, out.ny)).toBeCloseTo(1);
    });

    test('pushing out along the normal by the depth leaves the bubble just touching, and the inward velocity is removable', () => {
        const out = contact();
        const cases: [number, number][] = [
            [200, 170],
            [310, 130],
            [92, 90],
            [200, 90],
        ];
        for (const [cx, cy] of cases) {
            expect(touch(cx, cy, 30, BOX, out)).toBe(true);
            const x = cx + out.nx * out.depth;
            const y = cy + out.ny * out.depth;
            // Nearest point on the rectangle is now exactly one radius away.
            const nearX = Math.min(Math.max(x, BOX.x), BOX.x + BOX.width);
            const nearY = Math.min(Math.max(y, BOX.y), BOX.y + BOX.height);
            expect(Math.hypot(x - nearX, y - nearY)).toBeCloseTo(30, 6);
            // A velocity heading into the element loses exactly its component along the normal.
            const vx = -out.nx * 3 + out.ny * 1;
            const vy = -out.ny * 3 - out.nx * 1;
            const into = vx * out.nx + vy * out.ny;
            expect(into).toBeLessThan(0);
            const ux = vx - into * out.nx;
            const uy = vy - into * out.ny;
            expect(ux * out.nx + uy * out.ny).toBeCloseTo(0, 9);
        }
    });

    test('a centre inside the element leaves by the nearest side, the underside first on a tie', () => {
        const out = contact();
        // 5 from the bottom, 45 from the top: out through the bottom, and the full radius beyond it.
        expect(touch(200, 145, 20, BOX, out)).toBe(true);
        expect(out.ny).toBe(1);
        expect(out.nx).toBe(0);
        expect(out.y).toBe(150);
        expect(out.depth).toBeCloseTo(25);
        expect(touch(200, 103, 20, BOX, out)).toBe(true);
        expect(out.ny).toBe(-1);
        expect(out.depth).toBeCloseTo(23);
        expect(touch(103, 125, 20, BOX, out)).toBe(true);
        expect(out.nx).toBe(-1);
        expect(touch(297, 125, 20, BOX, out)).toBe(true);
        expect(out.nx).toBe(1);
        // Dead centre of a square: every side ties, the underside wins.
        const square: Box = { x: 0, y: 0, width: 40, height: 40 };
        expect(touch(20, 20, 10, square, out)).toBe(true);
        expect(out.ny).toBe(1);
        expect(out.nx).toBe(0);
        // Centre exactly on the surface counts as overlap, and still has a unit normal.
        expect(touch(200, 150, 10, BOX, out)).toBe(true);
        expect(Math.hypot(out.nx, out.ny)).toBe(1);
    });

    test('degenerate rectangles and radii give finite answers', () => {
        const out = contact();
        const flat: Box = { x: 50, y: 50, width: 0, height: 0 };
        expect(touch(50, 50, 10, flat, out)).toBe(true);
        for (const v of [out.nx, out.ny, out.depth, out.x, out.y]) expect(Number.isFinite(v)).toBe(true);
        expect(Math.hypot(out.nx, out.ny)).toBe(1);
        expect(touch(50, 55, 10, flat, out)).toBe(true);
        expect(out.ny).toBeCloseTo(1);
        expect(out.depth).toBeCloseTo(5);
        const line: Box = { x: 0, y: 10, width: 100, height: 0 };
        expect(touch(40, 14, 6, line, out)).toBe(true);
        expect(out.ny).toBeCloseTo(1);
        expect(Number.isFinite(out.depth)).toBe(true);
    });

    test('slideDirection: downwind when clear, else keep going, else the nearer end; fuseDelay: nearest first, at most 250', () => {
        const box: Box = { x: 0, y: 0, width: 100, height: 20 };
        expect(slideDirection(10, box, 0.5, 0.1, -1)).toBe(1);
        expect(slideDirection(90, box, -0.5, 0.1, 1)).toBe(-1);
        expect(slideDirection(10, box, 0.05, 0.1, 1)).toBe(1);
        expect(slideDirection(10, box, 0.05, 0.1, -1)).toBe(-1);
        expect(slideDirection(10, box, 0, 0.1, 0)).toBe(-1);
        expect(slideDirection(90, box, 0, 0.1, 0)).toBe(1);

        expect(fuseDelay(0, 200, 0)).toBe(0);
        expect(fuseDelay(100, 200, 0)).toBeLessThan(fuseDelay(150, 200, 0));
        expect(fuseDelay(200, 200, 1)).toBeCloseTo(250);
        for (const [d, r, roll] of [
            [1e6, 200, 1],
            [-5, 200, 0.5],
            [10, 0, 0.5],
            [0, 0, 1],
        ] as const) {
            const f = fuseDelay(d, r, roll);
            expect(Number.isFinite(f)).toBe(true);
            expect(f).toBeGreaterThanOrEqual(0);
            expect(f).toBeLessThanOrEqual(250);
        }
    });

    // The radius is squared in the test for overlap, so a negative one has to be turned away first.
    test('a negative radius overlaps nothing', () => {
        expect(touch(40, 14, -6, { x: 0, y: 10, width: 100, height: 0 }, contact())).toBe(false);
    });

    // A bubble whose state went bad must not count as touching the page: that would emit page:hit.
    test('a NaN position is not a contact', () => {
        expect(touch(Number.NaN, 120, 20, BOX, contact())).toBe(false);
    });
});
