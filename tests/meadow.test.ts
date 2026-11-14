import { describe, expect, test } from 'bun:test';
import { BladeRow, bladeIndices, MAX_LEAN, regrowth, STUBBLE, VERTS_PER_BLADE, writeBlade } from '../effects/Meadow/BladeRow';

function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Lean of blade 0 after `ms` of a steady acceleration. */
function settle(row: BladeRow, accel: number, ms: number): number {
    for (let t = 0; t < ms; t += 1000 / 60) {
        row.spring(0, accel, 1000 / 60);
    }
    return row.lean[0];
}

describe('BladeRow', () => {
    test('about `density` blades per 100 px, sorted by x, inside the row', () => {
        const row = new BladeRow('floor', 1000, 36, 46, seeded(1));
        expect(row.count).toBeGreaterThan(300);
        expect(row.count).toBeLessThan(420);
        for (let i = 1; i < row.count; i++) {
            expect(row.rx[i]).toBeGreaterThan(row.rx[i - 1]);
        }
        expect(row.rx[row.count - 1]).toBeLessThan(1000);
        expect(new BladeRow('none', 1000, 0, 46).count).toBe(0);
    });

    test('nearest and lowerBound agree with a linear scan', () => {
        const row = new BladeRow('floor', 600, 30, 46, seeded(2));
        for (const x of [-10, 0, 3.3, 151.7, 299, 598, 700]) {
            let best = 0;
            for (let i = 1; i < row.count; i++) {
                if (Math.abs(row.rx[i] - x) < Math.abs(row.rx[best] - x)) {
                    best = i;
                }
            }
            expect(Math.abs(row.rx[row.nearest(x)] - x)).toBeCloseTo(Math.abs(row.rx[best] - x));
            const lb = row.lowerBound(x);
            expect(lb === row.count || row.rx[lb] >= x).toBe(true);
            expect(lb === 0 || row.rx[lb - 1] < x).toBe(true);
        }
    });

    test('the natural gust leans a blade a clearly visible share of its height, and it springs back', () => {
        const row = new BladeRow('one', 10, 10, 46, seeded(3));
        const h = row.height[0];
        const lean = BladeRow.bend(settle(row, 0.00016, 6000), h) / h;
        expect(lean).toBeGreaterThan(0.12);
        expect(lean).toBeLessThan(0.4);
        expect(Math.abs(settle(row, 0, 8000))).toBeLessThan(0.05 * h);
    });

    test('a hard push lays it well over but never past the clamp', () => {
        const row = new BladeRow('one', 10, 10, 46, seeded(4));
        const h = row.height[0];
        const lean = BladeRow.bend(settle(row, 0.0011, 6000), h) / h;
        expect(lean).toBeGreaterThan(0.6);
        expect(lean).toBeLessThanOrEqual(MAX_LEAN);
        expect(BladeRow.bend(-1e6, h)).toBeGreaterThanOrEqual(-MAX_LEAN * h);
    });

    test('a cut blade is stubble, then grows back over the regrow time', () => {
        expect(regrowth(0, 9000)).toBeCloseTo(STUBBLE);
        expect(regrowth(4500, 9000)).toBeGreaterThan(0.5);
        expect(regrowth(9000, 9000)).toBe(1);
        expect(regrowth(Infinity, 9000)).toBe(1);
        const row = new BladeRow('floor', 100, 30, 46, seeded(5));
        row.cutAt[0] = 1000;
        row.scorchAt[0] = 1000;
        row.grow(1000, 9000);
        expect(row.growth[0]).toBeCloseTo(STUBBLE);
        expect(row.scorch[0]).toBe(1);
        expect(row.growth[1]).toBe(1);
        row.grow(20000, 9000);
        expect(row.growth[0]).toBe(1);
        expect(row.scorch[0]).toBe(0);
    });
});

describe('blade geometry', () => {
    test('root on the line, tip at the full height when upright, lower when leaning', () => {
        const out = new Float32Array(VERTS_PER_BLADE * 2);
        writeBlade(out, 0, 50, 40, 4, 0);
        expect(out[0]).toBeCloseTo(48);
        expect(out[2]).toBeCloseTo(52);
        expect(out[1]).toBeCloseTo(0);
        expect(out[out.length - 1]).toBeCloseTo(-40);
        writeBlade(out, 0, 50, 40, 4, 30);
        expect(out[out.length - 1]).toBeGreaterThan(-40);
        expect((out[out.length - 2] + out[out.length - 4]) / 2).toBeCloseTo(80);
    });

    test('indices stay inside the blades they draw', () => {
        const indices = bladeIndices([2, 0, 1]);
        expect(indices.length).toBe(3 * 24);
        expect(Math.max(...indices)).toBe(3 * VERTS_PER_BLADE - 1);
        expect(indices[0]).toBe(2 * VERTS_PER_BLADE);
    });
});
