import { Effect } from '../../src/Effect';
import { approach, clamp, lerp, randomNumber } from '../../src/math';
import type { AnchorRect } from '../../src/Stage';
import type { EffectContext, TickContext, TimedContext, Vector3 } from '../../src/types';
import type { BubblesContext, BubbleState } from '../contracts';
import { BubbleGlass } from './BubbleGlass';
import { fuseDelay, slideDirection, SQUASH_FLAT, touch, type Contact } from './ledge';

export interface BubblesOptions {
    /** Bubbles kept alive at full budget, 0 to 60. Default `COUNT` (14). */
    count?: number;
    /** Radius of the smallest bubble, in pixels. Default `MIN_RADIUS` (14). */
    minRadius?: number;
    /** Radius of the largest bubble, in pixels. Most are nearer the smallest. Default `MAX_RADIUS` (46). */
    maxRadius?: number;
    /** Raindrops can pop them (when the `rain` effect is on the page). Default `RAIN_POPS` (true). */
    rainPops?: boolean;
    /** Bump into page elements tagged `ledge` and slide round them. False ignores the page. Default `PAGE_INTERACTION` (true). */
    pageInteraction?: boolean;
}

interface Bubble {
    /** Position and radius in stage pixels. This very object is what the context lists. */
    state: BubbleState;
    vx: number;
    vy: number;
    /** Radius once fully blown; `state.radius` grows to it. */
    fullRadius: number;
    /** Upward acceleration, in px/ms². Balanced by drag at the bubble's rise speed. */
    lift: number;
    age: number;
    lifespan: number;
    /** 0..1, its own: where it is in its sway, its breathing and its film colours. */
    phase: number;
    /** Sideways sway, in radians per millisecond. */
    swayRate: number;
    /** 0..1: how flat it is pressed against an underside. */
    squash: number;
    /** 0..1: the outline shaking after a bump. */
    jiggle: number;
    /** Name of the element it is in contact with, and for how long it has been clear of it. */
    touching: string | undefined;
    clearFor: number;
    /** -1, 0, 1: the way it slides while held under an element. */
    slide: number;
    /** Milliseconds until it pops; Infinity until something sets it off. */
    fuse: number;
}

interface Pop {
    x: number;
    y: number;
    radius: number;
    squash: number;
    phase: number;
    age: number;
}

/**
 * Soap bubbles that meet the page from below, drawn with Three.js as glass spheres: each one is
 * a small lens that shows the backdrop and the Pixi layer behind it bent and, at its rim,
 * upside-down. They rise, stop under page elements tagged `ledge`, flatten a little, slide
 * along the underside to its end and slip round it. They are fragile, and every pop is an event.
 *
 * What it listens to:
 *   - the force field, generously: wind carries them, attractors pull them in, a shock ring
 *     throws them and bursts the small ones on its front.
 *   - the page: elements tagged `ledge` (see `pageInteraction`).
 *   - a press of the pointer on a bubble pops it.
 *   - `rain` (a Pixi effect): each droplet that touches a bubble has a small chance of popping it.
 *   - `crystal:exploded`, `rainEater:exploded`, `lightning:strike`, `meteor:impact`,
 *     `firework:exploded` near them, and `singularity:collapsed` anywhere: the pops run outward
 *     from where it happened.
 *   - `rainEater` and `singularity`: touching the eater or falling into the hole pops them.
 * What it tells the others: where every bubble is (its context), `bubble:popped` for each pop,
 * and `page:hit` when one bumps into an element.
 * Keys: `b` blows a cluster of bubbles from the pointer.
 */
export class Bubbles extends Effect<BubblesContext> {
    public effectName: string = 'bubbles';

    public static readonly COUNT = 14;
    public static readonly MAX_COUNT = 60;
    public static readonly MIN_RADIUS = 14;
    public static readonly MAX_RADIUS = 46;
    public static readonly RAIN_POPS = true;
    public static readonly PAGE_INTERACTION = true;

