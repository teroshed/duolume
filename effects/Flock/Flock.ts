import { Particle as PixiParticle, ParticleContainer, Rectangle, Texture } from 'pixi.js';
import { Effect } from '../../src/Effect';
import { clamp, mixColor, randomNumber } from '../../src/math';
import type { AnchorRect } from '../../src/Stage';
import type { EffectContext, TickContext, TimedContext, Vector3 } from '../../src/types';
import type { FlockContext } from '../contracts';
import { drawAtlas, ATLAS_CELL as CELL } from './birdAtlas';
import { DEFAULT_RULES, edgeSteer, integrate, steer, type BoidRules } from './boids';
import { Fears } from './fears';

export interface FlockOptions {
    /** Birds at full frame budget, 0..150. Default `COUNT` (60). */
    count?: number;
    /** Land on page elements tagged "ledge". False keeps every bird in the air. Default true. */
    perch?: boolean;
    /** Multiplier on flying speed, 0.2..3. Default `SPEED` (1). */
    speed?: number;
    /** Multiplier on how strongly the birds flee and how easily they startle; 0 or less is fearless. Default `FEAR` (1). */
    fear?: number;
}

const MAX_BIRDS = 150;
const FLYING = 0;
const LANDING = 1;
const PERCHED = 2;
/** Surplus birds on their way off the stage. */
const LEAVING = 3;

/** Texture pixels per stage pixel: drawn large, shown small, so they stay crisp. */
const FLY_SCALE = 11 / 28;
const PERCH_SCALE = 0.3;

/**
 * A flock of small birds that treats the page as its landscape. In the air they are boids
 * (separation, alignment, cohesion) wheeling together across the stage; when things are calm,
 * some peel off and sit in a row on top of page elements, shuffle about, and take off again.
 * Anything alarming sends every bird near it into the air at once.
 *
 * What it listens to:
 *   - the force field: wind carries the flock, shock rings scatter it.
 *   - `rainEater`, `serpent` and `singularity` contexts: flying birds keep clear of their positions.
 *   - presses (not on links or buttons), and a fast-moving or pressed pointer, which they avoid.
 *   - `crystal:exploded`, `rainEater:exploded`, `lightning:strike`, `firework:exploded`,
 *     `meteor:impact`, `bubble:popped`, `singularity:collapsed`: birds within range take fright.
 *   - `page:hit` (anything but rain): birds sitting on that element fly off.
 *   - elements tagged "ledge": perches, followed as they move. `rain` context: while its
 *     `dropCount` is above 20, no bird lands and those sitting leave within about three seconds.
 * What it tells the others: its `count`, `perched`, `center` and `heading`, and a
 * `flock:startled` event when three or more birds take fright at once.
 * Keys: none.
 */
export class Flock extends Effect<FlockContext> {
    public effectName = 'flock';

    public static readonly COUNT = 60;
    public static readonly SPEED = 1;
    public static readonly FEAR = 1;
    /** Chance per second that a calm flying bird looks for a perch. */
    public static readonly PERCH_CHANCE = 0.05;
    /** Calm time before a bird thinks of landing, ms. */
    public static readonly CALM_BEFORE_PERCH = 3000;
    /** Most of the flock that may sit at once. */
    public static readonly PERCHED_SHARE = 0.45;
    public static readonly PERCH_REACH = 500;
    /** Spacing of perch slots along an element's top edge, and their inset from its ends, px. */
    public static readonly SLOT = 16;
    public static readonly SLOT_INSET = 8;
    public static readonly STARTLE_MS = 1500;
    /** Share of the force field's acceleration the birds feel. */
    public static readonly FORCE_GAIN = 0.15;

    private readonly maxCount: number;
    private readonly perchEnabled: boolean;
    private readonly fear: number;
    private readonly rules: BoidRules;

