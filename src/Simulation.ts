import type { AnyEffect } from './Effect';
import { ForceField } from './ForceField';
import { LEVEL_HOLD_MS, nextStep, readLevels, stepFor, stepOf, type LevelTrack } from './Levels';
import type { Stage } from './Stage';
import type {
    BudgetState,
    ContextOf,
    EffectContext,
    EngineEvent,
    LevelEnum,
    LevelInfo,
    LevelOf,
    PayloadOf,
    PointerInfo,
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
    /** How the visitor is pointing. Left out, it is a mouse. */
    pointer?: PointerInfo;
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
    /** Events sent from the page between ticks, kept until the page's own listeners have heard them. */
    private readonly fromOutside: EngineEvent[] = [];
    /** True while the page's listeners are being called. */
    private telling = false;
    private readonly warnedNames = new Set<string>();

    /** Each effect's own intensity, 0..1. Missing means 1. */
    private readonly intensities = new Map<string, number>();
    private sceneIntensity = 1;
    private detail = 1;
    /** Looks the page pinned with `setLevel`, by effect name. */
    private readonly levelPins = new Map<string, number>();
    /** What the engine keeps about each effect that has asked for a level. */
    private readonly levelTracks = new Map<string, LevelTrack>();

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
            pointer: { kind: 'mouse', coarse: false, last: undefined },
            scrollY: 0,
            forces: this.forces,
            stage,
            theme,
            budget,
            intensity: 1,
            level<E extends LevelEnum>(levels: E, pinned?: LevelOf<E>): LevelOf<E> {
                return self.pickLevel(levels, pinned) as LevelOf<E>;
            },
            read<K extends string>(effectName: K): Readonly<ContextOf<K>> | undefined {
                const found = this.previousEffectsContext.get(effectName) ?? this.previousTickContext.get(effectName);
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
        this.intensities.delete(effectName);
        this.levelPins.delete(effectName);
        this.levelTracks.delete(effectName);
        return effect;
    }

    public getEffect<E extends AnyEffect>(effectName: string): E | undefined {
        return this.effects.find((effect) => effect.effectName === effectName) as E | undefined;
    }

    /** True when the effect ticks and draws: switched on, not failed, and its intensity above zero. */
    public isEnabled(effectName: string): boolean {
        return this.effectEnabled.get(effectName) === true && !this.failed.has(effectName) && this.intensityOf(effectName) > 0;
    }

    // ---- how much: intensity ----

    /**
     * Set intensities, clamped to 0..1: one effect's (`'rain', 0.4`), several (`{ rain: 0.4 }`),
     * or with a lone number the whole scene's, which is multiplied into every effect's own.
     * Zero switches an effect off until it is raised again. Names not on the page and values
     * that are not numbers are ignored.
     */
    public setIntensity(effectName: string, intensity: number): void;
    public setIntensity(intensities: Readonly<Record<string, number>>): void;
    public setIntensity(sceneIntensity: number): void;
    public setIntensity(target: string | number | Readonly<Record<string, number>>, intensity?: number): void {
        if (typeof target === 'number') {
            if (Number.isFinite(target)) {
                this.sceneIntensity = clamp01(target);
            }
            return;
        }
        const entries: [string, number | undefined][] = typeof target === 'string' ? [[target, intensity]] : Object.entries(target);
        for (const [effectName, value] of entries) {
            if (this.effectEnabled.has(effectName) && typeof value === 'number' && Number.isFinite(value)) {
                this.intensities.set(effectName, clamp01(value));
            }
        }
    }

    /** An effect's own intensity as set (default 1), or with no name the scene's. */
    public getIntensity(effectName?: string): number {
        return effectName === undefined ? this.sceneIntensity : (this.intensities.get(effectName) ?? 1);
    }

    /** What the effect sees as `tick.intensity`: its own times the scene's. */
    public intensityOf(effectName: string): number {
        return (this.intensities.get(effectName) ?? 1) * this.sceneIntensity;
    }

    // ---- how rich: detail and levels ----

    /** How rich the whole scene may look, 0..1. Default 1. Only effects with looks use it. */
    public setDetail(detail: number): void {
        if (Number.isFinite(detail)) {
            this.detail = clamp01(detail);
        }
    }

    public getDetail(): number {
        return this.detail;
    }

    /**
     * Fix an effect's look to one of its enum's values, or give it back to the machine with
     * `undefined`. Wins over the effect's own option. An effect with one look ignores it.
     */
    public setLevel(effectName: string, level: number | undefined): void {
        if (!this.effectEnabled.has(effectName)) {
            return;
        }
        if (level === undefined || !Number.isFinite(level)) {
            this.levelPins.delete(effectName);
            return;
        }
        this.levelPins.set(effectName, level);
        // Show it right away in getLevels, before the effect next asks.
        const track = this.levelTracks.get(effectName);
        if (track) {
            this.moveTo(track, stepOf(track.values, level));
            track.pinned = true;
        }
    }

    /** Every effect that has asked for a level: the look it draws now, all its look names, and whether it is pinned. */
    public getLevels(): Record<string, LevelInfo> {
        const out: Record<string, LevelInfo> = {};
        for (const [effectName, track] of this.levelTracks) {
            out[effectName] = {
                level: track.values[track.step],
                name: track.names[track.step],
                names: [...track.names],
                pinned: track.pinned,
            };
        }
        return out;
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
            // An intensity of zero is off, the same as the switch.
            states[effectName] = enabled && this.intensityOf(effectName) > 0;
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
        const filled = ctx.previousEffectsContext;
        const stale = ctx.previousTickContext;
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
        if (input.pointer) {
            ctx.pointer.kind = input.pointer.kind;
            ctx.pointer.coarse = input.pointer.coarse;
            ctx.pointer.last = input.pointer.last;
        } else if (input.mousePosition) {
            // A caller that scripts the pointer without saying what it is: a mouse, last seen here.
            ctx.pointer.last = input.mousePosition;
        }
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
            ctx.intensity = this.intensityOf(effect.effectName);
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
        ctx.totalTickCount += 1;
    }

    /** `tick.level(...)` for the effect now ticking. See `Levels.ts` for how a look is picked. */
    private pickLevel(levels: LevelEnum, optionPin: number | undefined): number {
        const tickCount = this.tickContext.totalTickCount;
        const richness = this.detail * clamp01(this.tickContext.budget.budget);
        const effectName = this.currentEffect;
        let track = this.levelTracks.get(effectName);
        if (!track || track.levels !== levels) {
            const { values, names } = readLevels(levels);
            if (values.length === 0) {
                return 0;
            }
            if (!effectName) {
                // Asked outside an effect's tick: nothing to remember it by.
                return values[optionPin === undefined ? stepFor(richness, values.length) : stepOf(values, optionPin)];
            }
            track = { levels, values, names, step: stepFor(richness, values.length), changedAt: tickCount, askedAt: -1, pinned: false };
            this.levelTracks.set(effectName, track);
        }
        if (track.askedAt === tickCount) {
            return track.values[track.step];
        }
        track.askedAt = tickCount;

        const pin = this.levelPins.get(effectName) ?? optionPin;
        if (pin !== undefined && Number.isFinite(pin)) {
            this.moveTo(track, stepOf(track.values, pin));
            track.pinned = true;
        } else if (track.pinned) {
            // Just given back to the machine: it starts from the pinned look and waits its hold.
            track.pinned = false;
            track.changedAt = tickCount;
        } else if ((tickCount - track.changedAt) * Simulation.TICK_MS >= LEVEL_HOLD_MS) {
            this.moveTo(track, nextStep(track.step, richness, track.values.length));
        }
        return track.values[track.step];
    }

    private moveTo(track: LevelTrack, step: number): void {
        if (step !== track.step) {
            track.step = step;
            track.changedAt = this.tickContext.totalTickCount;
        }
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
        this.telling = true;
        // What the page itself sent since the last tick: the effects have just read it, and the
        // page's listeners hear it now, with what the effects emitted in this tick after it.
        for (const event of this.fromOutside) {
            const listeners = this.outsideListeners.get(event.type);
            if (listeners) {
                for (const listener of listeners) {
                    try {
                        listener(event);
                    } catch (error) {
                        this.onEffectError?.(event.source, 'tick', error);
                    }
                }
            }
        }
        this.fromOutside.length = 0;
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
        this.telling = false;
    }

    private emit<K extends string>(type: K, payload: PayloadOf<K>): void {
        let list = this.eventsBuilding.get(type);
        if (!list) {
            list = [];
            this.eventsBuilding.set(type, list);
        }
        const event = {
            type,
            source: this.currentEffect,
            tick: this.tickContext.totalTickCount,
            payload,
        };
        list.push(event);
        // Sent from the page, between ticks: by the end of the next tick this list belongs to the
        // effects, so the page's listeners would never see it. Keep it for them.
        if (this.currentEffect === '' && !this.telling) {
            this.fromOutside.push(event);
        }
    }
}

function clamp01(value: number): number {
    return value < 0 ? 0 : value > 1 ? 1 : value;
}
