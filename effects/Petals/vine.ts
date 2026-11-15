/**
 * The layout of one vine inside a page element: pure numbers, no Pixi, so it can be tested.
 *
 * A stem runs along the bottom inside edge from the left end to the right, following the rounded
 * corner a little way up at each end, as a gently wavy line. Leaves sit at nodes along it,
 * alternating above (and, where there is room, below) the stem; a few nodes carry a blossom on a
 * short stalk instead. A tall element (height ≥ `TALL`) also gets a side shoot up its left side,
 * and the main stem carries on up the right side.
 *
 * Everything has a position `s` along the growth, 0..1: the vine is drawn as far as its growth,
 * and a node appears when the growth passes its `s`. Coordinates are the element's own pixels,
 * origin at its top-left corner.
 */

/** One stem: a polyline with the growth position of each point. `s` increases along it. */
export interface VineStem {
    x: Float32Array;
    y: Float32Array;
    s: Float32Array;
}

/** A leaf or a blossom where it joins a stem. */
export interface VineNode {
    /** Index into `Vine.stems`. */
    stem: number;
    /** Growth position, 0..1. */
    s: number;
    /** Where it joins the stem. */
    x: number;
    y: number;
    /** Which way a leaf points, or which way a blossom's stalk leans, in radians (y down). */
    angle: number;
    /** A leaf's length, or a blossom's diameter, in pixels. */
    size: number;
    blossom: boolean;
    /** A blossom's centre (the end of its stalk). Equal to x, y for a leaf. */
    cx: number;
    cy: number;
    /** Turn of the first petal, radians. */
    turn: number;
}

export interface Vine {
    width: number;
    height: number;
    stems: VineStem[];
    /** Sorted by `s` within each stem. */
    nodes: VineNode[];
    /** How many of `nodes` are blossoms. */
    blossoms: number;
}

/** Heights from this up count as tall: a side shoot climbs the left side. */
export const TALL = 64;
/** The most blossoms a vine carries. */
export const MAX_BLOSSOMS = 9;

/** A small seeded random generator (mulberry32): the same seed, the same sequence. */
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

/** A seed from an element's name and size. */
export function vineSeed(name: string, width: number, height: number): number {
    let h = 2166136261;
    for (let i = 0; i < name.length; i++) {
        h = Math.imul(h ^ name.charCodeAt(i), 16777619);
    }
    h = Math.imul(h ^ Math.round(width), 16777619);
    h = Math.imul(h ^ Math.round(height), 16777619);
    return h >>> 0;
}

interface Path {
    x: number[];
    y: number[];
    /** Unit normal pointing into the element (away from the nearest edge). */
    nx: number[];
    ny: number[];
    /** Arc length from the start. */
    len: number[];
}

function pushPoint(p: Path, x: number, y: number, nx: number, ny: number): void {
    const n = p.x.length;
    const len = n === 0 ? 0 : p.len[n - 1] + Math.hypot(x - p.x[n - 1], y - p.y[n - 1]);
    if (n > 0 && len - p.len[n - 1] < 0.01) {
        return;
    }
    p.x.push(x);
    p.y.push(y);
    p.nx.push(nx);
    p.ny.push(ny);
    p.len.push(len);
}

/** Sample a corner arc: centre (cx, cy), radius rr, from angle a0 to a1 (radians, y down, 0 = +x). */
function arc(p: Path, cx: number, cy: number, rr: number, a0: number, a1: number): void {
    const steps = Math.max(1, Math.ceil((Math.abs(a1 - a0) * rr) / 2));
    for (let i = 0; i <= steps; i++) {
        const a = a0 + ((a1 - a0) * i) / steps;
        const c = Math.cos(a);
        const s = Math.sin(a);
        pushPoint(p, cx + c * rr, cy + s * rr, -c, -s);
    }
}

function line(p: Path, x0: number, y0: number, x1: number, y1: number, nx: number, ny: number): void {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 2));
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        pushPoint(p, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, nx, ny);
    }
}

function emptyPath(): Path {
    return { x: [], y: [], nx: [], ny: [], len: [] };
}

