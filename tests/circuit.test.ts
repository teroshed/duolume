import { describe, expect, test } from 'bun:test';
import { GRID, hashSeed, makeRandom, nearestOnBoard, pointAt, routeBoard, type Board } from '../effects/Circuit/route';

const SIZES: ReadonlyArray<[string, number, number, number, 'open' | 'edges', number]> = [
    ['switch', 60, 28, 14, 'open', 3],
    ['bar', 182, 20, 10, 'open', 2],
    ['text', 216, 40, 8, 'edges', 2],
    ['button', 110, 38, 19, 'edges', 2],
    ['pad', 222, 98, 12, 'open', 8],
];

function board(name: string, w: number, h: number, r: number, mode: 'open' | 'edges', count: number, seed = hashSeed(name, w, h)): Board {
    return routeBoard({ width: w, height: h, radius: r, random: makeRandom(seed), count, mode });
}

describe('routeBoard', () => {
    test('the same name and size give the same board', () => {
        for (const [n, w, h, r, m, c] of SIZES) {
            expect(board(n, w, h, r, m, c)).toEqual(board(n, w, h, r, m, c));
        }
        expect(board('a', 222, 98, 12, 'open', 8)).not.toEqual(board('b', 222, 98, 12, 'open', 8));
    });

    test('every size gets traces, a pad has more than a switch', () => {
        for (const [n, w, h, r, m, c] of SIZES) {
            expect(board(n, w, h, r, m, c).roots).toBeGreaterThan(0);
        }
        expect(board('p', 222, 98, 12, 'open', 8).roots).toBeGreaterThanOrEqual(5);
    });

    test('every point is inside the element and on the grid', () => {
        for (let seed = 1; seed < 30; seed++) {
            for (const [, w, h, r, m, c] of SIZES) {
                const b = board('x', w, h, r, m, c, seed);
                for (const t of b.traces) {
                    for (let i = 0; i < t.xy.length; i += 2) {
                        const x = t.xy[i];
                        const y = t.xy[i + 1];
                        expect(x).toBeGreaterThanOrEqual(0);
                        expect(x).toBeLessThanOrEqual(w);
                        expect(y).toBeGreaterThanOrEqual(0);
                        expect(y).toBeLessThanOrEqual(h);
                        expect((x - b.originX) % GRID).toBe(0);
                        expect((y - b.originY) % GRID).toBe(0);
                    }
                }
            }
        }
    });

    test('segments are horizontal, vertical or 45 degrees', () => {
        for (let seed = 1; seed < 30; seed++) {
            for (const [, w, h, r, m, c] of SIZES) {
                for (const t of board('x', w, h, r, m, c, seed).traces) {
                    for (let i = 0; i + 3 < t.xy.length; i += 2) {
                        const dx = Math.abs(t.xy[i + 2] - t.xy[i]);
                        const dy = Math.abs(t.xy[i + 3] - t.xy[i + 1]);
                        expect(dx === 0 || dy === 0 || dx === dy).toBe(true);
                        expect(dx + dy).toBeGreaterThan(0);
                    }
                }
            }
        }
    });

    test('traces of different families never share a grid cell', () => {
        for (let seed = 1; seed < 40; seed++) {
            for (const [, w, h, r, m, c] of SIZES) {
                const b = board('x', w, h, r, m, c, seed);
                const owner = new Map<string, number>();
                for (const t of b.traces) {
                    for (let i = 0; i + 3 < t.xy.length; i += 2) {
                        const steps = Math.max(Math.abs(t.xy[i + 2] - t.xy[i]), Math.abs(t.xy[i + 3] - t.xy[i + 1])) / GRID;
                        for (let s = 0; s <= steps; s++) {
                            const x = t.xy[i] + ((t.xy[i + 2] - t.xy[i]) * s) / steps;
                            const y = t.xy[i + 1] + ((t.xy[i + 3] - t.xy[i + 1]) * s) / steps;
                            const key = `${x},${y}`;
                            const seen = owner.get(key);
                            if (seen !== undefined) {
                                expect(seen).toBe(t.family);
                            }
                            owner.set(key, t.family);
                        }
                    }
                }
            }
        }
    });

    test('lengths are consistent and nodes lie on their trace', () => {
        for (let seed = 1; seed < 20; seed++) {
            for (const [, w, h, r, m, c] of SIZES) {
                const b = board('x', w, h, r, m, c, seed);
                const p = { x: 0, y: 0 };
                for (const t of b.traces) {
                    let sum = 0;
                    for (let i = 0; i + 3 < t.xy.length; i += 2) {
                        sum += Math.hypot(t.xy[i + 2] - t.xy[i], t.xy[i + 3] - t.xy[i + 1]);
                        expect(t.cum[i / 2 + 1]).toBeCloseTo(sum, 6);
                    }
                    expect(t.length).toBeCloseTo(sum, 6);
                    pointAt(t, t.length, p);
                    expect(p.x).toBe(t.xy[t.xy.length - 2]);
                    expect(p.y).toBe(t.xy[t.xy.length - 1]);
                    pointAt(t, -5, p);
                    expect(p.x).toBe(t.xy[0]);
                    for (const n of t.nodes) {
                        pointAt(t, n.dist, p);
                        expect(p.x).toBeCloseTo(n.x, 6);
                        expect(p.y).toBeCloseTo(n.y, 6);
                    }
                    for (let i = 1; i < t.nodes.length; i++) {
                        expect(t.nodes[i].dist).toBeGreaterThanOrEqual(t.nodes[i - 1].dist);
                    }
                    t.splitAt.forEach((at, k) => {
                        const child = b.traces[t.splitTo[k]];
                        pointAt(t, at, p);
                        expect(p.x).toBeCloseTo(child.xy[0], 6);
                        expect(p.y).toBeCloseTo(child.xy[1], 6);
                        expect(child.parent).toBe(b.traces.indexOf(t));
                    });
                }
            }
        }
    });

    test('in edges mode the middle band stays clear', () => {
        for (let seed = 1; seed < 20; seed++) {
            const b = board('x', 216, 40, 8, 'edges', 4, seed);
            for (const t of b.traces) {
                for (let i = 1; i < t.xy.length; i += 2) {
                    expect(Math.abs(t.xy[i] - 20)).toBeGreaterThanOrEqual(10);
                }
            }
        }
    });

    test('degenerate sizes give an empty board and do not throw', () => {
        for (const [w, h] of [[0, 0], [3, 3], [10, 100], [-4, 20], [Number.NaN, 20]]) {
            expect(routeBoard({ width: w, height: h, radius: 4, random: makeRandom(1), count: 3 }).traces.length).toBe(0);
        }
    });

    test('nearestOnBoard finds the closest trace point', () => {
        const b = board('x', 222, 98, 12, 'open', 8);
        const t = b.traces[0];
        const out = { trace: -1, dist: 0, x: 0, y: 0, d2: 0 };
        expect(nearestOnBoard(b, t.xy[0], t.xy[1], out)).toBe(true);
        expect(out.d2).toBe(0);
        expect(b.traces[out.trace].family).toBe(t.family);
    });
});
