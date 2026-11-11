import type { Container } from 'pixi.js';
import type { Group } from 'three';
import type { Surfaces } from './Compositor';
import type { Stage } from './Stage';
import type { EffectContext, TickContext, TimedContext } from './types';

/**
 * What the manager lends an effect. An effect is not "a Pixi effect" or "a Three effect":
 * it gets a place in both renderers and may draw in either, or both, or neither.
 */
export interface EffectHost {
    /** This effect's Pixi container, composited behind the Three.js scene. */
    readonly pixi: Container;
    /** This effect's Pixi container composited in front of the Three.js scene. */
    readonly pixiFront: Container;
    /** This effect's Three.js group. */
    readonly three: Group;
    readonly stage: Stage;
    /** The other renderer's pixels, for shaders: Three.js materials can sample the Pixi layer. */
    readonly surfaces: Surfaces;
}

/**
 * The original contract, unchanged in shape: a named effect with explicit
 * initialize / onTick / onRender / cleanup.
 *
 * `onTick` advances the simulation and returns what the effect wants the others to know.
 * `onRender` only moves views; it must not change simulation state.
 * The effect owns everything it adds to its containers and releases it in `cleanup`.
 */
export abstract class Effect<T extends object = Record<string, unknown>> {
    public abstract effectName: string;

    /** Set by the manager before `initialize`. */
    protected host!: EffectHost;

    /** @internal */
    public attach(host: EffectHost): void {
        this.host = host;
    }

    public abstract initialize(): void;
    public abstract onTick(tickContext: TickContext): EffectContext<T>;
    public abstract cleanup(): void;
    public abstract onRender(timedContext: TimedContext): void;

    /** Shorthand for the return value of `onTick`. */
    protected publish(effectContext: T): EffectContext<T> {
        return { effectType: this.effectName, effectContext };
    }
}

/** Any effect, whatever it publishes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEffect = Effect<any>;
