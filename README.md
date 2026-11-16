# Duolume

A small framework for animated scenes on the web. It runs **PixiJS and Three.js as one picture**,
built from effects that react to each other and to the page, and writing a new effect is meant to
be laughably intuitive: one small class, four methods.

**Documentation, a nine-lesson tutorial with live editable demos, and every built-in effect running:
[duolume.danielsite.com](https://duolume.danielsite.com)**

| | |
| --- | --- |
| Status | 0.1.0, still in development: the API can change between versions |
| Install | `npm install duolume pixi.js three` |
| Needs | `pixi.js` ^8.20.1 and `three` ~0.187.0 (peer dependencies), and a bundler such as Vite |
| TypeScript | types are included; use `"moduleResolution": "bundler"` |
| License | MIT |

```ts
import { VisualsManager } from 'duolume';
import { Rain, RainEater, Wind } from 'duolume/effects';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const manager = await VisualsManager.create(canvas);
manager.addEffect(new Wind()).addEffect(new RainEater()).addEffect(new Rain());
manager.run();
```

Duolume is a rebuild of an earlier 2D canvas engine (October to November 2025) and keeps its
contract: a `VisualsManager` runs named `Effect` classes through `initialize`, `onTick`, `onRender`
and `cleanup`; every `onTick` returns a context that other effects can read; particles are motion
objects in pixels and milliseconds. The names are the same on purpose.

## The package

| Import | What it is |
| --- | --- |
| `duolume` | The engine: `VisualsManager`, `Effect`, `Particle`, `ParticleSet`, types and helpers |
| `duolume/effects` | The effect library: `Rain`, `RainEater`, `Crystals`, `Wind` and the rest, with their options |
| `duolume/effects/<Folder>/<File>` | Any file of the library by path, e.g. the building block `Crystal/CrystalBody` |
| `duolume/types` | Only for typing your own effects: the registries are augmented here |

npm ships JavaScript and type declarations built from this repository (`bun run build:lib`
writes them to `lib/`). The two renderers are peer dependencies, so a page has one copy of each.

```
src/       the engine                                   'duolume'
effects/   the library of effects (one folder each),    'duolume/effects'
           index.ts, and contracts.ts
tests/     unit tests for the renderer-free parts
lab/       a page that runs every effect, with controls (index.html),
           and one that runs chosen effects alone (solo.html)
scripts/   build-lib.ts, which builds what npm ships; solo-shot.mjs, which photographs solo.html
AGENTS.md  how to work in this repository, and the checklist for adding an effect
```

## Writing an effect

Copy `effects/Blank/`, rename the class and `effectName`, fill in four methods. (A library effect
also has to be listed in a few places by hand; `AGENTS.md` has the checklist.)

```ts
import { Effect } from 'duolume';
import type { EffectContext, TickContext, TimedContext } from 'duolume';

// A small version of effects/Wind/Wind.ts.
export class Breeze extends Effect {
    public effectName: string = 'breeze';

    public initialize(): void {}                     // create what you draw (this.host.pixi / .three)

    public onTick(tickContext: TickContext): EffectContext {
        const x = tickContext.keysPressed.includes('arrowright') ? 0.0011 : 0.0002;
        tickContext.forces.add({ kind: 'wind', owner: this.effectName, x: 0, y: 0, radius: 0, strength: x, dirX: 1, dirY: 0 });
        return this.publish({ x, y: 0 });            // what other effects can read
    }

    public onRender(timedContext: TimedContext): void {}   // move what you drew; never change simulation state
    public cleanup(): void {}                              // release what you created
}
```

and add it to a page:

```ts
import { VisualsManager } from 'duolume';
import { Rain, Wind } from 'duolume/effects';

const manager = await VisualsManager.create(canvas);
manager.addEffect(new Breeze()).addEffect(new Rain());
manager.run();
```

Inside this repository the effects import from relative paths (`'../../src/Effect'`), because
they are the package. Pages and projects use the package names.

A canvas belongs to one manager. `cleanup()` hands its WebGL context back to the browser, so the
next manager needs a new `<canvas>`; `create` throws a clear error when given a used one.

That is the whole of it. An effect never calls another effect. It may draw with Pixi, with
Three.js, with both, or with neither.

**Keep it that way.** No registries, plugin systems, config frameworks or wrapper layers on
top; no effect importing another effect's code; no simulation in `onRender`; no renaming the
vocabulary. If something seems to need more than a small effect class, that is a question
to raise in an issue first, not a reason to build machinery.

## The idea

In the original, `Rain` never called `RainEater`. `RainEater` returned `{ headPosition }` from
its tick, the manager kept it, and `Rain` looked it up and removed the droplets that were close.
Effects were independent modules that **published state and reacted to each other's published
state**.

That is the part worth building an engine around, and it is what makes mixing two renderers
natural: if effects only meet through what they publish, it does not matter what each one
draws with. Here the rain is Pixi, the rain eater is a Three.js crystal, and they still eat and
get eaten through the same mechanism as before.

## How effects reach each other

| Channel | What it is | Timing |
| --- | --- | --- |
| **Contexts** | The return value of `onTick`. `tick.previousEffectsContext` fills up as effects run this tick; `tick.previousTickContext` is the full map from the tick before. `tick.read(name)` gives the freshest of the two. | Ordered, as in the original: a later effect sees an earlier effect's result in the same tick. |
| **Forces** | `tick.forces.add({ kind: 'attract' \| 'repel' \| 'vortex' \| 'wind', … })` and `tick.forces.sample(x, y, out)`. Shock rings (`tick.forces.shock(…)`) are added once and expand on their own. | Sampled from the previous tick's complete set, so the result does not depend on run order. |
| **Events** | `tick.emit(type, payload)` / `tick.events(type)` for one-shot things ("I just exploded"). | Everything emitted in a tick is delivered as one batch on the next tick. |
| **Pixels** | The Pixi layer is uploaded as a texture each frame. A Three.js material can sample it through `host.surfaces` (the crystal, the bubbles and the singularity's lens show the rain behind them bent). Shock rings bend the whole composited picture. | Same frame. |

Contexts keep the original's ordered semantics. Events are an addition and are deliberately
batched; the two are different on purpose, not one replacing the other.

**Typing is optional.** An effect works with no declarations at all; reading its context gives
a loose object whose fields can be used directly. To make `tick.read('wind')` and
`tick.events('wind:gust')` typed, add an interface and one registry line. The library keeps all
of its own in `effects/contracts.ts`; a project augments the same registry:

```ts
declare module 'duolume/types' {
    interface EffectContextMap { breeze: { x: number; y: number } }
    interface EngineEventMap { 'breeze:gust': { strength: number } }
}
```

The module named there has to be `duolume/types`, the file that declares the registries; naming
`duolume` does not merge. Reading a name that no effect has logs one `console.debug` per name
(visible at the console's verbose level), which catches typos.

## The stage and the page

All positions are **stage pixels**, origin top-left. `Stage` frames the Three.js camera so the
plane `z = 0` matches the Pixi layer pixel for pixel (`stage.toWorld(x, y, z)`,
`stage.project(v)`), which is what lets a 3D object and a 2D particle share a position.

`Stage` also tracks DOM elements marked `data-fx-anchor="name"` (optional
`data-fx-tags="ledge"`), so effects can react to the page: rain lands on tagged elements and
crystal shards are stopped by them. `tick.stage.tagged('ledge')` is the list on screen now;
`tick.stage.anchor('name')` is one element's rectangle.

A tag can end in a number: `data-fx-tags="ledge-30"`. The element still counts as `ledge`
(`tagged('ledge')` and `tags.includes('ledge')` find it), and the number is on the rectangle as
`numbers.ledge` (30). For a ledge it is the percent of falling things that fall through:
`ledge-0` is solid, `ledge-100` stops nothing that falls, but birds still perch on it, grass
still grows on it and fireflies still shelter under it. Rain, snow, confetti, petals, meteors,
bubbles and crystal shards honour it; each piece rolls one number at birth and passes when
`roll * 100` is below the ledge's number, so it never flickers. A plain `ledge` keeps each
effect's own rule.

The manager keeps following its
`anchors` root: elements added, removed or retagged after `create` are picked up before the next
frame. `stage.observe(name, element, tags)` adds one by hand.

The page can answer back. An effect emits `page:hit` when something of its own stops on an
element, and the page listens with `manager.on('page:hit', …)`. `attachPageRipples(manager)`
is a ready-made listener: it plays a ripple on top of the element that was hit, which the
engine's own canvas (behind the page) cannot do. It works for a full-page canvas and for one
placed anywhere in the page.

## Inside inputs

The canvas is behind the page, so an element with a clear inside is a window onto the scene. An
input effect draws inside the page elements that carry its tag, clipped to their rounded corners:

```html
<label class="switch">
    <input type="checkbox" checked />
    <span class="track" data-fx-anchor="rain-switch" data-fx-tags="mini rain"></span>
    Rain
</label>
```

```ts
import { attachFieldTags, VisualsManager } from 'duolume';
import { Miniatures, Rain } from 'duolume/effects';

const manager = await VisualsManager.create(canvas);
manager.addEffect(new Rain()).addEffect(new Miniatures());
attachFieldTags(); // keeps each control's state in its tags
manager.run();
```

`Miniatures` puts a small moving picture of an effect inside anything tagged `mini`: rain in the
switch that turns the rain on, a bolt in the lightning switch. The other word names the effect;
all twenty scene effects have a miniature, and each moves in step with the real one (the small
bolt strikes when `lightning:strike` is emitted). The other input effects are asked for the same
way, by their own name: `data-fx-tags="liquid"`, `"sand"`, `"frost"`, `"fuse"`, `"circuit"`,
`"filings"`, `"pulse"`, `"petals"`.

The rest of the tags say what state the element is in, and that is how an effect knows:

| Word | Means |
| --- | --- |
| `on` / `off` | a switch or checkbox is checked or not |
| `focus` | it has the keyboard focus |
| `disabled`, `invalid`, `busy` | it cannot be used; what was entered is not accepted; it is waiting |
| `knob` | a knob covers one end (a switch track), so the picture keeps to the other |
| `value:0.62` | how full it is, 0 to 1: a slider, a progress bar |
| `r:10` | its corner radius in pixels; without it the element is taken to be a pill |

`attachFieldTags()` writes these from the real form controls and keeps them current: for an
element that is a control, contains one, or sits in the same `<label>` as one. A page can also
write them itself. After changing `.checked` or `.value` from script, which fires no event, call
`refresh()` on what `attachFieldTags()` returned.

A window shows the scene through whatever the page paints over it. A tinted card dims it; a card
with `backdrop-filter: blur` smears everything inside it, so keep windows off blurred surfaces.

## On the page

The canvas goes through the bloom at a capped resolution, so a 1 px line drawn there comes out
soft. For a sharp border or an ornament on a page element, an effect draws on the page itself:
`this.host.page`, a fourth place next to `pixi`, `pixiFront` and `three`. Two calls, made in
`onRender` every frame; whatever was not asked for in a frame is taken away after it:

```ts
public onRender(): void {
    this.host.page.picture('card', { image: '/star.svg', at: [1, 0] }); // on the top-right corner
    this.host.page.frame('card'); // a 1 px line round it, 6 px out, following its corners
}
```

- `on` is an anchor's name, an anchor (`stage.tagged('frame')` gives them), a `Field`, or any
  `{ name, x, y, width, height }`. Missing or off screen: nothing is drawn.
- `shown` is how far it has appeared: a number 0..1 is used as given; `true` or `false` fades it
  in or out by itself over `fade` ms (260) on the real clock, so it works while the scene is
  paused; left out, it is simply there. Under reduced motion there is no running bead, marching
  dash, rocking or twinkling, and a piece is there or gone in one frame.
- A `Picture` is any image file (`size`, `at`, `origin`, `gap`, `flip`, `mirror`, `span`,
  `grows`, `sway`, `twinkle`); its shape is used and `color` paints it: a theme colour by name
  (`'accent'`, `'ink'`, following `setTheme`), any CSS colour, or `'own'` for the file's colours.
  A `Frame` is the line (`gap`, `radius`, `line`, `dash`, `bead`, `color`) with pictures on it.
  Each piece takes a `zIndex` among the page's elements; left out, it sits right above the canvas.
- The stage measures each element's corner radius (`AnchorRect.radius`), so a frame follows it.

The layer is a `<div>` after the canvas, over it and clipped to it, that never takes the pointer.
The manager makes it on first use, hides it while the effect is off and removes it with the effect.

`FieldFrame` is built on it. Tag an element and it gets a frame while it has the keyboard focus:
`<input data-fx-anchor="email" data-fx-tags="frame laurel" />`, with `attachFieldTags()` on the
page. `manager.focus('email')` plays the focus look from code and `manager.unfocus('email')` ends
it, also while paused.

## Input

By default the manager listens to the whole window: as a background behind a page, a press
anywhere on the page is a press on the scene. A canvas that is one box in a page passes
`input: 'stage'`:

```ts
const manager = await VisualsManager.create(canvas, { input: 'stage' });
```

The pointer then counts only while it is over the canvas (`mousePosition` is `undefined`
elsewhere), keys only while the canvas has focus (it is given `tabindex="0"` if it has none),
and Space and the arrow keys stop scrolling the page while it has focus.

## Time

- Ticks are fixed-rate, 60 per second. Each advances the simulation by `1000 / 60` ms times
  the time scale; `tick.timeDelta` is that number, in **milliseconds**, like the original.
- Rendering runs once per animation frame and extrapolates with `timed.alpha`.
- Input edges (`mouseJustPressed`, `justPressedKeys`, …) reach exactly one tick, even when a
  frame runs several catch-up ticks. Keys are lower-case names: `'space'`, `'arrowleft'`, `'e'`.
- `tick.time` is the simulation clock. Gradients take it as an argument instead of reading
  `performance.now()`, so pausing, slow motion and still frames behave.
- `setMotionEnabled(false)` freezes everything; a frame is then drawn only when something
  changes. `prewarm(ticks)` settles the scene first so the still frame is not empty.

## Priorities and exits

Every `Particle` has a `priority` from 1 to 10, set at birth, and a life cycle
`alive → exiting → removed`. `PopulationGovernor` measures delivered frames over real time
(never simulation time) and turns that into a budget between 0 and 1. A `ParticleSet` over its
allowance asks the lowest-priority particles in the most crowded part of the stage to leave;
they play their exit animation. Only below 12.5 frames per second on average are particles
removed outright. Births and exits per tick are capped, and recovery is slow. The first second
of frames is not measured (`warmupMs`): a page compiles its shaders then, and that is not the
machine being slow.

Using a `ParticleSet`: call `govern(tick)` at the start of every tick, spawn while
`canSpawn()`, and `sweep(tick)` at the end. Without `govern`, nothing ever spawns.

## How much and how rich: intensity, detail and levels

Two numbers decide how heavy a scene is. **Intensity** is how much of an effect there is. A
**level** is how rich it looks. Every effect has an intensity. Only some effects have levels.

```ts
manager.setIntensity('rain', 0.4);                // a little rain
manager.setIntensity({ rain: 0.4, meadow: 1 });   // a scene is a plain object
manager.setIntensity(0.6);                        // the whole scene, multiplied into each
manager.setDetail(0.5);                           // how rich the whole scene may look
manager.setLevel('meadow', MeadowLevel.Lines);    // fix one effect's look
manager.setLevel('meadow', undefined);            // give it back to the machine
```

**Intensity** is 0 to 1, default 1, for every effect. The effect reads its own, times the
scene's, as `tick.intensity` (and `timed.intensity` while drawing). A `ParticleSet` already
allows `capacity × budget × intensity`, so "0.4 rain" is 40 percent of the drops with no change
to `Rain`, and the surplus leaves with its exit. Zero is off, the same as
`setEffectEnabled(name, false)`; raising it again switches the effect back on.
`getIntensity(name)` reads back what was set for one effect, `getIntensity()` the scene's.

**Levels** are an effect's looks, cheapest first, declared as a numeric enum. The meadow has four:

| `MeadowLevel` | What it draws |
| --- | --- |
| `Lines` | Each blade is one straight line. |
| `Blades` | Curved blades, standing still. |
| `Wind` | Curved blades that lean with the wind. |
| `Full` | Shaded blades, wind and everything. |

Unless the page fixes a look, the engine picks it from the scene's **detail** (0 to 1, default 1,
`setDetail`) times the frame budget. Full detail on a machine that keeps up gives the richest
look. A machine that struggles steps down by itself, and back up when there is room. A look
never flickers: it moves one step at a time, stays at least `LEVEL_HOLD_MS` (1.5 s) after each
move, and steps up only once there is `LEVEL_MARGIN` (0.1) to spare.

A page fixes a look with the effect's option, `new Meadow({ level: MeadowLevel.Lines })`, or at
any time with `setLevel`, which wins over the option. `manager.getLevels()` lists every effect
that has looks: the look it draws now (number and name), all its look names, and whether it is
pinned.

**An effect with no enum has one look.** It ignores detail, `setLevel` on it does nothing, and it
is not in `getLevels()`. That is the rule, not a gap: only effects with a real cheaper drawing
declare levels. Rain has one look; how much of it falls is its intensity.

## Viewer comfort

`manager.setComfort({ flash, ripple, bloom })` scales ambient flashes, shock-ring distortion
and glow in the compositor without touching the simulation. The lab's five intensity levels
(Minimal to Max) are built on it. Comfort is about the viewer's eyes, not about load, so it
stays apart from intensity and detail.

## Frame pipeline

1. Pixi renders the back layer to its own canvas; the canvas is uploaded as a texture.
2. If any effect put something in a front container, Pixi renders that and it is uploaded too.
3. Three.js renders its scene into a 16-bit float target (multisampled).
4. One pass combines backdrop, Pixi back, Three.js scene and Pixi front, with shock-ring refraction.
5. A three-level bloom.
6. Tone roll-off, vignette, dither and sRGB encode to the visible canvas.

Pixi and Three.js each keep their own WebGL context. That costs one or two texture uploads per
frame and is the arrangement both libraries support without patching.

### A transparent stage

`VisualsManager.create(canvas, { transparent: true })` leaves the backdrop out. Where no effect
draws, the canvas is see-through, so the page behind it shows (or the desktop, in a transparent
window). Effects are written exactly as before. What differs:

- A glow keeps a halo: light with nothing under it brings its own alpha, as much as its brightest
  channel, so it shows over a bright page too.
- No vignette, and no dither on empty pixels: a pixel nothing drew on is exactly zero.
- `surfaces.flash` and `surfaces.focus` light the backdrop, so they do nothing. Glass that bends
  the backdrop (crystals, bubbles, the singularity) bends only the Pixi layer and looks darker.
- Shock rings still bend the layers, and still leave their faint ring of light.
- Give the canvas no CSS background. The option cannot be changed after the manager is created.

## The effect library

Every library effect takes an optional options object: `new Rain({ dropCount: 300 })`,
`new FireworksEffect({ shells: 4 })`, `new Tide({ level: 90 })`, `new Fireflies({ coupling: 0.2 })`.
With none it runs as authored; the defaults are the effect's static constants. (`BlankEffect`,
the template, has none.) Every effect works alone; some show more with a neighbour: `Tide` and
`Nebula` with `Rain`, `Meadow` and `Snow` with `Wind`, `Singularity` with `Rain` to feed on.
Keys are named in the comment above each effect's class, and `AGENTS.md` keeps the table of which
key belongs to which effect.

| Effect | Drawn with | Listens to | Tells the others |
| --- | --- | --- | --- |
| `Rain` | Pixi | `rainEater` context (gets eaten), the force field, DOM ledges (stopped by them, pools on them, drips off them) | `rain:eaten`, `rain:landed`, `page:hit` |
| `RainEater` | Three.js (glass crystal that refracts the Pixi layer) | `rain:eaten` charges it, and so do `lightning:strike` and `meteor:impact` that land on its head; the force field shoves it; DOM ledges stop its shards | its head position, an attraction force, `rainEater:exploded` and a shock ring, `page:hit` |
| `Crystals` | Three.js | clicks; `rainEater:exploded` nearby (chain reaction); `lightning:strike`, `meteor:impact` and `singularity:collapsed` nearby; the force field; DOM ledges stop its shards | `crystal:exploded`, a shock ring, `page:hit` |
| `ClickExplosion` | Three.js points | presses, `rainEater:exploded`, `crystal:exploded`, `lightning:strike`, `meteor:impact`, `singularity:collapsed`, the force field | a shock ring per press |
| `LightningStorm` | Pixi | `rain:landed` builds charge where rain lands; strikes the rain eater when it is in range | `lightning:strike`, a shock ring, a flash over the backdrop |
| `FireworksEffect` | Pixi (stems, trails) and Three.js (bursts) | the force field bends stems and bursts; the rain eater sets off stems that come close | `firework:exploded`, a shock ring, a flash |
| `AuroraRibbons` | Pixi | ripples on presses, `lightning:strike`, `firework:exploded`, `rainEater:exploded`, `meteor:impact`, `singularity:collapsed`; the force field carries it; brightens with the eater's charge | — |
| `Wind` | nothing | arrow keys | one stage-wide wind force |
| `Meteors` | Pixi | the force field bends their path a little; the `wind` context (they tend to travel the way it blows); the `rainEater` and `singularity` contexts (a meteor that enters one lands there); DOM ledges (landed on) | `meteor:impact`, `page:hit`, a flash and a shock ring for the big ones |
| `Singularity` | Three.js (a lens that bends the backdrop and the Pixi layer round a dark disc) | the `rain` context (droplets fall in), `rainEater:exploded`, `crystal:exploded`, `meteor:impact`, `firework:exploded`, `lightning:strike` and `bubble:popped` feed it; the pointer (its home follows it, slowly); presses on it; the force field nudges it | its position, radius and mass; an attraction and a vortex force; `singularity:collapsed`, a shock ring and a flash when it collapses |
| `Nebula` | Three.js (one shader quad that only adds light) | the `rain` context thickens it; the force field carries it; `lightning:strike`, `firework:exploded`, `meteor:impact`, `crystal:exploded`, `rainEater:exploded`, `singularity:collapsed` and `fireflies:synced` light it from inside; the pointer | its density and how many lights glow in it |
| `Snow` | Pixi | the force field (wind slants the flakes and shaves the piles); DOM ledges (piles settle on them); the pointer wipes piles; `crystal:exploded`, `rainEater:exploded`, `lightning:strike`, `meteor:impact` and `singularity:collapsed` knock snow off, `firework:exploded` melts it; `page:hit` | its context only: flakes, settled, deepest |
| `Tide` | Pixi (three bands of water) | `rain:landed` raises it and rings it; the force field (wind sets the swell, shock rings push the surface); presses at the water; bursts near it splash it; `lightning:strike`, `firework:exploded` and `meteor:impact` are reflected | its `level`, `surfaceY` and how far it has `raised` |
| `Meadow` | Pixi (one mesh per row of grass); four looks, `MeadowLevel` `Lines` to `Full`; intensity is how many blades show | the force field (gusts roll through it, shock rings flatten it); the pointer parts it and a press mows it; `lightning:strike` and `meteor:impact` scorch it; `rain:landed` flicks blades; DOM ledges (grass grows on them). Below `Full` it feels only the stage-wide wind, and below `Wind` nothing moves it | how many blades stand and how far it leans |
| `Bubbles` | Three.js (glass spheres that refract the backdrop and the Pixi layer) | the force field; DOM ledges (they stop under them and slide round); presses pop them; the `rain` context (a droplet may pop one); the `rainEater` and `singularity` contexts; `crystal:exploded`, `rainEater:exploded`, `lightning:strike`, `meteor:impact`, `firework:exploded` and `singularity:collapsed` set off pops | where every bubble is; `bubble:popped`, `page:hit` |
| `Confetti` | Three.js (instanced paper pieces) | `firework:exploded`, `singularity:collapsed` and `fireflies:synced` set it off; the force field; presses lift lying pieces; DOM ledges (pieces come to rest on them) | how many pieces fly and lie; `page:hit` |
| `Fireflies` | Pixi | violent events scatter them (`lightning:strike`, `firework:exploded`, `crystal:exploded`, `rainEater:exploded`, `meteor:impact`, `bubble:popped`, `flock:startled`, `singularity:collapsed`) and so do presses; the `rain` context (they shelter under DOM ledges); the `serpent` context; the force field | the `fireflies` context (`count`, `sync`), `fireflies:synced` |
| `Flock` | Pixi | the force field; the `rainEater`, `serpent` and `singularity` contexts and a pressed or fast pointer (kept clear of); `crystal:exploded`, `rainEater:exploded`, `lightning:strike`, `firework:exploded`, `meteor:impact`, `bubble:popped`, `singularity:collapsed`, presses and `page:hit` frighten it; DOM ledges (perches); the `rain` context (no perching in rain) | `count`, `perched`, `center` and `heading`; `flock:startled` |
| `Serpent` | Three.js (instanced gems) | the pointer; the `flock` context (it hunts the birds); the `singularity` and `rainEater` contexts (it steers clear); `crystal:exploded`, `rainEater:exploded`, `meteor:impact`, `firework:exploded` and `singularity:collapsed` frighten it; `lightning:strike` runs down its body; the force field | its head position, velocity, length and `excited`; a vortex wake and a small repel force |
| `Constellation` | Pixi | every event that has a position (`lightning:strike`, `rainEater:exploded`, `singularity:collapsed`, `crystal:exploded`, `meteor:impact`, `firework:exploded`, `bubble:popped`, `flock:startled`, `fireflies:synced`) and presses start a spark; the pointer is one more point; the force field | its context only: `nodes`, `links`, `signals` |
| `FieldFrame` | the page itself (`host.page`), round elements tagged `frame` | the word `focus` in the element's tags (`attachFieldTags()`, `manager.focus(name)`); the other word picks the look: `hud`, `filigree`, `laurel`, `sparkle` | its default look |
| `Miniatures` | Pixi, inside page elements tagged `mini` | the element's state and the pointer over it; the events of the effect each miniature pictures (`lightning:strike`, `firework:exploded`, `rain:eaten`, `crystal:exploded`, `meteor:impact`, `bubble:popped`, …); the `wind` context; presses on the open stage | how many windows it draws in |
| `Liquid` | Pixi, inside elements tagged `liquid` | the element's state and value (how full it is), the pointer (a press pokes the surface), the element being moved (it sloshes), the force field | how many elements it draws in |
| `Sand` | Pixi, inside elements tagged `sand` | the element's state and value (which end the sand lies at), the pointer (a press dents the pile), the element being moved, the force field | that, and the grains in the air |
| `Frost` | Pixi, inside elements tagged `frost`; drips fall into the page | the element's state (it frosts over while off or disabled), the pointer (it melts a hole), the force field bends the falling drops | that, and how many are frosted over |
| `Fuse` | Pixi, round the border of elements tagged `fuse`; embers fall into the page | the element's state (`on`, `focus`, `busy`), the pointer (a press turns the spark round), the force field carries the embers, `lightning:strike` relights it | that, and the embers in the air |
| `Circuit` | Pixi, inside elements tagged `circuit` | the element's state and value (how often signals run), the pointer (a press sends one), `lightning:strike`, `meteor:impact` and `crystal:exploded` (a surge) | that, and the signals travelling |
| `Filings` | Pixi, inside elements tagged `filings` | the element's state (the field flips with the switch), the pointer near it, even from outside; the force field (wind and shock rings turn the needles) | that, and how many needles it draws |
| `Pulse` | Pixi, inside elements tagged `pulse` | the element's state (`on`, `off`, `busy`, `invalid`) and value (the rate), the pointer (a press is a beat), `lightning:strike` (a startle) | that, and the beats so far |
| `Petals` | Pixi, inside elements tagged `petals`; petals fall into the page | the element's state and value (how far the vine has grown), the pointer (a press shakes petals loose), the force field carries the falling petals, DOM ledges (they rest on them) | that, and the petals falling |
| `BlankEffect` | nothing | nothing | the template to copy |

`effects/Crystal/CrystalBody.ts` is not an effect but a building block shared by `RainEater`
and `Crystals`: a glass solid whose facets are particles. When it breaks, each facet flies
on its own, and half of them notice the page: an element tagged `ledge` stops a shard at its
edge with a 20–50% chance, and anywhere inside it with a small chance per tick. On a
numbered `ledge-N` every shard plays: N percent pass through and the rest stop at the edge. A stopped
shard stays on the element, then flies home; until it does, the crystal has a hole there.
Rain follows the same wall rule (`effects/Rain/PageWalls.ts`), and the water it leaves pools,
hangs from the element's underside and runs down its sides (`effects/Rain/PageWater.ts`).

Five other effects keep their rules in a file with no renderer in it, which `bun test tests`
runs: `Fireflies/sync.ts` (pulse-coupled oscillators), `Flock/boids.ts` (separation, alignment
and cohesion), `Snow/SnowCap.ts` (a heightfield of snow that slumps, melts and can be carved),
`Tide/WaterSurface.ts` (a row of spring columns whose disturbances spread as rings) and
`Meadow/BladeRow.ts` (a row of grass blades, each a spring on its tip). They are importable by
path like `CrystalBody`.

`effects/Field/` is the building block of the effects that draw inside inputs (the nine
rows above the template): `FieldSet` keeps one record per tagged page element (its state from the tags, eased
presence and level, the pointer over it, presses), and `FieldLayer` gives each element a
`Graphics` clipped to its rounded rectangle. "Inside inputs" above says how a page asks for one.

## Commands

```sh
bun install
bun run dev         # the lab at http://127.0.0.1:3031/lab/
bun run typecheck
bun test tests
bun run build       # the lab, as a static site
bun run build:lib   # what npm ships: JavaScript and type declarations in lib/
```

`lab/solo.html?effects=wind,rain` runs just those effects, found by `effectName`, on a stage with
two page elements tagged `ledge`. `node scripts/solo-shot.mjs out/rain "wind,rain"` photographs it
in headless Chromium (it needs Playwright, which is not a dependency). The address parameters,
the scripted input and the checklist for adding an effect are in `AGENTS.md`.

## Carrying a copy

A site that must build from its own repository alone can carry a copy of `src/` and `effects/`
instead of installing the package, and point the same import names at it with path aliases. The
documentation site and teroshed.work both do. This repository is where the engine is changed;
copies are brought up to date by copying the two folders over.

## Limits

- Pixels flow Pixi → Three.js. Three.js reaches Pixi through contexts, forces, events and the
  composite, not as a texture Pixi effects can sample.
- The Pixi layer is split into "behind" and "in front of" the 3D scene; there is no per-particle
  depth sorting against 3D objects.
- At most four shock rings exist at once; a fifth retires the oldest.
- An effect that throws is switched off for the rest of the session; the others keep running.
- After a lost WebGL context the engine stops drawing until the browser restores it; it does
  not rebuild resources itself beyond what Pixi and Three.js do.
- One manager per canvas, and a canvas is not reused after `cleanup()`.
- Checked in desktop Chrome. Not yet run on a real phone, and frame cost on phones is not measured.

Developed and tested against `pixi.js` 8.20.1 and `three` 0.187.0. `pixi.js/unsafe-eval` is loaded so the engine works
under a `script-src 'self'` content security policy.
