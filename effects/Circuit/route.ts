/**
 * The router of the Circuit effect: lays printed-circuit traces across a rectangle. Pure: no
 * Pixi, no Three, only numbers, so it can be tested on its own.
 *
 * Everything sits on a grid of `GRID` px, centred in the rectangle, so every point is a whole
 * pixel and a one-pixel line stays sharp. Traces start at a pad near the left end and run to the
 * right in horizontal stretches, changing lane with 45 degree or 90 degree jogs. Two traces
 * never come within one grid cell of each other (so parallel runs keep their spacing and nothing
 * crosses); a trace that runs into another ends early in a via. A trace may branch once:
 * the branch is a trace of its own that starts at a point on its parent.
 */

/** Grid pitch in pixels. */
export const GRID = 4;

export type NodeKind = 'pad' | 'via' | 'dot';

/** A pad, via or junction on a trace, at a distance along it. */
export interface BoardNode {
    x: number;
    y: number;
    dist: number;
    kind: NodeKind;
}

/** A polyline with cumulative lengths, so a point can be placed at any distance along it. */
export interface Trace {
    /** x0, y0, x1, y1, … in element pixels. */
    xy: number[];
    /** Distance from the start to each vertex (`cum[0]` is 0). */
    cum: number[];
    length: number;
    /** Sorted by `dist`. */
    nodes: BoardNode[];
    /** Where branches leave this trace, and which trace each one is (parallel arrays). */
    splitAt: number[];
    splitTo: number[];
    /** Traces of one family (a trace and its branch) may touch; those of two families never do. */
    family: number;
    /** Index of the trace this one branches from, or -1 for a root trace. */
    parent: number;
}

export interface Board {
    cols: number;
    rows: number;
    /** Where grid point (0, 0) lies. A grid point (gx, gy) is at (originX + gx * GRID, originY + gy * GRID). */
    originX: number;
    originY: number;
    /** Root traces come first (`0..roots-1`), then branches. */
    traces: Trace[];
    roots: number;
}

export interface RouteOptions {
    width: number;
    height: number;
    /** Corner radius of the element. */
    radius: number;
    /** Returns numbers in [0, 1). Seed it for a repeatable board. */
    random: () => number;
    /** How many root traces to try for. */
    count: number;
    /** `open`: traces anywhere (a pad, a switch). `edges`: only near the top and bottom, the middle left quiet for text. */
    mode?: 'open' | 'edges';
    /** Chance that a root trace branches, 0..1. Default 0.4. */
    branchChance?: number;
}

