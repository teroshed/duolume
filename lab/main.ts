import { AuroraRibbons } from '../effects/AuroraRibbons/AuroraRibbons';
import { Bubbles } from '../effects/Bubbles/Bubbles';
import { ClickExplosion } from '../effects/ClickExplosions/ClickExplosion';
import { Confetti } from '../effects/Confetti/Confetti';
import { Constellation } from '../effects/Constellation/Constellation';
import { Crystals } from '../effects/Crystals/Crystals';
import { Fireflies } from '../effects/Fireflies/Fireflies';
import { FireworksEffect } from '../effects/Fireworks/FireworksEffect';
import { Flock } from '../effects/Flock/Flock';
import { LightningStorm } from '../effects/LightningStorm/LightningStorm';
import { Meadow } from '../effects/Meadow/Meadow';
import { Meteors } from '../effects/Meteors/Meteors';
import { Nebula } from '../effects/Nebula/Nebula';
import { Rain } from '../effects/Rain/Rain';
import { RainEater } from '../effects/RainEater/RainEater';
import { Serpent } from '../effects/Serpent/Serpent';
import { Singularity } from '../effects/Singularity/Singularity';
import { Snow } from '../effects/Snow/Snow';
import { Tide } from '../effects/Tide/Tide';
import { Wind } from '../effects/Wind/Wind';
import { attachPageRipples, GradientType, VisualsManager } from '../src';
import { createLabActions } from './actions';
import {
    INTENSITY_LEVELS,
    INTENSITY_PRESETS,
    SCENE_PRESETS,
    isEffectName,
    type EffectName,
    type IntensityLevel,
    type SceneName,
} from './intensity';
import { initIntro } from './intro';
import { exposeLabActions } from './webmcp';

const $ = <T extends Element>(selector: string): T => {
    const found = document.querySelector<T>(selector);
    if (!found) {
        throw new Error(`Missing ${selector}`);
    }
    return found;
};

const canvas = $<HTMLCanvasElement>('#stage');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const manager = await VisualsManager.create(canvas, { motion: !reducedMotion.matches });

const rainEater = new RainEater();
const rain = new Rain({ gradient: GradientType.THEME });
const fireworks = new FireworksEffect();

// Run order is also draw order within each renderer, and decides who can read whom in the
// same tick. The wind goes first so everything sees this tick's wind. The sky comes next,
// back to front (nebula, ribbons, constellation), so it sits behind the rest. The eater, the
// black hole and the serpent come before the effects that steer by them (bubbles, rain,
// meteors, the flock, the fireflies). Rain comes before the snow, the tide it fills and the
// meadow it flicks. Lightning, fireworks and meteors follow, then the birds, the fireflies,
// the confetti and the click sparks on top. An effect that reads one placed after it (the
// nebula and the black hole read the rain, the serpent reads the flock) sees the last tick.
manager
    .addEffect(new Wind())
    .addEffect(new Nebula())
    .addEffect(new AuroraRibbons())
    .addEffect(new Constellation())
    .addEffect(rainEater)
    .addEffect(new Crystals({ count: 5 }))
    .addEffect(new Singularity())
    .addEffect(new Serpent())
    .addEffect(new Bubbles())
    .addEffect(rain)
    .addEffect(new Snow())
    .addEffect(new Tide())
    .addEffect(new Meadow())
    .addEffect(new LightningStorm())
    .addEffect(fireworks)
    .addEffect(new Meteors())
    .addEffect(new Flock())
    .addEffect(new Fireflies())
    .addEffect(new Confetti())
    .addEffect(new ClickExplosion());

// One set of operations for the panel, the keys, the intro, window.teroshedLab and WebMCP.
// Creating it restores the saved level and settings and applies them to the engine.
const actions = createLabActions(manager, { rain, rainEater, fireworks }, reducedMotion.matches);
exposeLabActions(actions);

// Shards and raindrops that stop on the panel or a shelf get a ripple on the element itself.
attachPageRipples(manager);

if (reducedMotion.matches) {
    manager.prewarm(240);
}
manager.run();

// ---- panel -----------------------------------------------------------------------

const level = $<HTMLInputElement>('#level');
const levelOut = $<HTMLOutputElement>('#level-out');
const scene = $<HTMLSelectElement>('#scene');
const effectBoxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[data-effect]'));
const speed = $<HTMLInputElement>('#speed');
const speedOut = $<HTMLOutputElement>('#speed-out');
const drops = $<HTMLInputElement>('#drops');
const dropsOut = $<HTMLOutputElement>('#drops-out');
const gradient = $<HTMLSelectElement>('#gradient');
const motionButton = $<HTMLButtonElement>('#motion');
const aboutButton = $<HTMLButtonElement>('#about');

