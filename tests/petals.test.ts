import { describe, expect, test } from 'bun:test';
import { layoutVine, MAX_BLOSSOMS, seededRandom, vineSeed, type Vine } from '../effects/Petals/vine';

// The sample inputs: a switch's free part, a button, a slider bar, a text field, a pad.
const SIZES: [number, number, number][] = [
    [32, 28, 14],
    [110, 38, 19],
    [182, 20, 10],
    [216, 40, 10],
    [222, 98, 12],
];

function vineFor(w: number, h: number, r: number, name = 'petals-x', blossoms = 1): Vine {
    return layoutVine(w, h, r, seededRandom(vineSeed(name, w, h)), blossoms);
}

describe('layoutVine', () => {
    test('the same seed lays out the same vine', () => {
        for (const [w, h, r] of SIZES) {
            const a = vineFor(w, h, r);
            const b = vineFor(w, h, r);
            expect(JSON.stringify(b.nodes)).toBe(JSON.stringify(a.nodes));
            expect(Array.from(b.stems[0].x)).toEqual(Array.from(a.stems[0].x));
        }
        const other = vineFor(216, 40, 10, 'petals-y');
        expect(JSON.stringify(other.nodes)).not.toBe(JSON.stringify(vineFor(216, 40, 10).nodes));
    });

    test('every point, node and blossom is inside the element', () => {
        for (const [w, h, r] of SIZES) {
            const vine = vineFor(w, h, r);
            for (const stem of vine.stems) {
                for (let i = 0; i < stem.x.length; i++) {
                    expect(stem.x[i]).toBeGreaterThanOrEqual(0);
                    expect(stem.x[i]).toBeLessThanOrEqual(w);
                    expect(stem.y[i]).toBeGreaterThanOrEqual(0);
                    expect(stem.y[i]).toBeLessThanOrEqual(h);
                }
            }
            for (const node of vine.nodes) {
                for (const [x, y] of [[node.x, node.y], [node.cx, node.cy]]) {
                    expect(x).toBeGreaterThanOrEqual(0);
                    expect(x).toBeLessThanOrEqual(w);
                    expect(y).toBeGreaterThanOrEqual(0);
                    expect(y).toBeLessThanOrEqual(h);
                }
                if (node.blossom) {
                    expect(node.cx - node.size / 2).toBeGreaterThanOrEqual(0);
                    expect(node.cx + node.size / 2).toBeLessThanOrEqual(w);
                    expect(node.cy - node.size / 2).toBeGreaterThanOrEqual(0);
                    expect(node.cy + node.size / 2).toBeLessThanOrEqual(h);
                }
            }
        }
    });

    test('the stem hugs the bottom edge outside a tall element', () => {
        const vine = vineFor(216, 40, 10);
        const stem = vine.stems[0];
        for (let i = 0; i < stem.y.length; i++) {
            expect(stem.y[i]).toBeGreaterThan(40 * 0.5);
        }
    });

    test('positions along each stem increase, and nodes are sorted by them', () => {
        for (const [w, h, r] of SIZES) {
            const vine = vineFor(w, h, r);
            for (const stem of vine.stems) {
                for (let i = 1; i < stem.s.length; i++) {
                    expect(stem.s[i]).toBeGreaterThan(stem.s[i - 1]);
                }
                expect(stem.s[0]).toBeGreaterThanOrEqual(0);
                expect(stem.s[stem.s.length - 1]).toBeLessThanOrEqual(1);
            }
            expect(vine.stems[0].s[0]).toBe(0);
            for (let i = 1; i < vine.nodes.length; i++) {
                const a = vine.nodes[i - 1];
                const b = vine.nodes[i];
                if (a.stem === b.stem) {
                    expect(b.s).toBeGreaterThanOrEqual(a.s);
                }
            }
        }
    });

    test('counts are bounded and grow with the width', () => {
        const counts = SIZES.map(([w, h, r]) => vineFor(w, h, r));
        for (const vine of counts) {
            expect(vine.blossoms).toBeGreaterThanOrEqual(1);
            expect(vine.blossoms).toBeLessThanOrEqual(MAX_BLOSSOMS);
            expect(vine.nodes.length).toBeLessThan(80);
        }
        const sw = counts[0];
        const text = counts[3];
        expect(sw.blossoms).toBe(2);
        expect(text.blossoms).toBeGreaterThanOrEqual(6);
        expect(text.nodes.length).toBeGreaterThan(sw.nodes.length * 3);
        expect(vineFor(400, 40, 10).nodes.length).toBeGreaterThan(text.nodes.length);
    });

    test('a tall element gets side shoots; blossoms 0 gives leaves only; nonsense gives nothing', () => {
        expect(vineFor(222, 98, 12).stems.length).toBe(3);
        expect(vineFor(216, 40, 10).stems.length).toBe(1);
        const bare = vineFor(216, 40, 10, 'petals-x', 0);
        expect(bare.blossoms).toBe(0);
        expect(bare.nodes.length).toBeGreaterThan(10);
        expect(vineFor(Number.NaN, 40, 10).stems.length).toBe(0);
        expect(vineFor(0, 0, 0).nodes.length).toBe(0);
        expect(vineFor(60, 28, Number.NaN).stems.length).toBe(1);
    });
});