/** A repeatable seed from a name and a size. */
export function hashSeed(name: string, width: number, height: number): number {
    let h = 2166136261;
    const text = `${name}|${Math.round(width)}|${Math.round(height)}`;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/** mulberry32: a small seeded generator returning [0, 1). */
export function makeRandom(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function routeBoard(o: RouteOptions): Board {
    const W = Math.max(0, Math.floor(o.width));
    const H = Math.max(0, Math.floor(o.height));
    const rnd = o.random;
    const cols = Math.floor((W - 4) / GRID) + 1;
    const rows = Math.floor((H - 4) / GRID) + 1;
    const board: Board = { cols: Math.max(cols, 0), rows: Math.max(rows, 0), originX: 0, originY: 0, traces: [], roots: 0 };
    if (cols < 5 || rows < 3 || !Number.isFinite(W + H)) {
        return board;
    }
    const ox = Math.round((W - (cols - 1) * GRID) / 2);
    const oy = Math.round((H - (rows - 1) * GRID) / 2);
    board.originX = ox;
    board.originY = oy;

    const rowMin = 1;
    const rowMax = rows - 2;
    const edges = o.mode === 'edges' && rows >= 6;
    const rint = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1));

    // Inside the element, kept two pixels from the edge and from the rounded corners.
    const corner = Math.max(0, Math.min(o.radius, W / 2, H / 2) - 2);
    const inside = (gx: number, gy: number): boolean => {
        const x = ox + gx * GRID;
        const y = oy + gy * GRID;
        if (x < 2 || x > W - 2 || y < 2 || y > H - 2) {
            return false;
        }
        const cx = x < 2 + corner ? 2 + corner : x > W - 2 - corner ? W - 2 - corner : x;
        const cy = y < 2 + corner ? 2 + corner : y > H - 2 - corner ? H - 2 - corner : y;
        return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= corner * corner + 0.01;
    };
    const rowAllowed = (gy: number): boolean => {
        if (gy < rowMin || gy > rowMax) {
            return false;
        }
        return !edges || gy <= 2 || gy >= rows - 3;
    };

    const occ = new Int16Array(cols * rows);
    const cellOk = (gx: number, gy: number, fam: number): boolean => {
        if (gx < 0 || gx >= cols || !rowAllowed(gy) || !inside(gx, gy)) {
            return false;
        }
        for (let dy = -1; dy <= 1; dy++) {
            const y = gy + dy;
            if (y < 0 || y >= rows) {
                continue;
            }
            for (let dx = -1; dx <= 1; dx++) {
                const x = gx + dx;
                if (x < 0 || x >= cols) {
                    continue;
                }
                const v = occ[y * cols + x];
                if (v !== 0 && v !== fam + 1) {
                    return false;
                }
            }
        }
        return true;
    };

    const pushVertex = (pts: number[], gx: number, gy: number): void => {
        const n = pts.length;
        if (n >= 2 && pts[n - 2] === gx && pts[n - 1] === gy) {
            return;
        }
        pts.push(gx, gy);
    };
    const mark = (cells: number[], gx: number, gy: number, fam: number): void => {
        occ[gy * cols + gx] = fam + 1;
        cells.push(gx, gy);
    };

    const narrow = W < 100;
    const minRun = narrow ? 2 : 5;
    const maxRun = narrow ? 6 : 14;
    const jogProb = narrow ? 0.9 : 0.6;

    /** Extend a trace from (startX, startY) to the right; `firstJog` forces a first lane change (a branch). */
    const walk = (fam: number, startX: number, startY: number, endCol: number, pts: number[], cells: number[], firstJog: number): void => {
        let gx = startX;
        let gy = startY;
        pushVertex(pts, gx, gy);
        let first = firstJog !== 0;
        let jogged = false;
        const options = [-2, -1, 1, 2];
        for (let guard = 0; guard < 120 && gx < endCol; guard++) {
            let blocked = false;
            if (!first) {
                const want = rint(minRun, maxRun);
                let ran = 0;
                while (ran < want && gx < endCol && cellOk(gx + 1, gy, fam)) {
                    gx++;
                    mark(cells, gx, gy, fam);
                    ran++;
                }
                pushVertex(pts, gx, gy);
                if (ran > 0) {
                    jogged = false;
                }
                if (gx >= endCol) {
                    break;
                }
                blocked = ran < want;
                // Boxed in right after a jog: end here rather than stack jogs into a staircase.
                if (blocked && jogged && ran === 0) {
                    break;
                }
                if (!blocked && rnd() > jogProb) {
                    continue;
                }
            }
            // Try a lane change: 45 degrees or straight across, one or two rows.
            let candidates: number[];
            if (first) {
                candidates = [firstJog, -firstJog];
            } else {
                // Prefer two rows (the lane spacing), shuffled within the preference.
                candidates = options.slice().sort((a, b) => Math.abs(b) - Math.abs(a) + (rnd() - 0.5) * 1.6);
            }
            let moved = false;
            for (const dy of candidates) {
                const n = Math.abs(dy);
                const s = Math.sign(dy);
                const diagonal = rnd() < 0.6;
                let ok = true;
                for (let i = 1; i <= n && ok; i++) {
                    ok = cellOk(diagonal ? gx + i : gx, gy + s * i, fam);
                }
                // The lane it lands in must have room to run on.
                const endX = diagonal ? gx + n : gx;
                for (let i = 1; i <= 3 && ok; i++) {
                    ok = cellOk(endX + i, gy + dy, fam);
                }
                if (!ok) {
                    continue;
                }
                for (let i = 1; i <= n; i++) {
                    mark(cells, diagonal ? gx + i : gx, gy + s * i, fam);
                }
                if (diagonal) {
                    gx += n;
                }
                gy += dy;
                pushVertex(pts, gx, gy);
                moved = true;
                jogged = true;
                break;
            }
            first = false;
            if (!moved && blocked) {
                break;
            }
        }
        pushVertex(pts, gx, gy);
    };

    /** Grid vertices to a Trace in pixels, dropping vertices that sit in the middle of a straight line. */
    const toTrace = (pts: number[], family: number, parent: number): Trace => {
        const xy: number[] = [];
        for (let i = 0; i < pts.length; i += 2) {
            const x = ox + pts[i] * GRID;
            const y = oy + pts[i + 1] * GRID;
            const n = xy.length;
            if (n >= 4) {
                const ax = xy[n - 2] - xy[n - 4];
                const ay = xy[n - 1] - xy[n - 3];
                const bx = x - xy[n - 2];
                const by = y - xy[n - 1];
                if (ax * by - ay * bx === 0 && ax * bx + ay * by > 0) {
                    xy[n - 2] = x;
                    xy[n - 1] = y;
                    continue;
                }
            }
            xy.push(x, y);
        }
        const cum: number[] = [0];
        for (let i = 2; i < xy.length; i += 2) {
            cum.push(cum[cum.length - 1] + Math.hypot(xy[i] - xy[i - 2], xy[i + 1] - xy[i - 1]));
        }
        return { xy, cum, length: cum[cum.length - 1], nodes: [], splitAt: [], splitTo: [], family, parent };
    };

    const count = Math.max(0, Math.min(Math.round(o.count), 14));

    // Lanes: tight buses with an occasional wider gap.
    let lanes: number[] = [];
    if (edges) {
        lanes = [1, rows - 2].slice(0, Math.max(1, count));
    } else {
        for (let attempt = 0; attempt < 2 && lanes.length < count; attempt++) {
            lanes = [];
            let gy = rowMin + (attempt === 0 ? rint(0, 1) : 0);
            while (gy <= rowMax && lanes.length < count) {
                lanes.push(gy);
                gy += 2 + (attempt === 0 && rnd() < 0.3 ? 1 : 0);
            }
        }
        // Centre the bus in the free rows.
        const slack = rowMax - lanes[lanes.length - 1];
        if (lanes.length > 0 && slack > 0) {
            const shift = Math.floor(slack / 2);
            lanes = lanes.map((l) => l + shift);
        }
    }

    const cellLists: number[][] = [];
    const tracePts: number[][] = [];
    for (let li = 0; li < lanes.length; li++) {
        const gy = lanes[li];
        let gx = 1;
        while (gx < cols - 4 && !cellOk(gx, gy, li)) {
            gx++;
        }
        gx += rint(0, 2);
        if (!cellOk(gx, gy, li) || gx > cols - 5) {
            continue;
        }
        const endCol = Math.max(gx + 3, cols - 1 - rint(0, 2));
        const pts: number[] = [];
        const cells: number[] = [];
        mark(cells, gx, gy, li);
        walk(li, gx, gy, endCol, pts, cells, 0);
        if (pts.length < 4) {
            // Not even one segment: give the cell back.
            for (let i = 0; i < cells.length; i += 2) {
                occ[cells[i + 1] * cols + cells[i]] = 0;
            }
            continue;
        }
        const trace = toTrace(pts, li, -1);
        board.traces.push(trace);
        cellLists.push(cells);
        tracePts.push(pts);
    }
    board.roots = board.traces.length;

    // Nodes on the roots: a pad where each begins; a via or pad where it ends; sometimes a via on the way.
    const chance = Math.max(0, Math.min(1, o.branchChance ?? 0.4));
    const addEnds = (trace: Trace, pts: number[], withStart: boolean): void => {
        if (withStart) {
            trace.nodes.push({ x: trace.xy[0], y: trace.xy[1], dist: 0, kind: 'pad' });
        }
        const n = trace.xy.length;
        trace.nodes.push({ x: trace.xy[n - 2], y: trace.xy[n - 1], dist: trace.length, kind: rnd() < 0.55 ? 'via' : 'pad' });
        if (W >= 100 && trace.xy.length >= 8 && rnd() < 0.4) {
            const v = rint(1, trace.xy.length / 2 - 2);
            trace.nodes.push({ x: trace.xy[v * 2], y: trace.xy[v * 2 + 1], dist: trace.cum[v], kind: 'via' });
        }
        void pts;
    };
    for (let t = 0; t < board.roots; t++) {
        addEnds(board.traces[t], tracePts[t], true);
    }

    // Branches.
    if (!edges || rows >= 8) {
        const maxBranches = Math.max(1, Math.ceil(board.roots * 0.7));
        let made = 0;
        for (let t = 0; t < board.roots && made < maxBranches; t++) {
            if (rnd() > (edges ? chance * 0.5 : chance)) {
                continue;
            }
            const parent = board.traces[t];
            const cells = cellLists[t];
            const n = cells.length / 2;
            if (n < 8) {
                continue;
            }
            let built = false;
            for (let attempt = 0; attempt < 6 && !built; attempt++) {
                const ci = Math.floor(n * (0.2 + rnd() * 0.45));
                const sx = cells[ci * 2];
                const sy = cells[ci * 2 + 1];
                // Only from a straight stretch: the cells either side are on the same row.
                if (ci < 1 || ci >= n - 1 || cells[(ci - 1) * 2 + 1] !== sy || cells[(ci + 1) * 2 + 1] !== sy) {
                    continue;
                }
                const stub = rnd() < 0.5;
                const endCol = stub ? Math.min(cols - 2, sx + rint(6, 14)) : Math.max(sx + 4, cols - 1 - rint(0, 3));
                const bpts: number[] = [];
                const bcells: number[] = [];
                walk(parent.family, sx, sy, endCol, bpts, bcells, (rnd() < 0.5 ? -1 : 1) * 2);
                if (bpts.length < 4 || bcells.length < 4) {
                    for (let i = 0; i < bcells.length; i += 2) {
                        occ[bcells[i + 1] * cols + bcells[i]] = 0;
                    }
                    continue;
                }
                const branch = toTrace(bpts, parent.family, t);
                const index = board.traces.length;
                const jx = ox + sx * GRID;
                const jy = oy + sy * GRID;
                const at = distanceAlong(parent, jx, jy);
                parent.splitAt.push(at);
                parent.splitTo.push(index);
                parent.nodes.push({ x: jx, y: jy, dist: at, kind: 'dot' });
                addEnds(branch, bpts, false);
                board.traces.push(branch);
                made++;
                built = true;
            }
        }
    }

    for (const trace of board.traces) {
        trace.nodes.sort((a, b) => a.dist - b.dist);
    }
    return board;
}

