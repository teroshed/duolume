import {
    Color,
    DoubleSide,
    DynamicDrawUsage,
    InstancedBufferAttribute,
    InstancedMesh,
    Matrix4,
    PlaneGeometry,
    Quaternion,
    ShaderMaterial,
    Vector3 as Vec3,
} from 'three';
import { Effect } from '../../src/Effect';
import { approach, clamp, mixColor, randomNumber } from '../../src/math';
import type { AnchorRect } from '../../src/Stage';
import type { EffectContext, Theme, TickContext, TimedContext, Vector3 } from '../../src/types';
import type { ConfettiContext } from '../contracts';

const MAX_PIECES = 900;
const FLYING = 0;
const RESTING = 1;
const LEAVING = 2;
const LEAVE_MS = 500;
/** Rest pieces checked against the force field per tick. */
const REST_STRIDE = 48;

export interface ConfettiOptions {
    /** Pieces per cannon shot at full budget, 0..300. Default `BURST` (90). */
    burst?: number;
    /** Milliseconds between the shots it fires on its own; 0 fires only on events and the key. Default `INTERVAL_MS` (9000). */
    interval?: number;
    /** Downward pull in px/ms². Default `GRAVITY` (0.0007). */
    gravity?: number;
    /** Let pieces come to rest on elements tagged "ledge". False ignores the page. Default true. */
    pageInteraction?: boolean;
}

/**
 * Paper confetti with real depth: each piece is a small two-sided rectangle in Three.js that
 * tumbles end over end, catches the light as it turns, flutters sideways as it falls and flies
 * toward and away from the viewer. It comes to rest on the floor and on page elements, lies
 * there a while, and is brushed off.
 *
 * What it listens to:
 *   - `c`: both corner cannons fire at once; on its own it fires one corner now and then.
 *   - `firework:exploded`: a burst of pieces where the shell burst, larger for a bigger shell.
 *   - `singularity:collapsed`: a big burst from the collapse. `fireflies:synced`: a small puff.
 *   - the force field: wind carries the fall, shock rings fling pieces and set them spinning,
 *     and knock resting pieces back into the air.
 *   - presses: pieces lying within reach of a press jump up again.
 *   - the page: elements tagged "ledge" catch falling pieces on their top edge.
 *
 * What it tells the others: its context (`pieces`, `resting`) and `page:hit` with
 * `kind: 'confetti'` when a piece lands on an element (at most one per element every 300 ms).
 */
export class Confetti extends Effect<ConfettiContext> {
    public effectName: string = 'confetti';

    public static readonly BURST = 90;
    public static readonly INTERVAL_MS = 9000;
    public static readonly GRAVITY = 0.0007;
    /** Air drag per millisecond at low speed; it weakens for fast pieces so a shot still climbs. */
    public static readonly DRAG = 0.0075;
    /** Speed (px/ms) above which drag falls away. */
    public static readonly DRAG_KNEE = 0.28;
    /** Peak sideways push from the flip, px/ms². */
    public static readonly FLUTTER = 0.0011;
    /** How strongly the force field moves paper, relative to a droplet. */
    public static readonly FORCE_GAIN = 1.4;
    /** Force (px/ms²) that lifts a resting piece back into the air. */
    public static readonly DISTURB = 0.0016;
    public static readonly PRESS_REACH = 80;
    public static readonly HIT_GAP_MS = 300;

