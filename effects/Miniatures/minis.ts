import type { Mini } from './Mini';
import { drift } from './minis/drift';
import { auroraRibbons } from './minis/auroraRibbons';
import { bubbles } from './minis/bubbles';
import { clickExplosion } from './minis/clickExplosion';
import { confetti } from './minis/confetti';
import { constellation } from './minis/constellation';
import { crystals } from './minis/crystals';
import { fireflies } from './minis/fireflies';
import { fireworks } from './minis/fireworks';
import { flock } from './minis/flock';
import { lightningStorm } from './minis/lightningStorm';
import { meadow } from './minis/meadow';
import { meteors } from './minis/meteors';
import { nebula } from './minis/nebula';
import { rain } from './minis/rain';
import { rainEater } from './minis/rainEater';
import { serpent } from './minis/serpent';
import { singularity } from './minis/singularity';
import { snow } from './minis/snow';
import { tide } from './minis/tide';
import { wind } from './minis/wind';

/**
 * The miniatures, by the `effectName` of the effect each one is a picture of. An element asks for
 * one by carrying that name among its tags: `data-fx-tags="mini rain"`. A new miniature is a new
 * file in `minis/` and a line here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const MINIS: Readonly<Record<string, Mini<any>>> = {
    rain,
    auroraRibbons,
    rainEater,
    crystals,
    clickExplosion,
    fireworks,
    lightningStorm,
    wind,
    nebula,
    constellation,
    tide,
    meadow,
    singularity,
    serpent,
    bubbles,
    snow,
    meteors,
    flock,
    fireflies,
    confetti,
    drift,
};
