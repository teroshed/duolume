import { Arc } from '../effects/Arc/Arc';
import { AuroraRibbons } from '../effects/AuroraRibbons/AuroraRibbons';
import { Bubbles } from '../effects/Bubbles/Bubbles';
import { Circuit } from '../effects/Circuit/Circuit';
import { ClickExplosion } from '../effects/ClickExplosions/ClickExplosion';
import { Confetti } from '../effects/Confetti/Confetti';
import { Constellation } from '../effects/Constellation/Constellation';
import { Crystals } from '../effects/Crystals/Crystals';
import { Echo } from '../effects/Echo/Echo';
import { FieldFrame } from '../effects/FieldFrame/FieldFrame';
import { Filings } from '../effects/Filings/Filings';
import { Fireflies } from '../effects/Fireflies/Fireflies';
import { FireworksEffect } from '../effects/Fireworks/FireworksEffect';
import { Flock } from '../effects/Flock/Flock';
import { Frost } from '../effects/Frost/Frost';
import { Glyphs } from '../effects/Glyphs/Glyphs';
import { Ivy } from '../effects/Ivy/Ivy';
import { Fuse } from '../effects/Fuse/Fuse';
import { LightningStorm } from '../effects/LightningStorm/LightningStorm';
import { Liquid } from '../effects/Liquid/Liquid';
import { Meadow } from '../effects/Meadow/Meadow';
import { Meteors } from '../effects/Meteors/Meteors';
import { Miniatures } from '../effects/Miniatures/Miniatures';
import { Nebula } from '../effects/Nebula/Nebula';
import { Orbit } from '../effects/Orbit/Orbit';
import { Petals } from '../effects/Petals/Petals';
import { Pulse } from '../effects/Pulse/Pulse';
import { Rain } from '../effects/Rain/Rain';
import { RainEater } from '../effects/RainEater/RainEater';
import { Sand } from '../effects/Sand/Sand';
import { Serpent } from '../effects/Serpent/Serpent';
import { Singularity } from '../effects/Singularity/Singularity';
import { Snow } from '../effects/Snow/Snow';
import { Tide } from '../effects/Tide/Tide';
import { Wind } from '../effects/Wind/Wind';
import { attachFieldTags, attachFieldText, attachPageRipples, GradientType, VisualsManager, type AnyEffect } from '../src';

/**
 * The Inputs page: controls as windows onto the scene.
 *
 * Two things are shown. A switch for every scene effect, with a miniature of that effect
 * inside it (`Miniatures`), and one more switch that turns on an effect chosen at random. And
 * a card for each effect made to live inside a control, on a switch, a field, a button and a
 * slider. The page writes no state into the tags itself: `attachFieldTags()` does that.
 */

const $ = <T extends Element>(selector: string): T => {
    const found = document.querySelector<T>(selector);
    if (!found) {
        throw new Error(`Missing ${selector}`);
    }
    return found;
};

/** The scene effects, in run order (which is draw order), as in the main lab. */
const SCENE: readonly (readonly [name: string, make: () => AnyEffect])[] = [
    ['wind', () => new Wind()],
    ['nebula', () => new Nebula()],
    ['auroraRibbons', () => new AuroraRibbons()],
    ['constellation', () => new Constellation()],
    ['rainEater', () => new RainEater()],
    ['crystals', () => new Crystals({ count: 3 })],
    ['singularity', () => new Singularity()],
    ['serpent', () => new Serpent()],
    ['bubbles', () => new Bubbles()],
    // The page scrolls under the viewport, so there is no floor: rain lands on the cards or falls through.
    ['rain', () => new Rain({ gradient: GradientType.THEME, dropCount: 260, groundBand: 0 })],
    ['snow', () => new Snow()],
    ['tide', () => new Tide()],
    ['meadow', () => new Meadow()],
    ['lightningStorm', () => new LightningStorm()],
    ['fireworks', () => new FireworksEffect({ shells: 4 })],
    ['meteors', () => new Meteors()],
    ['flock', () => new Flock()],
    ['fireflies', () => new Fireflies()],
    ['confetti', () => new Confetti()],
    ['clickExplosion', () => new ClickExplosion()],
];

