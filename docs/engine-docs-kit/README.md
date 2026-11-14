# Kit for the documentation website

The documentation site lives in a separate repository, `engine-docs`, which could not be reached
when twelve effects were added to this one. This folder holds what the site needs for them, written
from the effects' own source: `Bubbles`, `Confetti`, `Constellation`, `Fireflies`, `Flock`,
`Meadow`, `Meteors`, `Nebula`, `Serpent`, `Singularity`, `Snow` and `Tide`.

| File | What it is | Where it goes on the site |
| --- | --- | --- |
| `examples/<slug>.ts` (twelve) | One small program per effect, every option spelled out with its default | `examples/` |
| `examples-entries.ts` | Twelve entries for the example gallery | the `EXAMPLES` array in `examples/index.ts` |
| `reference-rows.ts` | Twelve rows for the "Effect options" table | `src/pages/referenceContent.ts` |

The hover notes need nothing from here. The site builds them from the JSDoc in `src/` and
`effects/`, and that arrives with step 1.

## Applying it

All of this is done in the `engine-docs` repository, on the machine that has it.

1. Run `bun run sync-engine`. It copies this repository's `src/` and `effects/` into the site's
   `engine/` folder. Do this first: the new examples import effects that are not in the old copy.
2. Restart the site's dev server, so it sees the new files.
3. Copy `examples/*.ts` into the site's `examples/`. A file that already has the same name is
   replaced; there should be none.
4. In `examples/index.ts`, open `examples-entries.ts`. Copy the object literals between
   `export const entries = [` and the closing `];` (not the two `declare` lines at the top, which
   only let this file be checked here) and paste them into `EXAMPLES`, before the `field-frame`
   and `blank` entries. The indentation already matches. Each entry calls `code('<slug>')`, which
   reads `examples/<slug>.ts`, and seven of them use `html: SHELF` for the page element tagged
   `ledge` on the demo stage.
5. In `src/pages/referenceContent.ts`, find the section with `id: 'library'` and its
   `members([...])` table ("Effect options"). Open `reference-rows.ts`, copy the rows between
   `export const rows ... = [` and `];`, and paste them into that table, after the `Wind` row
   and before `BlankEffect` if it has one. The indentation already matches.
6. Run the site's typecheck and its build. A failure in a new example is most likely a missing
   `sync-engine`.
7. Open the gallery in the dev server and run each of the twelve once. They are written for a demo
   stage of about 700 by 400 pixels: where a default population would crowd it, the example passes
   a smaller number and says so in a comment.

Deploying the site is outward-facing and needs the author's explicit yes. Do not deploy as part of
this.

When it is applied, delete this folder (`docs/engine-docs-kit/`) from this repository.

## Check on the site

These places may state effect counts or lists, and could not be read from here. Look at each and
change what the twelve make stale:

- `src/pages/landing.ts`: a count of effects, or a list of names.
- `lessons/index.ts`: lesson text that lists the effects or says how many there are.
- `src/search.ts`: a search index that may list effects and examples by hand.

The reference page may have other tables that list effects (for contexts, events or keys); a new
effect is a new row in each. The events and contexts are in `effects/contracts.ts`, the keys in
`AGENTS.md`.

## How these were checked

The twelve programs were compiled against this repository with a temporary `tsconfig` that maps
`duolume` to `src/index.ts` and `duolume/effects` to `effects/index.ts`. This folder is not in the
repository's own `tsconfig`, so it does not affect `bun run typecheck`.
