/**
 * A heightfield of snow lying along one surface: the top edge of a page element, or the floor.
 *
 * Pure numbers, no renderer. The surface is cut into columns about `COLUMN` px wide; each holds
 * a depth in px (capped at `cap`). Volume is height times column width, in square pixels.
 * Every method that removes snow says how much it removed, so callers can turn it into flakes.
 */
export class SnowCap {
    /** Wanted column width in px. The real width is the surface width divided into whole columns. */
    public static readonly COLUMN = 4;
    /** Steepest step between neighbouring columns, as a share of the column width. 0.75 = 3 px per 4 px. */
    public static readonly REPOSE = 0.75;

    /** Number of columns. */
    public cols = 0;
    /** Width of one column in px. */
    public colWidth = SnowCap.COLUMN;
    /** Depth of each column in px. */
    public heights = new Float32Array(0);
    /** Volume that slid off the left / right end during the last `relax()`, in px². */
    public fellLeft = 0;
    public fellRight = 0;

    /**
     * @param width surface width in px
     * @param cap deepest a column may get, in px
     * @param openEnds true when snow can fall off the ends (an element); false for a floor between walls
     */
    public constructor(
        width: number,
        public cap: number,
        public readonly openEnds: boolean,
    ) {
        this.resize(width);
    }

    /** Surface width in px. */
    public get width(): number {
        return this.cols * this.colWidth;
    }

    /** Snow lying here, in px². */
    public get total(): number {
        let sum = 0;
        for (let i = 0; i < this.cols; i++) {
            sum += this.heights[i];
        }
        return sum * this.colWidth;
    }

    /** Depth of the deepest column, in px. */
    public get deepest(): number {
        let best = 0;
        for (let i = 0; i < this.cols; i++) {
            if (this.heights[i] > best) {
                best = this.heights[i];
            }
        }
        return best;
    }

    /** Change the surface width. The snow is resampled so the shape of the pile survives. */
    public resize(width: number): void {
        const cols = Math.max(2, Math.round(Math.max(1, width) / SnowCap.COLUMN));
        const colWidth = Math.max(1, width) / cols;
        const old = this.heights;
        const oldCols = this.cols;
        const next = new Float32Array(cols);
        if (oldCols > 0) {
            const ratio = oldCols / cols;
            for (let i = 0; i < cols; i++) {
                next[i] = old[Math.min(oldCols - 1, Math.floor((i + 0.5) * ratio))];
            }
        }
        this.cols = cols;
        this.colWidth = colWidth;
        this.heights = next;
    }

    /** Depth at x (px from the left end of the surface). */
    public heightAt(x: number): number {
        if (this.cols === 0) {
            return 0;
        }
        return this.heights[this.columnOf(x)];
    }

    /**
     * Add `volume` px² of snow at x, spread over the column and its neighbours so piles stay smooth.
     * Returns how much was kept (less than `volume` where the pile is already at its cap).
     */
    public deposit(x: number, volume: number): number {
        if (volume <= 0 || this.cols === 0) {
            return 0;
        }
        const c = this.columnOf(x);
        const per = volume / this.colWidth;
        // A soft triangular kernel (1 2 3 4 3 2 1), so a flake adds to a small mound, not a spike.
        const KERNEL = [1, 2, 3, 4, 3, 2, 1];
        let weight = 0;
        for (let k = 0; k < 7; k++) {
            const col = c + k - 3;
            if (col >= 0 && col < this.cols) {
                weight += KERNEL[k];
            }
        }
        let kept = 0;
        for (let k = 0; k < 7; k++) {
            const col = c + k - 3;
            if (col >= 0 && col < this.cols) {
                kept += this.add(col, (per * KERNEL[k]) / weight);
            }
        }
        return kept * this.colWidth;
    }