    // Structure-of-arrays.
    private readonly px = new Float32Array(MAX_PIECES);
    private readonly py = new Float32Array(MAX_PIECES);
    private readonly pz = new Float32Array(MAX_PIECES);
    private readonly vx = new Float32Array(MAX_PIECES);
    private readonly vy = new Float32Array(MAX_PIECES);
    private readonly vz = new Float32Array(MAX_PIECES);
    /** Fast tumble about an in-plane axis, its current rate and its calm rate (rad/ms). */
    private readonly flip = new Float32Array(MAX_PIECES);
    private readonly flipRate = new Float32Array(MAX_PIECES);
    private readonly flipBase = new Float32Array(MAX_PIECES);
    /** Slow turn in the picture plane (rad, rad/ms). */
    private readonly yaw = new Float32Array(MAX_PIECES);
    private readonly yawRate = new Float32Array(MAX_PIECES);
    /** Direction of the flip axis within the piece. */
    private readonly axis = new Float32Array(MAX_PIECES);
    private readonly w = new Float32Array(MAX_PIECES);
    private readonly h = new Float32Array(MAX_PIECES);
    private readonly colour = new Uint8Array(MAX_PIECES);
    private readonly state = new Uint8Array(MAX_PIECES);
    /** Resting: when it starts to leave. Leaving: when it started. */
    private readonly timer = new Float64Array(MAX_PIECES);
    /** 0..1 progress of easing to lie flat. */
    private readonly settle = new Float32Array(MAX_PIECES);
    private readonly restDX = new Float32Array(MAX_PIECES);
    private readonly restYaw = new Float32Array(MAX_PIECES);
    private readonly restTilt = new Float32Array(MAX_PIECES);
    /** The element a piece lies on, or null for the floor. */
    private readonly restOn: (AnchorRect | null)[] = new Array<AnchorRect | null>(MAX_PIECES).fill(null);
    private count = 0;
    /** Every per-piece float array, for swap-removal. */
    private readonly floatArrays: (Float32Array | Float64Array)[] = [
        this.px, this.py, this.pz, this.vx, this.vy, this.vz, this.flip, this.flipRate, this.flipBase,
        this.yaw, this.yawRate, this.axis, this.w, this.h, this.timer, this.settle, this.restDX,
        this.restYaw, this.restTilt,
    ];

    private mesh!: InstancedMesh<PlaneGeometry, ShaderMaterial>;
    private colours!: InstancedBufferAttribute;
    private readonly palette: Color[] = Array.from({ length: 6 }, () => new Color());
    private paletteKey = '';
    private readonly lastHit = new Map<string, number>();
    private readonly force: Vector3 = { x: 0, y: 0 };
    private restCursor = 0;
    private nextShot = -1;
    private nextCorner = 0;
    private time = 0;
    private readonly context: ConfettiContext = { pieces: 0, resting: 0 };

    private readonly burst: number;
    private readonly interval: number;
    private readonly gravity: number;
    private readonly pageInteraction: boolean;

    // Render scratch.
    private readonly matrix = new Matrix4();
    private readonly position = new Vec3();
    private readonly scale = new Vec3();
    private readonly qFly = new Quaternion();
    private readonly qRest = new Quaternion();
    private readonly qTemp = new Quaternion();
    private readonly axisVec = new Vec3();
    private static readonly Z = new Vec3(0, 0, 1);
    private static readonly X = new Vec3(1, 0, 0);
    private static readonly Y = new Vec3(0, 1, 0);

    constructor(options: ConfettiOptions = {}) {
        super();
        this.burst = clamp(options.burst ?? Confetti.BURST, 0, 300);
        this.interval = Math.max(0, options.interval ?? Confetti.INTERVAL_MS);
        this.gravity = clamp(options.gravity ?? Confetti.GRAVITY, 0, 0.01);
        this.pageInteraction = options.pageInteraction ?? true;
    }

    public initialize(): void {
        const material = new ShaderMaterial({
            uniforms: {
                uLight: { value: new Vec3(-0.4, 0.55, 0.73).normalize() },
                uGain: { value: 0.92 },
            },
            vertexShader: /* glsl */ `
                varying vec3 vNormal;
                varying vec3 vView;
                varying vec3 vColour;
                void main() {
                    vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
                    // The plane's normal is local +z; the instance scale leaves z at 1.
                    vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * vec3(0.0, 0.0, 1.0));
                    vView = cameraPosition - world.xyz;
                    vColour = instanceColor;
                    gl_Position = projectionMatrix * viewMatrix * world;
                }
            `,
            fragmentShader: /* glsl */ `
                uniform vec3 uLight;
                uniform float uGain;
                varying vec3 vNormal;
                varying vec3 vView;
                varying vec3 vColour;
                void main() {
                    vec3 n = normalize(vNormal);
                    vec3 v = normalize(vView);
                    // Bright when it faces the key light, dark edge-on.
                    float facing = abs(dot(n, uLight));
                    float lum = 0.14 + 0.86 * facing * facing;
                    // The back of the paper is a shade darker and cooler, so a flip shows.
                    vec3 base = gl_FrontFacing ? vColour : vColour * vec3(0.55, 0.58, 0.7);
                    vec3 nv = dot(n, v) < 0.0 ? -n : n;
                    float glint = pow(max(dot(reflect(-uLight, nv), v), 0.0), 160.0);
                    vec3 colour = base * lum * uGain + vec3(0.9) * glint;
                    gl_FragColor = vec4(colour, 1.0);
                }
            `,
            side: DoubleSide,
            premultipliedAlpha: true,
            transparent: false,
            depthTest: true,
            depthWrite: true,
        });
        this.mesh = new InstancedMesh(new PlaneGeometry(1, 1), material, MAX_PIECES);
        this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
        this.colours = new InstancedBufferAttribute(new Float32Array(MAX_PIECES * 3), 3);
        this.colours.setUsage(DynamicDrawUsage);
        this.mesh.instanceColor = this.colours;
        this.mesh.count = 0;
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 5;
        this.host.three.add(this.mesh);
    }

