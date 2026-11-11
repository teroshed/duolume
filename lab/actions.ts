import type { FireworksEffect } from '../effects/Fireworks/FireworksEffect';
import type { Rain } from '../effects/Rain/Rain';
import type { RainEater } from '../effects/RainEater/RainEater';
import { GradientType, type VisualsManager } from '../src';
import {
    DEFAULT_LEVEL,
    EFFECT_NAMES,
    INTENSITY_PRESETS,
    isEffectName,
    isIntensityLevel,
    type EffectName,
    type IntensityLevel,
} from './intensity';

export interface LabState {
    level: IntensityLevel;
    effects: Record<EffectName, boolean>;
    /** Simulation speed, 0.2 to 3. */
    speed: number;
    /** Rain droplets at full budget, 0 to 1600. */
    drops: number;
    gradient: GradientType;
    paused: boolean;
    /** True when the visitor asked not to see the intro again. */
    skipIntro: boolean;
}

/**
 * Everything a person can do in the lab, as plain functions. The panel, the keyboard
 * shortcuts, the intro dialog, `window.teroshedLab` and the WebMCP tools all call these,
 * so they cannot drift apart. Invalid input throws; every change is saved and announced.
 */
export interface LabActions {
    getState(): Readonly<LabState>;
    /** Apply one of the five intensity levels: which effects run, how much rain, how bright. */
    setLevel(level: IntensityLevel): void;
    setEffectEnabled(effect: EffectName, enabled: boolean): void;
    toggleEffect(effect: EffectName): boolean;
    setSpeed(speed: number): number;
    setDrops(drops: number): number;
    setGradient(gradient: GradientType): void;
    setPaused(paused: boolean): void;
    explodeEater(): void;
    setSkipIntro(skip: boolean): void;
    /** Called after every change. Returns a function that stops the calls. */
    subscribe(listener: (state: Readonly<LabState>) => void): () => void;
}

export interface LabEffects {
    rain: Rain;
    rainEater: RainEater;
    fireworks: FireworksEffect;
}

const STORAGE_KEY = 'teroshed.lab.v1';
const GRADIENTS = Object.values(GradientType) as string[];

/** The saved subset of the state. Pausing is not saved: a lab that opens frozen looks broken. */
type SavedState = Pick<LabState, 'level' | 'effects' | 'speed' | 'drops' | 'gradient' | 'skipIntro'>;