    /** Rise speed of the smallest and of the largest bubble in still air, in px/ms. */
    public static readonly RISE_SLOW = 0.03;
    public static readonly RISE_FAST = 0.07;
    /** Drag: milliseconds for a slow bubble to settle, and the pixels over which a fast one is braked. */
    public static readonly DRAG_MS = 600;
    public static readonly DRAG_PX = 140;
    /** How much of the force field a bubble feels. */
    public static readonly FORCE_SHARE = 1.35;
    /** A shove harder than this (px/ms², a shock ring's front) bursts the small ones. */
    public static readonly BURST_FORCE = 0.0028;
    /** Sideways sway, in px/ms². */
    public static readonly SWAY = 0.000022;
    /** Sideways drift while held under an element, in px/ms². */
    public static readonly SLIDE = 0.00004;
    /** A sideways force above this (px/ms²) decides which way a held bubble slides. */
    public static readonly CLEAR_FORCE = 0.00002;
    /** How hard two overlapping bubbles part, in px/ms² per pixel of overlap. */
    public static readonly PUSH_APART = 0.00003;
    /** Chance that a droplet found inside a bubble pops it, per look. Half the droplets are looked at each tick. */
    public static readonly RAIN_POP_CHANCE = 0.002;
    /** Old age: a bubble pops after a random time in this range, in milliseconds. */
    public static readonly LIFE_MIN_MS = 40000;
    public static readonly LIFE_MAX_MS = 60000;
    /** How long the film takes to snap, in milliseconds. */
    public static readonly POP_MS = 160;
    /** Least time between two `page:hit` events on one element, in milliseconds. */
    public static readonly HIT_INTERVAL_MS = 250;
    public static readonly BLOW_KEY = 'b';
    /** Milliseconds between the bubbles of one breath. */
    public static readonly BLOW_GAP_MS = 45;
    public static readonly SPRAY_GRAVITY = 0.00055;
    /** Bubbles alive at once, blown ones included. The rest of the glass's room is for pops. */
    private static readonly MAX_ALIVE = BubbleGlass.MAX_BUBBLES - 40;

    private readonly count: number;
    private readonly minRadius: number;
    private readonly maxRadius: number;
    private readonly rainPops: boolean;
    private readonly pageInteraction: boolean;

    private glass: BubbleGlass | undefined;
    private readonly bubbles: Bubble[] = [];
    private readonly spare: Bubble[] = [];
    private readonly pops: Pop[] = [];
    private readonly states: BubbleState[] = [];
    private readonly context: BubblesContext = { bubbles: this.states, count: 0, popped: 0 };
    private readonly force: Vector3 = { x: 0, y: 0 };
    private readonly contact: Contact = { nx: 0, ny: 0, depth: 0, x: 0, y: 0 };
    /** Element name → when a bubble last announced hitting it. */
    private readonly lastHit = new Map<string, number>();
    private readonly breath = { left: 0, wait: 0, x: 0, y: 0, angle: 0 };
    private birthWait = 0;

    // Spray droplets are short-lived and many, so they are plain arrays, not objects.
    private readonly sprayX = new Float32Array(BubbleGlass.MAX_DROPLETS);
    private readonly sprayY = new Float32Array(BubbleGlass.MAX_DROPLETS);
    private readonly sprayVx = new Float32Array(BubbleGlass.MAX_DROPLETS);
    private readonly sprayVy = new Float32Array(BubbleGlass.MAX_DROPLETS);
    private readonly sprayLife = new Float32Array(BubbleGlass.MAX_DROPLETS);
    private readonly spraySpan = new Float32Array(BubbleGlass.MAX_DROPLETS);
    private readonly spraySize = new Float32Array(BubbleGlass.MAX_DROPLETS);
    private sprayCount = 0;