/** The wavy stem along a path, with growth positions from s0 to s1. */
function toStem(p: Path, s0: number, s1: number, amp: number, wave: number, phase: number, width: number, height: number): VineStem {
    const n = p.x.length;
    const total = p.len[n - 1] || 1;
    const stem: VineStem = { x: new Float32Array(n), y: new Float32Array(n), s: new Float32Array(n) };
    for (let i = 0; i < n; i++) {
        // No wave at the very start, so the stem leaves the edge cleanly.
        const w = amp * Math.sin((p.len[i] / wave) * Math.PI * 2 + phase) * Math.min(1, p.len[i] / 4);
        stem.x[i] = clampTo(p.x[i] + p.nx[i] * w, 1, width - 1);
        stem.y[i] = clampTo(p.y[i] + p.ny[i] * w, 1, height - 1);
        stem.s[i] = s0 + ((s1 - s0) * p.len[i]) / total;
    }
    return stem;
}

function clampTo(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Lay out a vine for an element `width` × `height` with corner `radius`.
 * `blossoms` multiplies the number of blossoms (0: leaves only).
 */
export function layoutVine(width: number, height: number, radius: number, random: () => number, blossoms = 1): Vine {
    const w = Number.isFinite(width) ? Math.max(0, width) : 0;
    const h = Number.isFinite(height) ? Math.max(0, height) : 0;
    const vine: Vine = { width: w, height: h, stems: [], nodes: [], blossoms: 0 };
    if (w < 8 || h < 8) {
        return vine;
    }
    const r = clampTo(Number.isFinite(radius) ? radius : h / 2, 0, Math.min(w, h) / 2);
    const tall = h >= TALL;
    // How far the stem runs inside the bottom edge.
    const inset = clampTo(h * 0.12, 3, 6);
    const rr = r - inset;
    const bottom = h - inset;
    // Small things in small elements.
    const scale = clampTo(h / 40, 0.75, 1.25);
    const amp = 0.7 * scale;
    const wave = 16 + random() * 8;

    // The main stem: up the left corner a little way, along the bottom, up the right corner.
    const climb = tall ? 0 : 0.55; // radians above the bottom-most point the ends reach (from the side)
    const main = emptyPath();
    if (rr > 1.5) {
        arc(main, r, h - r, rr, Math.PI - climb * 1.2, Math.PI / 2);
    } else {
        pushPoint(main, inset, bottom, 0, -1);
    }
    line(main, Math.max(r, inset), bottom, w - Math.max(r, inset), bottom, 0, -1);
    if (rr > 1.5) {
        arc(main, w - r, h - r, rr, Math.PI / 2, climb * 1.2);
    }
    let rightShoot: Path | undefined;
    let leftShoot: Path | undefined;
    if (tall) {
        // Carry on up the right side, and send a shoot up the left side.
        rightShoot = emptyPath();
        const top = h * (0.3 + random() * 0.12);
        line(rightShoot, main.x[main.x.length - 1], main.y[main.y.length - 1], w - inset, top, -1, 0);
        leftShoot = emptyPath();
        const leftTop = h * (0.22 + random() * 0.12);
        line(leftShoot, main.x[0], main.y[0], inset, leftTop, 1, 0);
    }

    const mainEnd = rightShoot ? 0.78 : 1;
    // Which way is "inward" from each stem, relative to the left of its growth direction.
    const flips: number[] = [1];
    const phase = random() * Math.PI * 2;
    vine.stems.push(toStem(main, 0, mainEnd, amp, wave, phase, w, h));
    if (rightShoot && rightShoot.x.length > 1) {
        flips.push(1);
        vine.stems.push(toStem(rightShoot, mainEnd, 1, amp, wave, phase + (main.len[main.len.length - 1] / wave) * Math.PI * 2, w, h));
    }
    if (leftShoot && leftShoot.x.length > 1) {
        flips.push(-1);
        vine.stems.push(toStem(leftShoot, 0.06, 0.56, amp, wave, random() * 6, w, h));
    }

    // Nodes along each stem.
    const spacing = 6.5 * scale;
    const below = inset >= 4.5;
    const leafLo = 3 * scale;
    const leafHi = 4.2 * scale;
    const stemsLeft = vine.stems.length;
    for (let k = 0; k < stemsLeft; k++) {
        const stem = vine.stems[k];
        const flip = flips[k];
        const n = stem.x.length;
        // Arc length per point, recomputed on the wavy stem.
        let along = 0;
        let next = spacing * (0.6 + random() * 0.5);
        let side = random() < 0.5 ? 1 : -1;
        for (let i = 1; i < n; i++) {
            const dx = stem.x[i] - stem.x[i - 1];
            const dy = stem.y[i] - stem.y[i - 1];
            along += Math.hypot(dx, dy);
            if (along < next || i >= n - 1) {
                continue;
            }
            next = along + spacing * (0.8 + random() * 0.45);
            const tangent = Math.atan2(dy, dx);
            // "Above" is toward the inside of the element: the left of the direction of growth.
            let up = side;
            side = -side;
            if (up < 0 && !(below && random() < 0.55)) {
                up = 1;
            }
            const lean = up > 0 ? 0.75 + random() * 0.35 : 0.5 + random() * 0.2;
            const angle = tangent - up * flip * lean;
            const size = up > 0 ? leafLo + random() * (leafHi - leafLo) : Math.min(leafLo, inset * 0.8);
            vine.nodes.push({ stem: k, s: stem.s[i], x: stem.x[i], y: stem.y[i], angle, size, blossom: false, cx: stem.x[i], cy: stem.y[i], turn: 0 });
        }
    }

    // Blossoms replace a few of the upward nodes, spread along the growth.
    const want = Math.round(clampTo(1 + w / 36 + (tall ? 1 : 0), 2, MAX_BLOSSOMS) * clampTo(Number.isFinite(blossoms) ? blossoms : 1, 0, 3));
    const count = Math.min(want, MAX_BLOSSOMS);
    const diameter = clampTo(5 * scale, 5, 7);
    for (let b = 0; b < count; b++) {
        const target = (b + 0.5 + (random() - 0.5) * 0.4) / count;
        let best = -1;
        let bestD = Infinity;
        for (let i = 0; i < vine.nodes.length; i++) {
            const node = vine.nodes[i];
            if (node.blossom) {
                continue;
            }
            const d = Math.abs(node.s - target);
            if (d < bestD && !crowded(vine.nodes, node, diameter * 1.4)) {
                bestD = d;
                best = i;
            }
        }
        if (best < 0) {
            break;
        }
        const node = vine.nodes[best];
        const stem = vine.stems[node.stem];
        // The stalk leans inward from the stem, a little along the growth.
        const tangent = tangentAt(stem, node.s);
        const stalk = diameter * 0.5 + 1.2 + random() * 1.2 * scale;
        const angle = tangent - flips[node.stem] * (Math.PI / 2 - 0.25) + (random() - 0.5) * 0.5;
        const m = diameter / 2 + 1;
        node.blossom = true;
        node.size = diameter;
        node.angle = angle;
        node.cx = clampTo(node.x + Math.cos(angle) * stalk, m, w - m);
        node.cy = clampTo(node.y + Math.sin(angle) * stalk, m, h - m);
        node.turn = random() * Math.PI * 2;
        vine.blossoms++;
    }
    vine.nodes.sort((a, b) => a.stem - b.stem || a.s - b.s);
    return vine;
}

function crowded(nodes: readonly VineNode[], node: VineNode, gap: number): boolean {
    for (const other of nodes) {
        if (other.blossom && Math.hypot(other.x - node.x, other.y - node.y) < gap) {
            return true;
        }
    }
    return false;
}

/** Direction of the stem at growth position s, radians. */
function tangentAt(stem: VineStem, s: number): number {
    const n = stem.s.length;
    let i = 1;
    while (i < n - 1 && stem.s[i] < s) {
        i++;
    }
    return Math.atan2(stem.y[i] - stem.y[i - 1], stem.x[i] - stem.x[i - 1]);
}