level.addEventListener('input', () => actions.setLevel(INTENSITY_LEVELS[Number(level.value)] as IntensityLevel));
scene.addEventListener('change', () => actions.setScene(scene.value as SceneName));
for (const box of effectBoxes) {
    box.addEventListener('change', () => actions.setEffectEnabled(box.dataset.effect as EffectName, box.checked));
}
speed.addEventListener('input', () => actions.setSpeed(Number(speed.value)));
drops.addEventListener('input', () => actions.setDrops(Number(drops.value)));
gradient.addEventListener('change', () => actions.setGradient(gradient.value as GradientType));
$<HTMLButtonElement>('#explode').addEventListener('click', () => actions.explodeEater());
motionButton.addEventListener('click', () => actions.setPaused(!actions.getState().paused));
reducedMotion.addEventListener('change', () => actions.setPaused(reducedMotion.matches));

// The page never keeps its own copy of the state: every control is redrawn from the actions' state.
const render = (): void => {
    const state = actions.getState();
    const index = INTENSITY_LEVELS.indexOf(state.level);
    const label = INTENSITY_PRESETS[state.level].label;
    level.value = String(index);
    level.setAttribute('aria-valuetext', label);
    level.style.setProperty('--fill', `${(index / (INTENSITY_LEVELS.length - 1)) * 100}%`);
    levelOut.textContent = label;
    scene.value = state.scene;
    scene.title = SCENE_PRESETS[state.scene].summary;
    for (const box of effectBoxes) {
        const name = box.dataset.effect;
        box.checked = isEffectName(name) ? state.effects[name] : false;
    }
    speed.value = String(state.speed);
    speedOut.textContent = `${state.speed.toFixed(1)}×`;
    drops.value = String(state.drops);
    dropsOut.textContent = String(state.drops);
    gradient.value = state.gradient;
    motionButton.textContent = state.paused ? 'Resume' : 'Pause';
    motionButton.setAttribute('aria-pressed', String(state.paused));
};
actions.subscribe(render);
render();

// ---- intro -----------------------------------------------------------------------

const intro = initIntro(actions, aboutButton);
aboutButton.addEventListener('click', () => intro.open());
// `?intro=0` in the address skips it for this visit: a scripted visit has nobody to press Start.
const introOff = new URLSearchParams(window.location.search).get('intro') === '0';
if (!actions.getState().skipIntro && !introOff) {
    intro.open();
}

// ---- keys ------------------------------------------------------------------------

// The original keys: 1–5 toggle rain, fireworks, lightning, ribbons and click explosions;
// 9 and 0 change speed. 6, 7 and 8 are new.
const keyEffects: Record<string, EffectName> = {
    '1': 'rain',
    '2': 'fireworks',
    '3': 'lightningStorm',
    '4': 'auroraRibbons',
    '5': 'clickExplosion',
    '6': 'rainEater',
    '7': 'wind',
    '8': 'crystals',
};
window.addEventListener('keydown', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    // While the intro is open the keys belong to it, and typing controls keep their own keys.
    if (target?.closest('dialog, select, textarea, input[type="text"]')) {
        return;
    }
    // Keep Space and the arrows for the scene rather than for scrolling or the focused control.
    const onControl = target?.closest('input, button') != null;
    if (!onControl && (event.key === ' ' || event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
    }
    if (event.repeat) {
        return;
    }
    const effectName = keyEffects[event.key];
    if (effectName) {
        actions.toggleEffect(effectName);
    } else if (event.key === '9') {
        actions.setSpeed(actions.getState().speed - 0.1);
    } else if (event.key === '0') {
        actions.setSpeed(actions.getState().speed + 0.1);
    }
});

// ---- readout ---------------------------------------------------------------------

const readout = {
    fps: $<HTMLElement>('#r-fps'),
    budget: $<HTMLElement>('#r-budget'),
    drops: $<HTMLElement>('#r-drops'),
    energy: $<HTMLElement>('#r-energy'),
    sparks: $<HTMLElement>('#r-sparks'),
    shells: $<HTMLElement>('#r-shells'),
    charge: $<HTMLElement>('#r-charge'),
    ribbons: $<HTMLElement>('#r-ribbons'),
    wind: $<HTMLElement>('#r-wind'),
};
window.setInterval(() => {
    const d = manager.getDiagnostics();
    const tick = manager.simulation.tickContext;
    const shells = tick.read('fireworks');
    const wind = tick.read('wind')?.x ?? 0;
    readout.fps.textContent = d.averageFps.toFixed(0);
    readout.budget.textContent = `${Math.round(d.budget * 100)}%`;
    readout.drops.textContent = String(tick.read('rain')?.dropCount ?? 0);
    readout.energy.textContent = `${Math.round((tick.read('rainEater')?.energy ?? 0) * 100)}%`;
    readout.sparks.textContent = String((tick.read('clickExplosion')?.explosions ?? 0) + (shells?.sparks ?? 0));
    readout.shells.textContent = String(shells?.fireworks ?? 0);
    readout.charge.textContent = String(tick.read('lightningStorm')?.chargePoints.length ?? 0);
    readout.ribbons.textContent = String(tick.read('auroraRibbons')?.count ?? 0);
    readout.wind.textContent = Math.abs(wind) < 0.00002 ? 'calm' : `${wind < 0 ? '←' : '→'} ${(Math.abs(wind) * 10000).toFixed(1)}`;
}, 250);

// Handy when poking at it from the console.
Object.assign(window, { visuals: manager });
