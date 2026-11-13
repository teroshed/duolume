import type { Particle as PixiParticle } from 'pixi.js';
import { gradientAtPosition, type GradientType } from '../../src/Gradients';
import { clamp, mixColor, randomNumber } from '../../src/math';
import type { AnchorRect } from '../../src/Stage';
import type { TickContext, TimedContext, Vector3 } from '../../src/types';

/** What PageWater needs from Rain: views from its pool, and a way to turn water into a falling droplet. */
export interface WaterPort {
    /** A teardrop view (head at the bottom, tail up): the same picture a falling droplet uses. */
    acquireTail(): PixiParticle;
    release(view: PixiParticle): void;
    /** Returns false when the drop set is full; the water then simply keeps hanging. */
    spawnDroplet(centerX: number, headY: number, water: number, velocityY: number): boolean;
}

// Rain draws a droplet of a given size on its 16x64 teardrop texture, 2.2x as wide and 1.5x as tall.
const WIDTH_SCALE = 2.2 / 16;
const HEIGHT_SCALE = 1.5 / 64;

/** A drop growing on the underside of an element. */
interface UndersideDrop {
    /** 0..1 along the bottom edge, fixed for this drop. */
    u: number;
    fill: number;
    detachAt: number;
    /** Personal growth rate multiplier. */
    rate: number;
    pause: number;
    view?: PixiParticle;
}

/** A bead sliding down an outer side edge. */
interface Runner {
    side: -1 | 1;
    /** Distance of the bead below the element's top, in pixels. */
    along: number;
    /** px per millisecond. */
    speed: number;
    pause: number;
    water: number;
    view?: PixiParticle;
}

/** The water an element holds, and what hangs and runs off it. */
interface Reservoir {
    name: string;
    level: number;
    slots: UndersideDrop[];
    runners: Runner[];
    /** Milliseconds since the element was last visible. */
    hiddenFor: number;
    asleep: boolean;
}

/**
 * Water that rain leaves on page elements.
 *
 * Each element has a reservoir that stopped droplets fill. It drains only two ways: beads
 * that grow on the underside and let go as droplets (which can land on an element further
 * down: the cascade), and runners that slide down a side edge now and then.
 *
 * Ported from the feel of NexusTwo's SignalRain (`src/lib/visual-effects/effects/rain.ts`):
 * water collects until it forms a hanging drip, the drip grows for about a second and then
 * lets go, and a released drip is caught again by whatever is below it.
 */
export class PageWater {
    public static readonly RESERVOIR_CAP = 60;
    /** Underside slots: one per this many pixels of width, at least 1. */
    public static readonly SLOT_WIDTH = 220;
    public static readonly MAX_UNDERSIDE_DROPS = 4;
    public static readonly MAX_RUNNERS = 2;
    /** Water an underside drop holds when it lets go (re-rolled per drop). */
    public static readonly MIN_DETACH = 2;
    public static readonly MAX_DETACH = 3;
    /** Volume per millisecond an underside drop draws, empty reservoir to full. */
    public static readonly GROW_BASE = 0.0003;
    public static readonly GROW_FULL = 0.0014;
    /** Below this a reservoir is dry: nothing grows or runs. */
    public static readonly MIN_DRAW = 0.15;
    public static readonly MIN_PAUSE_MS = 300;
    public static readonly MAX_PAUSE_MS = 1500;
    /** Chance per millisecond of a runner starting, times the fill fraction: about one per 3 s when full. */
    public static readonly RUNNER_PER_MS = 0.00035;
    public static readonly RUNNER_MIN_LEVEL = 3;
    public static readonly RUNNER_START_SPEED = 0.015;
    public static readonly RUNNER_ACCELERATION = 0.00012;
    public static readonly RUNNER_MAX_SPEED = 0.35;
    /** Chance per millisecond that a runner stalls, like water on glass. */
    public static readonly HESITATE_PER_MS = 0.0012;
    /** An element that has been gone this long forgets its water. */
    public static readonly FORGET_MS = 4000;
    public static readonly DETACHED_START_SPEED = 0.03;
    /** A free drop holding DROP_WATER has DROP_SIZE, in the units of a Droplet's size. */
    public static readonly DROP_WATER = 2.5;
    public static readonly DROP_SIZE: Vector3 = { x: 3.6, y: 8 };

