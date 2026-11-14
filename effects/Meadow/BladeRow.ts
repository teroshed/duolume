/**
 * One row of grass blades, as structure-of-arrays, with no renderer in it: the spring that
 * bends each blade, the curve that draws it, and the lookups the effect needs. `Meadow` owns
 * the rows and draws each one as a single Pixi mesh from `writeVertices`.
 *
 * A blade's state is the horizontal offset of its tip (`lean`, px) and that offset's velocity
 * (px/ms). Everything else is fixed at birth, except how far it has grown back after a cut.
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
/** Height of a cut blade, as a share of its full height. */
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
    /** When it was last scorched, -Infinity if never. */
    public readonly scorchAt: Float64Array;
    /** Current height as a share of full height (stubble .. 1). Updated by `grow`. */
    public readonly growth: Float32Array;
    /** Current scorch, 0..1. Updated by `grow`. */
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
        this.scorchAt = new Float64Array(n).fill(-Infinity);
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

    /** Update `growth` and `scorch` from the cut and scorch times. */
    public grow(time: number, regrowMs: number): void {
        for (let i = 0; i < this.count; i++) {
            this.growth[i] = regrowth(time - this.cutAt[i], regrowMs);
            const s = (time - this.scorchAt[i]) / regrowMs;
            this.scorch[i] = s >= 1 ? 0 : s <= 0 ? 1 : 1 - s * s * (3 - 2 * s);
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

    /** Height a blade shows now, px, before the budget fades it. */
    public shownHeight(i: number): number {
        return this.height[i] * this.growth[i];
    }

    /** The tip's offset as drawn, px, for a raw lean (rest included): soft-clamped to ±85% of `h`. */
    public static bend(lean: number, h: number): number {
        const m = MAX_LEAN * h;
        return m > 0 ? m * Math.tanh(lean / m) : 0;
    }
}

/** Share of full height `age` ms after a cut: stubble, then an eased climb back to 1 over `regrowMs`. */
export function regrowth(age: number, regrowMs: number): number {
    if (!(age < regrowMs)) {
        return 1;
    }
    const t = Math.max(0, age / regrowMs);
    const eased = 1 - (1 - t) * (1 - t) * (1 - t);
    return STUBBLE + (1 - STUBBLE) * eased;
}

/**
 * Write one blade's strip into `out` at `offset` (in floats), relative to the row's root line:
 * a quadratic curve from the root (fixed, at `rx, 0`), through a control point straight above
 * it, to the tip, which is pushed sideways by `dx` and drops so the blade's length looks constant.
 * Writes `VERTS_PER_BLADE` vertices (x, y pairs).
 */
export function writeBlade(out: Float32Array, offset: number, rx: number, h: number, rootWidth: number, dx: number): void {
    const tipY = -Math.sqrt(Math.max(h * h - dx * dx, 0.25 * h * h));
    const cy = tipY * 0.58;
    const halfW = rootWidth * 0.5;
    let o = offset;
    for (let j = 0; j <= SEGMENTS; j++) {
        const t = j / SEGMENTS;
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
