import { Effect } from '../../src/Effect';
import { approach, clamp, lerp, randomNumber, smoothstep } from '../../src/math';
import type { EffectContext, TickContext, TimedContext, Vector3 } from '../../src/types';
import type { SerpentContext } from '../contracts';
import { SerpentBody, type SerpentPose } from './SerpentBody';
import { bodyWidth, distanceToSegment, followChain, orbitPoint, segmentSpacing, turnRate } from './steering';

export interface SerpentOptions {
    /** Body segments, the head included. More is a longer serpent. Default `SEGMENTS` (46); kept within 8..120. */
    segments?: number;
    /** Multiplier on swimming speed (1 is about 0.13 px/ms). Default `SPEED` (1); kept within 0.1..4. */
    speed?: number;
    /** 0..1: how strongly it is drawn to the pointer. 0 ignores the pointer. Default `CURIOSITY` (0.6). */
    curiosity?: number;
    /** Chase the flock of birds when there is one on the page. Default `HUNT` (true). */
    hunt?: boolean;
    /** How far it weaves toward and away from the viewer, in pixels each way. Default `DEPTH` (160); kept within 0..600. */
    depth?: number;
}

const TAU = Math.PI * 2;

/**
 * A long, luminous creature swimming through the scene: a chain of faceted gems that follows
 * its head in S-curves and weaves toward and away from the viewer, growing and shrinking with
 * real perspective. It is drawn with one Three.js instanced mesh, and everything it does is
 * built from what the other effects publish.
 *
 * What it listens to:
 *   - the pointer: it comes over and circles it, and loses interest when the pointer has been
 *     still for a while (20 seconds). A press within 200 px of its head frightens it (not a press
 *     on a link or button).
 *   - `flock` context: it chases the birds in flight, and that outranks the pointer (option
 *     `hunt`). It never catches one; they read its context and flee.
 *   - `singularity` and `rainEater` contexts: it steers clear of both.
 *   - `crystal:exploded`, `rainEater:exploded`, `meteor:impact`, `firework:exploded` near its
 *     head, and `singularity:collapsed` anywhere: it darts away.
 *   - `lightning:strike`: a bolt that passes within 260 px of its body sends a band of light
 *     from head to tail.
 *   - the force field: wind drifts it, a shock ring shoves it and startles it a little.
 * What it tells the others: its `headPosition` (with depth), `velocity`, `length` and how
 * `excited` it is; and it stirs the force field with a vortex and a small repel at the head and
 * a counter-turning vortex at the middle of the body, so rain swirls in its wake. The wake
 * fades out when the head or the middle is deep behind the stage or close to the viewer. No
 * events, no shock rings.
 * Keys: none.
 */
export class Serpent extends Effect<SerpentContext> {
    public effectName = 'serpent';

    public static readonly SEGMENTS = 46;
    public static readonly MIN_SEGMENTS = 8;
    public static readonly MAX_SEGMENTS = 120;
    public static readonly SPEED = 1;
    public static readonly CURIOSITY = 0.6;
    public static readonly HUNT = true;
    public static readonly DEPTH = 160;

    /** Cruising speed in px/ms at `speed` 1. It drifts a little either side of this. */
    public static readonly CRUISE = 0.13;
    /** Fastest it turns when calm, in rad/ms. Frightened, it turns almost twice as fast. */
    public static readonly TURN_RATE = 0.0018;
    /** The left-right swing of its heading that writes the S-curves: its period in ms and its size in radians. */
    public static readonly UNDULATION_MS = 1800;
    public static readonly UNDULATION = 0.5;
    /** Radius of the circle it swims around the pointer, in pixels. */
    public static readonly ORBIT_RADIUS = 130;
    /** Milliseconds a pointer that does not move keeps its interest. */
    public static readonly INTEREST_MS = 20000;
    /** Milliseconds it flees after a fright, and milliseconds `excited` takes to fall from 1 to 0. */
    public static readonly FLEE_MS = 1500;
    public static readonly CALM_MS = 3000;
    /** How close to its head each kind of fright has to be, in pixels. */
    public static readonly PRESS_RANGE = 200;
    public static readonly CRYSTAL_RANGE = 300;
    public static readonly EATER_BURST_RANGE = 450;
    public static readonly METEOR_RANGE = 250;
    public static readonly FIREWORK_RANGE = 220;
    /** How close a bolt has to pass to any part of the body to send a surge down it, and how long the surge takes. */
    public static readonly SURGE_RANGE = 260;
    public static readonly SURGE_MS = 700;
    /** A push from the force field stronger than this (px/ms²) startles it: shock rings, not wind. */
    public static readonly SHOVE = 0.0014;
    /** Depth (either way, in pixels) beyond which it no longer stirs the force field. */
    public static readonly WAKE_DEPTH = 120;

