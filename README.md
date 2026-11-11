# Web visualizer manager

Daniel's visuals engine: a small animation engine that runs **PixiJS and Three.js as one
scene**, where effects drawn by either renderer can affect each other — and where writing a
new effect is meant to be laughably intuitive.

It is a rebuild of the original canvas engine (`E:\Desktop\Coding\VisualizerEngine\Original`,
Oct–Nov 2025) and keeps its contract: a `VisualsManager` runs named `Effect` classes through
`initialize`, `onTick`, `onRender` and `cleanup`; every `onTick` returns a context that other
effects can read; particles are motion objects in pixels and milliseconds. The names are the
same on purpose.

```
src/       the engine
effects/   the library of effects built on it (one folder each) + contracts.ts
tests/     unit tests for the renderer-free parts
lab/       a page that runs every effect, with controls
```

## Writing an effect

Copy `effects/Blank/`, rename the class and `effectName`, fill in four methods:

```ts
import { Effect } from '../../src/Effect';
import type { EffectContext, TickContext, TimedContext } from '../../src/types';

export class Wind extends Effect {
    public effectName: string = 'wind';

    public initialize(): void {}                     // create what you draw (this.host.pixi / .three)

    public onTick(tickContext: TickContext): EffectContext {
        const strength = tickContext.keysPressed.includes('arrowright') ? 0.0011 : 0.0002;
        tickContext.forces.add({ kind: 'wind', owner: this.effectName, x: 0, y: 0, radius: 0, strength, dirX: 1, dirY: 0 });
        return this.publish({ strength });           // what other effects can read
    }

    public onRender(timedContext: TimedContext): void {}   // move what you drew; never change simulation state
    public cleanup(): void {}                              // release what you created
}
```

and add it to a page:

```ts
const manager = await VisualsManager.create(canvas);
manager.addEffect(new Wind()).addEffect(new Rain());
manager.run();
```

That is the whole of it. An effect never calls another effect. It may draw with Pixi, with
Three.js, with both, or with neither.

**Keep it that way.** No registries, plugin systems, config frameworks or wrapper layers on
top; no effect importing another effect's code; no simulation in `onRender`; no renaming the
vocabulary. If something seems to need more than a small effect class, that is a question
for Daniel, not a reason to build machinery.

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
| **Pixels** | The Pixi layer is uploaded as a texture each frame. A Three.js material can sample it through `host.surfaces` (the crystal refracts the rain behind it). Shock rings bend the whole composited picture. | Same frame. |

Contexts keep the original's ordered semantics. Events are an addition and are deliberately
batched; the two are different on purpose, not one replacing the other.

**Typing is optional.** An effect works with no declarations at all; its context is simply
untyped for readers. To make `tick.read('wind')` and `tick.events('wind:gust')` typed, add an
interface and one line to the registry at the bottom of `effects/contracts.ts`. That file is
the single home for everything the library's effects share. Reading a name that no effect
has logs a one-time warning, which catches typos.

## The stage and the page

All positions are **stage pixels**, origin top-left. `Stage` frames the Three.js camera so the
plane `z = 0` matches the Pixi layer pixel for pixel (`stage.toWorld(x, y, z)`,
`stage.project(v)`), which is what lets a 3D object and a 2D particle share a position.

`Stage` also tracks DOM elements marked `data-fx-anchor="name"` (optional
`data-fx-tags="ledge"`), so effects can react to the page: rain lands on tagged elements and
crystal shards are stopped by them. `tick.stage.tagged('ledge')` is the list on screen now;
`tick.stage.anchor('name')` is one element's rectangle.

The page can answer back. An effect emits `page:hit` when something of its own stops on an
element, and the page listens with `manager.on('page:hit', …)`. `attachPageRipples(manager)`
is a ready-made listener: it plays a ripple on top of the element that was hit, which the
engine's own canvas (behind the page) cannot do.

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
removed outright. Births and exits per tick are capped, and recovery is slow.

Using a `ParticleSet`: call `govern(tick)` at the start of every tick, spawn while
`canSpawn()`, and `sweep(tick)` at the end. Without `govern`, nothing ever spawns.

## Viewer comfort

`manager.setComfort({ flash, ripple, bloom })` scales ambient flashes, shock-ring distortion
and glow in the compositor without touching the simulation. The lab's five intensity levels
(Minimal to Max) are built on it.

