/**
 * The crackle of an arc: a number from -1 to 1 for a seed, a moment and a place along the arc.
 * The same three numbers always give the same answer, so a frame drawn twice is the same
 * picture, and the next moment gives a different shape. No state, no renderer.
 */
export function jag(seed: number, moment: number, index: number): number {
    let h = (Math.imul(Math.floor(seed * 16) | 0, 0x9e3779b1) ^ Math.imul(moment | 0, 0x85ebca6b) ^ Math.imul((index + 1) | 0, 0xc2b2ae35)) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d) >>> 0;
    h ^= h >>> 12;
    h = Math.imul(h, 0x297a2d39) >>> 0;
    h ^= h >>> 15;
    return (h >>> 0) / 2147483648 - 1;
}