/** The switches, in the order they are shown, with what each is called on the page. */
const SWITCHES: readonly (readonly [name: string, label: string])[] = [
    ['rain', 'Rain'],
    ['auroraRibbons', 'Ribbons'],
    ['rainEater', 'Rain eater'],
    ['crystals', 'Crystals'],
    ['clickExplosion', 'Click sparks'],
    ['fireworks', 'Fireworks'],
    ['lightningStorm', 'Lightning'],
    ['wind', 'Wind'],
    ['fireflies', 'Fireflies'],
    ['bubbles', 'Bubbles'],
    ['meadow', 'Meadow'],
    ['snow', 'Snow'],
    ['tide', 'Tide'],
    ['flock', 'Flock'],
    ['constellation', 'Constellation'],
    ['nebula', 'Nebula'],
    ['singularity', 'Black hole'],
    ['serpent', 'Serpent'],
    ['meteors', 'Meteors'],
    ['confetti', 'Confetti'],
];
const ON_AT_START = ['wind', 'rain', 'auroraRibbons'];

/** The effects made for inputs: the tag that asks for one, its name, and what it does. */
const MADE: readonly (readonly [tag: string, title: string, text: string, make: () => AnyEffect])[] = [
    ['liquid', 'Liquid', 'The control is a vessel. It holds as much as it has value, and the surface sloshes when it changes or is poked.', () => new Liquid()],
    ['sand', 'Sand', 'A switch is something you tip: the sand runs to the side it is switched to and piles up there.', () => new Sand()],
    ['frost', 'Frost', 'What is switched off freezes over. Switch it on, or rest the pointer on it, and it thaws and drips.', () => new Frost()],
    ['fuse', 'Fuse', 'The border is a fuse. Switched on, a spark runs round it and sheds embers into the page.', () => new Fuse()],
    ['circuit', 'Circuit', 'A small circuit board. Switched on, signals run along its traces; a press sends one from where you touched.', () => new Circuit()],
    ['filings', 'Filings', 'Iron filings under glass: every needle turns to the pointer, to the switch, and to the wind in the scene.', () => new Filings()],
    ['pulse', 'Pulse', 'A heartbeat. Steady while on, flat while off, faster the higher a slider is set; a press is a beat.', () => new Pulse()],
    ['petals', 'Petals', 'Switched on, a vine grows along the edge and blossoms. Switched off, the petals fall into the page.', () => new Petals()],
    ['frame', 'Frame', 'Not in the control but round it: a sharp frame with pictures on it while it has the focus. Tab through these.', () => new FieldFrame()],
];

/** The effects that leave the control: same shape as `MADE`, on cards with more room round each control. */
const OUTSIDE: typeof MADE = [
    ['orbit', 'Orbit', 'Moons circle the control, just off its edge. A slider sets their speed; a press flings them out.', () => new Orbit()],
    ['ivy', 'Ivy', 'Switched on, tendrils grow out of the edge and over the page. Switched off, they draw back in.', () => new Ivy()],
    ['arc', 'Arc', 'A charged thing: arcs jump off its edge, a bolt reaches for the pointer when it comes near, a press discharges it.', () => new Arc()],
    ['echo', 'Echo', 'Its own outline leaves it in rings: on a press, on a switch, as a slider moves, and quietly while it has the focus.', () => new Echo()],
    ['glyphs', 'Glyphs', 'Type in the field. Every letter sends a mark as wide as itself up out of the field; a deleted one drops; the line below is as long as the text.', () => new Glyphs()],
];

// ---- the page's controls -----------------------------------------------------------

const toggle = (id: string, tags: string, label: string, checked: boolean, attributes = ''): string =>
    `<label class="switch"><input id="${id}" type="checkbox"${checked ? ' checked' : ''} ${attributes}/>` +
    `<span class="track" data-fx-anchor="${id}-track" data-fx-tags="${tags}"><span class="knob"></span></span>` +
    `<span class="switch-text">${label}</span></label>`;

$<HTMLElement>('#switches').innerHTML =
    SWITCHES.map(([name, label]) => toggle(`switch-${name}`, `mini ${name}`, label, ON_AT_START.includes(name), `data-effect="${name}"`)).join('') +
    toggle('switch-surprise', 'mini drift', 'Surprise<small id="surprise-name">a random one each time</small>', false);