    private n = 0;
    private readonly px = new Float32Array(MAX_BIRDS);
    private readonly py = new Float32Array(MAX_BIRDS);
    private readonly vx = new Float32Array(MAX_BIRDS);
    private readonly vy = new Float32Array(MAX_BIRDS);
    /** What the force field adds on top of the bird's own flight, px/ms. */
    private readonly driftX = new Float32Array(MAX_BIRDS);
    private readonly driftY = new Float32Array(MAX_BIRDS);
    private readonly state = new Uint8Array(MAX_BIRDS);
    /** Non-zero for birds that are not part of the flock in the air. */
    private readonly skip = new Uint8Array(MAX_BIRDS);
    private readonly calm = new Float32Array(MAX_BIRDS);
    private readonly startle = new Float32Array(MAX_BIRDS);
    private readonly phase = new Float32Array(MAX_BIRDS);
    private readonly turn = new Float32Array(MAX_BIRDS);
    private readonly tone = new Float32Array(MAX_BIRDS);
    private readonly alt = new Uint8Array(MAX_BIRDS);
    private readonly facing = new Int8Array(MAX_BIRDS);
    private readonly slot = new Int16Array(MAX_BIRDS);
    private readonly ledge: string[] = new Array<string>(MAX_BIRDS).fill('');
    /** Perched: when it leaves. Landing: when it set off. */
    private readonly until = new Float64Array(MAX_BIRDS);
    private readonly fidgetAt = new Float64Array(MAX_BIRDS);
    private readonly hopAt = new Float64Array(MAX_BIRDS);
    private readonly hopFrom = new Float32Array(MAX_BIRDS);
    /** Landing: start point, control point, duration. */
    private readonly fromX = new Float32Array(MAX_BIRDS);
    private readonly fromY = new Float32Array(MAX_BIRDS);
    private readonly ctrlX = new Float32Array(MAX_BIRDS);
    private readonly ctrlY = new Float32Array(MAX_BIRDS);
    private readonly landMs = new Float32Array(MAX_BIRDS);

    private readonly fears = new Fears();
    private readonly acc: Vector3 = { x: 0, y: 0 };
    private readonly vel: Vector3 = { x: 0, y: 0 };
    private readonly force: Vector3 = { x: 0, y: 0 };
    private readonly slotOut: Vector3 = { x: 0, y: 0 };
    private readonly context: FlockContext = { count: 0, perched: 0, center: { x: 0, y: 0 }, heading: { x: 0, y: 0 } };
    private seeded = false;
    private spawnAt = 0;
    private lastStartled = -Infinity;

    private container: ParticleContainer | undefined;
    private atlas: Texture | undefined;
    private flyTexture: Texture | undefined;
    private perchTexture: Texture | undefined;
    private readonly views: PixiParticle[] = [];

    constructor(options: FlockOptions = {}) {
        super();
        this.maxCount = Math.round(clamp(options.count ?? Flock.COUNT, 0, MAX_BIRDS));
        this.perchEnabled = options.perch ?? true;
        this.fear = Math.max(0, options.fear ?? Flock.FEAR);
        const speed = clamp(options.speed ?? Flock.SPEED, 0.2, 3);
        this.rules = { ...DEFAULT_RULES, minSpeed: DEFAULT_RULES.minSpeed * speed, maxSpeed: DEFAULT_RULES.maxSpeed * speed };
    }

    public initialize(): void {
        this.atlas = Texture.from(drawAtlas());
        this.flyTexture = new Texture({ source: this.atlas.source, frame: new Rectangle(0, 0, CELL, CELL) });
        this.perchTexture = new Texture({ source: this.atlas.source, frame: new Rectangle(CELL, 0, CELL, CELL) });
        this.container = new ParticleContainer({
            texture: this.flyTexture,
            dynamicProperties: { position: true, rotation: true, vertex: true, color: true, uvs: true },
        });
        this.host.pixi.addChild(this.container);
        for (let i = 0; i < this.maxCount; i++) {
            const view = new PixiParticle({ texture: this.flyTexture, anchorX: 0.5, anchorY: 0.5, alpha: 0 });
            this.views.push(view);
            this.container.addParticle(view);
        }
    }

