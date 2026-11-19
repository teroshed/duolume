/**
 * One row of grass blades, as structure-of-arrays, with no renderer in it: the spring that
 * bends each blade, the curve that draws it, and the lookups the effect needs. `Meadow` owns
 * the rows and draws each one as a single Pixi mesh from `writeVertices`.
 *
 * A blade's state is the horizontal offset of its tip (`lean`, px) and that offset's velocity
 * (px/ms). Everything else is fixed at birth, except where it was last cut and how far it has
 * grown back since.
 *
 * A cut does not shrink a blade: it keeps its curve and loses the part above the cut, so it ends
 * in a flat top. How much is left is `growth`, the share of the blade's length that still
 * stands (1 is whole). A cut blade stands as it was cut for a while, then climbs back at its own
 * speed; both numbers are given with the cut, so the row itself rolls no dice.
 */

/** Segments along a blade; each blade is a strip of (SEGMENTS + 1) × 2 vertices. */
export const SEGMENTS = 4;
export const VERTS_PER_BLADE = (SEGMENTS + 1) * 2;
export const INDICES_PER_BLADE = SEGMENTS * 6;

/** Spring constant of a typical blade, 1/ms² (a sway period of about 0.9 s). */
export const STIFFNESS = 4.9e-5;
/**
 * Lean per unit of acceleration, per pixel of blade height. Chosen so the wind effect's natural
 * gust (0.00016 px/ms²) holds a typical blade about 25% of its height over.
 */
export const GAIN = (0.25 * STIFFNESS) / 0.00016;
/** Tips never lean further than this share of the blade's height. */
export const MAX_LEAN = 0.85;
/** The least a cut leaves: this share of the blade's length. Nothing cuts lower. */
export const STUBBLE = 0.12;

const DAMPING_RATIO = 0.26;

export class BladeRow {
    /** Blades in the row, sorted by `rx`. */
    public readonly count: number;
    /** Root line, in stage pixels: the left end of the row. Set by the owner every tick. */
    public x = 0;
    public y = 0;

    /** Root x, relative to the row, ascending. */
    public readonly rx: Float32Array;
    /** Full height, px. */
    public readonly height: Float32Array;
    /** Width at the root, px. */
    public readonly rootWidth: Float32Array;
    /** Spring constant, 1/ms². */
    public readonly stiffness: Float32Array;
    /** Lean at rest, px. */
    public readonly rest: Float32Array;
    /** Palette column, 0..1 (higher is lighter). */
    public readonly shade: Float32Array;
    /** Depth layer: 0 back, 1 middle, 2 front. */
    public readonly layer: Uint8Array;
    /** Per-blade phase for its idle sway, radians. */
    public readonly phase: Float32Array;
    /** Which blades go first when the frame budget drops: 0 stays longest. */
    public readonly rank: Float32Array;

    /** Tip offset from rest, px. */
    public readonly lean: Float32Array;
    /** Its velocity, px/ms. */
    public readonly velocity: Float32Array;
    /** When the blade was last cut (simulation ms), -Infinity if never. */
    public readonly cutAt: Float64Array;
    /** The share of its length that last cut left standing. 1 if never cut. */
    public readonly cutShare: Float32Array;
    /** When it starts to grow back from that cut (simulation ms). */
    public readonly regrowAt: Float64Array;
    /** How long the climb from `cutShare` back to whole takes, ms. */
    public readonly regrowMs: Float32Array;
    /** 1 while the blade is burnt: set by a scorching cut, cleared when it has grown back. */
    public readonly scorched: Uint8Array;
    /** The share of its length standing now (stubble .. 1). Updated by `grow`. */
    public readonly growth: Float32Array;
    /** Current scorch, 0..1: full until the blade starts to grow, gone when it is whole. Updated by `grow`. */
    public readonly scorch: Float32Array;

    /** Blade indices in drawing order: back layer first. */
    public readonly order: Uint32Array;

