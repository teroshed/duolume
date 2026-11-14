# Working in this repository

Notes for anyone changing Duolume, written so that an AI coding agent can follow them without
guessing and a person can skim them. `README.md` explains what the engine is and why; this file
is the how.

## Commands

```sh
bun install
bun run typecheck                 # strict, noUnusedLocals, verbatimModuleSyntax
bun test tests                    # renderer-free unit tests
bun run build:lib                 # what npm ships (lib/)
bunx vite --host 127.0.0.1 --port 3031 --strictPort    # dev server without opening a browser
```

`bun run dev` is the same server but opens a browser, which a headless session cannot do.

## Layout

```
src/        the engine                    do not change it to make one effect work: raise it first
effects/    one folder per effect         effects/<Name>/<Name>.ts, helpers beside it
            contracts.ts                  every context and event the library publishes, typed
            index.ts                      the public export list
lab/        index.html, the showcase      every effect with controls
            solo.html, one effect alone   for building and checking an effect
tests/      bun tests                     pure modules only: nothing that needs WebGL
```

## Adding a library effect: the checklist

An effect is one class with four methods. Copy `effects/Blank/`. Then every place that lists
effects by hand has to hear about it; these are all of them.

In this repository:

1. `effects/<Name>/<Name>.ts`: the class, its `…Options` interface, its JSDoc (see "Comments are
   documentation" below).
2. `effects/contracts.ts`: the context interface, any event payloads, and one line each in
   `EffectContextMap` / `EngineEventMap`.
3. `effects/index.ts`: export the class and its options type.
4. `README.md`, "The effect library": one table row.
5. The lab: `lab/intensity.ts` (`EFFECT_NAMES`, and the scenes or levels it belongs to),
   `lab/main.ts` (construct it and add it, in draw order), `lab/index.html` (its checkbox),
   `lab/README.md` if a count or a table changes.
6. A test in `tests/` when the effect has logic that can be factored into a file with no
   `pixi.js` or `three` import (a solver, a heightfield, steering rules).

`bun test tests` includes `tests/library.test.ts`, which reads these files as text and fails,
naming the effect, when one of 2 to 5 was forgotten.

On the documentation site (`engine-docs`, a separate repository that carries a copy of `src/` and
`effects/`):

7. `bun run sync-engine` there, then restart its dev server.
8. `examples/<slug>.ts`: a small program that runs the effect with its options spelled out.
9. `examples/index.ts`: an entry in `EXAMPLES` (summary, listens, tells, interact).
10. `src/pages/referenceContent.ts`: a row in the "Effect options" table.

## Conventions an effect follows

- `export class X extends Effect<XContext>` with `public effectName = 'x'`. Names are unique on
  a page.
- Options: `export interface XOptions`, every field optional, numeric defaults in `public static
  readonly` constants on the class (an on/off option states its default in its comment),
  `constructor(options: XOptions = {})`. With no options the effect runs as authored. Clamp
  silly values; do not throw.
- `onTick` simulates and returns `this.publish(this.context)`, with the context object allocated
  once. `onRender` only moves views: it never changes simulation state and draws the same picture
  when called twice (still frames are redrawn).
- Units are stage pixels (origin top-left) and milliseconds. Time comes from `tick.time` and
  `timed.time`, never from the wall clock.
- The stage can resize at any tick. Read its size every tick; seed what needs the size in the
  first `onTick`, not in `initialize`.
- `cleanup()` destroys and disposes everything the effect created and resets its state.
- An effect never imports another effect's code. Shared shapes live in `effects/contracts.ts`.
  `tick.read('other')` is `undefined` when that effect is not on the page: every effect works alone.
- An effect that throws is switched off for the session, so guard what can be missing:
  `tick.mousePosition` (undefined until the pointer moves), other effects' contexts, zero sizes.
- Colour comes from the theme (`tick.theme`, `timed.theme`), read every frame.
- It is a background behind page text: modest alpha, no large bright fills.
- Ignore presses when `tick.mouseOnInteractive` is true.
- Whole-picture flashes go through `host.surfaces.flash.value += x` in `onRender`, so the
  viewer-comfort setting scales them.
- Shock rings are scarce (four at once). One per big, rare moment; never per particle.
- Scale populations with `tick.budget.budget`. `ParticleSet` for `Particle` objects (`govern`,
  `canSpawn`, `sweep`); structure-of-arrays with a budget-scaled cap for numerous short-lived things.
- No allocation per particle per tick. A few hundred `Graphics` primitives per frame are fine;
  beyond that use a `ParticleContainer`, a `Mesh` with a dynamic buffer, or Three.js instancing.
- Three.js: the scene buffer is linear and premultiplied. `gl_FragColor = vec4(colour, 0.0)` adds
  light; alpha up to 1 covers. There are no lights in the scene: shade in the material.
- Contexts and events are typed in `effects/contracts.ts`. Look there before reading another
  effect's context: `tick.read('singularity')` is already typed.

### Things that cost someone an hour

- **Bloom.** The glow pass picks up whatever is brighter than about 0.62 (`src/Compositor.ts`). A
  near-white fill turns into a lamp with a halo: the first snow drifts did. Keep large fills well
  under that and leave the bright values to small things.
- **The camera looks straight at the stage.** A flat thing lying in the stage plane is edge-on
  and under a pixel thick. Tip it toward the viewer if it should be seen.
- **Pixi `Graphics.poly(points)` keeps the array it is given.** A reused scratch array draws
  every polygon as the last one. Use `moveTo`/`lineTo`, or a fresh array.
- **`ParticleSet` caps births per tick.** Refilling a whole population at once arrives as a band
  across the stage. Spawn a trickle.
- **"[BindGroup] a 'textureSource' was destroyed while still bound"** on removing an effect comes
  from inside Pixi: bind groups that reference a texture outlive the display object that used it
  (for batches they sit in a cache that is never cleared, `getTextureBatchBindGroup`), so
  destroying the texture afterwards prints this. It is harmless. Rain, Meadow, Tide and Flock all
  print it, and no destroy order anyone tried avoids it short of leaking the texture.

### Keys in use

A key belongs to one effect. Lower-case names, read from `tick.justPressedKeys` / `keysPressed`.

| Key | Effect | Does |
| --- | --- | --- |
| `space` | `fireworks`, `lightningStorm` | burst the shells; discharge the two fullest points |
| `e` | `lightningStorm` | build charge |
| `w` `s` | `auroraRibbons` | add or remove a ribbon |
| `arrowleft` `arrowright` | `wind` | blow |
| `b` | `bubbles` | blow a cluster from the pointer |
| `c` | `confetti` | fire both cannons |
| `g` | `singularity` | move its home to the pointer |
| `m` | `meteors` | send one to the pointer |
| `1`–`0` | the lab page | effect switches and speed |

### Comments are documentation

The documentation site builds its hover notes from the JSDoc in `src/` and `effects/`. For an
effect that means: a block above the class (what it is, "What it listens to:", what it tells the
others, its keys) and one line per option (what it is, its unit, its default, and the constant
that holds it when there is one). Keep them true when behaviour changes.

## Seeing an effect without a GPU

`lab/solo.html?effects=wind,rain` runs just those effects, found by `effectName` (nothing to
register), on a stage with two page elements tagged `ledge`. Address parameters:

| Parameter | Meaning |
| --- | --- |
| `effects=a,b` | which effects, in run order |
| `still=600` | freeze, run 600 ticks, draw one frame; `window.solo.step(ticks, input)` advances it |
| `seed=7` | repeatable `Math.random` |
| `governor=off` | keep the budget at 100% when frames are slow (software rendering) |
| `budget=0.4` | hold the frame budget at 40%, to see an effect thin out |
| `ledges=0` | no page elements |
| `options={"rain":{"dropCount":300}}` | constructor options by effect name |

`window.solo.step(ticks, input)` takes scripted input for the first tick of the step:
`{ mouse: {x, y}, press, hold, keys, tap, wheel, emit: [{ type, payload }], enabled: { rain: false } }`.
`emit` delivers events as if an effect had sent them, which is how to test an effect's reaction
to an event without staging the thing that causes it. `enabled` switches effects on or off
before the step. Ticks are per step, not cumulative, and edges (`press`, `tap`, `emit`) reach
only the first tick of their step.

`scripts/solo-shot.mjs` drives that page in headless Chromium and writes screenshots:

```sh
node scripts/solo-shot.mjs out/rain "wind,rain" '[{"ticks":600,"shot":"a"},{"ticks":20,"input":{"mouse":{"x":640,"y":300},"press":true},"shot":"b"}]'
```

It needs Playwright with a Chromium it can launch, which is not a dependency of this package
(`npx playwright install chromium` once, or use an environment that has it; a globally installed
one is found through `NODE_PATH`). Runs are repeatable: the seed is 7 unless `seed=` says
otherwise. A step with `"print": true` prints what each effect published at that moment. At the
end it prints console errors, each effect's published context, and a cleanup check (every effect
removed without errors, nothing left in the scene). Keep a step under about 2000 ticks.