const cards = (list: typeof MADE, roomy: boolean): string => list.map(
    ([tag, title, text]) => `
      <article class="card${roomy ? ' roomy' : ''}" data-fx-anchor="card-${tag}" data-fx-tags="ledge">
        <h2>${title}</h2>
        <p>${text}</p>
        <div class="samples">
          ${toggle(`${tag}-switch`, tag, 'On', true)}
          <input class="field" type="text" placeholder="Write here" autocomplete="off" aria-label="${title}: a text field" data-fx-anchor="${tag}-field" data-fx-tags="${tag}" />
          <button class="press" type="button" data-fx-anchor="${tag}-button" data-fx-tags="${tag}">Press</button>
          <span class="bar" data-fx-anchor="${tag}-bar" data-fx-tags="${tag}"><input type="range" min="0" max="100" value="60" aria-label="${title}: a slider" /></span>
        </div>
      </article>`,
).join('');

$<HTMLElement>('#made').innerHTML = cards(MADE, false);
$<HTMLElement>('#outside').innerHTML = cards(OUTSIDE, true);

// ---- the scene ---------------------------------------------------------------------

const canvas = $<HTMLCanvasElement>('#stage');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const manager = await VisualsManager.create(canvas, { motion: !reducedMotion.matches });

for (const [, make] of SCENE) {
    manager.addEffect(make());
}
// The input effects go last: what they draw inside a control sits over the rest of the 2D scene.
manager.addEffect(new Miniatures());
for (const [, , , make] of [...MADE, ...OUTSIDE]) {
    manager.addEffect(make());
}

// Bursts and strikes are behind switches here, so a visitor chooses them; still, keep them gentle.
manager.setComfort({ flash: 0.4, ripple: 0.7, bloom: 0.85 });
attachPageRipples(manager);
const fields = attachFieldTags();
// What is typed, and where each letter is: `Glyphs` answers it.
attachFieldText(manager);

// ---- switching ---------------------------------------------------------------------

const enabled = new Set<string>(ON_AT_START);
/** The effect the surprise switch turned on, while it is on. */
let surprise: string | null = null;

const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[data-effect]'));
const surpriseBox = $<HTMLInputElement>('#switch-surprise');
const surpriseTrack = $<HTMLElement>('[data-fx-anchor="switch-surprise-track"]');
const surpriseName = $<HTMLElement>('#surprise-name');
const labelOf = new Map(SWITCHES);

// The page keeps no copy of the state in the controls: they are redrawn from `enabled` and `surprise`.
const render = (): void => {
    for (const [name] of SCENE) {
        manager.setEffectEnabled(name, enabled.has(name));
    }
    for (const box of boxes) {
        box.checked = enabled.has(box.dataset.effect ?? '');
    }
    surpriseBox.checked = surprise !== null;
    surpriseName.textContent = surprise ? labelOf.get(surprise) ?? surprise : 'a random one each time';
    // Its window shows whatever it picked: the miniature is chosen by the name in the tags.
    surpriseTrack.dataset.fxTags = `mini ${surprise ?? 'drift'}`;
    // Setting .checked from script fires no event, so tell the tags to read the controls again.
    fields.refresh();
};

for (const box of boxes) {
    box.addEventListener('change', () => {
        const name = box.dataset.effect ?? '';
        if (box.checked) {
            enabled.add(name);
        } else {
            enabled.delete(name);
            if (surprise === name) {
                surprise = null;
            }
        }
        render();
    });
}

surpriseBox.addEventListener('change', () => {
    if (surprise) {
        enabled.delete(surprise);
        surprise = null;
    }
    if (surpriseBox.checked) {
        // Something that is not already running, so the switch always changes the scene.
        const off = SWITCHES.map(([name]) => name).filter((name) => !enabled.has(name));
        const pool = off.length > 0 ? off : SWITCHES.map(([name]) => name);
        surprise = pool[Math.floor(Math.random() * pool.length)];
        enabled.add(surprise);
    }
    render();
});

const motionButton = $<HTMLButtonElement>('#motion');
let paused = reducedMotion.matches;
const showMotion = (): void => {
    manager.setMotionEnabled(!paused);
    motionButton.textContent = paused ? 'Resume' : 'Pause';
    motionButton.setAttribute('aria-pressed', String(paused));
};
motionButton.addEventListener('click', () => {
    paused = !paused;
    showMotion();
});

render();
showMotion();
if (reducedMotion.matches) {
    manager.prewarm(240);
}
manager.run();

// Handy when poking at it from the console.
Object.assign(window, { visuals: manager });