    constructor(options: BubblesOptions = {}) {
        super();
        this.count = Math.round(clamp(options.count ?? Bubbles.COUNT, 0, Bubbles.MAX_COUNT));
        this.minRadius = clamp(options.minRadius ?? Bubbles.MIN_RADIUS, 4, 160);
        this.maxRadius = clamp(options.maxRadius ?? Bubbles.MAX_RADIUS, this.minRadius, 160);
        this.rainPops = options.rainPops ?? Bubbles.RAIN_POPS;
        this.pageInteraction = options.pageInteraction ?? Bubbles.PAGE_INTERACTION;
    }

    public initialize(): void {
        this.glass = new BubbleGlass(this.host);
    }

    public onTick(tickContext: TickContext): EffectContext<BubblesContext> {
        this.context.popped = 0;
        this.blowAndBear(tickContext);
        this.hear(tickContext);
        this.move(tickContext);
        this.end(tickContext);
        this.fade(tickContext.timeDelta);

        const bubbles = this.bubbles;
        this.states.length = bubbles.length;
        for (let i = 0; i < bubbles.length; i++) {
            this.states[i] = bubbles[i].state;
        }
        this.context.count = bubbles.length;
        return this.publish(this.context);
    }

    /** New bubbles: a breath from the pointer on `b`, and the standing population from below. */
    private blowAndBear(tickContext: TickContext): void {
        const { width, height } = tickContext.stage;
        const dt = tickContext.timeDelta;
        const breath = this.breath;

        if (tickContext.justPressedKeys.includes(Bubbles.BLOW_KEY)) {
            const mouse = tickContext.mousePosition;
            breath.left = 6 + Math.floor(Math.random() * 4);
            breath.wait = 0;
            breath.x = mouse?.x ?? width / 2;
            breath.y = mouse?.y ?? height * 0.75;
            // Somewhere upward, as if blown through a ring held in front of the mouth.
            breath.angle = randomNumber(-2.3, -0.85);
        }
        breath.wait -= dt;
        while (breath.left > 0 && breath.wait <= 0) {
            breath.left--;
            breath.wait += Bubbles.BLOW_GAP_MS;
            // Small to medium, each leaving a little differently.
            const bubble = this.add(breath.x, breath.y, lerp(this.minRadius, this.maxRadius, 0.5 * Math.random() ** 1.5));
            if (bubble) {
                const angle = breath.angle + randomNumber(-0.4, 0.4);
                const speed = randomNumber(0.1, 0.42);
                bubble.vx = Math.cos(angle) * speed;
                bubble.vy = Math.sin(angle) * speed;
                bubble.state.radius = bubble.fullRadius * 0.3;
            }
        }

        // One at a time from just below the bottom edge, sooner when the stage is short of them.
        const target = Math.round(this.count * tickContext.budget.budget);
        this.birthWait -= dt;
        if (this.bubbles.length < target && this.birthWait <= 0) {
            const radius = lerp(this.minRadius, this.maxRadius, Math.random() ** 2.2);
            const bubble = this.add(randomNumber(radius, Math.max(radius, width - radius)), height + radius + randomNumber(4, 30), radius);
            if (bubble) {
                bubble.vy = -bubble.lift * Bubbles.DRAG_MS * 0.8;
            }
            this.birthWait = lerp(280, 1000, this.bubbles.length / Math.max(1, target)) * randomNumber(0.7, 1.3);
        }
    }

