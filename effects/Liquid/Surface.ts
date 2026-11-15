/**
 * The surface of a small body of liquid: a row of spring columns, with no drawing in it.
 *
 * The columns run along the surface, one every 4 to 6 pixels and at least `MIN_COLUMNS`, the
 * first at 0 and the last at `length`. Each has a height offset (pixels, positive is "more
 * liquid": up for a glass, forward for a bar filled from the side) and a velocity (px/ms). A
 * spring pulls every column back to level, each column pulls on its neighbours (which is what
 * makes a poke spread as ripples and a tilt slosh), and damping takes the energy out in about a
 * second. Time advances in fixed sub-steps, so the result does not depend on the tick length.
 *
 * Renderer-free on purpose: `Liquid` draws it, `tests/liquid.test.ts` checks it.
 */
export class Surface {
    /** Wanted distance between columns, in pixels; the real one is fitted to the length. */
    public static readonly SPACING = 5;
    public static readonly MIN_COLUMNS = 6;
    /** Spring pulling a column back to level, per ms² (about 4 Hz on its own: a small glass). */
    public static readonly SPRING = 0.0006;
    /** Pull between neighbours, per ms² per pixel of height difference. Sets how fast ripples run. */
    public static readonly COUPLING = 0.003;
    /** Velocity damping, per ms. A ripple is down to a few percent after a second. */
    public static readonly DAMPING = 0.006;
    /** Fixed sub-step, in ms. */
    public static readonly SUBSTEP = 4;
    public static readonly MAX_VELOCITY = 1.5;

    public heights: Float32Array = new Float32Array(Surface.MIN_COLUMNS);
    public velocities: Float32Array = new Float32Array(Surface.MIN_COLUMNS);
    /** Length the columns span, in pixels. */
    public length = 0;
    /** Distance between columns, in pixels. */
    public spacing = 1;
    /** Largest height offset either way, in pixels. Set it from the vessel's size. */
    public limit: number;
    /** Multiplier on the spring and the damping: lower settles more slowly. */
    public stiffness: number;

    private leftover = 0;

    constructor(length: number, limit = 12, stiffness = 1) {
        this.limit = Number.isFinite(limit) && limit > 0 ? limit : 12;
        this.stiffness = Number.isFinite(stiffness) ? Math.min(4, Math.max(0.1, stiffness)) : 1;
        this.resize(length);
    }

    public get count(): number {
        return this.heights.length;
    }

    /** Position of column `i` along the surface, in pixels. */
    public columnAt(i: number): number {
        return i * this.spacing;
    }

    /** Rebuild the columns for a new length. The current shape is resampled onto them. */
    public resize(length: number): void {
        const l = Number.isFinite(length) ? Math.max(0, length) : 0;
        const count = Math.max(Surface.MIN_COLUMNS, Math.round(l / Surface.SPACING) + 1);
        if (count === this.heights.length && l === this.length) {
            return;
        }
        const oldH = this.heights;
        const oldV = this.velocities;
        const oldCount = oldH.length;
        if (count !== oldCount) {
            const heights = new Float32Array(count);
            const velocities = new Float32Array(count);
            for (let i = 0; i < count; i++) {
                const t = (i / (count - 1)) * (oldCount - 1);
                const a = Math.min(oldCount - 1, Math.floor(t));
                const b = Math.min(oldCount - 1, a + 1);
                const f = t - a;
                heights[i] = oldH[a] + (oldH[b] - oldH[a]) * f;
                velocities[i] = oldV[a] + (oldV[b] - oldV[a]) * f;
            }
            this.heights = heights;
            this.velocities = velocities;
        }
        this.length = l;
        this.spacing = l > 0 ? l / (count - 1) : 1;
    }

