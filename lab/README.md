# Engine lab (`/lab/`)

A showcase page for the visuals engine: twenty effects, a control panel, and an intro dialog
that warns about intensity and lets the visitor choose a level before anything bright runs.
Twenty effects at once is a lot, so the lab groups them into scenes.

## Scenes

Defined in `intensity.ts` (`SCENE_PRESETS`). A scene is a set of effects that belong together.
Choosing one switches its effects on and every other effect off; the checkboxes still change
single effects afterwards without leaving the scene.

| Scene | Effects running | What to try |
| --- | --- | --- |
| Storm (default) | what the intensity level says (the table below) | the level slider; Space, E, W, S, the arrows |
| Night meadow | wind, meadow, fireflies, flock, constellation | blow with the arrows and watch the grass; wait for the fireflies to blink together and the birds to land on the panel |
| Winter | wind, snow, nebula, crystals, ribbons | let the snow pile up on the panel and shelves, then blow it off; break a crystal to light the cloud |
| Rising tide | wind, rain, tide, bubbles, serpent | B blows bubbles from the pointer; more rain raises the sea; the serpent follows the pointer |
| Celebration | wind, fireworks, confetti, click sparks, ribbons | C fires both confetti cannons; Space bursts the shells |
| Deep space | wind, black hole, rain, meteors, constellation, click sparks | G moves the black hole to the pointer; M sends a meteor there |
| Everything | all twenty | heavy: expect the frame governor to thin the scene on a slow machine |

In every scene but Storm the intensity level no longer chooses effects; it still sets
flashes, ripples, glow, the rain droplets and the firework shells.

## Intensity levels

Defined in `intensity.ts`. This table describes the Storm scene, where each level adds to the
one before it. The effects added after the first eight are off at every level.

| Level | Effects running | Rain | Flashes | Shock ripples | Glow |
| --- | --- | --- | --- | --- | --- |
| Minimal | rain, ribbons, wind | 120 | off | off | 50% |
| Low (default) | + rain eater, crystals | 240 | off | 40% | 70% |
| Mid | + click sparks, fireworks (4 shells) | 380 | 40% | 70% | 85% |
| High | + lightning, fireworks (7 shells) | 500 | 75% | 100% | 100% |
| Max | everything, fireworks (10 shells) | 650 | 100% | 100% | 100% |

Flashes, ripples and glow are scaled in the compositor (`VisualsManager.setComfort`), so the
simulation itself is unchanged; only how hard it hits the eye changes.

## Intro dialog

Shown on entering the page unless "Don't show this again" was ticked. It is a native modal
`<dialog>`: focus starts on the slider, stays inside while it is open, Escape or Start
accepts the current level, and focus returns to whatever opened it (the About button on
first load). The scene keeps running behind a dimmed backdrop and follows the slider live.
With reduced motion on, the dialog and the dim appear without animation. Outside the Storm
scene its summary line says that the scene chooses the effects and the level only the
brightness, instead of the level's own summary.

`?intro=0` in the address skips the dialog for that visit without saving anything, for a
scripted visit that has nobody to press Start.

## Programmatic access

Every control goes through one set of operations, `LabActions` in `actions.ts`. The panel,
the keyboard shortcuts and the intro all call it, and so can anything else:

```js
window.teroshedLab.getState();
window.teroshedLab.setScene('meadow');         // 'storm' | 'meadow' | 'winter' | 'sea' | 'party' | 'space' | 'everything'
window.teroshedLab.setLevel('mid');            // 'minimal' | 'low' | 'mid' | 'high' | 'max'
window.teroshedLab.setEffectEnabled('wind', false);
window.teroshedLab.toggleEffect('fireworks');
window.teroshedLab.setSpeed(1.5);              // clamped to 0.2–3, returns the applied value
window.teroshedLab.setDrops(400);              // clamped to 0–1600
window.teroshedLab.setGradient('heatmap');     // 'theme' | 'heatmap' | 'rainbow' | 'aurora' | 'spiral'
window.teroshedLab.setPaused(true);
window.teroshedLab.explodeEater();
window.teroshedLab.setSkipIntro(true);
const stop = window.teroshedLab.subscribe((state) => console.log(state));
```

