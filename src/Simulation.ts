import type { AnyEffect } from './Effect';
import { ForceField } from './ForceField';
import type { Stage } from './Stage';
import type {
    BudgetState,
    ContextOf,
    EffectContext,
    EngineEvent,
    PayloadOf,
    Theme,
    TickContext,
    Vector3,
} from './types';

/** Everything the outside world feeds one tick. Edges (`just…`) must be supplied to one tick only. */
export interface TickInput {
    canvasDimensions: Vector3;
    mousePosition?: Vector3;
    mouseDown: boolean;
    mouseOnInteractive: boolean;
    keysPressed: string[];
    justPressedKeys: string[];
    justReleasedKeys: string[];
    mouseJustPressed: boolean;
    mouseJustReleased: boolean;
    wheelDelta: number;
    scrollY: number;
}

const NO_EVENTS: readonly EngineEvent[] = Object.freeze([]);

/**
 * The renderer-free half of the engine: the effect list, the tick, and the three ways
 * effects reach each other.
 *
 * 1. Published contexts — the original mechanism, kept ordered. `previousTickContext` is
 *    the whole map from the tick before; `previousEffectsContext` fills up as effects run,
 *    so a later effect can read what an earlier one returned this very tick.
 * 2. Forces — a shared field (see ForceField).
 * 3. Events — one-shot messages. Deliberately different from (1): everything emitted during
 *    a tick is delivered as one batch on the next, so delivery never depends on run order.
 *
 * None of the three knows which renderer an effect draws with. That is the whole point:
 * a Three.js object and a Pixi particle system influence each other through the same
 * channels two Pixi effects would use.
 */
export class Simulation {
    public static readonly TICK_RATE = 60;
    public static readonly TICK_MS = 1000 / Simulation.TICK_RATE;

    public readonly effects: AnyEffect[] = [];
    public readonly forces = new ForceField();
    public readonly tickContext: TickContext;

    private readonly effectEnabled = new Map<string, boolean>();
    private readonly failed = new Set<string>();
    private timeScale = 1;
    private currentEffect = '';

    private mapA = new Map<string, EffectContext>();
    private mapB = new Map<string, EffectContext>();
    private eventsBuilding = new Map<string, EngineEvent[]>();
    private eventsSettled = new Map<string, EngineEvent[]>();

    public onEffectError?: (effectName: string, phase: 'tick' | 'render' | 'cleanup', error: unknown) => void;

    private readonly outsideListeners = new Map<string, Set<(event: EngineEvent) => void>>();
    private readonly warnedNames = new Set<string>();

    public constructor(stage: Stage, theme: Theme, budget: BudgetState) {
        const self = this;
        this.tickContext = {
            timeDelta: 0,
            canvasDimensions: { x: 1, y: 1 },
            previousTickContext: this.mapA,
            previousEffectsContext: this.mapB,
            totalTickCount: 0,
            mousePosition: undefined,
            mouseDown: false,
            keysPressed: [],
            justPressedKeys: [],
            justReleasedKeys: [],
            mouseJustPressed: false,
            mouseJustReleased: false,
            wheelDelta: 0,
            speedMultiplier: 1,
            time: 0,
            mouseOnInteractive: false,
            scrollY: 0,
            forces: this.forces,
            stage,
            theme,
            budget,
            read<K extends string>(effectName: K): Readonly<ContextOf<K>> | undefined {
                const found =
                    this.previousEffectsContext?.get(effectName) ?? this.previousTickContext?.get(effectName);
                if (!found) {
                    self.noteUnknownName(effectName);
                }
                return found?.effectContext as Readonly<ContextOf<K>> | undefined;
            },
            emit<K extends string>(type: K, payload: PayloadOf<K>): void {
                self.emit(type, payload);
            },
            events<K extends string>(type: K): readonly EngineEvent<K>[] {
                return (self.eventsSettled.get(type) as EngineEvent<K>[] | undefined) ?? (NO_EVENTS as EngineEvent<K>[]);
            },
        };
    }

    public addEffect(effect: AnyEffect): void {
        if (this.effectEnabled.has(effect.effectName)) {
            throw new Error(`An effect named "${effect.effectName}" is already registered.`);
        }
        this.effects.push(effect);
        this.effectEnabled.set(effect.effectName, true);
    }

    /**
     * Let code outside the simulation (the page) hear an event type. Listeners are called once
     * the tick that emitted the event has finished, never in the middle of it.
     */
    public on<K extends string>(type: K, listener: (event: EngineEvent<K>) => void): () => void {
        let set = this.outsideListeners.get(type);
        if (!set) {
            set = new Set();
            this.outsideListeners.set(type, set);
        }
        const entry = listener as (event: EngineEvent) => void;
        set.add(entry);
        return () => set.delete(entry);
    }

    public removeEffect(effectName: string): AnyEffect | undefined {
        const index = this.effects.findIndex((effect) => effect.effectName === effectName);
        if (index < 0) {
            return undefined;
        }
        const [effect] = this.effects.splice(index, 1);
        this.effectEnabled.delete(effectName);
        this.failed.delete(effectName);
        this.mapA.delete(effectName);
        this.mapB.delete(effectName);
        return effect;
    }

