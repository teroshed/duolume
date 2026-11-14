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

// ---- fireflies --------------------------------------------------------------------

export interface FirefliesContext {
    /** Fireflies alive right now. */
    count: number;
    /** 0..1: how closely the swarm blinks together. 0 is every one for itself, 1 is one single pulse. */
    sync: number;
}

/** Emitted by `fireflies` once each time the whole swarm falls into step. */
export interface FirefliesSyncedEvent {
    /** The swarm's `sync` at that moment, 0..1. */
    sync: number;
    /** Middle of the swarm, in stage pixels. */
    x: number;
    y: number;
}

// ---- bubbles ----------------------------------------------------------------------

export interface BubbleState {
    x: number;
    y: number;
    radius: number;
}

export interface BubblesContext {
    /** One entry per bubble, reused between ticks. Read it, do not edit it. */
    bubbles: readonly BubbleState[];
    count: number;
    /** Bubbles that popped this tick. */
    popped: number;
}

/** Emitted by `bubbles` when one pops. */
export interface BubblePoppedEvent {
    x: number;
    y: number;
    radius: number;
}

// ---- meadow -----------------------------------------------------------------------

export interface MeadowContext {
    /** Blades standing right now (ground and page elements together). */
    blades: number;
    /** -1..1: how far the grass leans on average, left to right. */
    sway: number;
}

// ---- singularity ------------------------------------------------------------------

export interface SingularityContext {
    /** Centre of the hole, in stage pixels. */
    position: Vector3;
    /** Radius of the dark disc, in pixels. Grows with `mass`. */
    radius: number;
    /** 0..1. Fills as it feeds; at 1 it collapses. */
    mass: number;
    /** True from the collapse until it has formed again. */
    collapsed: boolean;
}

/** Emitted by `singularity` when it has fed too much and collapses. */
export interface SingularityCollapsedEvent {
    x: number;
    y: number;
    /** Radius of the dark disc at the moment of collapse. */
    radius: number;
}

// ---- flock ------------------------------------------------------------------------

export interface FlockContext {
    /** Birds in the flock, flying and perched. */
    count: number;
    /** Birds sitting on page elements right now. */
    perched: number;
    /** Middle of the birds in flight, in stage pixels. */
    center: Vector3;
    /** Their average velocity, in px/ms. */
    heading: Vector3;
}

/** Emitted by `flock` when several birds are frightened at once. */
export interface FlockStartledEvent {
    /** What they fled from, in stage pixels. */
    x: number;
    y: number;
    /** How many took fright. */
    count: number;
}

// ---- constellation ----------------------------------------------------------------

export interface ConstellationContext {
    nodes: number;
    /** Links drawn right now. */
    links: number;
    /** Signals travelling along links right now. */
    signals: number;
}

// ---- snow -------------------------------------------------------------------------

export interface SnowContext {
    /** Flakes in the air. */
    flakes: number;
    /** Snow lying on the ground and on page elements, in square pixels. */
    settled: number;
    /** Depth of the deepest drift, in pixels. */
    deepest: number;
}

// ---- confetti ---------------------------------------------------------------------

export interface ConfettiContext {
    /** Pieces alive, flying and lying. */
    pieces: number;
    /** Pieces lying on the ground or on a page element. */
    resting: number;
}

// ---- meteors ----------------------------------------------------------------------

export interface MeteorsContext {
    /** Meteors in flight. */
    meteors: number;
    /** Impacts since the effect started. */
    impacts: number;
}

/** Emitted by `meteors` when one comes down. */
export interface MeteorImpactEvent {
    x: number;
    y: number;
    /** 0..1 size of the impact relative to the largest. */
    power: number;
}

// ---- tide -------------------------------------------------------------------------

export interface TideContext {
    /** Height of the water above the bottom of the stage, in pixels. Rises as rain lands. */
    level: number;
    /** Where the surface is, in stage pixels (the stage height minus `level`). */
    surfaceY: number;
    /** 0..1: how far the rain has raised it between its resting level and its highest. */
    raised: number;
}

// ---- nebula -----------------------------------------------------------------------

export interface NebulaContext {
    /** 0..1: how much cloud there is right now. Thickens while it rains. */
    density: number;
    /** Lights currently glowing inside the cloud (strikes, bursts, impacts). */
    lights: number;
}

// ---- serpent ----------------------------------------------------------------------

export interface SerpentContext {
    /** The head, in stage pixels. `z` is its depth toward the viewer. */
    headPosition: Vector3;
    /** Head velocity in px/ms. */
    velocity: Vector3;
    /** Body segments. */
    length: number;
    /** 0..1: calm at 0, darting at 1 (after a strike or a fright). */
    excited: number;
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
        fireflies: FirefliesContext;
        bubbles: BubblesContext;
        meadow: MeadowContext;
        singularity: SingularityContext;
        flock: FlockContext;
        constellation: ConstellationContext;
        snow: SnowContext;
        confetti: ConfettiContext;
        meteors: MeteorsContext;
        tide: TideContext;
        nebula: NebulaContext;
        serpent: SerpentContext;
    }
    /** event name → its payload. (`page:hit` is declared by the engine itself.) */
    interface EngineEventMap {
        'rain:eaten': RainEatenEvent;
        'rain:landed': RainLandedEvent;
        'rainEater:exploded': RainEaterExplodedEvent;
        'lightning:strike': LightningStrikeEvent;
        'firework:exploded': FireworkExplodedEvent;
        'crystal:exploded': CrystalExplodedEvent;
        'fireflies:synced': FirefliesSyncedEvent;
        'bubble:popped': BubblePoppedEvent;
        'singularity:collapsed': SingularityCollapsedEvent;
        'flock:startled': FlockStartledEvent;
        'meteor:impact': MeteorImpactEvent;
    }
}
