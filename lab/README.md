# Engine lab (`/lab/`)

A showcase page for the visuals engine: eight effects, a control panel, and an intro dialog
that warns about intensity and lets the visitor choose a level before anything bright runs.

## Intensity levels

Defined in `intensity.ts`. Each level adds to the one before it.

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
With reduced motion on, the dialog and the dim appear without animation.

## Programmatic access

Every control goes through one set of operations, `LabActions` in `actions.ts`. The panel,
the keyboard shortcuts and the intro all call it, and so can anything else:

```js
window.teroshedLab.getState();
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
registered as tools in `webmcp.ts`: `lab_get_state`, `lab_set_intensity`, `lab_set_effect`,
`lab_set_speed`, `lab_set_drops`, `lab_set_gradient`, `lab_set_paused`, `lab_explode_eater`.
Each returns the resulting state as JSON.

### Not covered

- **WebMCP registration has never run.** No browser used for checking exposed
  `navigator.modelContext`, so the tool definitions are untested against a real host.
- **Scene input has no programmatic equivalent.** Clicking the stage (shock ring, sparks),
  clicking a crystal to break it, and the scene keys (Space, E, W, S, the arrows) are read
  by the engine as raw input. Only "explode the eater" has an operation.

## The page as part of the scene

The control panel and the two shelves are tagged `data-fx-tags="ledge"`. Rain lands on them,
and when a crystal breaks, half its shards can be stopped by them: at an edge with a 20–50%
chance, or anywhere inside with a small chance per tick. Each stop plays a ripple on the
element (`attachPageRipples`). Stopped shards fly home after about five seconds.
- `setSkipIntro` and opening the intro are not WebMCP tools; they concern the dialog, not the scene.

## Saved state

Level, per-effect switches, speed, droplets, gradient and the "don't show again" choice are
saved to `localStorage` under `teroshed.lab.v1` on every change and restored on load.
Paused is not saved: a lab that opens frozen looks broken.

## Checked

Desktop Chrome, 1440×900 and 375×812 emulation: the dialog opens focused on the slider,
arrow keys change the level and the scene follows, Escape and Start close it and focus
returns to About, About reopens it, the choice survives a reload, and no control needs
scrolling to reach. Not checked: a screen reader, a physical touch device, forced colours,
and how the animations look in motion (the preview pane was hidden, which freezes them).
