/**
 * A heap of sand as a row of columns: the pure half of the Sand effect (no renderer).
 *
 * `heights[i]` is how much sand stands at `x = i * spacing`, in pixels, between 0 and
 * `ceiling`. Each `step` the surface slides downhill wherever it is steeper than the angle of
 * repose. Leaning gravity sideways (`tilt`, or a `target` the sand is drawn toward) lowers the
 * angle the sand holds on one side and raises it on the other, so the heap flows that way, even
 * up a gentle slope, the way sand runs to the low end of a tipped box. The amount of sand never
 * changes: every move takes from one column what it gives to its neighbour.
 */
export class Pile {
    /** Distance between columns, in pixels. */
    public static readonly SPACING = 2.5;
    /** Share of a bond's excess slope that moves in one substep (below 0.5 to stay stable). */
    public static readonly FLOW = 0.42;
    /** Substep length in milliseconds. */
    public static readonly SUBSTEP = 1000 / 240;
    /** How sharply the pull toward `target` turns over: pixels from the target to full lean. */
    public static readonly REACH = 6;

    public readonly count: number;
    public readonly spacing: number;
    public readonly width: number;
    /** Sand never stands higher than this, in pixels. */
    public readonly ceiling: number;
    public readonly heights: Float32Array;
    /** Sand moved across each bond (between column i and i+1) in the last `step`, in px of height; positive to the right. */
    public readonly flux: Float32Array;

    /** Steepest slope the sand holds, as a tangent. */
    public repose: number;
    /** Gravity leaning sideways everywhere, -1..1 (positive leans to the right), on top of the pull toward `target`. */
    public tilt = 0;
    /** Where the sand is drawn to, in pixels from the left; NaN for nowhere. */
    public target = Number.NaN;
    /** How hard it is drawn there, 0..2: 1 tips the far side to twice the angle of repose. */
    public pull = 0;
    /** Slow levelling per second (a vibrating tray), for a heap that should end flat. */
    public creep = 0;
    /** How fast the sand runs, 1..4: more substeps per step, the same shape at the end. */
    public speed = 1;

    private flip = false;

    public constructor(width: number, ceiling: number, reposeDegrees = 34) {
        const w = Number.isFinite(width) && width > 0 ? width : 0;
        this.width = w;
        this.spacing = Pile.SPACING;
        this.count = Math.max(2, Math.ceil(w / this.spacing) + 1);
        this.ceiling = Number.isFinite(ceiling) && ceiling > 0 ? ceiling : 0;
        this.heights = new Float32Array(this.count);
        this.flux = new Float32Array(this.count - 1);
        this.repose = Pile.tangent(reposeDegrees);
    }

    /** The tangent of an angle in degrees, clamped to a sand-like 5..70. */
    public static tangent(degrees: number): number {
        const d = Number.isFinite(degrees) ? Math.min(70, Math.max(5, degrees)) : 34;
        return Math.tan((d * Math.PI) / 180);
    }

    public columnX(i: number): number {
        return i * this.spacing;
    }

    /** All the sand, as area in px² (height × column spacing summed). */
    public get total(): number {
        let sum = 0;
        for (let i = 0; i < this.count; i++) {
            sum += this.heights[i];
        }
        return sum * this.spacing;
    }

    /** Where the sand's centre of mass is, in pixels from the left (the middle when empty). */
    public centre(): number {
        let sum = 0;
        let moment = 0;
        for (let i = 0; i < this.count; i++) {
            sum += this.heights[i];
            moment += this.heights[i] * i;
        }
        return sum > 0 ? (moment / sum) * this.spacing : this.width / 2;
    }

    /** Height of the surface at x, interpolated between columns. */
    public surface(x: number): number {
        const f = Math.min(this.count - 1, Math.max(0, x / this.spacing));
        const i = Math.min(this.count - 2, Math.floor(f));
        const t = f - i;
        return this.heights[i] * (1 - t) + this.heights[i + 1] * t;
    }

    /** Spread `area` px² of sand as an even layer. */
    public fillLevel(area: number): void {
        const h = Math.min(this.ceiling, Math.max(0, area) / (this.count * this.spacing));
        this.heights.fill(h);
    }

    /**
     * Pour `area` px² of sand as a heap at the angle of repose, peaked at x and pressed against
     * the walls when it reaches them. Fills from the bottom by bisection on the peak height.
     */
    public fillHeap(area: number, x: number): void {
        const want = Math.max(0, area) / this.spacing;
        let lo = 0;
        let hi = this.ceiling + this.repose * this.width;
        for (let k = 0; k < 40; k++) {
            const peak = (lo + hi) / 2;
            if (this.heapSum(peak, x) < want) {
                lo = peak;
            } else {
                hi = peak;
            }
        }
        const peak = lo;
        for (let i = 0; i < this.count; i++) {
            this.heights[i] = Math.min(this.ceiling, Math.max(0, peak - this.repose * Math.abs(this.columnX(i) - x)));
        }
        // Whatever the bisection left over (a hair), on the peak column, so the total is what was asked.
        const rest = want - this.heapSum(peak, x);
        const c = Math.min(this.count - 1, Math.max(0, Math.round(x / this.spacing)));
        this.heights[c] = Math.max(0, this.heights[c] + rest);
    }