Why still mode: a software renderer delivers a few frames per second, the governor reads that as
an overloaded machine and empties the scene, and a screenshot of the running lab then shows a
fifth of the effect. Still mode never samples the frame rate.

## Several agents at once

Twelve effects were built in parallel in one working tree. What made that work, and what did not:

- Write the contracts first. With every context and event declared in `effects/contracts.ts`
  before anyone starts, each agent can code against effects that do not exist yet.
- One folder per agent, and the shared files (`index.ts`, the README, the lab) left to whoever
  integrates.
- A whole-repository `tsc` and the solo page both see everyone's half-written files. The solo
  page skips a file that does not compile; type errors in someone else's folder are theirs.
- Commit between phases. With other people's uncommitted edits in the tree, `git diff` cannot
  show an agent its own change. A git worktree per agent, each with its own dev server
  (`SOLO_PORT`), avoids all of it at the price of merging.
- Have each agent write its report to a file as it goes. A restarted worker loses the final
  message; the files survive.

## Rules that come from the author

- No registries, plugin systems, configuration frameworks, dependency injection or base-class
  hierarchies on top of the engine; no renaming of its vocabulary. If something seems to need
  more than a small effect class, raise it before building it.
- The documentation site's `engine/` folder is a copy: change the engine here, never there.
- Deploying the documentation site is outward-facing: ask first.
