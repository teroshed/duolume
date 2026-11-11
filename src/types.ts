import type { Container } from 'pixi.js';
import type { Group } from 'three';
import type { ForceField } from './ForceField';
import type { Stage } from './Stage';

/** Same shape as the original engine's vector. `z` is optional depth in stage pixels. */
export interface Vector3 {
    x: number;
    y: number;
    z?: number;
}

/**
 * What an effect (or a particle) hands back from `onTick`.
 * Identical to the original contract: a type tag plus a free-form bag.
 */
export interface EffectContext<T extends object = Record<string, unknown>> {
    effectType: string;
    effectContext: T;
}

/**
 * Registry of published effect contexts, keyed by `effectName`. Optional: an effect works
 * without an entry, its context is just untyped for readers. The effect library keeps all of
 * its entries in one file, `effects/contracts.ts`; add a line there to make
 * `tick.read('yourEffect')` typed.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface EffectContextMap {}

/**
 * Emitted by any effect when something of its own stops against a page element: a crystal
 * shard, a raindrop. The page can listen with `manager.on('page:hit', …)` and answer on the
 * element itself, for example with a ripple.
 */
export interface PageHitEvent {
    /** Where it stopped, in stage pixels. */
    x: number;
    y: number;
    /** `data-fx-anchor` name of the element it stopped on. */
    anchor: string;
    /** True when it was stopped at the element's edge, false when it stopped somewhere inside. */
    edge: boolean;
    /** What hit it: 'shard', 'rain', … */
    kind: string;
}

/** Registry of one-shot event payloads, keyed by event type. Extended the same way. */
export interface EngineEventMap {
    'page:hit': PageHitEvent;
}

export type ContextOf<K extends string> = K extends keyof EffectContextMap
    ? EffectContextMap[K]
    : Record<string, unknown>;

export type PayloadOf<K extends string> = K extends keyof EngineEventMap ? EngineEventMap[K] : unknown;

export interface EngineEvent<K extends string = string> {
    readonly type: K;
    /** `effectName` of the emitter. */
    readonly source: string;
    /** Tick on which it was emitted. Readers see it on the following tick. */
    readonly tick: number;
    readonly payload: PayloadOf<K>;
}

/** Paint, kept apart from simulation: changing it never restarts an effect. Colours are 0xRRGGBB. */
export interface Theme {
    bgTop: number;
    bgBottom: number;
    glowA: number;
    glowB: number;
    accent: number;
    accentAlt: number;
    ink: number;
}

/** Frame-rate governor state handed to effects. See PopulationGovernor. */
export interface BudgetState {
    /** 0..1 share of each population's capacity that may be alive right now. */
    readonly budget: number;
    /** Delivered frames per real second, averaged. */
    readonly averageFps: number;
    /** True below the emergency threshold (12.5 fps average): immediate removal is allowed. */
    readonly emergency: boolean;
}

/**
 * Passed to every `onTick`. The original fields keep their names and units:
 * `timeDelta` is milliseconds, positions are stage pixels with the origin top-left.
 */
export interface TickContext {
    timeDelta: number;
    canvasDimensions?: Vector3;
    /** The complete map published during the preceding tick. */
    previousTickContext?: Map<string, EffectContext>;
    /** Filled as effects run during this tick: an effect can read what earlier effects just returned. */
    previousEffectsContext?: Map<string, EffectContext>;
    totalTickCount?: number;
    mousePosition?: Vector3;
    mouseDown: boolean;
    keysPressed: string[];
    justPressedKeys?: string[];
    justReleasedKeys?: string[];
    mouseJustPressed?: boolean;
    mouseJustReleased?: boolean;
    wheelDelta?: number;
    speedMultiplier?: number;

    // ---- additions ----

    /** Simulation clock in milliseconds. Pauses and scales with the simulation; use it instead of performance.now(). */
    time: number;
    /** True when the press landed on a link, button or form control. */
    mouseOnInteractive: boolean;
    /** Page scroll offset in pixels. */
    scrollY: number;
    /** Shared force field: any effect adds forces, any effect samples them, whichever renderer it draws with. */
    forces: ForceField;
    /** Shared coordinate space, DOM anchors and the 2D↔3D mapping. */
    stage: Stage;
    theme: Theme;
    budget: BudgetState;
    /**
     * Freshest published context for an effect: this tick's if that effect already ran,
     * otherwise last tick's. Returns the inner `effectContext`.
     */
    read<K extends string>(effectName: K): Readonly<ContextOf<K>> | undefined;
    /** Queue a one-shot event. Every effect sees it during the next tick, whatever the run order. */
    emit<K extends string>(type: K, payload: PayloadOf<K>): void;
    /** Events emitted during the previous tick. */
    events<K extends string>(type: K): readonly EngineEvent<K>[];
}

/**
 * Passed to every `onRender` (the original `TimedContext`).
 * `context` used to be the 2D canvas context; it is now the effect's own Pixi container.
 */
export interface TimedContext {
    /** Effect-owned Pixi container, drawn behind the Three.js scene. */
    context: Container;
    /** Effect-owned Pixi container drawn in front of the Three.js scene. */
    front: Container;
    /** Effect-owned Three.js group. */
    group: Group;
    /** Measured milliseconds since the previous rendered frame. */
    timeDelta: number;
    /** How far the frame is into the next tick, 0..1, for extrapolating motion. */
    alpha: number;
    /** Milliseconds of simulation one tick advances at the current speed. */
    tickDelta: number;
    /** Simulation clock in milliseconds, including the partial tick. */
    time: number;
    canvasDimensions?: Vector3;
    mousePosition?: Vector3;
    mouseDown: boolean;
    keysPressed: string[];
    justPressedKeys?: string[];
    justReleasedKeys?: string[];
    mouseJustPressed?: boolean;
    mouseJustReleased?: boolean;
    wheelDelta?: number;
    speedMultiplier?: number;
    stage: Stage;
    theme: Theme;
    budget: BudgetState;
}