## Frame pipeline

1. Pixi renders the back layer to its own canvas; the canvas is uploaded as a texture.
2. If any effect put something in a front container, Pixi renders that and it is uploaded too.
3. Three.js renders its scene into a 16-bit float target (multisampled).
4. One pass combines backdrop, Pixi back, Three.js scene and Pixi front, with shock-ring refraction.
5. A three-level bloom.
6. Tone roll-off, vignette, dither and sRGB encode to the visible canvas.

Pixi and Three.js each keep their own WebGL context. That costs one or two texture uploads per
frame and is the arrangement both libraries support without patching.

## The effect library

| Effect | Drawn with | Listens to | Tells the others |
| --- | --- | --- | --- |
| `Rain` | Pixi | `rainEater` context (gets eaten), the force field, DOM ledges (stopped by them, pools on them, drips off them) | `rain:eaten`, `rain:landed`, `page:hit` |
| `RainEater` | Three.js (glass crystal that refracts the Pixi layer) | `rain:eaten` and `lightning:strike` charge it; the force field shoves it; DOM ledges stop its shards | its head position, an attraction force, `rainEater:exploded` and a shock ring, `page:hit` |
| `Crystals` | Three.js | clicks; `rainEater:exploded` nearby (chain reaction); `lightning:strike` nearby; the force field; DOM ledges stop its shards | `crystal:exploded`, a shock ring, `page:hit` |
| `ClickExplosion` | Three.js points | presses, `rainEater:exploded`, `crystal:exploded`, `lightning:strike`, the force field | a shock ring per press |
| `LightningStorm` | Pixi | `rain:landed` builds charge where rain lands; strikes the rain eater when it is in range | `lightning:strike`, a shock ring, a flash over the backdrop |
| `FireworksEffect` | Pixi (stems, trails) and Three.js (bursts) | the force field bends stems and bursts; the rain eater sets off stems that come close | `firework:exploded`, a shock ring, a flash |
| `AuroraRibbons` | Pixi | ripples on presses, `lightning:strike`, `firework:exploded`, `rainEater:exploded`; the force field carries it; brightens with the eater's charge | — |
| `Wind` | nothing | arrow keys | one stage-wide wind force |
| `BlankEffect` | nothing | nothing | the template to copy |

`effects/Crystal/CrystalBody.ts` is not an effect but a building block shared by `RainEater`
and `Crystals`: a glass solid whose facets are particles. When it breaks, each facet flies
on its own, and half of them notice the page: an element tagged `ledge` stops a shard at its
edge with a 20–50% chance, and anywhere inside it with a small chance per tick. A stopped
shard stays on the element, then flies home; until it does, the crystal has a hole there.
Rain follows the same wall rule (`effects/Rain/PageWalls.ts`), and the water it leaves pools,
hangs from the element's underside and runs down its sides (`effects/Rain/PageWater.ts`).

## Commands

```sh
bun install
bun run dev         # the lab at http://127.0.0.1:3031/lab/
bun run typecheck
bun test tests
bun run build
```

## Where else this code lives

teroshed.work carries a copy of this engine in its own repository (`teroshed/teroshed-work`,
folders `engine/src`, `engine/effects`, `engine/tests`, plus `lab/`), because its Cloudflare
build needs a self-contained repository. This repository is where the engine is meant to be
changed; the site's copy is brought up to date by copying `src/`, `effects/` and `tests/` over
its `engine/` folder. The lab differs only in its import paths (`../src` here,
`../engine/src` there).

## Limits

- Pixels flow Pixi → Three.js. Three.js reaches Pixi through contexts, forces, events and the
  composite, not as a texture Pixi effects can sample.
- The Pixi layer is split into "behind" and "in front of" the 3D scene; there is no per-particle
  depth sorting against 3D objects.
- At most four shock rings exist at once; a fifth retires the oldest.
- An effect that throws is switched off for the rest of the session; the others keep running.
- After a lost WebGL context the engine stops drawing until the browser restores it; it does
  not rebuild resources itself beyond what Pixi and Three.js do.
- Checked in desktop Chrome with the simulation stepped by hand. Not yet watched running in
  real time, and not yet run on a phone.

Pinned: `pixi.js` 8.20.1, `three` 0.187.0. `pixi.js/unsafe-eval` is loaded so the engine works
under a `script-src 'self'` content security policy.