    private heapSum(peak: number, x: number): number {
        let sum = 0;
        for (let i = 0; i < this.count; i++) {
            sum += Math.min(this.ceiling, Math.max(0, peak - this.repose * Math.abs(this.columnX(i) - x)));
        }
        return sum;
    }

    /**
     * Dig a dent at x: take up to `depth` px from the columns within `radius` (deepest in the
     * middle) and heap it on the rims just outside. Returns the area moved, in px².
     */
    public dig(x: number, depth: number, radius: number): number {
        const r = Math.max(this.spacing, radius);
        let moved = 0;
        const first = Math.max(0, Math.floor((x - r) / this.spacing));
        const last = Math.min(this.count - 1, Math.ceil((x + r) / this.spacing));
        let leftMoved = 0;
        for (let i = first; i <= last; i++) {
            const d = Math.abs(this.columnX(i) - x) / r;
            if (d >= 1) {
                continue;
            }
            const take = Math.min(this.heights[i], Math.max(0, depth) * (1 - d * d));
            this.heights[i] -= take;
            moved += take;
            if (this.columnX(i) < x) {
                leftMoved += take;
            }
        }
        // Onto the rims; a rim against a wall (or the ceiling) passes the rest to the other one.
        let left = leftMoved;
        let right = moved - leftMoved;
        left = this.deposit(first - 1, -1, left);
        right += left;
        right = this.deposit(last + 1, 1, right);
        if (right > 0) {
            right = this.deposit(first - 1, -1, right);
        }
        // Nowhere left to put it: back where it came from.
        if (right > 0) {
            const c = Math.min(this.count - 1, Math.max(0, Math.round(x / this.spacing)));
            this.heights[c] += right;
        }
        return moved * this.spacing;
    }

    /** Lay `amount` px of height onto columns from `start` outward in `dir`; returns what did not fit. */
    private deposit(start: number, dir: number, amount: number): number {
        let rest = amount;
        for (let i = start, k = 0; rest > 1e-6 && i >= 0 && i < this.count && k < 4; i += dir, k++) {
            const share = k < 3 ? rest * 0.6 : rest;
            const put = Math.min(share, this.ceiling - this.heights[i]);
            if (put > 0) {
                this.heights[i] += put;
                rest -= put;
            }
        }
        return rest;
    }

    /** Advance `dt` milliseconds. */
    public step(dt: number): void {
        this.flux.fill(0);
        if (!(dt > 0)) {
            return;
        }
        const span = Math.min(dt, 100);
        const speed = Number.isFinite(this.speed) ? Math.min(4, Math.max(1, this.speed)) : 1;
        const substeps = Math.max(1, Math.ceil((span * speed) / Pile.SUBSTEP));
        const creep = Math.min(0.25, Math.max(0, this.creep) * (span / substeps / 1000)) || 0;
        for (let s = 0; s < substeps; s++) {
            this.flip = !this.flip;
            this.substep(creep);
        }
    }

    private substep(creep: number): void {
        const h = this.heights;
        const n = this.count - 1;
        const sp = this.spacing;
        const repose = this.repose;
        const ceiling = this.ceiling;
        const hasTarget = Number.isFinite(this.target);
        const pull = Math.min(2, Math.max(0, this.pull));
        const tilt = Math.min(2, Math.max(-2, Number.isFinite(this.tilt) ? this.tilt : 0));
        for (let k = 0; k < n; k++) {
            const b = this.flip ? k : n - 1 - k;
            let lean = tilt;
            if (hasTarget) {
                const toward = (this.target - (b + 0.5) * sp) / Pile.REACH;
                lean += pull * (toward > 1 ? 1 : toward < -1 ? -1 : toward);
            }
            // Leaning gravity by `lean` lowers the slope the sand holds on that side by lean × repose.
            const shift = lean * repose * 2;
            const slope = (h[b] - h[b + 1]) / sp;
            let move = 0;
            if (slope > repose - shift) {
                move = (slope - (repose - shift)) * sp * 0.5 * Pile.FLOW;
            } else if (-slope > repose + shift) {
                move = -(-slope - (repose + shift)) * sp * 0.5 * Pile.FLOW;
            }
            move += (h[b] - h[b + 1]) * 0.5 * creep;
            if (move > 0) {
                move = Math.min(move, h[b], ceiling - h[b + 1]);
                if (move <= 0) continue;
            } else if (move < 0) {
                move = -Math.min(-move, h[b + 1], ceiling - h[b]);
                if (move >= 0) continue;
            } else {
                continue;
            }
            h[b] -= move;
            h[b + 1] += move;
            this.flux[b] += move;
        }
    }
}
