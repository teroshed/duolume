import type { Vector3 } from '../src/types';
import type { Droplet } from './Rain/Droplet';

/**
 * Everything the effects in this library publish and emit, in one file.
 *
 * This is what lets effects react to each other without importing each other: an effect
 * imports its own context type from here, and `tick.read('someEffect')` and
 * `tick.events('some:event')` come back typed for everyone.
 *
 * Adding an effect does not require touching this file — an unregistered context still
 * works, it is just untyped. To type it, add the interface and one line to the registry
 * at the bottom.
 */

// ---- rain -------------------------------------------------------------------------

export interface RainContext {
    /** The live droplet list, as in the original. Read it, do not edit it. */
    drops: readonly Droplet[];
    dropCount: number;
    /** Droplets the rain eater caught this tick. */
    eaten: number;
    /** Droplets that landed on a page ledge (top edge or inside it) this tick. */
    landed: number;
    /** Water held across the reservoirs of all elements. About 1 per average droplet. */
    pooled: number;
    /** Underside drops and runners alive right now. */
    dripping: number;
}

export interface RainLandedEvent {
    /** Where droplets landed this tick (ledges and ground), in stage pixels. At most 16 per tick. */
    points: Vector3[];
}

export interface RainEatenEvent {
    count: number;
    /** Average position of what was eaten, in stage pixels. */
    x: number;
    y: number;
}

// ---- rain eater -------------------------------------------------------------------

export interface RainEaterContext {
    /** The head's live position in stage pixels, as in the original. */
    headPosition: Vector3;
    velocity: Vector3;
    exploded: boolean;
    isExploded: boolean;
    /** Droplets closer than this are eaten. */
    eatDistance: number;
    radius: number;
    /** 0..1. Fills as it eats; at 1 the head explodes. */
    energy: number;
}

export interface RainEaterExplodedEvent {
    x: number;
    y: number;
    radius: number;
}

// ---- click explosion --------------------------------------------------------------

export interface ClickExplosionContext {
    /** Sparks currently alive. */
    explosions: number;
    /** Where the latest burst started, in stage pixels. */
    lastBurst: Vector3 | null;
}

// ---- lightning storm --------------------------------------------------------------

/** Emitted by `lightningStorm` when a bolt lands. */
export interface LightningStrikeEvent {
    /** Where the bolt ends, in stage pixels. */
    x: number;
    y: number;
    /** Where it started. */
    fromX: number;
    fromY: number;
    /** True when the bolt ended on the rain eater's head. */
    hitEater: boolean;
}

export interface ChargePoint {
    position: Vector3;
    charge: number;
    maxCharge: number;
}

export interface LightningStormContext {
    /** The live list, as in the original. Read it, do not edit it. */
    chargePoints: readonly ChargePoint[];
    /** Bolts currently visible. */
    activeLightning: number;
}

// ---- fireworks --------------------------------------------------------------------

/** Emitted by `fireworks` when a shell bursts. */
export interface FireworkExplodedEvent {
    x: number;
    y: number;
    /** 0..1 size of the burst relative to the largest. */
    power: number;
}

export interface FireworksContext {
    /** Shells in flight. */
    fireworks: number;
    /** Burst particles alive. */
    sparks: number;
}

// ---- aurora ribbons ---------------------------------------------------------------

export interface AuroraRibbonsContext {
    count: number;
}

// ---- crystals ---------------------------------------------------------------------

/** Emitted by `crystals` when one of them breaks. */
export interface CrystalExplodedEvent {
    x: number;
    y: number;
    radius: number;
}

export interface CrystalState {
    x: number;
    y: number;
    radius: number;
    exploded: boolean;
}

export interface CrystalsContext {
    /** One entry per crystal, reused between ticks. Read it, do not edit it. */
    crystals: readonly CrystalState[];
}

// ---- wind -------------------------------------------------------------------------

export interface WindContext {
    /** Acceleration the wind is applying right now, in px/ms². */
    x: number;
    y: number;
}

// ---- the registry -----------------------------------------------------------------

declare module '../src/types' {
    /** effectName → what that effect publishes. */
    interface EffectContextMap {
        rain: RainContext;
        rainEater: RainEaterContext;
        clickExplosion: ClickExplosionContext;
        lightningStorm: LightningStormContext;
        fireworks: FireworksContext;
        auroraRibbons: AuroraRibbonsContext;
        crystals: CrystalsContext;
        wind: WindContext;
    }
    /** event name → its payload. (`page:hit` is declared by the engine itself.) */
    interface EngineEventMap {
        'rain:eaten': RainEatenEvent;
        'rain:landed': RainLandedEvent;
        'rainEater:exploded': RainEaterExplodedEvent;
        'lightning:strike': LightningStrikeEvent;
        'firework:exploded': FireworkExplodedEvent;
        'crystal:exploded': CrystalExplodedEvent;
    }
}
