import { describe, expect, test } from 'bun:test';
import {
    BladeRow,
    bladeIndices,
    LINE_WIDTH,
    MAX_LEAN,
    regrown,
    riseAt,
    shareAtRise,
    STUBBLE,
    VERTS_PER_BLADE,
    writeBlade,
    writeLine,
} from '../effects/Meadow/BladeRow';

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

    test('a cut leaves the share asked for, waits, then climbs back at its speed', () => {
        const row = new BladeRow('floor', 100, 30, 46, seeded(5));
        // Cut to half at 1 s, wait 6 s, then a ten-thousandth of its length per ms: the missing half takes 5 s.
        expect(row.cut(0, 0.5, 1000, 6000, 0.0001)).toBe(true);
        row.grow(1000);
        expect(row.growth[0]).toBeCloseTo(0.5);
        row.grow(6999);
        expect(row.growth[0]).toBeCloseTo(0.5);
        row.grow(9500);
        expect(row.growth[0]).toBeCloseTo(0.75);
        expect(row.shownHeight(0)).toBeCloseTo(row.height[0] * riseAt(0.75), 3);
        row.grow(12000);
        expect(row.growth[0]).toBe(1);
        // Its neighbour was never cut.
        expect(row.growth[1]).toBe(1);
        expect(row.scorch[0]).toBe(0);
    });

    test('a cut never lengthens a blade, goes no lower than stubble, and a missed cut leaves the wait alone', () => {
        const row = new BladeRow('floor', 100, 30, 46, seeded(5));
        row.cut(0, 0.4, 0, 5000, 0.001);
        // Above where the blade ends now: nothing happens, and it is not made to wait again.
        expect(row.cut(0, 0.6, 3000, 5000, 0.001)).toBe(false);
        expect(row.cut(0, 0.4, 3000, 5000, 0.001)).toBe(false);
        expect(row.regrowAt[0]).toBe(5000);
        expect(row.cut(0, 0.01, 3000, 5000, 0.001)).toBe(true);
        expect(row.growthAt(0, 3000)).toBeCloseTo(STUBBLE);
        expect(row.regrowAt[0]).toBe(8000);
        // Once it has grown back past the height, the same cut takes again.
        expect(row.cut(0, 0.4, 60000, 5000, 0.001)).toBe(true);
    });

    test('a scorching cut burns the blade until it has grown back, and takes even on stubble', () => {
        const row = new BladeRow('floor', 100, 30, 46, seeded(5));
        const speed = (1 - STUBBLE) / 4000;
        row.cut(0, STUBBLE, 1000, 5000, speed, true);
        row.grow(1000);
        expect(row.growth[0]).toBeCloseTo(STUBBLE);
        expect(row.scorch[0]).toBeCloseTo(1);
        row.grow(5999);
        expect(row.scorch[0]).toBeCloseTo(1);
        row.grow(8000);
        expect(row.scorch[0]).toBeCloseTo(0.5);
        row.grow(20000);
        expect(row.growth[0]).toBe(1);
        expect(row.scorch[0]).toBe(0);
        expect(row.scorched[0]).toBe(0);

        row.cut(0, STUBBLE, 30000, 5000, speed, true);
        expect(row.cut(0, STUBBLE, 31000, 5000, speed)).toBe(false);
        expect(row.cut(0, STUBBLE, 31000, 5000, speed, true)).toBe(true);
        expect(row.regrowAt[0]).toBe(36000);
    });

    test('regrowth is the cut share while it waits, eased after, and whole at the end', () => {
        expect(regrown(0.3, -4000, 1000)).toBe(0.3);
        expect(regrown(0.3, 0, 1000)).toBe(0.3);
        expect(regrown(0.3, 500, 1000)).toBeCloseTo(0.65);
        expect(regrown(0.3, 1000, 1000)).toBe(1);
        // A blade that was never cut: whole, whatever the time.
        expect(regrown(1, Infinity, 1)).toBe(1);
    });

    test('riseAt and shareAtRise undo each other', () => {
        expect(riseAt(0)).toBe(0);
        expect(riseAt(1)).toBeCloseTo(1);
        for (const t of [STUBBLE, 0.3, 0.5, 0.8, 1]) {
            expect(shareAtRise(riseAt(t))).toBeCloseTo(t);
        }
        expect(shareAtRise(-1)).toBe(0);
        expect(shareAtRise(2)).toBeCloseTo(1);
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

    test('a cut blade is the lower part of the same curve and ends in a flat top', () => {
        const whole = new Float32Array(VERTS_PER_BLADE * 2);
        const cut = new Float32Array(VERTS_PER_BLADE * 2);
        writeBlade(whole, 0, 50, 40, 4, 12);
        writeBlade(cut, 0, 50, 40, 4, 12, 0.5);
        const n = whole.length;
        // The same root.
        expect(cut[0]).toBeCloseTo(whole[0]);
        expect(cut[1]).toBeCloseTo(whole[1]);
        // It ends as high as the whole blade is half-way along, and a quarter of the way sideways.
        const tipY = (whole[n - 3] + whole[n - 1]) / 2;
        expect((cut[n - 3] + cut[n - 1]) / 2).toBeCloseTo(tipY * riseAt(0.5));
        expect((cut[n - 4] + cut[n - 2]) / 2).toBeCloseTo(50 + 0.25 * 12);
        // The whole blade comes to a point; the cut one ends as wide as the blade is there.
        const width = (out: Float32Array): number => Math.hypot(out[n - 2] - out[n - 4], out[n - 1] - out[n - 3]);
        expect(width(cut)).toBeGreaterThan(2);
        expect(width(whole)).toBeLessThanOrEqual(1.01);
    });

    test('a line blade is straight, even and as tall as a curved one', () => {
        const out = new Float32Array(VERTS_PER_BLADE * 2);
        writeLine(out, 0, 50, 40, 0);
        expect(out[1]).toBeCloseTo(0);
        expect(out[out.length - 1]).toBeCloseTo(-40);
        expect(out[2] - out[0]).toBeCloseTo(LINE_WIDTH);
        expect(out[out.length - 2] - out[out.length - 4]).toBeCloseTo(LINE_WIDTH);
        writeLine(out, 0, 50, 40, 20);
        // Every centre point lies on the line from root to tip.
        const tipX = (out[out.length - 2] + out[out.length - 4]) / 2;
        const tipY = (out[out.length - 1] + out[out.length - 3]) / 2;
        expect(tipX).toBeCloseTo(70);
        for (let j = 0; j < VERTS_PER_BLADE; j += 2) {
            const cx = (out[j * 2] + out[j * 2 + 2]) / 2 - 50;
            const cy = (out[j * 2 + 1] + out[j * 2 + 3]) / 2;
            expect(cx * tipY - cy * (tipX - 50)).toBeCloseTo(0);
        }
    });

    test('indices stay inside the blades they draw', () => {
        const indices = bladeIndices([2, 0, 1]);
        expect(indices.length).toBe(3 * 24);
        expect(Math.max(...indices)).toBe(3 * VERTS_PER_BLADE - 1);
        expect(indices[0]).toBe(2 * VERTS_PER_BLADE);
    });
});
