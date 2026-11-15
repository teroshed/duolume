/**
 * The ice of one element, grown once: fern-like dendrites that start on the element's border
 * and head inward. Pure (no pixi, no three), so it can be tested.
 *
 * Every dendrite is a main stem (level 0) that curves slightly as it grows, with pairs of side
 * branches (level 1) at 60° that get shorter toward the tip, and pairs of twigs (level 2) on the
 * longer branches. Every segment knows how far along its dendrite it starts and ends, as `reach`
 * normalised 0..1 over the element: drawing the segments whose reach is below a coverage makes the
 * ice creep in from the edges as the coverage grows, and retreat toward them as it falls.
 *
 * Positions are the element's own pixels, origin at its top-left corner.
 */
export interface Dendrites {
    width: number;
    height: number;
    /** Segments in use. */
    count: number;
    x1: Float32Array;
    y1: Float32Array;
    x2: Float32Array;
    y2: Float32Array;
    /** Reach at the segment's start and end, 0..1; `reach1 >= reach0`, and a segment starts where its parent's reach is. */
    reach0: Float32Array;
    reach1: Float32Array;
    /** 0 stem, 1 branch, 2 twig. */
    level: Uint8Array;
    /** Static glints in the ice: position, the reach at which the ice covers them, a twinkle phase. */
    sparkles: number;
    sx: Float32Array;
    sy: Float32Array;
    sreach: Float32Array;
    sphase: Float32Array;
}

/** Side branches leave their stem, and twigs their branch, at this angle. */
export const BRANCH_ANGLE = Math.PI / 3;
/** Fewest and most segments one element gets. */
export const MIN_SEGMENTS = 60;
export const MAX_SEGMENTS = 480;
/** Segments per pixel of perimeter, before the bounds above. */
const SEGMENTS_PER_PX = 0.72;
/** How far inside the border everything stays (the element's clip is one pixel in). */
const MARGIN = 1;