export function createLabActions(manager: VisualsManager, effects: LabEffects, reducedMotion: boolean): LabActions {
    const listeners = new Set<(state: Readonly<LabState>) => void>();
    const saved = load();
    const level = saved?.level ?? DEFAULT_LEVEL;
    const preset = INTENSITY_PRESETS[level];

    const state: LabState = {
        level,
        effects: { ...preset.effects, ...saved?.effects },
        speed: saved?.speed ?? 1,
        drops: saved?.drops ?? preset.drops,
        gradient: saved?.gradient ?? GradientType.THEME,
        paused: reducedMotion,
        skipIntro: saved?.skipIntro ?? false,
    };

    const changed = (): void => {
        save(state);
        for (const listener of listeners) {
            listener(state);
        }
    };

    const applyLevelToEngine = (): void => {
        const current = INTENSITY_PRESETS[state.level];
        manager.setComfort(current.comfort);
        effects.fireworks.setShellTarget(current.shells);
    };

    // Bring the engine in line with the restored state once, before anything is shown.
    applyLevelToEngine();
    for (const name of EFFECT_NAMES) {
        manager.setEffectEnabled(name, state.effects[name]);
    }
    manager.setTimeScale(state.speed);
    state.speed = manager.getTimeScale();
    effects.rain.setDropTarget(state.drops);
    effects.rain.setDropletGradientType(state.gradient);

    return {
        getState: () => state,

        setLevel(next) {
            if (!isIntensityLevel(next)) {
                throw new RangeError(`Unknown intensity level: ${String(next)}`);
            }
            const target = INTENSITY_PRESETS[next];
            state.level = next;
            state.effects = { ...target.effects };
            state.drops = target.drops;
            for (const name of EFFECT_NAMES) {
                manager.setEffectEnabled(name, state.effects[name]);
            }
            effects.rain.setDropTarget(state.drops);
            applyLevelToEngine();
            changed();
        },

        setEffectEnabled(effect, enabled) {
            if (!isEffectName(effect)) {
                throw new RangeError(`Unknown effect: ${String(effect)}`);
            }
            if (typeof enabled !== 'boolean') {
                throw new TypeError('enabled must be true or false');
            }
            state.effects[effect] = enabled;
            manager.setEffectEnabled(effect, enabled);
            changed();
        },

        toggleEffect(effect) {
            this.setEffectEnabled(effect, !state.effects[effect]);
            return state.effects[effect];
        },

        setSpeed(speed) {
            if (!Number.isFinite(speed)) {
                throw new TypeError('speed must be a number');
            }
            manager.setTimeScale(speed);
            state.speed = Math.round(manager.getTimeScale() * 10) / 10;
            changed();
            return state.speed;
        },

        setDrops(drops) {
            if (!Number.isFinite(drops)) {
                throw new TypeError('drops must be a number');
            }
            state.drops = Math.max(0, Math.min(1600, Math.round(drops)));
            effects.rain.setDropTarget(state.drops);
            changed();
            return state.drops;
        },

        setGradient(gradient) {
            if (!GRADIENTS.includes(gradient)) {
                throw new RangeError(`Unknown gradient: ${String(gradient)}`);
            }
            state.gradient = gradient;
            effects.rain.setDropletGradientType(gradient);
            changed();
        },

        setPaused(paused) {
            if (typeof paused !== 'boolean') {
                throw new TypeError('paused must be true or false');
            }
            state.paused = paused;
            manager.setMotionEnabled(!paused);
            changed();
        },

        explodeEater() {
            // Goes through the same path a full charge takes on the next tick.
            effects.rainEater.headParticle.explode();
        },

        setSkipIntro(skip) {
            if (typeof skip !== 'boolean') {
                throw new TypeError('skip must be true or false');
            }
            state.skipIntro = skip;
            changed();
        },

        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

function load(): Partial<SavedState> | undefined {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return undefined;
        }
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) {
            return undefined;
        }
        const data = parsed as Record<string, unknown>;
        const result: Partial<SavedState> = {};
        if (isIntensityLevel(data.level)) {
            result.level = data.level;
        }
        if (typeof data.effects === 'object' && data.effects !== null) {
            const source = data.effects as Record<string, unknown>;
            const restored = {} as Record<EffectName, boolean>;
            let complete = true;
            for (const name of EFFECT_NAMES) {
                const value = source[name];
                if (typeof value === 'boolean') {
                    restored[name] = value;
                } else {
                    complete = false;
                }
            }
            if (complete) {
                result.effects = restored;
            }
        }
        if (typeof data.speed === 'number' && Number.isFinite(data.speed)) {
            result.speed = data.speed;
        }
        if (typeof data.drops === 'number' && Number.isFinite(data.drops)) {
            result.drops = Math.max(0, Math.min(1600, data.drops));
        }
        if (typeof data.gradient === 'string' && GRADIENTS.includes(data.gradient)) {
            result.gradient = data.gradient as GradientType;
        }
        if (typeof data.skipIntro === 'boolean') {
            result.skipIntro = data.skipIntro;
        }
        return result;
    } catch {
        // Storage blocked or the saved value is damaged: start from defaults.
        return undefined;
    }
}

function save(state: LabState): void {
    const data: SavedState = {
        level: state.level,
        effects: state.effects,
        speed: state.speed,
        drops: state.drops,
        gradient: state.gradient,
        skipIntro: state.skipIntro,
    };
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
        // Private mode or a full quota: the lab still works, it just will not remember.
    }
}
