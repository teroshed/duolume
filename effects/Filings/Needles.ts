/**
 * The needles of one element: positions fixed, angles that swing. No Pixi, no Three: the maths
 * of "turn toward the field" lives here so that it can be tested.
 *
 * A needle is a line, not an arrow, so every direction is handled as a *line angle*: summing
 * fields is done on the doubled angle (the way nematic liquid crystals are averaged), which makes
 * "right" and "left" the same line and keeps the result smooth when two fields disagree.
 */

/** What drives the needles this tick. One object per element, filled in by the effect. */
export interface Drive {
    /** Milliseconds, the effect's clock. */
    time: number;
    width: number;
    height: number;
    /** 0: calm travelling wave (button, text); 1: a switch (flips with a wave); 2: a value (slider, bar). */
    mode: 0 | 1 | 2;
    /** Switch: the direction before and after the last flip (-1 left, +1 right), when it flipped, and where the old knob was. */
    fromD: number;
    toD: number;
    flipAt: number;
    originX: number;
    /** Value mode: eased 0..1. */
    level: number;
    /** The pointer, from the element's corner, how far it is from the rectangle, and how much it counts (0 = not at all). */
    pointerOn: boolean;
    pointerX: number;
    pointerY: number;
    pointerDist: number;
    pointerFade: number;
    /** Scene force on a 3×2 grid (columns left to right, rows top to bottom), already scaled to a field weight. */
    sceneX: Float32Array;
    sceneY: Float32Array;
}

export function makeDrive(): Drive {
    return {
        time: 0, width: 0, height: 0, mode: 0, fromD: 1, toD: 1, flipAt: -1e9, originX: 0, level: 0,
        pointerOn: false, pointerX: 0, pointerY: 0, pointerDist: 1e9, pointerFade: 0,
        sceneX: new Float32Array(6), sceneY: new Float32Array(6),
    };
}

export class Needles {
    /** Pixels between needles, ms for a wave to cross the element, and so on: tuning in one place. */
    public static readonly FLIP_MS = 200;
    public static readonly OWN_TILT = 0.8;
    public static readonly POINTER_WEIGHT = 6;
    public static readonly POINTER_SOFT = 70;
    public static readonly MAX_SCENE = 3.5;
    /** Spring: natural frequency (rad/ms) and damping ratio. Settles in about 300 ms. */
    public static readonly OMEGA = 0.019;
    public static readonly ZETA = 0.7;

    public count = 0;
    public x = new Float32Array(0);
    public y = new Float32Array(0);
    /** Line angle in (-π/2, π/2]. */
    public angle = new Float32Array(0);
    public vel = new Float32Array(0);
    /** Per needle stiffness factor, about 0.8 to 1.25. */
    public stiff = new Float32Array(0);
    /** 1 for the few needles drawn in the second accent. */
    public alt = new Uint8Array(0);

    /** A jittered grid over x0..x0+w by 0..height, shuffled so that any prefix is spread evenly. */
    public seed(x0: number, w: number, height: number, spacing: number, cap: number, rand: () => number = Math.random): void {
        const margin = 2.5;
        const aw = Math.max(0, w - margin * 2);
        const ah = Math.max(0, height - margin * 2);
        const s = Math.max(2, spacing);
        const cols = Math.max(0, Math.floor(aw / s) + (aw > 0 ? 1 : 0));
        const rows = Math.max(0, Math.floor(ah / s) + (ah > 0 ? 1 : 0));
        let n = cols * rows;
        // Too many: coarsen the grid until under the cap.
        let sx = cols > 1 ? aw / (cols - 1) : 0;
        let sy = rows > 1 ? ah / (rows - 1) : 0;
        let c = cols;
        let r = rows;
        while (n > cap && c > 1 && r > 1) {
            c = Math.max(1, Math.floor(c * 0.95));
            r = Math.max(1, Math.floor(r * 0.95));
            n = c * r;
            sx = c > 1 ? aw / (c - 1) : 0;
            sy = r > 1 ? ah / (r - 1) : 0;
        }
        this.count = n;
        this.x = new Float32Array(n);
        this.y = new Float32Array(n);
        this.angle = new Float32Array(n);
        this.vel = new Float32Array(n);
        this.stiff = new Float32Array(n);
        this.alt = new Uint8Array(n);
        let i = 0;
        for (let row = 0; row < r; row++) {
            for (let col = 0; col < c; col++) {
                const jx = (rand() - 0.5) * s * 0.5;
                const jy = (rand() - 0.5) * s * 0.5;
                this.x[i] = Math.min(x0 + w - margin, Math.max(x0 + margin, x0 + margin + (c > 1 ? col * sx : aw / 2) + jx));
                this.y[i] = Math.min(height - margin, Math.max(margin, margin + (r > 1 ? row * sy : ah / 2) + jy));
                this.stiff[i] = 0.8 + rand() * 0.45;
                this.alt[i] = rand() < 0.1 ? 1 : 0;
                this.angle[i] = (rand() - 0.5) * 0.6;
                i++;
            }
        }
        for (let k = n - 1; k > 0; k--) {
            const j = Math.floor(rand() * (k + 1));
            this.swap(k, j);
        }
    }