Unknown names throw `RangeError`; wrong types throw `TypeError`. Nothing here needs
authentication: it is a public demo page with no data behind it.

Where the browser provides WebMCP (`navigator.modelContext`), the same operations are
registered as tools in `webmcp.ts`: `lab_get_state`, `lab_set_scene`, `lab_set_intensity`,
`lab_set_effect`, `lab_set_speed`, `lab_set_drops`, `lab_set_gradient`, `lab_set_paused`,
`lab_explode_eater`. Each returns the resulting state as JSON.

### Not covered

- **WebMCP registration has never run.** No browser used for checking exposed
  `navigator.modelContext`, so the tool definitions are untested against a real host.
- **Scene input has no programmatic equivalent.** Clicking the stage (shock ring, sparks),
  clicking a crystal to break it, and the scene keys (Space, E, W, S, the arrows) are read
  by the engine as raw input. Only "explode the eater" has an operation. The same goes for
  the keys of the later effects: C (confetti cannons), M (a meteor to the pointer),
  B (bubbles from the pointer) and G (move the black hole to the pointer).
- `setSkipIntro` and opening the intro are not WebMCP tools; they concern the dialog, not the scene.

## The page as part of the scene

The control panel and the two shelves are tagged `data-fx-tags="ledge"`. Rain lands on them,
and when a crystal breaks, half its shards can be stopped by them: at an edge with a 20–50%
chance, or anywhere inside with a small chance per tick. Each stop plays a ripple on the
element (`attachPageRipples`). Stopped shards fly home after about five seconds. The later
effects use the same tag: snow and confetti settle on them, grass grows on them, birds
perch on them, bubbles slide along their undersides.

## Saved state

Scene, level, per-effect switches, speed, droplets, gradient and the "don't show again"
choice are saved to `localStorage` under `teroshed.lab.v1` on every change and restored on
load. Paused is not saved: a lab that opens frozen looks broken. A saved state without a
scene opens in Storm; one whose switches lack any of the twenty effects (a save from the
eight-effect lab) keeps its level and settings and takes the switches from the scene.

## Solo page

`/lab/solo.html?effects=name,name` runs the chosen effects alone, in that order, on a small
stage with two shelves, and takes scripted input (`window.solo.step`). `scripts/solo-shot.mjs`
drives it in headless Chromium and writes screenshots. It is built with the lab
(`bun run build` writes `dist/lab/solo.html`). The parameters and the script are described
in `AGENTS.md`, "Seeing an effect without a GPU".

## Checked

Twenty-effect version, in headless Chromium (Playwright) with a software renderer
(SwiftShader), at 1440×900 and at 375×812 with touch emulation. At 1440×900 every control
is on screen without scrolling while Readout and Keyboard are folded; with both open the
panel scrolls inside itself. At 375×812 the panel does not fit: it scrolls inside itself
(the page does not), and every control, Readout and Keyboard included, is reachable that way.
Through the scene select, each of the seven scenes switched exactly its effects in the engine
and the checkboxes; changing the level in Night meadow kept the effects and changed the
comfort and droplets; back in Storm the level chose the eight again; a new effect's checkbox
switched it without leaving the scene; keys 1–8 still toggle the eight and do not fire while
the select has focus; Tab goes from the level slider to the scene select to the checkboxes;
scene, level and switches survived a reload; an eight-effect save loaded as Storm / Mid with
the later effects off; `setScene('nope')` threw `RangeError`; the intro opened on a fresh
profile, focused its slider, and the arrow keys changed the level; no console errors. Not
checked: a real GPU or how any scene looks in motion at full frame rate (the software
renderer runs a few frames a second and the governor thins the scene), a screen reader, a
physical touch device, forced colours, browsers other than Chromium.

The earlier eight-effect version was checked in desktop Chrome at the same two sizes: the
dialog's focus and keys, About reopening it, and the choice surviving a reload.