    private add(x: number, y: number, radius: number): Bubble | undefined {
        if (this.bubbles.length >= Bubbles.MAX_ALIVE) {
            return undefined;
        }
        const bubble: Bubble = this.spare.pop() ?? {
            state: { x: 0, y: 0, radius: 0 },
            vx: 0,
            vy: 0,
            fullRadius: 0,
            lift: 0,
            age: 0,
            lifespan: 0,
            phase: 0,
            swayRate: 0,
            squash: 0,
            jiggle: 0,
            touching: undefined,
            clearFor: 0,
            slide: 0,
            fuse: Infinity,
        };
        // Bigger bubbles rise a bit faster. The lift is what drag balances at that speed.
        const size = clamp((radius - this.minRadius) / Math.max(1, this.maxRadius - this.minRadius), 0, 1);
        const rise = lerp(Bubbles.RISE_SLOW, Bubbles.RISE_FAST, size) * randomNumber(0.9, 1.1);
        bubble.state.x = x;
        bubble.state.y = y;
        bubble.state.radius = radius;
        bubble.fullRadius = radius;
        bubble.vx = 0;
        bubble.vy = 0;
        bubble.lift = rise * (1 / Bubbles.DRAG_MS + rise / Bubbles.DRAG_PX);
        bubble.age = 0;
        bubble.lifespan = randomNumber(Bubbles.LIFE_MIN_MS, Bubbles.LIFE_MAX_MS);
        bubble.phase = Math.random();
        bubble.swayRate = (Math.PI * 2) / randomNumber(2400, 5200);
        bubble.squash = 0;
        bubble.jiggle = 0;
        bubble.touching = undefined;
        bubble.clearFor = 0;
        bubble.slide = 0;
        bubble.fuse = Infinity;
        this.bubbles.push(bubble);
        return bubble;
    }

    /** What happened last tick: a press on a bubble, and blasts that set off the bubbles near them. */
    private hear(tickContext: TickContext): void {
        const pointer = tickContext.mousePosition;
        if (tickContext.mouseJustPressed && !tickContext.mouseOnInteractive && pointer) {
            // One press, one bubble: the one whose centre is nearest.
            let nearest: Bubble | undefined;
            let nearestDistance = Infinity;
            for (const bubble of this.bubbles) {
                const distance = Math.hypot(bubble.state.x - pointer.x, bubble.state.y - pointer.y);
                if (distance < bubble.state.radius + 3 && distance < nearestDistance) {
                    nearest = bubble;
                    nearestDistance = distance;
                }
            }
            if (nearest) {
                nearest.fuse = 0;
            }
        }

        for (const { payload } of tickContext.events('crystal:exploded')) {
            this.setOff(payload.x, payload.y, payload.radius + 140);
        }
        for (const { payload } of tickContext.events('rainEater:exploded')) {
            this.setOff(payload.x, payload.y, 300);
        }
        for (const { payload } of tickContext.events('lightning:strike')) {
            this.setOff(payload.x, payload.y, 160);
        }
        for (const { payload } of tickContext.events('meteor:impact')) {
            this.setOff(payload.x, payload.y, 120 + 120 * payload.power);
        }
        for (const { payload } of tickContext.events('firework:exploded')) {
            this.setOff(payload.x, payload.y, 140 * payload.power + 60);
        }
        for (const { payload } of tickContext.events('singularity:collapsed')) {
            this.setOff(payload.x, payload.y, Infinity);
        }
    }

    /** Light the fuse of every bubble within `range` of a blast: the nearest pop first. */
    private setOff(x: number, y: number, range: number): void {
        for (const bubble of this.bubbles) {
            const distance = Math.hypot(bubble.state.x - x, bubble.state.y - y);
            if (distance < range) {
                bubble.fuse = Math.min(bubble.fuse, fuseDelay(distance, range, Math.random()));
            }
        }
    }