    /**
     * Size of a free drop holding `water`. A hanging drop grows into exactly this size, and the
     * droplet that falls is born with it, so nothing changes size at the moment it lets go.
     */
    public static dropSize(water: number, out: Vector3): Vector3 {
        const scale = Math.sqrt(clamp(water, 0.2, 6) / PageWater.DROP_WATER);
        out.x = PageWater.DROP_SIZE.x * scale;
        out.y = PageWater.DROP_SIZE.y * scale;
        return out;
    }

    /** Total water held across reservoirs. */
    public pooled = 0;
    /** Underside drops and runners alive. */
    public dripping = 0;

    private readonly reservoirs = new Map<string, Reservoir>();
    private readonly scratch: Vector3 = { x: 0, y: 0 };
    private readonly size: Vector3 = { x: 0, y: 0 };

    public constructor(private readonly port: WaterPort) {}

    /** Water from a stopped droplet. */
    public add(rect: AnchorRect, volume: number): void {
        const reservoir = this.reservoirOf(rect.name);
        reservoir.level = Math.min(PageWater.RESERVOIR_CAP, reservoir.level + volume);
    }

    /** A droplet was stopped on a side edge at height `y`: start a runner there, or feed the one already running. */
    public runOnSide(rect: AnchorRect, side: -1 | 1, y: number, volume: number): void {
        const reservoir = this.reservoirOf(rect.name);
        for (let i = 0; i < reservoir.runners.length; i++) {
            const runner = reservoir.runners[i];
            if (runner.side === side) {
                runner.water += this.draw(reservoir, volume);
                return;
            }
        }
        if (reservoir.runners.length < PageWater.MAX_RUNNERS) {
            this.startRunner(reservoir, side, clamp(y - rect.y, 0, rect.height), volume);
        }
    }

    public tick(tickContext: TickContext, elements: readonly AnchorRect[]): void {
        const dt = tickContext.timeDelta;
        for (const reservoir of this.reservoirs.values()) {
            reservoir.hiddenFor += dt;
        }
        for (let i = 0; i < elements.length; i++) {
            const rect = elements[i];
            const reservoir = this.reservoirOf(rect.name);
            reservoir.hiddenFor = 0;
            reservoir.asleep = false;
            this.fitSlots(reservoir, rect);
            this.growUndersideDrops(reservoir, rect, dt);
            this.startRunnerNow(reservoir, rect, dt);
            this.slideRunners(reservoir, rect, dt);
        }

        let pooled = 0;
        let dripping = 0;
        for (const reservoir of this.reservoirs.values()) {
            if (reservoir.hiddenFor > 0) {
                if (!reservoir.asleep) {
                    this.sleep(reservoir);
                }
                if (reservoir.hiddenFor > PageWater.FORGET_MS) {
                    this.reservoirs.delete(reservoir.name);
                    continue;
                }
            }
            pooled += reservoir.level;
            for (let i = 0; i < reservoir.slots.length; i++) {
                if (reservoir.slots[i].fill > 0) {
                    dripping++;
                }
            }
            dripping += reservoir.runners.length;
        }
        this.pooled = pooled;
        this.dripping = dripping;
    }