    // ---- sources ------------------------------------------------------------------

    /** One party-cannon shot from a bottom corner (0 = left, 1 = right). */
    public fireCannon(tick: TickContext, corner: number): void {
        const { width, height } = tick.stage;
        const side = corner === 0 ? 1 : -1;
        const x = corner === 0 ? 14 : width - 14;
        const reach = clamp(Math.sqrt(height / 800), 0.8, 1.25);
        const amount = Math.round(this.burst * tick.budget.budget);
        for (let i = 0; i < amount; i++) {
            const angle = ((62 + randomNumber(-25, 25)) * Math.PI) / 180;
            const speed = (0.75 + 0.7 * Math.sqrt(Math.random())) * reach;
            const n = this.spawn(
                x + randomNumber(-6, 6),
                height + randomNumber(2, 14),
                randomNumber(-40, 40),
                Math.cos(angle) * speed * side,
                -Math.sin(angle) * speed,
                randomNumber(-0.4, 0.5),
            );
            if (n < 0) {
                return;
            }
            // Spread the shot along the barrel so it does not leave from a single point.
            this.advance(n, randomNumber(0, 45));
        }
    }

    /** A burst outward in a sphere, so some pieces come at the viewer. */
    public sphereBurst(x: number, y: number, amount: number, speedMin: number, speedMax: number): void {
        for (let i = 0; i < amount; i++) {
            const u = Math.random() * 2 - 1;
            const theta = Math.random() * Math.PI * 2;
            const ring = Math.sqrt(1 - u * u);
            const speed = randomNumber(speedMin, speedMax);
            const n = this.spawn(
                x,
                y,
                0,
                Math.cos(theta) * ring * speed,
                Math.sin(theta) * ring * speed - 0.08,
                u * speed * 0.8,
            );
            if (n < 0) {
                return;
            }
            this.advance(n, randomNumber(0, 30));
        }
    }