    public onTick(tick: TickContext): EffectContext<FlockContext> {
        const width = tick.stage.width;
        const height = tick.stage.height;
        const dt = tick.timeDelta;
        const time = tick.time;
        const target = Math.round(this.maxCount * clamp(tick.budget.budget, 0, 1));
        if (!this.seeded && width > 1) {
            this.seeded = true;
            this.seed(target, width, height);
        }
        this.population(target, width, height, time);
        this.fears.gather(tick);
        this.frighten(tick, time);

        const raining = (tick.read('rain')?.dropCount ?? 0) > 20;
        const ledges = this.perchEnabled ? tick.stage.tagged('ledge') : undefined;
        let settled = 0;
        for (let i = 0; i < this.n; i++) {
            if (this.state[i] === LANDING || this.state[i] === PERCHED) {
                settled++;
            }
            this.skip[i] = this.state[i] === FLYING ? 0 : 1;
        }
        const maxSettled = Math.floor(this.n * Flock.PERCHED_SHARE);
        const perchChance = 1 - Math.exp((-Flock.PERCH_CHANCE * dt) / 1000);

        for (let i = 0; i < this.n; i++) {
            switch (this.state[i]) {
                case FLYING:
                case LEAVING:
                    this.fly(i, tick, width, height);
                    if (
                        this.state[i] === FLYING &&
                        ledges &&
                        ledges.length > 0 &&
                        !raining &&
                        settled < maxSettled &&
                        this.calm[i] > Flock.CALM_BEFORE_PERCH &&
                        Math.random() < perchChance &&
                        this.choosePerch(i, ledges, time)
                    ) {
                        settled++;
                    }
                    break;
                case LANDING:
                    this.land(i, tick, time, dt);
                    break;
                case PERCHED:
                    this.sit(i, tick, time, dt, raining);
                    break;
            }
        }

        // Surplus birds that have left the stage are gone.
        for (let i = this.n - 1; i >= 0; i--) {
            if (this.state[i] === LEAVING && (this.px[i] < -40 || this.px[i] > width + 40 || this.py[i] < -40 || this.py[i] > height + 40)) {
                this.copyBird(this.n - 1, i);
                this.n--;
            }
        }
        this.publishState();
        return this.publish(this.context);
    }