    constructor(
        public readonly key: string,
        public readonly width: number,
        density: number,
        typicalHeight: number,
        random: () => number = Math.random,
    ) {
        const spacing = 100 / Math.max(1e-6, density);
        const roots: number[] = [];
        if (density > 0 && width > 0) {
            for (let x = random() * spacing; x < width; x += spacing * (0.45 + random() * 1.1)) {
                roots.push(x);
            }
        }
        const n = roots.length;
        this.count = n;
        this.rx = Float32Array.from(roots);
        this.height = new Float32Array(n);
        this.rootWidth = new Float32Array(n);
        this.stiffness = new Float32Array(n);
        this.rest = new Float32Array(n);
        this.shade = new Float32Array(n);
        this.layer = new Uint8Array(n);
        this.phase = new Float32Array(n);
        this.rank = new Float32Array(n);
        this.lean = new Float32Array(n);
        this.velocity = new Float32Array(n);
        this.cutAt = new Float64Array(n).fill(-Infinity);
        this.cutShare = new Float32Array(n).fill(1);
        this.regrowAt = new Float64Array(n).fill(-Infinity);
        this.regrowMs = new Float32Array(n).fill(1);
        this.scorched = new Uint8Array(n);
        this.growth = new Float32Array(n).fill(1);
        this.scorch = new Float32Array(n);
        this.order = new Uint32Array(n);

        for (let i = 0; i < n; i++) {
            const r = random();
            const layer = r < 0.3 ? 0 : r < 0.65 ? 1 : 2;
            this.layer[i] = layer;
            const depth = layer === 0 ? 0.72 : layer === 1 ? 0.9 : 1;
            const h = typicalHeight * depth * (0.6 + random() * 0.8);
            this.height[i] = h;
            this.rootWidth[i] = (2.6 + random() * 2.6) * (layer === 0 ? 0.85 : 1);
            this.stiffness[i] = STIFFNESS * (0.75 + random() * 0.5);
            this.rest[i] = (random() - 0.5) * 0.7 * h;
            const lo = layer === 0 ? 0.24 : layer === 1 ? 0.38 : 0.5;
            const hi = layer === 0 ? 0.52 : layer === 1 ? 0.8 : 1;
            this.shade[i] = lo + random() * (hi - lo);
            this.phase[i] = random() * Math.PI * 2;
            this.rank[i] = random() * 0.9;
        }

        let k = 0;
        for (let layer = 0; layer <= 2; layer++) {
            for (let i = 0; i < n; i++) {
                if (this.layer[i] === layer) {
                    this.order[k++] = i;
                }
            }
        }
    }

    /** Index of the blade whose root is nearest to `x` (row-relative), or -1 for an empty row. */
    public nearest(x: number): number {
        const rx = this.rx;
        let lo = 0;
        let hi = this.count - 1;
        if (hi < 0) {
            return -1;
        }
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (rx[mid] < x) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if (lo > 0 && x - rx[lo - 1] < rx[lo] - x) {
            return lo - 1;
        }
        return lo;
    }