/** A small seeded generator, 0 ≤ x < 1. */
export function seededRandom(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A seed from an element's name and size, so the same element always grows the same ice. */
export function iceSeed(name: string, width: number, height: number): number {
    let h = 2166136261;
    const text = `${name}|${Math.round(width)}x${Math.round(height)}`;
    for (let i = 0; i < text.length; i++) {
        h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    }
    return h >>> 0;
}

/** True when (x, y) lies inside the rounded rectangle, at least `margin` from its edge. */
export function insideRounded(x: number, y: number, width: number, height: number, radius: number, margin: number): boolean {
    if (x < margin || y < margin || x > width - margin || y > height - margin) {
        return false;
    }
    const r = Math.max(0, radius - margin);
    const cx = Math.min(Math.max(x, radius), width - radius);
    const cy = Math.min(Math.max(y, radius), height - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r + 1e-6 || (dx === 0 && dy === 0);
}

/** The lowest point inside the rounded rectangle at column x (where water on its inside ends up). */
export function bottomAt(x: number, width: number, height: number, radius: number): number {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    const cx = Math.min(Math.max(x, r), width - r);
    const dx = Math.min(r, Math.abs(x - cx));
    return height - r + Math.sqrt(Math.max(0, r * r - dx * dx));
}

function empty(width: number, height: number): Dendrites {
    return {
        width,
        height,
        count: 0,
        x1: new Float32Array(0),
        y1: new Float32Array(0),
        x2: new Float32Array(0),
        y2: new Float32Array(0),
        reach0: new Float32Array(0),
        reach1: new Float32Array(0),
        level: new Uint8Array(0),
        sparkles: 0,
        sx: new Float32Array(0),
        sy: new Float32Array(0),
        sreach: new Float32Array(0),
        sphase: new Float32Array(0),
    };
}

/** A point on the border at distance `s` along it (clockwise from the top edge's left end), with the inward normal. */
function borderPoint(s: number, w: number, h: number, r: number, out: number[]): void {
    const top = w - 2 * r;
    const side = h - 2 * r;
    const arc = (Math.PI / 2) * r;
    const corner = (cx: number, cy: number, start: number, t: number): void => {
        const a = start + (t / Math.max(arc, 1e-6)) * (Math.PI / 2);
        out[0] = cx + Math.cos(a) * r;
        out[1] = cy + Math.sin(a) * r;
        out[2] = -Math.cos(a);
        out[3] = -Math.sin(a);
    };
    if (s < top) {
        out[0] = r + s; out[1] = 0; out[2] = 0; out[3] = 1;
        return;
    }
    s -= top;
    if (s < arc) return corner(w - r, r, -Math.PI / 2, s);
    s -= arc;
    if (s < side) {
        out[0] = w; out[1] = r + s; out[2] = -1; out[3] = 0;
        return;
    }
    s -= side;
    if (s < arc) return corner(w - r, h - r, 0, s);
    s -= arc;
    if (s < top) {
        out[0] = w - r - s; out[1] = h; out[2] = 0; out[3] = -1;
        return;
    }
    s -= top;
    if (s < arc) return corner(r, h - r, Math.PI / 2, s);
    s -= arc;
    if (s < side) {
        out[0] = 0; out[1] = h - r - s; out[2] = 1; out[3] = 0;
        return;
    }
    s -= side;
    corner(r, r, Math.PI, Math.min(s, arc));
}

/**
 * Grow the ice for an element of this size and corner radius. The same `random` sequence gives
 * the same ice. Sizes that are too small or not numbers give no ice.
 */
export function growDendrites(width: number, height: number, radius: number, random: () => number): Dendrites {
    const w = Number.isFinite(width) ? width : 0;
    const h = Number.isFinite(height) ? height : 0;
    if (w < 6 || h < 6) {
        return empty(Math.max(0, w), Math.max(0, h));
    }
    const r = Math.min(Math.max(Number.isFinite(radius) ? radius : 0, 0), w / 2, h / 2);
    const short = Math.min(w, h);
    const perimeter = 2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * Math.PI * r;
    const budget = Math.round(Math.min(MAX_SEGMENTS, Math.max(MIN_SEGMENTS, perimeter * SEGMENTS_PER_PX)));

    // Sizes from the short side: a switch gets fine ice, a pad longer fronds.
    const step = Math.min(5, Math.max(2.6, short * 0.11));
    const spacing = Math.min(20, Math.max(9, short * 0.4));
    const seeds = Math.max(4, Math.round(perimeter / spacing));
    const depth = short / 2;

    const X1: number[] = [];
    const Y1: number[] = [];
    const X2: number[] = [];
    const Y2: number[] = [];
    const R0: number[] = [];
    const R1: number[] = [];
    const L: number[] = [];
    // One dendrite at a time, kept only if it fits the budget.
    const dx1: number[] = [];
    const dy1: number[] = [];
    const dx2: number[] = [];
    const dy2: number[] = [];
    const dr0: number[] = [];
    const dr1: number[] = [];
    const dl: number[] = [];
    const inside = (x: number, y: number): boolean => insideRounded(x, y, w, h, r, MARGIN);
    const push = (ax: number, ay: number, bx: number, by: number, ra: number, rb: number, level: number): void => {
        dx1.push(ax); dy1.push(ay); dx2.push(bx); dy2.push(by); dr0.push(ra); dr1.push(rb); dl.push(level);
    };

    /** A straight-ish run of segments from (x, y); returns nothing, records segments. */
    const run = (x: number, y: number, heading: number, length: number, segment: number, curl: number, reach: number, level: number): void => {
        const n = Math.max(1, Math.round(length / segment));
        const seg = length / n;
        let a = heading;
        let travelled = 0;
        for (let i = 0; i < n; i++) {
            const nx = x + Math.cos(a) * seg;
            const ny = y + Math.sin(a) * seg;
            if (!inside(nx, ny)) {
                return;
            }
            push(x, y, nx, ny, reach + travelled, reach + travelled + seg, level);
            travelled += seg;
            x = nx;
            y = ny;
            const left = length - travelled;
            // Branch pairs at the joints, shorter toward the tip: on every joint of a short stem,
            // every other joint of a long one; twigs only near the base of a long branch.
            if (level < 2 && i < n - 1 && left > seg * 0.9) {
                const every = level === 0 ? (n > 4 ? 2 : 1) : n;
                if (i % every === 0) {
                    const childLength = level === 0 ? left * 0.62 + seg * 0.4 : left * 0.55;
                    if (childLength >= (level === 0 ? 1.6 : 1.8)) {
                        const childSegment = level === 0 ? Math.max(step * 1.3, childLength / 3) : childLength;
                        for (const side of [-1, 1]) {
                            run(x, y, a + side * BRANCH_ANGLE, childLength * (0.9 + random() * 0.2), childSegment, curl * 0.5, reach + travelled, level + 1);
                        }
                    }
                }
            }
            a += curl;
        }
    };

    const order: number[] = [];
    for (let i = 0; i < seeds; i++) order.push(i);
    // Interleaved, so a budget that runs out thins the ice evenly instead of leaving one side bare.
    order.sort((a, b) => ((a * 0.6180339887) % 1) - ((b * 0.6180339887) % 1));

    const point = [0, 0, 0, 0];
    const offset = perimeter * random();
    const maxStem = Math.min(depth, 30);
    for (const i of order) {
        const s = (offset + (i + 0.5 + (random() - 0.5) * 0.5) * (perimeter / seeds)) % perimeter;
        borderPoint(s, w, h, r, point);
        const x = point[0] + point[2] * (MARGIN + 0.6);
        const y = point[1] + point[3] * (MARGIN + 0.6);
        const heading = Math.atan2(point[3], point[2]) + (random() - 0.5) * 0.6;
        const length = maxStem * (0.55 + random() * 0.4);
        const curl = (random() < 0.5 ? -1 : 1) * (0.03 + random() * 0.07);
        const start = random() * 0.18 * maxStem;
        dx1.length = dy1.length = dx2.length = dy2.length = dr0.length = dr1.length = dl.length = 0;
        if (!inside(x, y)) {
            continue;
        }
        run(x, y, heading, length, step, curl, start, 0);
        if (X1.length + dx1.length > budget) {
            continue;
        }
        for (let k = 0; k < dx1.length; k++) {
            X1.push(dx1[k]); Y1.push(dy1[k]); X2.push(dx2[k]); Y2.push(dy2[k]); R0.push(dr0[k]); R1.push(dr1[k]); L.push(dl[k]);
        }
    }

    const out = empty(w, h);
    const count = X1.length;
    let far = 0;
    for (let k = 0; k < count; k++) far = Math.max(far, R1[k]);
    far = far || 1;
    out.count = count;
    out.x1 = Float32Array.from(X1);
    out.y1 = Float32Array.from(Y1);
    out.x2 = Float32Array.from(X2);
    out.y2 = Float32Array.from(Y2);
    out.reach0 = Float32Array.from(R0, (v) => Math.min(1, v / far));
    out.reach1 = Float32Array.from(R1, (v) => Math.min(1, v / far));
    out.level = Uint8Array.from(L);

    const sparkles = Math.round(Math.min(14, Math.max(3, (w * h) / 380)));
    out.sx = new Float32Array(sparkles);
    out.sy = new Float32Array(sparkles);
    out.sreach = new Float32Array(sparkles);
    out.sphase = new Float32Array(sparkles);
    let n = 0;
    for (let tries = 0; tries < sparkles * 6 && n < sparkles; tries++) {
        const x = Math.floor(random() * w) + 0.5;
        const y = Math.floor(random() * h) + 0.5;
        if (!insideRounded(x, y, w, h, r, MARGIN + 1.5)) {
            continue;
        }
        out.sx[n] = x;
        out.sy[n] = y;
        out.sreach[n] = 0.35 + random() * 0.6;
        out.sphase[n] = random() * Math.PI * 2;
        n++;
    }
    out.sparkles = n;
    return out;
}