    /** The first flock: already in the air, together, heading the same way. */
    private seed(target: number, width: number, height: number): void {
        const heading = randomNumber(-0.6, 0.6);
        for (let i = 0; i < target; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random());
            this.addBird(width * 0.35 + Math.cos(a) * r * 140, height * 0.32 + Math.sin(a) * r * 70, heading + randomNumber(-0.3, 0.3));
        }
    }

    /** Fly in the missing birds from an edge, and send surplus ones off the stage. */
    private population(target: number, width: number, height: number, time: number): void {
        let present = 0;
        for (let i = 0; i < this.n; i++) {
            if (this.state[i] !== LEAVING) {
                present++;
            }
        }
        if (present > target) {
            // One at a time, a flying bird first.
            let pick = -1;
            for (let i = 0; i < this.n && pick < 0; i++) {
                pick = this.state[i] === FLYING ? i : -1;
            }
            for (let i = 0; i < this.n && pick < 0; i++) {
                pick = this.state[i] !== LEAVING ? i : -1;
            }
            if (pick >= 0) {
                if (this.state[pick] !== FLYING) {
                    this.takeOff(pick, this.px[pick], this.py[pick] + 20, false);
                }
                this.state[pick] = LEAVING;
            }
        } else if (present < target && this.n < this.views.length && time >= this.spawnAt) {
            this.spawnAt = time + 150;
            const fromLeft = Math.random() < 0.5;
            const y = height * randomNumber(0.1, 0.6);
            this.addBird(fromLeft ? -20 : width + 20, y, (fromLeft ? 0 : Math.PI) + randomNumber(-0.3, 0.3));
        }
    }

    private addBird(x: number, y: number, angle: number): void {
        if (this.n >= this.views.length) {
            return;
        }
        const i = this.n++;
        const speed = (this.rules.minSpeed + this.rules.maxSpeed) / 2;
        this.px[i] = x;
        this.py[i] = y;
        this.vx[i] = Math.cos(angle) * speed;
        this.vy[i] = Math.sin(angle) * speed;
        this.driftX[i] = 0;
        this.driftY[i] = 0;
        this.state[i] = FLYING;
        this.calm[i] = randomNumber(0, Flock.CALM_BEFORE_PERCH);
        this.startle[i] = 0;
        this.phase[i] = Math.random() * Math.PI * 2;
        this.turn[i] = 0;
        this.tone[i] = Math.random();
        this.alt[i] = Math.random() < 0.1 ? 1 : 0;
        this.facing[i] = 1;
        this.ledge[i] = '';
    }

    private copyBird(from: number, to: number): void {
        const arrays = [this.px, this.py, this.vx, this.vy, this.driftX, this.driftY, this.state, this.skip, this.calm, this.startle,
            this.phase, this.turn, this.tone, this.alt, this.facing, this.slot, this.until, this.fidgetAt, this.hopAt, this.hopFrom,
            this.fromX, this.fromY, this.ctrlX, this.ctrlY, this.landMs];
        for (const array of arrays) {
            array[to] = array[from];
        }
        this.ledge[to] = this.ledge[from];
    }

    /** Every bird in range of an alarm takes fright: flying ones dart away, sitting ones take off. */
    private frighten(tick: TickContext, time: number): void {
        if (this.fear <= 0) {
            return;
        }
        const { alarms, alarmCount } = this.fears;
        for (let a = 0; a < alarmCount; a++) {
            const alarm = alarms[a];
            let frightened = 0;
            for (let i = 0; i < this.n; i++) {
                const s = this.state[i];
                if (s === LEAVING) {
                    continue;
                }
                if (alarm.anchor !== '') {
                    if (s === FLYING || this.ledge[i] !== alarm.anchor) {
                        continue;
                    }
                } else if (Math.hypot(this.px[i] - alarm.x, this.py[i] - alarm.y) > alarm.range) {
                    continue;
                }
                frightened++;
                if (s === FLYING) {
                    this.dart(i, alarm.x, alarm.y);
                } else {
                    this.takeOff(i, alarm.x, alarm.y, true);
                }
            }
            if (frightened >= 3 && time - this.lastStartled >= 400) {
                this.lastStartled = time;
                tick.emit('flock:startled', { x: alarm.x, y: alarm.y, count: frightened });
            }
        }
    }

    /** An impulse straight away from (x, y), a little scattered, and faster flight for a while. */
    private dart(i: number, x: number, y: number): void {
        const angle = Math.atan2(this.py[i] - y, this.px[i] - x) + randomNumber(-0.45, 0.45);
        const speed = this.rules.maxSpeed * 1.7 * Math.min(1.3, 0.6 + 0.4 * this.fear);
        this.vx[i] = this.vx[i] * 0.25 + Math.cos(angle) * speed;
        this.vy[i] = this.vy[i] * 0.25 + Math.sin(angle) * speed;
        this.startle[i] = Flock.STARTLE_MS;
        this.calm[i] = 0;
    }

    /**
     * Leave a perch (or abandon a landing) with a hop up. Calm birds set off gently; frightened
     * ones burst away from (x, y), each at its own angle and speed.
     */
    private takeOff(i: number, x: number, y: number, frightened: boolean): void {
        let angle = Math.atan2(this.py[i] - y, this.px[i] - x) + randomNumber(-0.6, 0.6);
        // Always upward: a bird does not take off into its own element.
        angle = clamp(angle > 0 ? -angle : angle, -Math.PI + 0.35, -0.35);
        const speed = frightened ? this.rules.maxSpeed * randomNumber(1.1, 1.7) : randomNumber(0.12, 0.16);
        this.state[i] = FLYING;
        this.ledge[i] = '';
        this.py[i] -= 2;
        this.vx[i] = Math.cos(angle) * speed;
        this.vy[i] = Math.sin(angle) * speed;
        this.driftX[i] = 0;
        this.driftY[i] = 0;
        this.calm[i] = 0;
        this.startle[i] = frightened ? Flock.STARTLE_MS : 0;
    }

    private fly(i: number, tick: TickContext, width: number, height: number): void {
        const dt = tick.timeDelta;
        const time = tick.time;
        const acc = this.acc;
        const x = this.px[i];
        const y = this.py[i];
        const vx = this.vx[i];
        const vy = this.vy[i];
        const speed = Math.hypot(vx, vy) || 1;
        if (this.state[i] === LEAVING) {
            // Head for the nearest side.
            const left = x;
            const right = width - x;
            acc.x = left < right ? -0.0004 : 0.0004;
            acc.y = -0.00005;
        } else {
            steer(i, this.px, this.py, this.vx, this.vy, this.n, this.rules, acc, this.skip);
            // A slow shared roaming point, so the flock covers the stage instead of circling one spot.
            const wx = width * (0.5 + 0.36 * Math.sin(time * 0.000071 + 1.3)) - x;
            const wy = height * (0.4 + 0.24 * Math.sin(time * 0.000113 + 0.4)) - y;
            const wd = Math.hypot(wx, wy) || 1;
            acc.x += (wx / wd) * 0.00005;
            acc.y += (wy / wd) * 0.00005;
            // Scattered groups drift back together.
            const gx = this.context.center.x - x;
            const gy = this.context.center.y - y;
            const gd = Math.hypot(gx, gy);
            if (gd > 60) {
                acc.x += (gx / gd) * 0.00005;
                acc.y += (gy / gd) * 0.00005;
            }
            // A shared bias to turn, which swings from one side to the other: the flock wheels together.
            const wheel = Math.sin(time * 0.00023) * Math.sin(time * 0.00007 + 2);
            acc.x += (-vy / speed) * wheel * 0.00016;
            acc.y += (vx / speed) * wheel * 0.00016;
            // Each bird wavers a little on its own, so the flock breathes instead of flying in formation.
            const own = this.tone[i] * 40;
            acc.x += Math.sin(time * 0.0013 + own) * 0.00006;
            acc.y += Math.cos(time * 0.0011 + own * 1.7) * 0.00006;
            edgeSteer(x, y, width, height, 80, (this.rules.maxSpeed * this.rules.maxSpeed) / 60, acc);
        }
        // Keep clear of predators and a pressed or fast pointer.
        let afraid = false;
        const threats = this.fears.threats;
        for (let t = 0; t < this.fears.threatCount && this.fear > 0; t++) {
            const dx = x - threats[t * 3];
            const dy = y - threats[t * 3 + 1];
            const range = threats[t * 3 + 2];
            const d = Math.hypot(dx, dy);
            if (d < range && d > 0.001) {
                const k = (1 - d / range) * 0.0018 * this.fear;
                acc.x += (dx / d) * k;
                acc.y += (dy / d) * k;
                afraid = true;
            }
        }
        const startled = this.startle[i] > 0 || afraid;
        const boost = startled ? 1.7 : 1;
        integrate(vx, vy, acc.x, acc.y, dt, this.rules, boost, this.vel);
        let turn = Math.atan2(this.vel.y, this.vel.x) - Math.atan2(vy, vx);
        turn = turn > Math.PI ? turn - Math.PI * 2 : turn < -Math.PI ? turn + Math.PI * 2 : turn;
        this.turn[i] = turn / dt;
        this.vx[i] = this.vel.x;
        this.vy[i] = this.vel.y;

        // Birds are light: the field carries them on top of their own flight, and lets go slowly.
        tick.forces.sample(x, y, this.force, this.effectName);
        const decay = Math.exp(-dt / 600);
        this.driftX[i] = this.driftX[i] * decay + this.force.x * Flock.FORCE_GAIN * dt;
        this.driftY[i] = this.driftY[i] * decay + this.force.y * Flock.FORCE_GAIN * dt;

        this.px[i] = x + (this.vel.x + this.driftX[i]) * dt;
        this.py[i] = y + (this.vel.y + this.driftY[i]) * dt;
        this.phase[i] += dt * 0.024 * (startled ? 1.6 : 1);
        this.startle[i] = Math.max(0, this.startle[i] - dt);
        this.calm[i] = afraid || startled ? 0 : this.calm[i] + dt;
    }

    /** The ledge a bird sits on, if it is still there and still a ledge. */
    private ledgeOf(tick: TickContext, i: number): AnchorRect | undefined {
        const rect = tick.stage.anchor(this.ledge[i]);
        return rect && rect.visible && rect.tags.includes('ledge') ? rect : undefined;
    }

    /** Where slot `k` of `rect` is, or false when the element is too short to have it. */
    private slotPosition(rect: AnchorRect, k: number, out: Vector3): boolean {
        const span = rect.width - Flock.SLOT_INSET * 2;
        if (span < 0 || k < 0) {
            return false;
        }
        const slots = Math.floor(span / Flock.SLOT) + 1;
        if (k >= slots) {
            return false;
        }
        out.x = rect.x + Flock.SLOT_INSET + (span - (slots - 1) * Flock.SLOT) / 2 + k * Flock.SLOT;
        out.y = rect.y;
        return true;
    }

    private slotTaken(name: string, k: number, except: number): boolean {
        for (let j = 0; j < this.n; j++) {
            if (j !== except && (this.state[j] === LANDING || this.state[j] === PERCHED) && this.slot[j] === k && this.ledge[j] === name) {
                return true;
            }
        }
        return false;
    }

    /** Pick the free slot nearest the bird on the nearest ledge in reach, and start gliding to it. */
    private choosePerch(i: number, ledges: readonly AnchorRect[], time: number): boolean {
        const x = this.px[i];
        const y = this.py[i];
        let best: AnchorRect | undefined;
        let bestD = Flock.PERCH_REACH;
        for (const rect of ledges) {
            const d = Math.hypot(clamp(x, rect.x, rect.x + rect.width) - x, rect.y - y);
            if (d < bestD && rect.y > 20) {
                bestD = d;
                best = rect;
            }
        }
        if (!best || !this.slotPosition(best, 0, this.slotOut)) {
            return false;
        }
        const slots = Math.floor((best.width - Flock.SLOT_INSET * 2) / Flock.SLOT) + 1;
        const near = clamp(Math.round((x - this.slotOut.x) / Flock.SLOT), 0, slots - 1);
        for (let step = 0; step < slots * 2; step++) {
            const k = near + (step % 2 === 0 ? step / 2 : -(step + 1) / 2);
            if (k < 0 || k >= slots || this.slotTaken(best.name, k, i)) {
                continue;
            }
            this.slotPosition(best, k, this.slotOut);
            const dist = Math.hypot(this.slotOut.x - x, this.slotOut.y - y);
            const reach = Math.min(dist * 0.45, 140);
            const speed = Math.hypot(this.vx[i], this.vy[i]) || 1;
            this.state[i] = LANDING;
            this.ledge[i] = best.name;
            this.slot[i] = k;
            this.until[i] = time;
            this.landMs[i] = clamp(dist / (this.rules.maxSpeed * 0.75), 700, 3200);
            this.fromX[i] = x;
            this.fromY[i] = y;
            // Carry on the way it was flying, then come down onto the slot from above.
            this.ctrlX[i] = x + (this.vx[i] / speed) * reach;
            this.ctrlY[i] = Math.min(y + (this.vy[i] / speed) * reach, this.slotOut.y - 50);
            this.driftX[i] = 0;
            this.driftY[i] = 0;
            return true;
        }
        return false;
    }

    private land(i: number, tick: TickContext, time: number, dt: number): void {
        const rect = this.ledgeOf(tick, i);
        if (!rect || !this.slotPosition(rect, this.slot[i], this.slotOut)) {
            this.state[i] = FLYING;
            this.ledge[i] = '';
            return;
        }
        const t = clamp((time - this.until[i]) / this.landMs[i], 0, 1);
        // Eased: quick at first, slowing as it arrives.
        const s = 1 - (1 - t) * (1 - t) * (1 - t);
        const u = 1 - s;
        const x = u * u * this.fromX[i] + 2 * u * s * this.ctrlX[i] + s * s * this.slotOut.x;
        const y = u * u * this.fromY[i] + 2 * u * s * this.ctrlY[i] + s * s * this.slotOut.y;
        this.vx[i] = (x - this.px[i]) / dt;
        this.vy[i] = (y - this.py[i]) / dt;
        this.px[i] = x;
        this.py[i] = y;
        this.phase[i] += dt * 0.024 * (t > 0.8 ? 1.8 : 0.7);
        if (t >= 1) {
            this.state[i] = PERCHED;
            this.facing[i] = this.slotOut.x >= this.fromX[i] ? 1 : -1;
            this.until[i] = time + randomNumber(4000, 14000);
            this.fidgetAt[i] = time + randomNumber(1200, 4000);
            this.hopAt[i] = -Infinity;
            this.vx[i] = 0;
            this.vy[i] = 0;
        }
    }

    private sit(i: number, tick: TickContext, time: number, dt: number, raining: boolean): void {
        const rect = this.ledgeOf(tick, i);
        if (!rect || !this.slotPosition(rect, this.slot[i], this.slotOut)) {
            this.takeOff(i, this.px[i], this.py[i] + 20, true);
            return;
        }
        if (raining && this.until[i] > time + 3000) {
            this.until[i] = time + randomNumber(300, 3000);
        }
        if (time >= this.until[i]) {
            this.takeOff(i, this.px[i] - this.facing[i] * 20, this.py[i] + 10, false);
            return;
        }
        if (time >= this.fidgetAt[i]) {
            this.fidgetAt[i] = time + randomNumber(1500, 5000);
            const side = Math.random() < 0.5 ? -1 : 1;
            if (Math.random() < 0.5) {
                this.facing[i] = -this.facing[i] as -1 | 1;
                this.hopAt[i] = time;
                this.hopFrom[i] = 0;
            } else if (!this.slotTaken(this.ledge[i], this.slot[i] + side, i) && this.slotPosition(rect, this.slot[i] + side, this.slotOut)) {
                this.slot[i] += side;
                this.facing[i] = side as -1 | 1;
                this.hopAt[i] = time;
                this.hopFrom[i] = -side * Flock.SLOT;
            }
            this.slotPosition(rect, this.slot[i], this.slotOut);
        }
        // Follow the element wherever it moves.
        this.vx[i] = (this.slotOut.x - this.px[i]) / dt;
        this.vy[i] = (this.slotOut.y - this.py[i]) / dt;
        if (Math.abs(this.vx[i]) > 2 || Math.abs(this.vy[i]) > 2) {
            this.vx[i] = 0;
            this.vy[i] = 0;
        }
        this.px[i] = this.slotOut.x;
        this.py[i] = this.slotOut.y;
    }

    private publishState(): void {
        const ctx = this.context;
        let flying = 0;
        let perched = 0;
        let cx = 0;
        let cy = 0;
        let hx = 0;
        let hy = 0;
        for (let i = 0; i < this.n; i++) {
            if (this.state[i] === PERCHED) {
                perched++;
            } else if (this.state[i] === FLYING) {
                flying++;
                cx += this.px[i];
                cy += this.py[i];
                hx += this.vx[i] + this.driftX[i];
                hy += this.vy[i] + this.driftY[i];
            }
        }
        ctx.count = this.n;
        ctx.perched = perched;
        if (flying > 0) {
            ctx.center.x = cx / flying;
            ctx.center.y = cy / flying;
            ctx.heading.x = hx / flying;
            ctx.heading.y = hy / flying;
        }
    }

    public onRender(timed: TimedContext): void {
        if (!this.flyTexture || !this.perchTexture) {
            return;
        }
        const lead = timed.alpha * timed.tickDelta;
        const time = timed.time;
        const theme = timed.theme;
        const body = mixColor(theme.ink, theme.accent, 0.3);
        const altBody = mixColor(theme.accentAlt, theme.ink, 0.2);
        for (let v = 0; v < this.views.length; v++) {
            const view = this.views[v];
            if (v >= this.n) {
                view.alpha = 0;
                continue;
            }
            const i = v;
            const base = this.alt[i] ? altBody : body;
            view.tint = mixColor(base, theme.bgBottom, this.tone[i] * 0.28);
            view.alpha = 0.9;
            if (this.state[i] === PERCHED) {
                const hop = clamp((time - this.hopAt[i]) / 220, 0, 1);
                // Now and then a quick bob of the head (the whole little body dips).
                const bob = Math.sin(time * 0.0011 + this.phase[i] * 7) > 0.96 ? 0.88 : 1;
                view.texture = this.perchTexture;
                view.anchorX = 0.5;
                view.anchorY = 1;
                view.x = this.px[i] + this.hopFrom[i] * (1 - hop);
                view.y = this.py[i] + 1 - Math.sin(Math.PI * hop) * 4;
                view.rotation = 0;
                view.scaleX = PERCH_SCALE * this.facing[i];
                view.scaleY = PERCH_SCALE * bob;
                continue;
            }
            const landing = this.state[i] === LANDING;
            const vx = this.vx[i] + this.driftX[i];
            const vy = this.vy[i] + this.driftY[i];
            const startled = this.startle[i] > 0;
            const rate = 0.024 * (startled ? 1.6 : landing ? 0.9 : 1);
            const flap = Math.sin(this.phase[i] + rate * lead);
            let wings = 0.35 + 0.65 * Math.abs(flap);
            let angle = Math.atan2(vy, vx);
            if (landing) {
                // The flare: wings spread wide and the body pitches up just before touching down.
                const t = clamp((time - this.until[i]) / this.landMs[i], 0, 1);
                const flare = clamp((t - 0.75) / 0.25, 0, 1);
                wings = wings * (1 - flare) + flare * (0.9 + 0.2 * Math.abs(flap));
                const up = vx >= 0 ? -1.1 : Math.PI + 1.1;
                angle = angle + (up - angle) * flare * 0.6;
            }
            // Banking into a turn narrows the silhouette.
            const bank = 1 - Math.min(0.4, Math.abs(this.turn[i]) * 90);
            view.texture = this.flyTexture;
            view.anchorX = 0.5;
            view.anchorY = 0.5;
            view.x = this.px[i] + vx * lead;
            view.y = this.py[i] + vy * lead;
            view.rotation = angle;
            view.scaleX = FLY_SCALE;
            view.scaleY = FLY_SCALE * wings * bank;
        }
    }

    public cleanup(): void {
        this.container?.destroy();
        this.container = undefined;
        this.views.length = 0;
        this.flyTexture?.destroy();
        this.perchTexture?.destroy();
        this.atlas?.destroy(true);
        this.flyTexture = undefined;
        this.perchTexture = undefined;
        this.atlas = undefined;
        this.fears.reset();
        this.n = 0;
        this.seeded = false;
        this.spawnAt = 0;
        this.lastStartled = -Infinity;
    }
}