    public getEffect<E extends AnyEffect>(effectName: string): E | undefined {
        return this.effects.find((effect) => effect.effectName === effectName) as E | undefined;
    }

    public isEnabled(effectName: string): boolean {
        return this.effectEnabled.get(effectName) === true && !this.failed.has(effectName);
    }

    public setEffectEnabled(effectName: string, enabled: boolean): void {
        if (!this.effectEnabled.has(effectName)) {
            return;
        }
        this.effectEnabled.set(effectName, enabled);
    }

    public toggleEffect(effectName: string): boolean {
        const current = this.effectEnabled.get(effectName);
        if (current === undefined) {
            return false;
        }
        this.effectEnabled.set(effectName, !current);
        return !current;
    }

    public getEffectEnabledState(): Record<string, boolean> {
        const states: Record<string, boolean> = {};
        for (const [effectName, enabled] of this.effectEnabled.entries()) {
            states[effectName] = enabled;
        }
        return states;
    }

    public setTimeScale(scale: number): void {
        this.timeScale = Math.max(0.2, Math.min(3, scale));
    }

    public getTimeScale(): number {
        return this.timeScale;
    }

    /** Milliseconds of simulation one tick advances at the current speed. */
    public get tickDelta(): number {
        return Simulation.TICK_MS * this.timeScale;
    }

    /** Stop ticking and rendering an effect after it threw. The rest carry on. */
    public markFailed(effectName: string): void {
        this.failed.add(effectName);
    }

    /** Advance exactly one tick. */
    public tickCycle(input: TickInput): void {
        const ctx = this.tickContext;

        // The map filled last tick becomes "previous tick"; the older one is cleared and refilled.
        const filled = ctx.previousEffectsContext!;
        const stale = ctx.previousTickContext!;
        stale.clear();
        ctx.previousTickContext = filled;
        ctx.previousEffectsContext = stale;

        const settledEvents = this.eventsSettled;
        this.eventsSettled = this.eventsBuilding;
        settledEvents.clear();
        this.eventsBuilding = settledEvents;

        ctx.timeDelta = this.tickDelta;
        ctx.canvasDimensions = input.canvasDimensions;
        ctx.mousePosition = input.mousePosition;
        ctx.mouseDown = input.mouseDown;
        ctx.mouseOnInteractive = input.mouseOnInteractive;
        ctx.keysPressed = input.keysPressed;
        ctx.justPressedKeys = input.justPressedKeys;
        ctx.justReleasedKeys = input.justReleasedKeys;
        ctx.mouseJustPressed = input.mouseJustPressed;
        ctx.mouseJustReleased = input.mouseJustReleased;
        ctx.wheelDelta = input.wheelDelta;
        ctx.scrollY = input.scrollY;
        ctx.speedMultiplier = this.timeScale;

        for (let i = 0; i < this.effects.length; i++) {
            const effect = this.effects[i];
            if (!this.isEnabled(effect.effectName)) {
                continue;
            }
            this.currentEffect = effect.effectName;
            try {
                const effectContext = effect.onTick(ctx);
                ctx.previousEffectsContext.set(effect.effectName, effectContext);
            } catch (error) {
                this.failed.add(effect.effectName);
                this.onEffectError?.(effect.effectName, 'tick', error);
            }
        }
        this.currentEffect = '';

        if (this.outsideListeners.size > 0) {
            this.tellOutside();
        }

        this.forces.step(ctx.timeDelta);
        ctx.time += ctx.timeDelta;
        ctx.totalTickCount = (ctx.totalTickCount ?? 0) + 1;
    }

    /**
     * Reading an effect that is switched off is normal and returns undefined. Reading a name
     * no effect on this page has is either an optional partner that was left out, or a typo.
     * Say so once, quietly: it shows with the console's verbose level on.
     */
    private noteUnknownName(effectName: string): void {
        if (this.effectEnabled.has(effectName) || this.warnedNames.has(effectName)) {
            return;
        }
        this.warnedNames.add(effectName);
        console.debug(
            `[visuals] read('${effectName}'): no effect with that name is on this page. Fine if it is optional; otherwise check the spelling.`,
        );
    }

    private tellOutside(): void {
        for (const [type, listeners] of this.outsideListeners) {
            const events = this.eventsBuilding.get(type);
            if (!events || listeners.size === 0) {
                continue;
            }
            for (const event of events) {
                for (const listener of listeners) {
                    try {
                        listener(event);
                    } catch (error) {
                        this.onEffectError?.(event.source, 'tick', error);
                    }
                }
            }
        }
    }

    private emit<K extends string>(type: K, payload: PayloadOf<K>): void {
        let list = this.eventsBuilding.get(type);
        if (!list) {
            list = [];
            this.eventsBuilding.set(type, list);
        }
        list.push({
            type,
            source: this.currentEffect,
            tick: this.tickContext.totalTickCount ?? 0,
            payload,
        });
    }
}