    /** Push the columns within `width` px of `at` by `velocity` (px/ms), strongest in the middle. */
    public poke(at: number, velocity: number, width: number = this.spacing * 2): void {
        if (!Number.isFinite(at) || !Number.isFinite(velocity)) {
            return;
        }
        const half = Math.max(this.spacing, Number.isFinite(width) ? width : 0) * 0.5;
        const first = Math.max(0, Math.ceil((at - half) / this.spacing));
        const last = Math.min(this.count - 1, Math.floor((at + half) / this.spacing));
        for (let i = first; i <= last; i++) {
            const d = Math.min(1, Math.abs(i * this.spacing - at) / half);
            this.kick(i, velocity * (0.5 + 0.5 * Math.cos(Math.PI * d)));
        }
    }

    /** Slosh: `velocity` (px/ms) at the far end, the opposite at the near end, nothing in the middle. */
    public tilt(velocity: number): void {
        if (!Number.isFinite(velocity)) {
            return;
        }
        const n = this.count;
        for (let i = 0; i < n; i++) {
            this.kick(i, velocity * ((2 * i) / (n - 1) - 1));
        }
    }

    /** A bump from above or below: the middle goes one way and the ends the other (the second sloshing mode). */
    public heave(velocity: number): void {
        if (!Number.isFinite(velocity)) {
            return;
        }
        const n = this.count;
        for (let i = 0; i < n; i++) {
            this.kick(i, velocity * Math.cos((2 * Math.PI * i) / (n - 1)));
        }
    }

    /** Advance by `dtMs` milliseconds. */
    public step(dtMs: number): void {
        if (!(dtMs > 0)) {
            return;
        }
        // A long stall is not replayed.
        this.leftover = Math.min(250, this.leftover + dtMs);
        const h = this.heights;
        const v = this.velocities;
        const n = h.length;
        const dt = Surface.SUBSTEP;
        const spring = Surface.SPRING * this.stiffness;
        const coupling = Surface.COUPLING;
        const damping = Math.exp(-Surface.DAMPING * this.stiffness * dt);
        const maxV = Surface.MAX_VELOCITY;
        const maxH = this.limit;
        while (this.leftover >= dt) {
            this.leftover -= dt;
            // Velocities from the old heights, then heights from the new velocities (symplectic Euler).
            for (let i = 0; i < n; i++) {
                const left = i > 0 ? h[i - 1] : h[i];
                const right = i < n - 1 ? h[i + 1] : h[i];
                const a = -spring * h[i] + coupling * (left + right - 2 * h[i]);
                let next = (v[i] + a * dt) * damping;
                next = next > maxV ? maxV : next < -maxV ? -maxV : next;
                v[i] = next;
            }
            for (let i = 0; i < n; i++) {
                let next = h[i] + v[i] * dt;
                if (next > maxH || next < -maxH) {
                    next = next > 0 ? maxH : -maxH;
                    v[i] *= -0.3;
                }
                h[i] = next;
            }
        }
    }

    /** Height at a position along the surface, interpolated between columns. */
    public heightAt(at: number): number {
        const h = this.heights;
        if (!(at > 0)) {
            return h[0];
        }
        const t = at / this.spacing;
        if (t >= h.length - 1) {
            return h[h.length - 1];
        }
        const a = Math.floor(t);
        return h[a] + (h[a + 1] - h[a]) * (t - a);
    }

    /** Kinetic plus spring energy, in arbitrary units: 0 when the surface is still and level. */
    public energy(): number {
        const h = this.heights;
        const v = this.velocities;
        const spring = Surface.SPRING * this.stiffness;
        let e = 0;
        for (let i = 0; i < h.length; i++) {
            e += 0.5 * v[i] * v[i] + 0.5 * spring * h[i] * h[i];
            if (i > 0) {
                const d = h[i] - h[i - 1];
                e += 0.5 * Surface.COUPLING * d * d;
            }
        }
        return e;
    }

    /** Everything level and still. */
    public calm(): void {
        this.heights.fill(0);
        this.velocities.fill(0);
        this.leftover = 0;
    }

    private kick(i: number, dv: number): void {
        const v = this.velocities;
        const next = v[i] + dv;
        const limit = Surface.MAX_VELOCITY;
        v[i] = next > limit ? limit : next < -limit ? -limit : next;
    }
}
