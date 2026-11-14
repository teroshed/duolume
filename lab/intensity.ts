export const EFFECT_NAMES = [
    'rain',
    'fireworks',
    'lightningStorm',
    'auroraRibbons',
    'clickExplosion',
    'rainEater',
    'wind',
    'crystals',
    'nebula',
    'constellation',
    'tide',
    'meadow',
    'singularity',
    'serpent',
    'bubbles',
    'snow',
    'meteors',
    'flock',
    'fireflies',
    'confetti',
] as const;
export type EffectName = (typeof EFFECT_NAMES)[number];

export const INTENSITY_LEVELS = ['minimal', 'low', 'mid', 'high', 'max'] as const;
export type IntensityLevel = (typeof INTENSITY_LEVELS)[number];

export interface IntensityPreset {
    label: string;
    /** One sentence saying what the visitor will see at this level. */
    summary: string;
    effects: Record<EffectName, boolean>;
    /** Rain droplets at full budget. */
    drops: number;
    /** Firework shells kept in flight. */
    shells: number;
    /** Multipliers on ambient flashes, shock-ring distortion and glow (1 = as authored). */
    comfort: { flash: number; ripple: number; bloom: number };
}

const on = (...names: EffectName[]): Record<EffectName, boolean> => {
    const state = {} as Record<EffectName, boolean>;
    for (const name of EFFECT_NAMES) {
        state[name] = names.includes(name);
    }
    return state;
};

/**
 * Five steps from calm to everything. Each level adds effects to the one before it and
 * lets flashes, ripples and glow through a little more. The effect sets are the original
 * eight (the Storm scene); every effect added later is off at every level.
 */
export const INTENSITY_PRESETS: Record<IntensityLevel, IntensityPreset> = {
    minimal: {
        label: 'Minimal',
        summary: 'Light rain and slow ribbons of light. No flashes, no sudden movement.',
        effects: on('rain', 'auroraRibbons', 'wind'),
        drops: 120,
        shells: 1,
        comfort: { flash: 0, ripple: 0, bloom: 0.5 },
    },
    low: {
        label: 'Low',
        summary: 'Adds glass crystals you can break with a click; the big one eats the rain. Still no flashes.',
        effects: on('rain', 'auroraRibbons', 'wind', 'rainEater', 'crystals'),
        drops: 240,
        shells: 1,
        comfort: { flash: 0, ripple: 0.4, bloom: 0.7 },
    },
    mid: {
        label: 'Mid',
        summary: 'Adds sparks where you click and a few fireworks. Bursts light the sky gently.',
        effects: on('rain', 'auroraRibbons', 'wind', 'rainEater', 'crystals', 'clickExplosion', 'fireworks'),
        drops: 380,
        shells: 4,
        comfort: { flash: 0.4, ripple: 0.7, bloom: 0.85 },
    },
    high: {
        label: 'High',
        summary: 'Adds lightning and more fireworks. Expect bright flashes every few seconds.',
        effects: on('rain', 'auroraRibbons', 'wind', 'rainEater', 'crystals', 'clickExplosion', 'fireworks', 'lightningStorm'),
        drops: 500,
        shells: 7,
        comfort: { flash: 0.75, ripple: 1, bloom: 1 },
    },
    max: {
        label: 'Max',
        summary: 'Everything at full strength: frequent bright flashes, heavy rain and a busy sky.',
        effects: on('rain', 'auroraRibbons', 'wind', 'rainEater', 'crystals', 'clickExplosion', 'fireworks', 'lightningStorm'),
        drops: 650,
        shells: 10,
        comfort: { flash: 1, ripple: 1, bloom: 1 },
    },
};

/** What a first-time visitor gets before they choose. */
export const DEFAULT_LEVEL: IntensityLevel = 'low';

export const SCENE_NAMES = ['storm', 'meadow', 'winter', 'sea', 'party', 'space', 'everything'] as const;
export type SceneName = (typeof SCENE_NAMES)[number];

export interface ScenePreset {
    label: string;
    /** One sentence saying what the visitor will see in this scene and what to try. */
    summary: string;
    /** null: the intensity level decides (the original eight). */
    effects: Record<EffectName, boolean> | null;
}

/**
 * Named sets of effects that belong together. In every scene but Storm the intensity level
 * still sets flashes, ripples, glow, rain and shells, but no longer chooses the effects.
 */
export const SCENE_PRESETS: Record<SceneName, ScenePreset> = {
    storm: {
        label: 'Storm',
        summary: 'Rain, ribbons, crystals and the rain eater; the intensity level adds sparks, fireworks and lightning.',
        effects: null,
    },
    meadow: {
        label: 'Night meadow',
        summary: 'Grass that shows the wind, fireflies that fall into step, and birds that land on the panel. Blow with the arrow keys.',
        effects: on('wind', 'meadow', 'fireflies', 'flock', 'constellation'),
    },
    winter: {
        label: 'Winter',
        summary: 'Snow that piles up on the panel and shelves, under ribbons of light and a cloud that glows when a crystal breaks. Blow it sideways with the arrow keys.',
        effects: on('wind', 'snow', 'nebula', 'crystals', 'auroraRibbons'),
    },
    sea: {
        label: 'Rising tide',
        summary: 'Rain raises a sea along the bottom, bubbles rise and slide under the shelves, and a serpent follows the pointer. Press B to blow bubbles.',
        effects: on('wind', 'rain', 'tide', 'bubbles', 'serpent'),
    },
    party: {
        label: 'Celebration',
        summary: 'Fireworks, confetti and sparks under ribbons of light. Press C to fire the cannons, Space to burst the shells.',
        effects: on('wind', 'fireworks', 'confetti', 'clickExplosion', 'auroraRibbons'),
    },
    space: {
        label: 'Deep space',
        summary: 'A black hole that swallows the rain and bends passing meteors, among stars that pass on every impact. Press G to move it to the pointer, M to send a meteor.',
        effects: on('wind', 'singularity', 'rain', 'meteors', 'constellation', 'clickExplosion'),
    },
    everything: {
        label: 'Everything',
        summary: 'All twenty effects at once: busy, bright and heavy on the machine.',
        effects: on(...EFFECT_NAMES),
    },
};

/** What a first-time visitor gets before they choose. */
export const DEFAULT_SCENE: SceneName = 'storm';

export function isSceneName(value: unknown): value is SceneName {
    return typeof value === 'string' && (SCENE_NAMES as readonly string[]).includes(value);
}

export function isIntensityLevel(value: unknown): value is IntensityLevel {
    return typeof value === 'string' && (INTENSITY_LEVELS as readonly string[]).includes(value);
}

export function isEffectName(value: unknown): value is EffectName {
    return typeof value === 'string' && (EFFECT_NAMES as readonly string[]).includes(value);
}