    /** Buoyancy, drag, the force field, each other, and the page. */
    private move(tickContext: TickContext): void {
        const dt = tickContext.timeDelta;
        const bubbles = this.bubbles;
        const force = this.force;
        const ledges = this.pageInteraction ? tickContext.stage.tagged('ledge') : undefined;
        const smallBelow = lerp(this.minRadius, this.maxRadius, 0.4);

        for (const bubble of bubbles) {
            const state = bubble.state;
            tickContext.forces.sample(state.x, state.y, force);
            if (bubble.fullRadius < smallBelow && Math.hypot(force.x, force.y) > Bubbles.BURST_FORCE) {
                bubble.fuse = Math.min(bubble.fuse, Math.random() * 120);
            }
            const sway = Math.sin(tickContext.time * bubble.swayRate + bubble.phase * 6.2832) * Bubbles.SWAY;
            bubble.vx += (force.x * Bubbles.FORCE_SHARE + sway + bubble.slide * Bubbles.SLIDE) * dt;
            bubble.vy += (force.y * Bubbles.FORCE_SHARE - bubble.lift) * dt;
            // Light things stop quickly, and the faster they go the harder the air brakes them.
            const keep = Math.exp(-dt * (1 / Bubbles.DRAG_MS + Math.hypot(bubble.vx, bubble.vy) / Bubbles.DRAG_PX));
            bubble.vx *= keep;
            bubble.vy *= keep;
            bubble.clearFor += dt;
            bubble.jiggle = approach(bubble.jiggle, 0, 2.5, dt);
            state.radius = approach(state.radius, bubble.fullRadius, 9, dt);
            state.x += bubble.vx * dt;
            state.y += bubble.vy * dt;
            if (ledges && ledges.length > 0) {
                this.meetPage(bubble, ledges, force.x, tickContext);
            }
        }

        // Soft against each other: overlapping bubbles part, the smaller one giving way more.
        for (let i = 0; i < bubbles.length; i++) {
            const a = bubbles[i];
            for (let j = i + 1; j < bubbles.length; j++) {
                const b = bubbles[j];
                const dx = b.state.x - a.state.x;
                const dy = b.state.y - a.state.y;
                const reach = a.state.radius + b.state.radius;
                if (dx > reach || dx < -reach || dy > reach || dy < -reach) {
                    continue;
                }
                const distance = Math.hypot(dx, dy);
                if (distance >= reach || distance < 0.001) {
                    continue;
                }
                const nx = dx / distance;
                const ny = dy / distance;
                const closing = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
                if (closing > 0.012) {
                    const bump = Math.min(1, closing * 9);
                    a.jiggle = Math.max(a.jiggle, bump);
                    b.jiggle = Math.max(b.jiggle, bump);
                }
                const push = (reach - distance) * Bubbles.PUSH_APART * dt * 2;
                const shareA = (b.state.radius * b.state.radius) / (a.state.radius * a.state.radius + b.state.radius * b.state.radius);
                a.vx -= nx * push * shareA;
                a.vy -= ny * push * shareA;
                b.vx += nx * push * (1 - shareA);
                b.vy += ny * push * (1 - shareA);
            }
        }
    }

    /** Keep a bubble out of the page's elements; under one it flattens and slides toward an end. */
    private meetPage(bubble: Bubble, ledges: readonly AnchorRect[], forceX: number, tickContext: TickContext): void {
        const state = bubble.state;
        const contact = this.contact;
        let under: AnchorRect | undefined;

        for (let i = 0; i < ledges.length; i++) {
            const rect = ledges[i];
            if (!touch(state.x, state.y, state.radius, rect, contact)) {
                continue;
            }
            if (contact.ny > 0.6) {
                under = rect;
            }
            // Flattened against an underside it sits that much closer to it.
            const depth = contact.depth - (contact.ny > 0 ? state.radius * SQUASH_FLAT * bubble.squash * contact.ny * contact.ny : 0);
            if (depth > 0) {
                state.x += contact.nx * depth;
                state.y += contact.ny * depth;
                const into = bubble.vx * contact.nx + bubble.vy * contact.ny;
                if (into < 0) {
                    bubble.vx -= into * contact.nx;
                    bubble.vy -= into * contact.ny;
                }
            }
            if (bubble.touching !== rect.name) {
                // First touch: the outline shakes, and the page is told (not too often per element).
                bubble.touching = rect.name;
                bubble.jiggle = Math.max(bubble.jiggle, 0.7);
                if (tickContext.time - (this.lastHit.get(rect.name) ?? -Infinity) >= Bubbles.HIT_INTERVAL_MS) {
                    this.lastHit.set(rect.name, tickContext.time);
                    tickContext.emit('page:hit', { x: contact.x, y: contact.y, anchor: rect.name, edge: true, kind: 'bubble' });
                }
            }
            bubble.clearFor = 0;
        }

        if (bubble.clearFor > 400) {
            bubble.touching = undefined;
        }
        bubble.slide = under ? slideDirection(state.x, under, forceX, Bubbles.CLEAR_FORCE, bubble.slide) : 0;
        bubble.squash = approach(bubble.squash, under ? 1 : 0, under ? 7 : 4, tickContext.timeDelta);
    }