    private swap(a: number, b: number): void {
        let t = this.x[a]; this.x[a] = this.x[b]; this.x[b] = t;
        t = this.y[a]; this.y[a] = this.y[b]; this.y[b] = t;
        t = this.angle[a]; this.angle[a] = this.angle[b]; this.angle[b] = t;
        t = this.stiff[a]; this.stiff[a] = this.stiff[b]; this.stiff[b] = t;
        const u = this.alt[a]; this.alt[a] = this.alt[b]; this.alt[b] = u;
    }

    /** Swing the first `limit` needles toward the field `drive` describes, for `dt` ms. */
    public step(dt: number, drive: Drive, limit: number = this.count): void {
        const h = Math.min(32, Math.max(0, dt));
        if (h <= 0) {
            return;
        }
        const n = Math.min(limit, this.count);
        const { width, height, time } = drive;
        const soft2 = Needles.POINTER_SOFT * Needles.POINTER_SOFT;
        const pointerReach = drive.pointerOn && drive.pointerFade > 0.001;
        // Over the element the needles run round the pointer; from outside they point at it.
        const toward = Math.min(1, Math.max(0, drive.pointerDist / 40));
        const toward2 = toward * toward * (3 - 2 * toward);
        const pw = Needles.POINTER_WEIGHT * drive.pointerFade;
        const valueX = drive.level * width;
        const valueY = height / 2;
        const px0 = drive.pointerX;
        const py0 = drive.pointerY;
        const sx = drive.sceneX;
        const sy = drive.sceneY;
        const colMax = 1 / Math.max(1, width);
        const rowMax = 1 / Math.max(1, height);

        for (let i = 0; i < n; i++) {
            const x = this.x[i];
            const y = this.y[i];
            let C = 0;
            let S = 0;

            // 1. The element's own field.
            if (drive.mode === 1) {
                const d = time - drive.flipAt >= (Math.abs(x - drive.originX) / Math.max(1, width)) * Needles.FLIP_MS ? drive.toD : drive.fromD;
                const vy = -Needles.OWN_TILT;
                const m2 = d * d + vy * vy;
                C += (d * d - vy * vy) / m2;
                S += (2 * d * vy) / m2;
            } else if (drive.mode === 2) {
                const d = 2 * drive.level - 1;
                const vy = -Needles.OWN_TILT;
                const m2 = d * d + vy * vy;
                C += (d * d - vy * vy) / m2;
                S += (2 * d * vy) / m2;
                // A gentle curl round where the value is.
                const dx = valueX - x;
                const dy = valueY - y;
                const r2 = dx * dx + dy * dy + 1e-3;
                const w = 1.6 * Math.exp(-r2 / (2 * 24 * 24));
                C -= (w * (dx * dx - dy * dy)) / r2;
                S -= (w * 2 * dx * dy) / r2;
            } else {
                const vy = 0.35 * Math.sin(time * 0.0012 - x * 0.045 + y * 0.03);
                const m2 = 1 + vy * vy;
                C += (1 - vy * vy) / m2;
                S += (2 * vy) / m2;
            }

            // 2. The pointer.
            if (pointerReach) {
                const dx = px0 - x;
                const dy = py0 - y;
                const r2 = dx * dx + dy * dy + 1e-3;
                const w = pw / (1 + r2 / soft2);
                const rc = (dx * dx - dy * dy) / r2;
                const rs = (2 * dx * dy) / r2;
                // radial counts +, tangential (a quarter turn: doubled, a half turn) counts -
                const k = w * (toward2 - (1 - toward2));
                C += k * rc;
                S += k * rs;
            }

            // 3. The scene, interpolated from the coarse grid.
            const fx = Math.min(1, Math.max(0, x * colMax)) * 2;
            const col = Math.min(1, Math.floor(fx));
            const tx = fx - col;
            const row = y * rowMax > 0.5 ? 1 : 0;
            const a0 = row * 3 + col;
            const ax = sx[a0] + (sx[a0 + 1] - sx[a0]) * tx;
            const ay = sy[a0] + (sy[a0 + 1] - sy[a0]) * tx;
            const am2 = ax * ax + ay * ay;
            if (am2 > 1e-8) {
                const m = Math.sqrt(am2);
                const w = Math.min(Needles.MAX_SCENE, m);
                C += (w * (ax * ax - ay * ay)) / am2;
                S += (w * 2 * ax * ay) / am2;
            }

            // The spring.
            const target = 0.5 * Math.atan2(S, C);
            let e = target - this.angle[i];
            e -= Math.PI * Math.round(e / Math.PI);
            const omega = Needles.OMEGA * Math.sqrt(this.stiff[i]);
            let v = this.vel[i];
            v += (omega * omega * e - 2 * Needles.ZETA * omega * v) * h;
            let a = this.angle[i] + v * h;
            a -= Math.PI * Math.round(a / Math.PI);
            this.vel[i] = v;
            this.angle[i] = a;
        }
    }

    /** A tap on the glass: every needle near (px, py) gets a spin, in a direction of its own. */
    public kick(px: number, py: number, amount: number, reach = 45): void {
        for (let i = 0; i < this.count; i++) {
            const dx = this.x[i] - px;
            const dy = this.y[i] - py;
            const close = Math.exp(-Math.sqrt(dx * dx + dy * dy) / reach);
            if (close > 0.02) {
                this.vel[i] += (i % 2 === 0 ? 1 : -1) * amount * close * (0.6 + this.stiff[i] * 0.4);
            }
        }
    }
}