/** Distance from a trace's start to the point (x, y) on it; the closest point if it is not exactly on it. */
export function distanceAlong(trace: Trace, x: number, y: number): number {
    const out = { x: 0, y: 0, dist: 0, d2: 0 };
    nearestOnTrace(trace, x, y, out);
    return out.dist;
}

/** The point `dist` px along a trace (clamped to its ends), into `out`. */
export function pointAt(trace: Trace, dist: number, out: { x: number; y: number }): void {
    const xy = trace.xy;
    const cum = trace.cum;
    const last = cum.length - 1;
    if (last < 1) {
        out.x = xy[0] ?? 0;
        out.y = xy[1] ?? 0;
        return;
    }
    const d = dist < 0 ? 0 : dist > trace.length ? trace.length : dist;
    const i = segmentAt(trace, d);
    const span = cum[i + 1] - cum[i];
    const t = span > 0 ? (d - cum[i]) / span : 0;
    out.x = xy[i * 2] + (xy[i * 2 + 2] - xy[i * 2]) * t;
    out.y = xy[i * 2 + 1] + (xy[i * 2 + 3] - xy[i * 2 + 1]) * t;
}

/** The index of the segment (vertex i to i + 1) that holds distance `dist`. */
export function segmentAt(trace: Trace, dist: number): number {
    const cum = trace.cum;
    let i = 0;
    const last = cum.length - 2;
    while (i < last && cum[i + 1] < dist) {
        i++;
    }
    return i;
}