    /** Every way a bubble ends: rain, the eater, the hole, a lit fuse, old age, or leaving the stage. */
    private end(tickContext: TickContext): void {
        const dt = tickContext.timeDelta;
        const { width } = tickContext.stage;
        const bubbles = this.bubbles;
        if (this.rainPops) {
            this.meetRain(tickContext);
        }
        const eater = tickContext.read('rainEater');
        const eaterHead = eater && !eater.isExploded ? eater.headPosition : undefined;
        const hole = tickContext.read('singularity');
        const holeCentre = hole && !hole.collapsed ? hole.position : undefined;

        for (let i = bubbles.length - 1; i >= 0; i--) {
            const bubble = bubbles[i];
            const { x, y, radius } = bubble.state;
            bubble.age += dt;
            bubble.fuse -= dt;
            // Gone over the top (or blown off a side): simply gone, no pop.
            if (y < -radius * 1.3 - 4 || x < -radius - 60 || x > width + radius + 60) {
                this.remove(i);
                continue;
            }
            const pops =
                bubble.fuse <= 0 ||
                bubble.age > bubble.lifespan ||
                (eaterHead !== undefined && Math.hypot(x - eaterHead.x, y - eaterHead.y) < (eater?.radius ?? 0) + radius * 0.5) ||
                (holeCentre !== undefined && Math.hypot(x - holeCentre.x, y - holeCentre.y) < (hole?.radius ?? 0) + radius * 0.3);
            if (pops) {
                this.pop(i, tickContext);
            }
        }
    }

    /** Droplets of the `rain` effect: one found inside a bubble may pop it. Half the list per tick. */
    private meetRain(tickContext: TickContext): void {
        const drops = tickContext.read('rain')?.drops;
        const bubbles = this.bubbles;
        if (!drops || drops.length === 0 || bubbles.length === 0) {
            return;
        }
        // Most droplets are nowhere near a bubble: one box round all of them rules those out.
        let left = Infinity;
        let right = -Infinity;
        let top = Infinity;
        let bottom = -Infinity;
        for (const { state } of bubbles) {
            left = Math.min(left, state.x - state.radius);
            right = Math.max(right, state.x + state.radius);
            top = Math.min(top, state.y - state.radius);
            bottom = Math.max(bottom, state.y + state.radius);
        }
        for (let i = tickContext.totalTickCount & 1; i < drops.length; i += 2) {
            const drop = drops[i];
            const x = drop.position.x;
            const y = drop.position.y + drop.size.y; // the head of the droplet
            if (x < left || x > right || y < top || y > bottom || drop.life !== 'alive') {
                continue;
            }
            for (const bubble of bubbles) {
                const dx = x - bubble.state.x;
                const dy = y - bubble.state.y;
                const radius = bubble.state.radius;
                if (dx > radius || dx < -radius || dy > radius || dy < -radius || dx * dx + dy * dy > radius * radius) {
                    continue;
                }
                if (Math.random() < Bubbles.RAIN_POP_CHANCE) {
                    bubble.fuse = 0;
                }
            }
        }
    }

