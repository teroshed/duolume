/**
 * A row of spring columns: the ripple part of a water surface, with no drawing in it.
 *
 * Each column has a height (pixels, up is positive) and a vertical velocity (px/ms). A spring
 * pulls every column back to 0, each column pulls on its two neighbours (which is what makes a
 * disturbance spread outward as rings), and damping takes the energy out over a couple of
 * seconds. Time is advanced in fixed sub-steps, so the result does not depend on the tick
 * length and the coupling stays stable.
 *
 * Renderer-free on purpose: `Tide` draws it, `tests/tide.test.ts` checks it.
 */
export class WaterSurface {
    /** Horizontal distance between columns, in pixels. */
    public static readonly SPACING = 9;
    /** Spring pulling a column back to rest, per ms² (about 1.6 Hz on its own). */
    public static readonly STIFFNESS = 0.0001;
    /** Pull between neighbours, per ms² per pixel of height difference. Sets how fast rings run. */
    public static readonly COUPLING = 0.002;
    /** Velocity damping, per ms. Ripples are mostly gone in about two seconds. */
    public static readonly DAMPING = 0.0022;
    /** Fixed sub-step, in ms. */
    public static readonly SUBSTEP = 4;
    /** Hard limits that keep the surface finite whatever is thrown at it. */
    public static readonly MAX_HEIGHT = 90;
    public static readonly MAX_VELOCITY = 2;

    /** Column heights in pixels, up positive. Read it, do not resize it. */
    public heights: Float32Array = new Float32Array(2);
    public velocities: Float32Array = new Float32Array(2);
    /** Width the columns span, in pixels. */
    public width = 0;
    public spacing: number;

    private leftover = 0;

    constructor(width: number, spacing: number = WaterSurface.SPACING) {
        this.spacing = Math.max(2, Number.isFinite(spacing) ? spacing : WaterSurface.SPACING);
        this.resize(width);
    }

    public get count(): number {
        return this.heights.length;
    }

    /** x of column `i`, in pixels. */
    public columnX(i: number): number {
        return i * this.spacing;
    }

    /**
     * Rebuild the columns for a new width (one every `spacing` px, at least two). The current
     * shape is resampled onto the new columns, so a resize does not throw the water about.
     */
    public resize(width: number): void {
        const w = Number.isFinite(width) ? Math.max(0, width) : 0;
        const count = Math.max(2, Math.ceil(w / this.spacing) + 1);
        if (count === this.heights.length && w === this.width) {
            return;
        }
        const oldH = this.heights;
        const oldV = this.velocities;
        const oldCount = oldH.length;
        const heights = new Float32Array(count);
        const velocities = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const t = count > 1 ? (i / (count - 1)) * (oldCount - 1) : 0;
            const a = Math.min(oldCount - 1, Math.floor(t));
            const b = Math.min(oldCount - 1, a + 1);
            const f = t - a;
            heights[i] = oldH[a] + (oldH[b] - oldH[a]) * f;
            velocities[i] = oldV[a] + (oldV[b] - oldV[a]) * f;
        }
        this.heights = heights;
        this.velocities = velocities;
        this.width = w;
    }

    /**
     * Kick the surface at `x`: `velocity` (px/ms, negative pushes it down) is added to the
     * columns within `width` px of it, strongest in the middle.
     */
    public disturb(x: number, velocity: number, width: number = this.spacing * 2): void {
        if (!Number.isFinite(x) || !Number.isFinite(velocity)) {
            return;
        }
        const half = Math.max(this.spacing, Number.isFinite(width) ? width : 0) * 0.5;
        const v = this.velocities;
        const first = Math.max(0, Math.ceil((x - half) / this.spacing));
        const last = Math.min(v.length - 1, Math.floor((x + half) / this.spacing));
        const limit = WaterSurface.MAX_VELOCITY;
        for (let i = first; i <= last; i++) {
            const d = (i * this.spacing - x) / half;
            const k = 0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, Math.abs(d)));
            const next = v[i] + velocity * k;
            v[i] = next > limit ? limit : next < -limit ? -limit : next;
        }
    }

    /** Advance by `dtMs` milliseconds, in fixed sub-steps. */
    public step(dtMs: number): void {
        if (!(dtMs > 0)) {
            return;
        }
        // A long stall is not replayed: at most a quarter of a second at once.
        this.leftover = Math.min(250, this.leftover + dtMs);
        const h = this.heights;
        const v = this.velocities;
        const n = h.length;
        const dt = WaterSurface.SUBSTEP;
        const stiffness = WaterSurface.STIFFNESS;
        const coupling = WaterSurface.COUPLING;
        const damping = Math.exp(-WaterSurface.DAMPING * dt);
        const maxH = WaterSurface.MAX_HEIGHT;
        const maxV = WaterSurface.MAX_VELOCITY;
        while (this.leftover >= dt) {
            this.leftover -= dt;
            // Velocities first, from the old heights (symplectic Euler: stable for these constants).
            for (let i = 0; i < n; i++) {
                const left = i > 0 ? h[i - 1] : h[i];
                const right = i < n - 1 ? h[i + 1] : h[i];
                const a = -stiffness * h[i] + coupling * (left + right - 2 * h[i]);
                let vi = (v[i] + a * dt) * damping;
                if (!Number.isFinite(vi)) vi = 0;
                v[i] = vi > maxV ? maxV : vi < -maxV ? -maxV : vi;
            }
            for (let i = 0; i < n; i++) {
                let hi = h[i] + v[i] * dt;
                if (!Number.isFinite(hi)) hi = 0;
                h[i] = hi > maxH ? maxH : hi < -maxH ? -maxH : hi;
            }
        }
    }

    /** Height at any x, interpolated between columns (0 outside the row). */
    public heightAt(x: number): number {
        const h = this.heights;
        const t = x / this.spacing;
        if (!(t >= 0)) {
            return h[0];
        }
        const a = Math.floor(t);
        if (a >= h.length - 1) {
            return h[h.length - 1];
        }
        const f = t - a;
        return h[a] + (h[a + 1] - h[a]) * f;
    }

    /** Kinetic plus spring energy, summed over the columns. Zero when the water is flat and still. */
    public energy(): number {
        const h = this.heights;
        const v = this.velocities;
        let e = 0;
        for (let i = 0; i < h.length; i++) {
            e += v[i] * v[i] + WaterSurface.STIFFNESS * h[i] * h[i];
            if (i > 0) {
                const d = h[i] - h[i - 1];
                e += WaterSurface.COUPLING * d * d;
            }
        }
        return e * 0.5;
    }

    /** Flat and still. */
    public reset(): void {
        this.heights.fill(0);
        this.velocities.fill(0);
        this.leftover = 0;
    }
}
