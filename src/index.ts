export { VisualsManager, DEFAULT_THEME, type VisualsManagerOptions } from './VisualsManager';
export { Simulation, type TickInput } from './Simulation';
export { Effect, type AnyEffect, type EffectHost } from './Effect';
export { Particle, type ParticleProps, type ParticleLife } from './Particle';
export { ParticleSet, PopulationGovernor, type GovernorOptions, type ParticleSetOptions } from './Governor';
export { ForceField, type Force, type ForceKind, type Shock, type ShockOptions } from './ForceField';
export { Stage, type AnchorRect } from './Stage';
export { Compositor, type CompositorOptions, type Surfaces } from './Compositor';
export { InputState, normalizeKey } from './Input';
export { attachPageRipples, type PageRipplesOptions } from './dom/PageRipples';
export { GradientType, gradientAtPosition } from './Gradients';
export { randomNumber, distanceV2, clamp, lerp, smoothstep, approach, mixColor, rgbToHex } from './math';
export type {
    Vector3,
    EffectContext,
    EffectContextMap,
    EngineEventMap,
    EngineEvent,
    ContextOf,
    PayloadOf,
    TickContext,
    TimedContext,
    Theme,
    BudgetState,
} from './types';
