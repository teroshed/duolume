/**
 * The effect library in one import: `import { Rain, Wind } from 'duolume/effects'`.
 *
 * Only the effects and their options are listed here. Their building blocks (Droplet, Head,
 * CrystalBody, …) stay importable by path, e.g. 'duolume/effects/Crystal/CrystalBody'.
 * Exporting the contracts also brings the library's typed registry into any program that
 * imports this file, so `tick.read('rain')` comes back typed.
 */
export { AuroraRibbons, type AuroraRibbonsOptions } from './AuroraRibbons/AuroraRibbons';
export { BlankEffect } from './Blank/BlankEffect';
export { Bubbles, type BubblesOptions } from './Bubbles/Bubbles';
export { ClickExplosion, type ClickExplosionOptions } from './ClickExplosions/ClickExplosion';
export { Confetti, type ConfettiOptions } from './Confetti/Confetti';
export { Constellation, type ConstellationOptions } from './Constellation/Constellation';
export { Crystals, type CrystalsOptions } from './Crystals/Crystals';
export { Fireflies, type FirefliesOptions } from './Fireflies/Fireflies';
export { FireworksEffect, type FireworksOptions } from './Fireworks/FireworksEffect';
export { Flock, type FlockOptions } from './Flock/Flock';
export { LightningStorm, type LightningStormOptions } from './LightningStorm/LightningStorm';
export { Meadow, type MeadowOptions } from './Meadow/Meadow';
export { Meteors, type MeteorsOptions } from './Meteors/Meteors';
export { Nebula, type NebulaOptions } from './Nebula/Nebula';
export { Rain, type RainOptions } from './Rain/Rain';
export { RainEater, type RainEaterOptions } from './RainEater/RainEater';
export { Serpent, type SerpentOptions } from './Serpent/Serpent';
export { Singularity, type SingularityOptions } from './Singularity/Singularity';
export { Snow, type SnowOptions } from './Snow/Snow';
export { Tide, type TideOptions } from './Tide/Tide';
export { Wind, type WindOptions } from './Wind/Wind';
export type * from './contracts';