    private readonly count: number;
    private readonly speed: number;
    private readonly curiosity: number;
    private readonly hunt: boolean;
    private readonly depth: number;

    private readonly pose: SerpentPose;
    private readonly spacing: Float32Array;
    private readonly widths: Float32Array;
    private body: SerpentBody | undefined;
    private seeded = false;

    /** Direction it is steering, in radians, and how fast that is changing (rad/ms). */
    private heading = 0;
    private turn = 0;
    /** Turn rate including the swimming swing: which way its wake swirls. */
    private swirl = 0;
    private excited = 0;
    /** Progress of a lightning surge from 0 to 1; negative when there is none. */
    private surge = -1;
    private fleeFor = 0;
    private readonly fleeFrom = { x: 0, y: 0 };
    /** Velocity the force field has pushed into it, px/ms. It dies away on its own. */
    private readonly push = { x: 0, y: 0 };
    /** Where it wants to go this tick. */
    private readonly aim = { x: 0, y: 0 };
    private readonly wander = { x: 0, y: 0 };
    private readonly wanderGoal = { x: 0, y: 0 };
    private wanderFor = 0;
    /** Which way round the pointer it goes: +1 clockwise on screen, -1 the other way. */
    private orbit = 1;
    private readonly lastPointer = { x: -1, y: -1 };
    private pointerStillFor = 0;
    private depthPhase = 0;
    private readonly force: Vector3 = { x: 0, y: 0 };
    private readonly scratch = { x: 0, y: 0 };
    private readonly context: SerpentContext;