/** Closest point of one trace to (x, y). `out.d2` is the squared distance. */
export function nearestOnTrace(trace: Trace, x: number, y: number, out: { x: number; y: number; dist: number; d2: number }): void {
    const xy = trace.xy;
    let best = Infinity;
    for (let i = 0; i + 3 < xy.length; i += 2) {
        const ax = xy[i];
        const ay = xy[i + 1];
        const dx = xy[i + 2] - ax;
        const dy = xy[i + 3] - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + dx * t;
        const py = ay + dy * t;
        const d2 = (x - px) * (x - px) + (y - py) * (y - py);
        if (d2 < best) {
            best = d2;
            out.x = px;
            out.y = py;
            out.dist = trace.cum[i / 2] + Math.sqrt(len2) * t;
            out.d2 = d2;
        }
    }
}

/** Closest point of the whole board to (x, y): which trace, how far along it, where, and the squared distance. */
export function nearestOnBoard(board: Board, x: number, y: number, out: { trace: number; dist: number; x: number; y: number; d2: number }): boolean {
    const scratch = { x: 0, y: 0, dist: 0, d2: 0 };
    out.trace = -1;
    out.d2 = Infinity;
    for (let t = 0; t < board.traces.length; t++) {
        nearestOnTrace(board.traces[t], x, y, scratch);
        if (scratch.d2 < out.d2) {
            out.d2 = scratch.d2;
            out.trace = t;
            out.dist = scratch.dist;
            out.x = scratch.x;
            out.y = scratch.y;
        }
    }
    return out.trace >= 0;
}