    /** The film snaps: an event, a ring that the glass animates, and a spray of droplets from the rim. */
    private pop(index: number, tickContext: TickContext): void {
        const bubble = this.bubbles[index];
        const { x, y, radius } = bubble.state;
        tickContext.emit('bubble:popped', { x, y, radius });
        this.context.popped++;
        if (this.pops.length < 40) {
            this.pops.push({ x, y, radius, squash: bubble.squash, phase: bubble.phase, age: 0 });
        }
        const droplets = Math.round(randomNumber(6, 12) * (0.4 + 0.6 * tickContext.budget.budget));
        for (let k = 0; k < droplets && this.sprayCount < BubbleGlass.MAX_DROPLETS; k++) {
            const n = this.sprayCount++;
            const angle = Math.random() * Math.PI * 2;
            const speed = randomNumber(0.04, 0.17);
            this.sprayX[n] = x + Math.cos(angle) * radius;
            this.sprayY[n] = y + Math.sin(angle) * radius;
            this.sprayVx[n] = Math.cos(angle) * speed + bubble.vx;
            this.sprayVy[n] = Math.sin(angle) * speed + bubble.vy - 0.02;
            this.spraySpan[n] = randomNumber(300, 620);
            this.sprayLife[n] = this.spraySpan[n];
            this.spraySize[n] = randomNumber(2.2, 4.2) * (0.8 + radius / 120);
        }
        this.remove(index);
    }

    private remove(index: number): void {
        const bubbles = this.bubbles;
        this.spare.push(bubbles[index]);
        bubbles[index] = bubbles[bubbles.length - 1];
        bubbles.pop();
    }

    /** Pops and their spray play out. */
    private fade(dt: number): void {
        const pops = this.pops;
        for (let i = pops.length - 1; i >= 0; i--) {
            pops[i].age += dt;
            if (pops[i].age >= Bubbles.POP_MS) {
                pops.splice(i, 1);
            }
        }
        const { sprayX, sprayY, sprayVx, sprayVy, sprayLife, spraySpan, spraySize } = this;
        const keep = Math.exp(-dt / 900);
        for (let i = 0; i < this.sprayCount; i++) {
            sprayLife[i] -= dt;
            if (sprayLife[i] <= 0) {
                const last = --this.sprayCount;
                sprayX[i] = sprayX[last];
                sprayY[i] = sprayY[last];
                sprayVx[i] = sprayVx[last];
                sprayVy[i] = sprayVy[last];
                sprayLife[i] = sprayLife[last];
                spraySpan[i] = spraySpan[last];
                spraySize[i] = spraySize[last];
                i--;
                continue;
            }
            sprayVx[i] *= keep;
            sprayVy[i] = (sprayVy[i] + Bubbles.SPRAY_GRAVITY * dt) * keep;
            sprayX[i] += sprayVx[i] * dt;
            sprayY[i] += sprayVy[i] * dt;
        }
    }

    public onRender(timedContext: TimedContext): void {
        const glass = this.glass;
        if (!glass) {
            return;
        }
        const lead = timedContext.alpha * timedContext.tickDelta;
        glass.begin(timedContext);
        for (const bubble of this.bubbles) {
            const { x, y, radius } = bubble.state;
            glass.bubble(x + bubble.vx * lead, y + bubble.vy * lead, radius, bubble.squash, bubble.phase, bubble.jiggle, 0, clamp(bubble.age / 250, 0, 1));
        }
        for (const pop of this.pops) {
            glass.bubble(pop.x, pop.y, pop.radius, pop.squash, pop.phase, 0, clamp((pop.age + lead) / Bubbles.POP_MS, 0.001, 1), 1);
        }
        for (let i = 0; i < this.sprayCount; i++) {
            const left = this.sprayLife[i] / this.spraySpan[i];
            glass.droplet(this.sprayX[i] + this.sprayVx[i] * lead, this.sprayY[i] + this.sprayVy[i] * lead, this.spraySize[i], left * (2 - left) * 0.9);
        }
        glass.end();
    }

    public cleanup(): void {
        this.glass?.dispose();
        this.glass = undefined;
        this.bubbles.length = 0;
        this.spare.length = 0;
        this.pops.length = 0;
        this.states.length = 0;
        this.sprayCount = 0;
        this.lastHit.clear();
        this.breath.left = 0;
        this.birthWait = 0;
        this.context.count = 0;
        this.context.popped = 0;
    }
}