    constructor(options: SerpentOptions = {}) {
        super();
        this.count = Math.round(clamp(finite(options.segments, Serpent.SEGMENTS), Serpent.MIN_SEGMENTS, Serpent.MAX_SEGMENTS));
        this.speed = clamp(finite(options.speed, Serpent.SPEED), 0.1, 4);
        this.curiosity = clamp(finite(options.curiosity, Serpent.CURIOSITY), 0, 1);
        this.hunt = options.hunt ?? Serpent.HUNT;
        this.depth = clamp(finite(options.depth, Serpent.DEPTH), 0, 600);

        const n = this.count;
        this.spacing = new Float32Array(n);
        this.widths = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const t = i / (n - 1);
            this.spacing[i] = segmentSpacing(t);
            this.widths[i] = bodyWidth(t);
        }
        this.pose = {
            x: new Float32Array(n),
            y: new Float32Array(n),
            z: new Float32Array(n),
            prevX: new Float32Array(n),
            prevY: new Float32Array(n),
            prevZ: new Float32Array(n),
            phase: 0,
            excited: 0,
            surge: -9,
            depth: this.depth,
        };
        this.context = { headPosition: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, length: n, excited: 0 };
    }

    public initialize(): void {
        this.body = new SerpentBody(this.host, this.count, this.widths, this.spacing);
    }

    public onTick(tick: TickContext): EffectContext<SerpentContext> {
        if (tick.timeDelta <= 0) {
            return this.publish(this.context);
        }
        // Placed here rather than in initialize(), so it starts somewhere on the real stage.
        if (!this.seeded) {
            this.seeded = true;
            this.seed(tick);
        }
        this.hearTheScene(tick);
        this.chooseAim(tick);
        this.swim(tick);
        this.stirTheField(tick);

        const dt = tick.timeDelta;
        this.excited = Math.max(0, this.excited - dt / Serpent.CALM_MS);
        this.fleeFor = Math.max(0, this.fleeFor - dt);
        if (this.surge >= 0) {
            this.surge += dt / Serpent.SURGE_MS;
            if (this.surge > 1) {
                this.surge = -1;
            }
        }

        const pose = this.pose;
        pose.excited = this.excited;
        // The band starts just ahead of the snout and leaves just past the tail.
        pose.surge = this.surge < 0 ? -9 : lerp(-0.12, 1.12, this.surge);
        this.context.excited = this.excited;
        return this.publish(this.context);
    }

    /** Lay the body out behind the head along a gentle S, as if it had been swimming already. */
    private seed(tick: TickContext): void {
        const { width, height } = tick.stage;
        const { x, y, z, prevX, prevY, prevZ } = this.pose;
        this.heading = randomNumber(-Math.PI, Math.PI);
        this.depthPhase = randomNumber(0, TAU);
        this.pose.phase = randomNumber(0, TAU);
        x[0] = randomNumber(0.3, 0.7) * width;
        y[0] = randomNumber(0.3, 0.7) * height;
        z[0] = this.depthAt(tick.time);
        const dirX = Math.cos(this.heading);
        const dirY = Math.sin(this.heading);
        const reach = (Serpent.CRUISE * Serpent.UNDULATION * Serpent.UNDULATION_MS) / TAU; // how wide the S is
        let behind = 0;
        for (let i = 1; i < this.count; i++) {
            behind += this.spacing[i];
            const earlier = behind / Serpent.CRUISE; // milliseconds ago the head was here
            const sway = reach * (Math.cos(this.pose.phase - (earlier * TAU) / Serpent.UNDULATION_MS) - Math.cos(this.pose.phase));
            x[i] = x[0] - dirX * behind + dirY * sway;
            y[i] = y[0] - dirY * behind - dirX * sway;
            z[i] = this.depthAt(tick.time - earlier);
        }
        followChain(x, y, z, this.count, this.spacing);
        prevX.set(x);
        prevY.set(y);
        prevZ.set(z);
        const head = this.context.headPosition;
        head.x = x[0];
        head.y = y[0];
        head.z = z[0];
        this.wander.x = this.wanderGoal.x = x[0] + dirX * 200;
        this.wander.y = this.wanderGoal.y = y[0] + dirY * 200;
        this.wanderFor = randomNumber(2000, 5000);
    }

    /** Frights and lightning: what happened around it since the last tick. */
    private hearTheScene(tick: TickContext): void {
        const mouse = tick.mousePosition;
        if (tick.mouseJustPressed && !tick.mouseOnInteractive && mouse) {
            this.startle(mouse.x, mouse.y, Serpent.PRESS_RANGE);
        }
        for (const event of tick.events('crystal:exploded')) {
            this.startle(event.payload.x, event.payload.y, Serpent.CRYSTAL_RANGE);
        }
        for (const event of tick.events('rainEater:exploded')) {
            this.startle(event.payload.x, event.payload.y, Serpent.EATER_BURST_RANGE);
        }
        for (const event of tick.events('meteor:impact')) {
            this.startle(event.payload.x, event.payload.y, Serpent.METEOR_RANGE);
        }
        for (const event of tick.events('firework:exploded')) {
            this.startle(event.payload.x, event.payload.y, Serpent.FIREWORK_RANGE);
        }
        for (const event of tick.events('singularity:collapsed')) {
            this.startle(event.payload.x, event.payload.y, Infinity);
        }

        // A bolt passing close to any part of the body runs down it as a band of light.
        const { x, y } = this.pose;
        for (const event of tick.events('lightning:strike')) {
            const bolt = event.payload;
            for (let i = 0; i < this.count; i += 2) {
                if (distanceToSegment(x[i], y[i], bolt.fromX, bolt.fromY, bolt.x, bolt.y) < Serpent.SURGE_RANGE) {
                    this.surge = 0;
                    this.excited = 1;
                    break;
                }
            }
        }

        // Whatever else is in the field pushes the head: wind drifts it, a shock ring shoves it.
        const head = this.context.headPosition;
        const dt = tick.timeDelta;
        const force = tick.forces.sample(head.x, head.y, this.force, this.effectName);
        this.push.x = approach(this.push.x + force.x * dt * 0.6, 0, 3, dt);
        this.push.y = approach(this.push.y + force.y * dt * 0.6, 0, 3, dt);
        const shove = Math.hypot(force.x, force.y);
        if (shove > Serpent.SHOVE) {
            this.excited = Math.min(1, this.excited + Math.min(0.06, (shove - Serpent.SHOVE) * dt * 0.7));
        }
    }

    /** Take fright at something that happened at (x, y), if it was within `range` of the head. */
    private startle(x: number, y: number, range: number): void {
        const head = this.context.headPosition;
        if (Math.hypot(head.x - x, head.y - y) > range) {
            return;
        }
        this.fleeFrom.x = x;
        this.fleeFrom.y = y;
        this.fleeFor = Serpent.FLEE_MS;
        this.excited = 1;
    }

    /** Decide where it wants to go. Later rules overrule earlier ones: the last word is the strongest. */
    private chooseAim(tick: TickContext): void {
        const dt = tick.timeDelta;
        const { width, height } = tick.stage;
        const head = this.context.headPosition;
        const aim = this.aim;

        // Nothing better to do: follow a point that itself drifts about the stage.
        const marginX = Math.min(120, width / 3);
        const marginY = Math.min(120, height / 3);
        this.wanderFor -= dt;
        if (this.wanderFor <= 0 || Math.hypot(this.wanderGoal.x - head.x, this.wanderGoal.y - head.y) < 110) {
            // Somewhere new every 6 to 12 seconds, or as soon as it gets there: the farthest of
            // three random spots, so it makes long passes across the stage instead of circling.
            this.wanderFor = randomNumber(6000, 12000);
            let farthest = -1;
            for (let tries = 0; tries < 3; tries++) {
                const x = randomNumber(marginX, width - marginX);
                const y = randomNumber(marginY, height - marginY);
                const distance = Math.hypot(x - head.x, y - head.y);
                if (distance > farthest) {
                    farthest = distance;
                    this.wanderGoal.x = x;
                    this.wanderGoal.y = y;
                }
            }
        }
        this.wander.x = clamp(approach(this.wander.x, this.wanderGoal.x, 0.5, dt), marginX, width - marginX);
        this.wander.y = clamp(approach(this.wander.y, this.wanderGoal.y, 0.5, dt), marginY, height - marginY);
        aim.x = this.wander.x;
        aim.y = this.wander.y;

        // Curious: come over to the pointer and circle it, rather than sit on it.
        const mouse = tick.mousePosition;
        if (mouse && this.curiosity > 0 && mouse.x >= 0 && mouse.x <= width && mouse.y >= 0 && mouse.y <= height) {
            const moved = Math.hypot(mouse.x - this.lastPointer.x, mouse.y - this.lastPointer.y) > 3;
            this.pointerStillFor = moved ? 0 : this.pointerStillFor + dt;
            this.lastPointer.x = mouse.x;
            this.lastPointer.y = mouse.y;
            const interest = 1 - smoothstep(Serpent.INTEREST_MS, Serpent.INTEREST_MS * 1.3, this.pointerStillFor);
            const pull = Math.min(1, this.curiosity * 1.5) * interest;
            if (pull > 0) {
                const dx = head.x - mouse.x;
                const dy = head.y - mouse.y;
                if (Math.hypot(dx, dy) > Serpent.ORBIT_RADIUS * 1.6) {
                    // Still on its way: go round the way it is already heading.
                    this.orbit = dx * Math.sin(this.heading) - dy * Math.cos(this.heading) >= 0 ? 1 : -1;
                }
                const ahead = orbitPoint(head.x, head.y, mouse.x, mouse.y, Serpent.ORBIT_RADIUS, this.orbit, 0.7, this.scratch);
                aim.x = lerp(aim.x, ahead.x, pull);
                aim.y = lerp(aim.y, ahead.y, pull);
            }
        }

        // Hungry: go for the middle of the birds in flight, a little ahead of where they are going.
        const flock = this.hunt ? tick.read('flock') : undefined;
        if (flock && flock.count - flock.perched > 0) {
            aim.x = flock.center.x + flock.heading.x * 500;
            aim.y = flock.center.y + flock.heading.y * 500;
        }

        // Wary: keep clear of the hole, and let the other character pass.
        const hole = tick.read('singularity');
        if (hole && !hole.collapsed) {
            this.steerClear(hole.position.x, hole.position.y, hole.radius * 6 + 160);
        }
        const eater = tick.read('rainEater');
        if (eater) {
            this.steerClear(eater.headPosition.x, eater.headPosition.y, 160);
        }

        // Frightened: straight away from whatever it was.
        if (this.fleeFor > 0) {
            const dx = head.x - this.fleeFrom.x;
            const dy = head.y - this.fleeFrom.y;
            const distance = Math.hypot(dx, dy);
            aim.x = head.x + (distance > 0.001 ? dx / distance : Math.cos(this.heading)) * 300;
            aim.y = head.y + (distance > 0.001 ? dy / distance : Math.sin(this.heading)) * 300;
        }

        // Always: it may leave the picture for a moment, but it comes back.
        const outside = Math.max(-head.x, head.x - width, -head.y, head.y - height);
        const back = smoothstep(150, 280, outside);
        aim.x = lerp(aim.x, width / 2, back);
        aim.y = lerp(aim.y, height / 2, back);
    }

    /** Bend the aim away from (x, y) when the head is within `range` of it, sliding past rather than turning back. */
    private steerClear(x: number, y: number, range: number): void {
        const head = this.context.headPosition;
        let dx = head.x - x;
        let dy = head.y - y;
        const distance = Math.hypot(dx, dy);
        if (distance >= range || distance < 0.001) {
            return;
        }
        dx /= distance;
        dy /= distance;
        // Sideways along the edge of the thing, on whichever side it is already heading.
        const along = -dy * Math.cos(this.heading) + dx * Math.sin(this.heading) >= 0 ? 1 : -1;
        const weight = smoothstep(range, range * 0.5, distance);
        this.aim.x = lerp(this.aim.x, head.x + (dx * 0.7 - dy * along * 0.7) * 260, weight);
        this.aim.y = lerp(this.aim.y, head.y + (dy * 0.7 + dx * along * 0.7) * 260, weight);
    }

    /** Turn toward the aim in a smooth arc, swim forward with a left-right swing, and pull the body along. */
    private swim(tick: TickContext): void {
        const dt = tick.timeDelta;
        const pose = this.pose;
        const { x, y, z } = pose;
        pose.prevX.set(x);
        pose.prevY.set(y);
        pose.prevZ.set(z);

        const excited = this.excited;
        const want = Math.atan2(this.aim.y - y[0], this.aim.x - x[0]);
        const wanted = turnRate(this.heading, want, 0.004, Serpent.TURN_RATE * (1 + 0.9 * excited));
        this.turn = approach(this.turn, wanted, 8, dt);
        this.heading = (this.heading + this.turn * dt) % TAU;

        // The swing that writes S-curves even on a straight course. It quickens when it darts.
        const swing = (TAU / Serpent.UNDULATION_MS) * (1 + 0.6 * excited);
        pose.phase = (pose.phase + swing * dt) % TAU;
        const direction = this.heading + Serpent.UNDULATION * Math.sin(pose.phase);
        this.swirl = this.turn + Serpent.UNDULATION * swing * Math.cos(pose.phase);

        const cruise = Serpent.CRUISE + 0.03 * Math.sin(tick.time * 0.00041 + this.depthPhase);
        const speed = this.speed * cruise * (1 + excited);
        const velocity = this.context.velocity;
        velocity.x = Math.cos(direction) * speed + this.push.x;
        velocity.y = Math.sin(direction) * speed + this.push.y;
        x[0] += velocity.x * dt;
        y[0] += velocity.y * dt;
        const depth = this.depthAt(tick.time);
        velocity.z = (depth - z[0]) / dt;
        z[0] = depth;
        followChain(x, y, z, this.count, this.spacing);

        const head = this.context.headPosition;
        head.x = x[0];
        head.y = y[0];
        head.z = z[0];
    }

    /** Depth of the head at a moment in time: a slow rise and fall with a quicker, smaller one on top. */
    private depthAt(time: number): number {
        return this.depth * (0.8 * Math.sin(time * 0.0004 + this.depthPhase) + 0.2 * Math.sin(time * 0.00095 + this.depthPhase * 2.3));
    }

    /** Its wake: two counter-turning vortices and a small repel, only while it is near the plane the rain is in. */
    private stirTheField(tick: TickContext): void {
        const { x, y, z } = this.pose;
        // Swirl the way it is turning. A straight course swings left and right, so the wake alternates.
        const swirl = clamp(-this.swirl / 0.0012, -1, 1);
        const near = 1 - smoothstep(Serpent.WAKE_DEPTH * 0.6, Serpent.WAKE_DEPTH * 1.1, Math.abs(z[0]));
        if (near > 0.01) {
            tick.forces.add({ kind: 'vortex', owner: this.effectName, x: x[0], y: y[0], radius: 150, strength: 0.0006 * swirl * near });
            tick.forces.add({ kind: 'repel', owner: this.effectName, x: x[0], y: y[0], radius: 70, strength: 0.0008 * near });
        }
        const mid = this.count >> 1;
        const midNear = 1 - smoothstep(Serpent.WAKE_DEPTH * 0.6, Serpent.WAKE_DEPTH * 1.1, Math.abs(z[mid]));
        if (midNear > 0.01) {
            tick.forces.add({ kind: 'vortex', owner: this.effectName, x: x[mid], y: y[mid], radius: 120, strength: -0.00035 * swirl * midNear });
        }
    }

    public onRender(timed: TimedContext): void {
        if (this.seeded) {
            this.body?.render(timed, this.pose);
        }
    }

    public cleanup(): void {
        this.body?.dispose();
        this.body = undefined;
        this.seeded = false;
        this.turn = 0;
        this.swirl = 0;
        this.excited = 0;
        this.surge = -1;
        this.fleeFor = 0;
        this.push.x = 0;
        this.push.y = 0;
        this.pointerStillFor = 0;
        this.context.excited = 0;
    }
}

/** An option that is missing or not a number falls back to its default. */
function finite(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