    /**
     * Let snow slide downhill where a step is steeper than the angle of repose, `passes` times.
     * Snow pushed past an open end is gone (see `fellLeft` / `fellRight`). Returns the volume
     * that moved, in px², so a caller can tell when a pile has come to rest.
     */
    public relax(passes = 1): number {
        this.fellLeft = 0;
        this.fellRight = 0;
        const n = this.cols;
        const h = this.heights;
        const limit = SnowCap.REPOSE * this.colWidth;
        let moved = 0;
        for (let pass = 0; pass < passes; pass++) {
            for (let i = 0; i < n - 1; i++) {
                // Alternate the sweep direction so piles do not lean one way.
                const k = pass % 2 === 0 ? i : n - 2 - i;
                const d = h[k] - h[k + 1];
                const over = Math.abs(d) - limit;
                if (over > 0) {
                    const m = over * 0.3;
                    if (d > 0) {
                        h[k] -= m;
                        h[k + 1] += m;
                    } else {
                        h[k] += m;
                        h[k + 1] -= m;
                    }
                    moved += m;
                }
            }
            if (this.openEnds) {
                // Past the end is nothing, and the lip may stand a little steeper than the slope.
                const lip = limit * 1.6;
                const a = h[0] - lip;
                if (a > 0) {
                    const m = a * 0.3;
                    h[0] -= m;
                    this.fellLeft += m * this.colWidth;
                }
                const b = h[n - 1] - lip;
                if (b > 0) {
                    const m = b * 0.3;
                    h[n - 1] -= m;
                    this.fellRight += m * this.colWidth;
                }
            }
        }
        // A little diffusion rounds the mounds (it moves snow between neighbours, never out).
        for (let i = 0; i < n - 1; i++) {
            const m = (h[i] - h[i + 1]) * 0.06;
            h[i] -= m;
            h[i + 1] += m;
        }
        // Keep the cap after sideways moves (a column may have received more than it can hold).
        for (let i = 0; i < n; i++) {
            if (h[i] > this.cap) {
                h[i] = this.cap;
            }
        }
        return moved * this.colWidth;
    }

    /**
     * Scoop snow out around x: a column at distance d from x loses up to `depth * (1 - (d / radius)²)` px.
     * Returns the volume removed, in px².
     */
    public carve(x: number, radius: number, depth: number): number {
        if (this.cols === 0 || radius <= 0 || depth <= 0) {
            return 0;
        }
        const h = this.heights;
        const from = Math.max(0, Math.floor((x - radius) / this.colWidth));
        const to = Math.min(this.cols - 1, Math.ceil((x + radius) / this.colWidth));
        let removed = 0;
        for (let i = from; i <= to; i++) {
            const d = Math.abs((i + 0.5) * this.colWidth - x) / radius;
            if (d >= 1) {
                continue;
            }
            const take = Math.min(h[i], depth * (1 - d * d));
            h[i] -= take;
            removed += take;
        }
        return removed * this.colWidth;
    }

    /** Wind takes the tops: columns deeper than half the deepest lose up to `depth` px, the deepest most. */
    public shave(depth: number): number {
        const top = this.deepest;
        if (top < 2 || depth <= 0) {
            return 0;
        }
        const h = this.heights;
        let removed = 0;
        for (let i = 0; i < this.cols; i++) {
            const t = h[i] / top;
            if (t > 0.5) {
                const take = Math.min(h[i], depth * t * t);
                h[i] -= take;
                removed += take;
            }
        }
        return removed * this.colWidth;
    }

    /** Every column loses `amount` px (to zero at most). Returns the volume lost, in px². */
    public melt(amount: number): number {
        return this.meltAt(0, Infinity, amount);
    }

    /** Like `melt`, but only columns within `radius` of x, strongest at x. */
    public meltAt(x: number, radius: number, amount: number): number {
        if (amount <= 0) {
            return 0;
        }
        const h = this.heights;
        let removed = 0;
        for (let i = 0; i < this.cols; i++) {
            let k = 1;
            if (radius !== Infinity) {
                const d = Math.abs((i + 0.5) * this.colWidth - x) / radius;
                if (d >= 1) {
                    continue;
                }
                k = 1 - d;
            }
            const take = Math.min(h[i], amount * k);
            h[i] -= take;
            removed += take;
        }
        return removed * this.colWidth;
    }

    /** Where along the surface (px) the snow is deepest. */
    public crest(): number {
        let best = 0;
        let at = 0;
        for (let i = 0; i < this.cols; i++) {
            if (this.heights[i] > best) {
                best = this.heights[i];
                at = i;
            }
        }
        return (at + 0.5) * this.colWidth;
    }

    private columnOf(x: number): number {
        const c = Math.floor(x / this.colWidth);
        return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
    }

    private add(column: number, amount: number): number {
        const room = this.cap - this.heights[column];
        const put = amount < room ? amount : room > 0 ? room : 0;
        this.heights[column] += put;
        return put;
    }
}