    /** First blade with a root at or right of `x` (row-relative); `count` if none. */
    public lowerBound(x: number): number {
        const rx = this.rx;
        let lo = 0;
        let hi = this.count;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (rx[mid] < x) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    /**
     * Cut blade `i` at `time`, leaving `share` of its length (never less than `STUBBLE`). It
     * stands like that for `delay` ms, then grows back at `speed`, in shares of its length per ms.
     * A cut never lengthens a blade: one at or above where the blade ends now changes nothing,
     * not even the wait it is in, and returns false. A scorching cut also burns the blade, and
     * always takes: lightning that finds only stubble still starts its wait again.
     */
    public cut(i: number, share: number, time: number, delay: number, speed: number, scorch = false): boolean {
        const now = this.growthAt(i, time);
        const left = Math.min(now, Math.max(STUBBLE, share));
        if (!scorch && !(left < now - 0.004)) {
            return false;
        }
        this.cutAt[i] = time;
        this.cutShare[i] = left;
        this.regrowAt[i] = time + Math.max(0, delay);
        this.regrowMs[i] = Math.max(1, (1 - left) / Math.max(1e-9, speed));
        if (scorch) {
            this.scorched[i] = 1;
        }
        this.growth[i] = left;
        return true;
    }

    /** The share of blade `i` standing at `time`, from its last cut alone. */
    public growthAt(i: number, time: number): number {
        return regrown(this.cutShare[i], time - this.regrowAt[i], this.regrowMs[i]);
    }

    /** Update `growth` and `scorch` for `time`. */
    public grow(time: number): void {
        for (let i = 0; i < this.count; i++) {
            const share = this.cutShare[i];
            const g = regrown(share, time - this.regrowAt[i], this.regrowMs[i]);
            this.growth[i] = g;
            if (this.scorched[i] === 1) {
                if (g >= 1) {
                    this.scorched[i] = 0;
                    this.scorch[i] = 0;
                } else {
                    // The ash goes as the blade comes back: all of it until it starts, none when whole.
                    this.scorch[i] = share < 1 ? (1 - g) / (1 - share) : 0;
                }
            } else {
                this.scorch[i] = 0;
            }
        }
    }

    /**
     * Advance blade `i` by `dt` ms under an acceleration `accel` (px/ms², the force felt at its
     * tip). A damped spring pulls it back upright.
     */
    public spring(i: number, accel: number, dt: number): void {
        const k = this.stiffness[i];
        const h = this.height[i];
        const damping = 2 * DAMPING_RATIO * Math.sqrt(k);
        let v = this.velocity[i];
        let x = this.lean[i];
        v += (accel * GAIN * h - k * x - damping * v) * dt;
        x += v * dt;
        // Far past the visible clamp a blade is already flat; holding it there keeps the
        // spring-back after a shock ring short.
        const limit = 1.6 * h;
        if (x > limit) {
            x = limit;
            v = Math.min(v, 0);
        } else if (x < -limit) {
            x = -limit;
            v = Math.max(v, 0);
        }
        this.lean[i] = x;
        this.velocity[i] = v;
    }

    /** How high blade `i` reaches now when upright, px, before the budget fades it. */
    public shownHeight(i: number): number {
        return this.height[i] * riseAt(this.growth[i]);
    }

    /** The tip's offset as drawn, px, for a raw lean (rest included): soft-clamped to ±85% of `h`. */
    public static bend(lean: number, h: number): number {
        const m = MAX_LEAN * h;
        return m > 0 ? m * Math.tanh(lean / m) : 0;
    }
}

/**
 * The share of a blade standing `since` ms after it began to grow back from a cut that left
 * `share`: `share` until then (a negative `since` is the wait), then an eased climb to 1 over
 * `regrowMs`.
 */
export function regrown(share: number, since: number, regrowMs: number): number {
    if (!(since > 0)) {
        return share;
    }
    if (!(since < regrowMs)) {
        return 1;
    }
    const t = since / regrowMs;
    return share + (1 - share) * t * t * (3 - 2 * t);
}

/**
 * How high an upright blade reaches at the share `t` of its length, as a share of its full
 * height. Not `t` itself: the curve `writeBlade` draws climbs fastest near the root.
 */
export function riseAt(t: number): number {
    return t * (1.16 - 0.16 * t);
}

/** The inverse of `riseAt`: the share of a blade's length that reaches `rise` of its height. */
export function shareAtRise(rise: number): number {
    const r = rise < 0 ? 0 : rise > 1 ? 1 : rise;
    return (1.16 - Math.sqrt(1.16 * 1.16 - 0.64 * r)) / 0.32;
}

/**
 * Write one blade's strip into `out` at `offset` (in floats), relative to the row's root line:
 * a quadratic curve from the root (fixed, at `rx, 0`), through a control point straight above
 * it, to the tip, which is pushed sideways by `dx` and drops so the blade's length looks constant.
 * `share` below 1 draws only that much of the curve, from the root: a cut blade, ending in a
 * flat top as wide as the blade is there. Writes `VERTS_PER_BLADE` vertices (x, y pairs).
 */
export function writeBlade(out: Float32Array, offset: number, rx: number, h: number, rootWidth: number, dx: number, share = 1): void {
    const tipY = -Math.sqrt(Math.max(h * h - dx * dx, 0.25 * h * h));
    const cy = tipY * 0.58;
    const halfW = rootWidth * 0.5;
    let o = offset;
    for (let j = 0; j <= SEGMENTS; j++) {
        const t = (j / SEGMENTS) * share;
        const u = 1 - t;
        // Point on the curve: root (rx, 0), control (rx, cy), tip (rx + dx, tipY).
        const px = rx + t * t * dx;
        const py = 2 * t * u * cy + t * t * tipY;
        // Tangent.
        const tx = 2 * t * dx;
        const ty = 2 * u * cy + 2 * t * (tipY - cy);
        const len = Math.hypot(tx, ty) || 1;
        // Tapers to a point, but never thinner than about a pixel, or the tip breaks into dots.
        const w = h > 0 ? Math.max(0.5, halfW * (1 - t * 0.9)) : 0;
        const nx = (-ty / len) * w;
        const ny = (tx / len) * w;
        out[o++] = px - nx;
        out[o++] = py - ny;
        out[o++] = px + nx;
        out[o++] = py + ny;
    }
}

/** Width of a blade drawn as a plain line, px. */
export const LINE_WIDTH = 1.3;

/**
 * Write one blade as a straight line of even width, root to tip, into the same strip
 * `writeBlade` fills. Cheaper: one direction for the whole blade, no curve, no taper.
 */
export function writeLine(out: Float32Array, offset: number, rx: number, h: number, dx: number): void {
    const tipY = -Math.sqrt(Math.max(h * h - dx * dx, 0.25 * h * h));
    const len = Math.hypot(dx, tipY) || 1;
    const w = h > 0 ? LINE_WIDTH * 0.5 : 0;
    const nx = (-tipY / len) * w;
    const ny = (dx / len) * w;
    let o = offset;
    for (let j = 0; j <= SEGMENTS; j++) {
        const t = j / SEGMENTS;
        const px = rx + t * dx;
        const py = t * tipY;
        out[o++] = px - nx;
        out[o++] = py - ny;
        out[o++] = px + nx;
        out[o++] = py + ny;
    }
}

/** Fixed triangle indices for `count` blade strips, in the given drawing order. */
export function bladeIndices(order: ArrayLike<number>): Uint32Array {
    const indices = new Uint32Array(order.length * INDICES_PER_BLADE);
    let k = 0;
    for (let n = 0; n < order.length; n++) {
        const base = order[n] * VERTS_PER_BLADE;
        for (let j = 0; j < SEGMENTS; j++) {
            const a = base + j * 2;
            indices[k++] = a;
            indices[k++] = a + 1;
            indices[k++] = a + 2;
            indices[k++] = a + 1;
            indices[k++] = a + 3;
            indices[k++] = a + 2;
        }
    }
    return indices;
}