    /** Move views only. Positions come from the anchor's rectangle this frame, so beads follow scrolling. */
    public onRender(timedContext: TimedContext, gradientType: GradientType): void {
        const lead = timedContext.alpha * timedContext.tickDelta;
        const point = this.scratch;
        for (const reservoir of this.reservoirs.values()) {
            const rect = timedContext.stage.anchor(reservoir.name);
            const visible = rect !== undefined && rect.visible;

            for (let i = 0; i < reservoir.slots.length; i++) {
                const slot = reservoir.slots[i];
                const view = slot.view;
                if (!view) {
                    continue;
                }
                if (!visible) {
                    view.alpha = 0;
                    continue;
                }
                const progress = clamp(slot.fill / slot.detachAt, 0, 1);
                // It grows into the droplet that will fall: same picture, and at the moment it lets
                // go the same size, place and colour. It swells first, then stretches to full length.
                const full = PageWater.dropSize(slot.detachAt, this.size);
                const width = full.x * (0.3 + 0.7 * Math.pow(progress, 0.7));
                const length = width + (full.y - width) * progress * progress * progress;
                view.scaleX = width * WIDTH_SCALE;
                view.scaleY = length * HEIGHT_SCALE;
                view.x = rect.x + slot.u * rect.width;
                view.y = rect.y + rect.height + length;
                point.x = view.x;
                point.y = view.y;
                view.tint = mixColor(
                    gradientAtPosition(gradientType, point, timedContext.time, timedContext.theme),
                    0xffffff,
                    0.4 * (1 - progress),
                );
                view.alpha = 0.5 + 0.5 * progress;
            }

            for (let i = 0; i < reservoir.runners.length; i++) {
                const runner = reservoir.runners[i];
                const view = runner.view;
                if (!view) {
                    continue;
                }
                if (!visible) {
                    view.alpha = 0;
                    continue;
                }
                const speed = runner.pause > 0 ? 0 : runner.speed;
                const along = Math.min(rect.height, runner.along + speed * lead);
                view.x = runner.side < 0 ? rect.x - 1.5 : rect.x + rect.width + 1.5;
                view.y = rect.y + along;
                // As wide as the droplet it becomes at the bottom of the edge.
                view.scaleX = PageWater.dropSize(runner.water, this.size).x * WIDTH_SCALE;
                view.scaleY = Math.min(40, 6 + speed * 140) / 64;
                point.x = view.x;
                point.y = view.y;
                view.tint = mixColor(gradientAtPosition(gradientType, point, timedContext.time, timedContext.theme), 0xffffff, 0.35);
                view.alpha = 0.75;
            }
        }
    }

    /** Release every view and forget all water. */
    public clear(): void {
        for (const reservoir of this.reservoirs.values()) {
            this.releaseAll(reservoir);
        }
        this.reservoirs.clear();
        this.pooled = 0;
        this.dripping = 0;
    }

    private reservoirOf(name: string): Reservoir {
        let reservoir = this.reservoirs.get(name);
        if (!reservoir) {
            reservoir = { name, level: 0, slots: [], runners: [], hiddenFor: 0, asleep: false };
            this.reservoirs.set(name, reservoir);
        }
        return reservoir;
    }

    /** One hanging drop per ~220 px of width, each at its own fixed place along the bottom edge. */
    private fitSlots(reservoir: Reservoir, rect: AnchorRect): void {
        const wanted = clamp(Math.round(rect.width / PageWater.SLOT_WIDTH), 1, PageWater.MAX_UNDERSIDE_DROPS);
        if (reservoir.slots.length === wanted) {
            return;
        }
        for (let i = 0; i < reservoir.slots.length; i++) {
            this.returnSlot(reservoir, reservoir.slots[i]);
        }
        reservoir.slots.length = 0;
        for (let i = 0; i < wanted; i++) {
            reservoir.slots.push({
                u: (i + 0.15 + Math.random() * 0.7) / wanted,
                fill: 0,
                detachAt: randomNumber(PageWater.MIN_DETACH, PageWater.MAX_DETACH),
                rate: randomNumber(0.7, 1.3),
                pause: randomNumber(0, PageWater.MAX_PAUSE_MS),
            });
        }
    }

    private growUndersideDrops(reservoir: Reservoir, rect: AnchorRect, dt: number): void {
        const fullness = reservoir.level / PageWater.RESERVOIR_CAP;
        const rate = PageWater.GROW_BASE + PageWater.GROW_FULL * fullness;
        for (let i = 0; i < reservoir.slots.length; i++) {
            const slot = reservoir.slots[i];
            if (slot.pause > 0) {
                slot.pause -= dt;
                continue;
            }
            if (reservoir.level > PageWater.MIN_DRAW && slot.fill < slot.detachAt) {
                const wanted = Math.min(slot.detachAt - slot.fill, rate * slot.rate * dt);
                slot.fill += this.draw(reservoir, wanted);
            }
            if (slot.fill > 0 && !slot.view) {
                slot.view = this.port.acquireTail();
            }
            if (slot.fill >= slot.detachAt) {
                const x = rect.x + slot.u * rect.width;
                // Born where the hanging drop's head is: one drop-length below the edge.
                const headY = rect.y + rect.height + PageWater.dropSize(slot.fill, this.size).y;
                if (this.port.spawnDroplet(x, headY, slot.fill, PageWater.DETACHED_START_SPEED)) {
                    this.resetSlot(slot);
                }
            }
        }
    }