    private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number): number {
        if (this.count >= MAX_PIECES) {
            return -1;
        }
        const n = this.count++;
        this.px[n] = x;
        this.py[n] = y;
        this.pz[n] = z;
        this.vx[n] = vx;
        this.vy[n] = vy;
        this.vz[n] = vz;
        this.flip[n] = Math.random() * Math.PI * 2;
        this.flipBase[n] = randomNumber(0.006, 0.014) * (Math.random() < 0.5 ? -1 : 1);
        this.flipRate[n] = this.flipBase[n] * 2.6;
        this.yaw[n] = Math.random() * Math.PI * 2;
        this.yawRate[n] = randomNumber(-0.0016, 0.0016);
        this.axis[n] = Math.random() * Math.PI;
        this.w[n] = randomNumber(6, 13);
        this.h[n] = randomNumber(4, 8);
        this.colour[n] = Math.floor(Math.random() * this.palette.length);
        this.state[n] = FLYING;
        this.settle[n] = 0;
        this.restOn[n] = null;
        return n;
    }

    /** Move a fresh piece along its launch, without forces. */
    private advance(n: number, ms: number): void {
        this.px[n] += this.vx[n] * ms;
        this.py[n] += this.vy[n] * ms;
        this.pz[n] += this.vz[n] * ms;
    }

    /** Back into the air: from a shove, a press, or an element that went away. */
    private launch(n: number, vx: number, vy: number): void {
        this.state[n] = FLYING;
        this.restOn[n] = null;
        this.settle[n] = 0;
        this.vx[n] = vx;
        this.vy[n] = vy;
        this.vz[n] = randomNumber(-0.08, 0.08);
        this.flipRate[n] = this.flipBase[n] * randomNumber(3, 5);
        this.flip[n] += Math.PI * 0.5;
    }

    // ---- simulation ---------------------------------------------------------------

    public onTick(tick: TickContext): EffectContext<ConfettiContext> {
        const dt = tick.timeDelta;
        this.time = tick.time;
        const budget = tick.budget.budget;

        if (this.nextShot < 0) {
            this.nextShot = tick.time + this.interval * 0.5;
        }
        if (tick.justPressedKeys.includes('c')) {
            this.fireCannon(tick, 0);
            this.fireCannon(tick, 1);
        }
        if (this.interval > 0 && tick.time >= this.nextShot) {
            this.fireCannon(tick, this.nextCorner);
            this.nextCorner = 1 - this.nextCorner;
            this.nextShot = tick.time + this.interval * randomNumber(0.85, 1.15);
        }
        for (const event of tick.events('firework:exploded')) {
            const power = clamp(event.payload.power, 0, 1);
            const amount = Math.round((30 + 60 * power) * budget);
            this.sphereBurst(event.payload.x, event.payload.y, amount, 0.18, 0.42 + 0.3 * power);
        }
        for (const event of tick.events('singularity:collapsed')) {
            this.sphereBurst(event.payload.x, event.payload.y, Math.round(170 * budget), 0.25, 0.95);
        }
        for (const event of tick.events('fireflies:synced')) {
            this.sphereBurst(event.payload.x, event.payload.y, Math.round(16 * budget), 0.08, 0.26);
        }

        const width = tick.stage.width;
        const height = tick.stage.height;
        const distance = tick.stage.camera.position.z;
        const ledges = this.pageInteraction ? tick.stage.tagged('ledge') : [];
        const forces = tick.forces;
        const force = this.force;
        const gain = Confetti.FORCE_GAIN;
        const { px, py, pz, vx, vy, vz, flip, flipRate, flipBase, yaw, yawRate } = this;

        this.stirResting(tick);

        let resting = 0;
        for (let i = 0; i < this.count; i++) {
            const state = this.state[i];
            if (state !== FLYING) {
                if (!this.holdResting(i, dt, ledges, width, height, distance)) {
                    this.removeAt(i);
                    i--;
                    continue;
                }
                resting++;
                continue;
            }

            const speed = Math.hypot(vx[i], vy[i], vz[i]);
            const k = speed / Confetti.DRAG_KNEE;
            const drag = Confetti.DRAG / (1 + k * k);
            // Face-on to the fall it catches more air than edge-on.
            const face = Math.abs(Math.cos(flip[i]));
            const keepX = Math.exp(-drag * dt);
            const keepY = Math.exp(-drag * (0.55 + 0.9 * face) * dt);
            // Flutter only once it has slowed to a fall: the falling-card glide.
            const calm = clamp(1 - speed / 0.35, 0, 1);
            const glide = Confetti.FLUTTER * calm;

            forces.sample(px[i], py[i], force, this.effectName);
            vx[i] = (vx[i] + (force.x * gain + glide * Math.cos(flip[i])) * dt) * keepX;
            vy[i] = (vy[i] + (force.y * gain + this.gravity) * dt) * keepY;
            vz[i] = (vz[i] + glide * 0.6 * Math.sin(flip[i] + this.axis[i]) * dt) * keepX;

            // Spin: a hard shove sets it spinning; it settles to a slower tumble as it slows.
            const shove = Math.hypot(force.x, force.y) - 0.0014;
            if (shove > 0) {
                flipRate[i] += Math.sign(flipRate[i] || 1) * shove * dt * 0.2;
            }
            const target = flipBase[i] * (0.4 + 0.6 * clamp(speed / 0.5, 0, 1)) * 2.6;
            flipRate[i] = clamp(approach(flipRate[i], target, 2.5, dt), -0.06, 0.06);
            flip[i] += flipRate[i] * dt;
            yaw[i] += yawRate[i] * dt;

            const lastY = py[i];
            px[i] += vx[i] * dt;
            py[i] += vy[i] * dt;
            pz[i] = clamp(pz[i] + vz[i] * dt, -220, 260);

            if (vy[i] > 0 && Math.abs(pz[i]) < 90 && this.landOnLedge(tick, i, lastY, ledges)) {
                resting++;
                continue;
            }
            // Where it is in the picture, for the floor and the bottom edge.
            const seenY = height / 2 + ((py[i] - height / 2) * distance) / Math.max(1, distance - pz[i]);
            if (seenY >= height - 4 && Math.abs(pz[i]) < 140) {
                this.rest(i, null, tick.time);
                resting++;
                continue;
            }
            if (px[i] < -80 || px[i] > width + 80 || seenY > height + 60 || py[i] < -2000) {
                this.removeAt(i);
                i--;
            }
        }

        this.context.pieces = this.count;
        this.context.resting = resting;
        return this.publish(this.context);
    }

    private landOnLedge(tick: TickContext, i: number, lastY: number, ledges: readonly AnchorRect[]): boolean {
        const x = this.px[i];
        const y = this.py[i];
        for (const rect of ledges) {
            if (lastY < rect.y && y >= rect.y && x >= rect.x && x <= rect.x + rect.width) {
                this.py[i] = rect.y;
                this.rest(i, rect, tick.time);
                const last = this.lastHit.get(rect.name) ?? -Infinity;
                if (tick.time - last >= Confetti.HIT_GAP_MS) {
                    this.lastHit.set(rect.name, tick.time);
                    tick.emit('page:hit', { x, y: rect.y, anchor: rect.name, edge: true, kind: 'confetti' });
                }
                return true;
            }
        }
        return false;
    }

    private rest(i: number, rect: AnchorRect | null, time: number): void {
        this.state[i] = RESTING;
        this.restOn[i] = rect;
        this.restDX[i] = rect ? this.px[i] - rect.x : 0;
        this.settle[i] = 0;
        this.timer[i] = time + randomNumber(4000, 9000);
        this.restYaw[i] = randomNumber(-0.7, 0.7);
        this.restTilt[i] = randomNumber(0.45, 0.75);
        this.vx[i] = 0;
        this.vy[i] = 0;
        this.vz[i] = 0;
    }

    /** Keep a lying piece in place; false when it has finished leaving. */
    private holdResting(i: number, dt: number, ledges: readonly AnchorRect[], width: number, height: number, distance: number): boolean {
        this.settle[i] = Math.min(1, this.settle[i] + dt / 380);
        const rect = this.restOn[i];
        if (rect) {
            if (!ledges.includes(rect)) {
                // The element went away: fall again.
                this.launch(i, randomNumber(-0.03, 0.03), 0.02);
                return true;
            }
            this.px[i] = rect.x + this.restDX[i];
            this.py[i] = rect.y;
            this.pz[i] = approach(this.pz[i], 0, 6, dt);
        } else {
            // On the floor: keep its depth and sit on the bottom edge of the picture.
            this.py[i] = height / 2 + ((height - 3 - height / 2) * (distance - this.pz[i])) / distance;
            if (this.px[i] < -20 || this.px[i] > width + 20) {
                return false;
            }
        }
        if (this.state[i] === RESTING && this.time >= this.timer[i]) {
            this.state[i] = LEAVING;
            this.timer[i] = this.time;
        }
        return !(this.state[i] === LEAVING && this.time - this.timer[i] >= LEAVE_MS);
    }

    /** Shock rings, strong forces and nearby presses lift lying pieces back into the air. */
    private stirResting(tick: TickContext): void {
        const count = this.count;
        if (count === 0) {
            return;
        }
        const force = this.force;
        const checks = Math.min(REST_STRIDE, count);
        for (let c = 0; c < checks; c++) {
            const i = (this.restCursor + c) % count;
            if (this.state[i] === FLYING) {
                continue;
            }
            tick.forces.sample(this.px[i], this.py[i], force, this.effectName);
            const strength = Math.hypot(force.x, force.y);
            if (strength > Confetti.DISTURB) {
                this.launch(i, clamp(force.x * 180, -0.6, 0.6), clamp(force.y * 120, -0.5, 0.2) - randomNumber(0.12, 0.3));
            }
        }
        this.restCursor = (this.restCursor + checks) % count;

        const mouse = tick.mousePosition;
        if (!tick.mouseJustPressed || !mouse || tick.mouseOnInteractive) {
            return;
        }
        const reach = Confetti.PRESS_REACH;
        for (let i = 0; i < count; i++) {
            if (this.state[i] === FLYING) {
                continue;
            }
            const dx = this.px[i] - mouse.x;
            const dy = this.py[i] - mouse.y;
            const d = Math.hypot(dx, dy);
            if (d < reach) {
                const push = (1 - d / reach) * 0.25 + 0.12;
                this.launch(i, (dx / (d || 1)) * push + randomNumber(-0.05, 0.05), -randomNumber(0.18, 0.4));
            }
        }
    }

    private removeAt(index: number): void {
        const last = --this.count;
        if (index !== last) {
            for (const array of this.floatArrays) {
                array[index] = array[last];
            }
            this.colour[index] = this.colour[last];
            this.state[index] = this.state[last];
            this.restOn[index] = this.restOn[last];
        }
        this.restOn[last] = null;
    }

    // ---- drawing ------------------------------------------------------------------

    public onRender(timed: TimedContext): void {
        this.refreshPalette(timed.theme);
        const stage = timed.stage;
        const lead = timed.alpha * timed.tickDelta;
        const halfW = stage.width / 2;
        const halfH = stage.height / 2;
        const colours = this.colours.array as Float32Array;
        const { matrix, position, scale, qFly, qRest, qTemp, axisVec } = this;

        for (let i = 0; i < this.count; i++) {
            const flying = this.state[i] === FLYING;
            const t = flying ? lead : 0;
            const flip = this.flip[i] + (flying ? this.flipRate[i] * t : 0);
            const yaw = this.yaw[i] + (flying ? this.yawRate[i] * t : 0);

            const a = this.axis[i];
            axisVec.set(Math.cos(a), Math.sin(a), 0);
            qFly.setFromAxisAngle(Confetti.Z, yaw).multiply(qTemp.setFromAxisAngle(axisVec, flip));

            let lift = 0;
            let size = 1;
            if (!flying) {
                // Lying flat, tipped a little toward the viewer so it reads as a thin sliver.
                const tilt = this.restTilt[i];
                qRest.setFromAxisAngle(Confetti.Y, this.restYaw[i]).multiply(qTemp.setFromAxisAngle(Confetti.X, -(Math.PI / 2 - tilt)));
                const e = this.settle[i];
                const ease = e * e * (3 - 2 * e);
                qFly.slerp(qRest, ease);
                lift = (this.h[i] / 2) * Math.sin(tilt) * ease + 0.5;
                if (this.state[i] === LEAVING) {
                    size = clamp(1 - (timed.time - this.timer[i]) / LEAVE_MS, 0, 1);
                }
            }

            position.set(
                this.px[i] + this.vx[i] * t - halfW,
                halfH - (this.py[i] + this.vy[i] * t - lift),
                this.pz[i] + this.vz[i] * t,
            );
            scale.set(this.w[i] * size, this.h[i] * size, 1);
            matrix.compose(position, qFly, scale);
            this.mesh.setMatrixAt(i, matrix);

            const colour = this.palette[this.colour[i]];
            colours[i * 3] = colour.r;
            colours[i * 3 + 1] = colour.g;
            colours[i * 3 + 2] = colour.b;
        }
        this.mesh.count = this.count;
        if (this.count > 0) {
            this.mesh.instanceMatrix.needsUpdate = true;
            this.colours.needsUpdate = true;
        }
    }

    /** Six colours from the theme, rebuilt when it changes. */
    private refreshPalette(theme: Theme): void {
        const key = `${theme.accent},${theme.accentAlt},${theme.ink},${theme.glowA},${theme.glowB}`;
        if (key === this.paletteKey) {
            return;
        }
        this.paletteKey = key;
        const hexes = [
            theme.accent,
            theme.accentAlt,
            theme.glowB,
            mixColor(theme.glowA, theme.ink, 0.3),
            mixColor(theme.accentAlt, theme.ink, 0.6),
            mixColor(theme.glowB, theme.accent, 0.5),
        ];
        hexes.forEach((hex, index) => this.palette[index].setHex(hex));
    }

    public cleanup(): void {
        if (this.mesh) {
            this.mesh.removeFromParent();
            this.mesh.geometry.dispose();
            this.mesh.material.dispose();
            this.mesh.dispose();
        }
        this.count = 0;
        this.restOn.fill(null);
        this.lastHit.clear();
        this.nextShot = -1;
        this.nextCorner = 0;
        this.restCursor = 0;
        this.paletteKey = '';
        this.context.pieces = 0;
        this.context.resting = 0;
    }
}
