import type { LevelEnum } from './types';

/**
 * How the engine picks an effect's look, its level, when the page has not pinned one.
 *
 * Richness is the scene's detail times the frame budget, 0..1. It is cut into as many equal
 * steps as the effect has looks: with four, 0.75 and up is the richest. A look must never
 * flicker, so the step moves by one at a time, stays put for `LEVEL_HOLD_MS` after each move,
 * and steps up only once richness is `LEVEL_MARGIN` past where the next step begins.
 */

/** Real milliseconds a look is kept, after any change, before the machine may change it again. */
export const LEVEL_HOLD_MS = 1500;

/** How far past the next step's start richness must be (on the 0..1 scale) before a look steps up. */
export const LEVEL_MARGIN = 0.1;

/** What the engine keeps about one effect's looks. */
export interface LevelTrack {
    /** The enum object the effect last passed. */
    levels: LevelEnum;
    /** Its member values, cheapest first. */
    values: number[];
    /** Its member names, in the same order. */
    names: string[];
    /** Index into `values` of the look drawn now. */
    step: number;
    /** Tick on which `step` last changed. */
    changedAt: number;
    /** Tick on which the effect last asked, so asking twice in one tick changes nothing. */
    askedAt: number;
    /** True while the page has fixed the look. */
    pinned: boolean;
}

/** The members of a numeric enum, cheapest first. A numeric enum maps both ways; its names are the keys whose value is a number. */
export function readLevels(levels: LevelEnum): { values: number[]; names: string[] } {
    const members = Object.keys(levels)
        .filter((key) => typeof levels[key] === 'number')
        .map((key) => ({ name: key, value: levels[key] as number }))
        .sort((a, b) => a.value - b.value);
    return { values: members.map((m) => m.value), names: members.map((m) => m.name) };
}

/** The step a richness asks for, with no history: richness 1 is the richest of `count` steps. */
export function stepFor(richness: number, count: number): number {
    const r = richness > 0 ? Math.min(1, richness) : 0;
    return Math.min(count - 1, Math.floor(r * count));
}

/** One move from `current` toward what richness asks for: down by one, up by one past the margin, or none. */
export function nextStep(current: number, richness: number, count: number): number {
    const target = stepFor(richness, count);
    if (target < current) {
        return current - 1;
    }
    if (target > current) {
        // Never above 1, or the richest look could not be reached at full richness.
        const threshold = Math.min(1, (current + 1) / count + LEVEL_MARGIN);
        return richness >= threshold ? current + 1 : current;
    }
    return current;
}

/** The step for a pinned value: its own, or the nearest member when the value is not one. */
export function stepOf(values: readonly number[], value: number): number {
    let best = 0;
    for (let i = 1; i < values.length; i++) {
        if (Math.abs(values[i] - value) < Math.abs(values[best] - value)) {
            best = i;
        }
    }
    return best;
}