    /** Now and then a bead starts at the top of a side edge; wetter elements do it more often. */
    private startRunnerNow(reservoir: Reservoir, rect: AnchorRect, dt: number): void {
        if (reservoir.runners.length >= PageWater.MAX_RUNNERS || reservoir.level < PageWater.RUNNER_MIN_LEVEL) {
            return;
        }
        const fullness = reservoir.level / PageWater.RESERVOIR_CAP;
        if (Math.random() < PageWater.RUNNER_PER_MS * fullness * dt) {
            const side = Math.random() < 0.5 ? -1 : 1;
            const along = randomNumber(2, Math.min(28, rect.height * 0.25));
            this.startRunner(reservoir, side, along, randomNumber(0.8, 1.4));
        }
    }

    private slideRunners(reservoir: Reservoir, rect: AnchorRect, dt: number): void {
        for (let i = reservoir.runners.length - 1; i >= 0; i--) {
            const runner = reservoir.runners[i];
            if (runner.pause > 0) {
                runner.pause -= dt;
            } else {
                runner.speed = Math.min(PageWater.RUNNER_MAX_SPEED, runner.speed + PageWater.RUNNER_ACCELERATION * dt);
                if (Math.random() < PageWater.HESITATE_PER_MS * dt) {
                    // Real water on glass stalls, then lets go again slowly.
                    runner.pause = randomNumber(90, 320);
                    runner.speed *= 0.25;
                }
                runner.along += runner.speed * dt;
            }
            if (runner.along < rect.height) {
                continue;
            }
            runner.along = rect.height;
            const x = runner.side < 0 ? rect.x - 2 : rect.x + rect.width + 2;
            if (this.port.spawnDroplet(x, rect.y + rect.height + 6, runner.water, Math.max(0.04, runner.speed))) {
                this.releaseView(runner.view);
                runner.view = undefined;
                reservoir.runners.splice(i, 1);
            }
        }
    }

    private startRunner(reservoir: Reservoir, side: -1 | 1, along: number, wanted: number): void {
        const water = this.draw(reservoir, wanted);
        if (water <= 0) {
            return;
        }
        reservoir.runners.push({
            side,
            along,
            speed: PageWater.RUNNER_START_SPEED,
            pause: 0,
            water,
            view: this.port.acquireTail(),
        });
    }

    /** Take up to `wanted` from the reservoir. Returns what was actually taken. */
    private draw(reservoir: Reservoir, wanted: number): number {
        const taken = Math.min(wanted, reservoir.level);
        reservoir.level -= taken;
        return taken;
    }

    /** The element is off-screen: views go back to the pool and hanging water returns to the reservoir. */
    private sleep(reservoir: Reservoir): void {
        reservoir.asleep = true;
        for (let i = 0; i < reservoir.slots.length; i++) {
            this.returnSlot(reservoir, reservoir.slots[i]);
        }
        for (let i = 0; i < reservoir.runners.length; i++) {
            const runner = reservoir.runners[i];
            reservoir.level = Math.min(PageWater.RESERVOIR_CAP, reservoir.level + runner.water);
            this.releaseView(runner.view);
        }
        reservoir.runners.length = 0;
    }

    private returnSlot(reservoir: Reservoir, slot: UndersideDrop): void {
        reservoir.level = Math.min(PageWater.RESERVOIR_CAP, reservoir.level + slot.fill);
        slot.fill = 0;
        this.releaseView(slot.view);
        slot.view = undefined;
    }

    private resetSlot(slot: UndersideDrop): void {
        slot.fill = 0;
        slot.detachAt = randomNumber(PageWater.MIN_DETACH, PageWater.MAX_DETACH);
        slot.rate = randomNumber(0.7, 1.3);
        slot.pause = randomNumber(PageWater.MIN_PAUSE_MS, PageWater.MAX_PAUSE_MS);
        this.releaseView(slot.view);
        slot.view = undefined;
    }

    private releaseAll(reservoir: Reservoir): void {
        for (let i = 0; i < reservoir.slots.length; i++) {
            this.releaseView(reservoir.slots[i].view);
            reservoir.slots[i].view = undefined;
        }
        for (let i = 0; i < reservoir.runners.length; i++) {
            this.releaseView(reservoir.runners[i].view);
            reservoir.runners[i].view = undefined;
        }
    }

    private releaseView(view: PixiParticle | undefined): void {
        if (view) {
            this.port.release(view);
        }
    }
}
