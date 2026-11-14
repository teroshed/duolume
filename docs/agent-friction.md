# What got in the way: adding twelve effects with agents

14 November 2026. Twelve effects were added to the library in one session: one orchestrating
agent in a cloud container (no GPU), twelve builder agents in parallel (four on the strongest
model for the shader pieces, four on Opus, four on Sonnet), then four follow-up agents (lab
wiring, documentation, polish, tests). This file is the list of what slowed that work down, what
was done about it in the same branch, and what is only proposed.

It is written for the next agent as much as for a person. The aim throughout was to help agents
without making the repository worse for people: nothing here adds machinery to the engine, and
every proposal says what it would cost someone working by hand.

**Status words:** *done* means it is in this branch. *proposed* means it is not, and is yours to
decide.

## The short version

1. The biggest win was being able to **see one effect, repeatably, without a GPU**
   (`lab/solo.html` and `scripts/solo-shot.mjs`). Before it, an agent could not check its own
   work; with it, a look takes five seconds.
2. The second was **writing the rules down** (`AGENTS.md`). The conventions were consistent but
   lived only in the nine existing effects.
3. The largest cost still standing is that **one effect is described by hand in about ten
   places across two repositories**, and one of those repositories cannot be reached from the
   cloud.

## 1. Seeing the result

| # | What happened | What was done or is proposed | Cost to a person |
| --- | --- | --- | --- |
| 1 | A cloud container renders with software WebGL at about 4 frames per second. The governor reads that as an overloaded machine, drops the budget to 20% and calls an emergency, so a screenshot of the lab shows a fifth of the effect. | *done*: the solo page has a still mode (`still=`) that never samples the frame rate, `governor=off`, and `budget=0.4` to hold a low budget on purpose. | none |
| 2 | Every effect ran in one scene; there was no way to look at one alone. | *done*: `lab/solo.html?effects=a,b` finds effects by `effectName`. Nothing to register. | none |
| 3 | Effects use `Math.random`, so two screenshots never matched and "before and after" meant nothing. | *done*: `seed=`; the script defaults to 7. | none |
| 4 | An agent could not make another effect's event happen (a meteor impact, a collapse) to test its reaction, nor switch an effect off mid-run. | *done*: scripted steps take `emit: [{ type, payload }]` and `enabled: { rain: false }`. | none |
| 5 | With several agents saving files, Vite's hot reload reloaded every open page and killed runs in progress ("Execution context was destroyed"). | *done*: the script replaces Vite's client with a stub for its own page. | none |
| 6 | The script printed what effects published only at the end; one agent copied the script to print per step. Input edges reach only the first tick of a step, which was not written anywhere. | *done*: `"print": true` per step; the semantics are in `AGENTS.md` and the script's header. | none |
| 7 | The lab's intro dialog blocks any scripted visit until `localStorage` is primed with `{"skipIntro":true}`. | *done*: `/lab/?intro=0` skips it for that visit and saves nothing. | none |
| 8 | `bun run dev` opens a browser, which a headless session cannot. Agents have to know to call Vite directly. | *done*: documented in `AGENTS.md`. *proposed*: a second script, `"serve": "vite --host 127.0.0.1 --port 3031 --strictPort"`, so the name says it. | one more script name |
| 9 | Playwright is not a dependency (rightly), and in the cloud image it is only reachable through `NODE_PATH`, which `import()` ignores. | *done*: the script uses `createRequire`, and says what to install when it finds nothing. | none |
| 10 | A person following the session cannot open a dev server bound to 127.0.0.1 inside a container. | *done for this session*: a second server with `allowedHosts: true`, announced to the app as a preview port. Nothing to change in the repository. | none |

## 2. Knowing the rules

| # | What happened | What was done or is proposed | Cost to a person |
| --- | --- | --- | --- |
| 11 | No file told an agent how effects are written here: options with static defaults, one reused context object, no simulation in `onRender`, theme colours, the flash channel, how scarce shock rings are. All of it had to be inferred from nine files. | *done*: `AGENTS.md`. The brief given to the builders became that file. | a file to keep true |
| 12 | Adding an effect means touching `contracts.ts`, `index.ts`, the README table, four lab files, and on the documentation site an example program, a gallery entry and a reference row. Nothing checked that they agree. | *done*: the checklist in `AGENTS.md`, and `tests/library.test.ts`, which reads the files as text and names the effect and the place that was forgotten. It is a test, not a registry: the engine is untouched. | a failing test when a listing is forgotten, which is the point |
| 13 | The same facts about an effect (what it listens to, what it tells, its options) are written by hand in the class comment, the README row, the site's gallery entry and the site's reference row. They drift: the audit of the twelve found a dozen comments that were already wrong on the day they were written. | *proposed*: let the documentation site build its gallery card and option row from the JSDoc it already parses for hover notes, so the class comment is the one place. That is a change to `engine-docs`, not to the engine. | less to write; the class comment has to stay in its fixed shape |
| 14 | Keys were claimed by effects (`space`, `e`, `w`, `s`, the arrows) with no list. Four new effects wanted keys. | *done*: a table in `AGENTS.md`; each class comment names its keys. | none |
| 15 | "How bright is too bright" was not written. The glow pass starts at about 0.62; the first snow drifts were near white and glowed like lamps. | *done*: a line in `AGENTS.md`. *proposed*: the same number in the README's "Frame pipeline". | none |
| 16 | Pixi surprises cost three agents real time: `Graphics.poly` keeps the array it is given (a reused scratch array draws every tail as the last one, so they were invisible); a `ParticleSet` refill arrives as a band because births are capped per tick; and the "textureSource was destroyed while still bound" warning on cleanup, which four effects print and nobody could silence. | *done*: all three are in `AGENTS.md` under "Things that cost someone an hour", the warning with its cause in Pixi (`getTextureBatchBindGroup` keeps bind groups in a cache it never clears). *proposed*: nothing more; it is harmless. | none |
| 17 | Nothing says the camera looks straight at the stage, so a confetti piece lying flat was under a pixel thick. | *done*: `AGENTS.md`. *proposed*: one sentence in the README's "The stage and the page". | none |
| 18 | One agent read another effect's context untyped, not noticing it was already declared in `contracts.ts`. | *done*: a line in `AGENTS.md`. | none |
| 19 | Option comments differ in form between files ("Default 2500 (`X`)", "Default `X` (14)", "Defaults to"), and on/off options have no constant to name. | *done*: the rule in `AGENTS.md` now says a constant is named when there is one. *proposed*: pick one form the next time the comments are touched; not worth a pass of its own. | none |

## 3. Many agents in one working tree

| # | What happened | What was done or is proposed | Cost to a person |
| --- | --- | --- | --- |
| 20 | Twelve agents needed each other's contexts and events before the effects existed. | *done*: all twelve contracts were written first, by the orchestrator. This worked well enough to recommend as the way to do it: the serpent hunts a flock it never saw. | none |
| 21 | A whole-repository `tsc` and the solo page's file glob both see other agents' half-written files. | *done*: the solo page skips a file that fails to load. Agents were told that type errors outside their folder are not theirs. | none |
| 22 | With other agents' uncommitted edits in the tree, `git status` and `git diff` could not show an agent its own change. Three follow-up agents reported this. | *proposed (practice)*: commit between phases, or give each agent a git worktree and its own dev server (`SOLO_PORT` is already honoured). Worktrees cost a merge and a `bun install` each. | none |
| 23 | The session's worker restarted three times. Files survived; the final reports of four builders did not, and had to be reconstructed by reading their code. | *proposed (practice)*: agents write their report to a file as they go; the orchestrator commits and pushes at each milestone. Both are in `AGENTS.md`. | none |
| 24 | Several effects came out larger than "one small class": `Snow.ts` 744 lines, `Flock.ts` 679, `Meteors.ts` 658, `Confetti.ts` 611. Each has its rules in one place and reads top to bottom, but they are not small. | *not done*. Candidates to split when one is next changed: Snow's drift drawing, Flock's perching. | reading time |

## 4. Cloud session and the PC

| # | What happened | What was done or is proposed | Cost to a person |
| --- | --- | --- | --- |
| 25 | The cloud session could not attach the PC's folders (they are in the Remote Control list but not offered to cloud sessions). The workspace was readable only through NexusMCP, which lists and reads but does not search: finding the engine's folder and the documentation site took 108 tool calls. | *proposed*: a text search tool in NexusMCP. Until then, `AGENTS.md` now names the documentation site and what it needs. | none |
| 26 | The engine's folder on the PC is still called `web-visualizer-manager`. A search for "duolume" does not find it. | *proposed*: rename it when nothing has it open. | a few stale shortcuts |
| 27 | The documentation site (`engine-docs`) has no git remote, so nothing in the cloud can update it or check it. (The brief also said it held uncommitted work. That came from a hand-over note that had gone stale: it was clean.) | *done*: a kit was carried in this repository (twelve example programs compiled against it, the gallery entries, the reference rows, the steps). The PC session applied it and deployed the site on 14 November, and the kit was then removed. *proposed*: give `engine-docs` a private remote. | a remote to push to |
| 28 | Starting a session on the PC from the cloud is refused until its owner approves in person; the approval then limits the cloud session to trusted devices for good. | *done*: approved once in this session. Worth knowing before planning work around a PC companion. | one approval |
| 29 | The orchestrator's own brief told an agent to use `baseUrl` in a temporary tsconfig; TypeScript 7 rejects it. | *done*: the agent used absolute `paths`. Noted here because the repository is on TypeScript 7 and older habits fail on it. | none |
| 30 | The PC session could not message the cloud session back ("not vouched for as a trusted device"): only the cloud side had been approved. Its two reports reached the cloud session by being read off the PC's disk and by the owner pasting them. | *proposed (practice)*: have a companion session write its report to a file from the start, and say where. Do not plan on a reply. | a paste |
| 31 | The PC session would not publish on an approval relayed by another session, even quoted and offered for checking in the transcript. It asked its owner one yes/no question in its own chat instead. | *nothing to fix*: this is the right behaviour, and it cost one word. Worth knowing when planning: a deploy from a companion session needs its owner present there. | one word, typed in the right chat |
| 32 | A check-in the cloud session scheduled for itself failed with "access denied" after the session had been limited to trusted devices. | *not understood*. Do not rely on a scheduled wake-up in a session that has been through the trust approval. | none |

## What worked, to keep

- **Contracts first, then parallel builders** (20 above).
- **A spec per effect that says what makes it interesting**, not only what it does. The builders
  were told the author finds half the existing effects dull; each spec led with the idea (the
  fireflies synchronise, the tide is filled by the rain, the meadow shows the wind) and left the
  look to the builder and the screenshots.
- **Cheaper models for bounded work.** The four Pixi effects given to Sonnet (constellation,
  meteors, fireflies, snow) each took 3 to 10 minutes and 130,000 to 175,000 tokens, and needed
  one small polish pass between them. The shader pieces (singularity, bubbles, nebula, serpent)
  went to the strongest model and needed none. The documentation audit on Sonnet was the most
  expensive single agent (316,000 tokens) because checking every sentence against the code is
  reading, not writing.
- **Asking every agent for a friction list.** Most of this file came from them.

## Checked afterwards, on a real GPU

A companion session on the PC (RTX 4070 SUPER, hardware WebGL through Direct3D 11, a 60 Hz
display) measured the branch before it was merged:

- All twelve effects, six combinations and the seven lab scenes hold 60 frames per second at a
  full budget, at 1920×1080 and on a 5120×2880 canvas. No frame over 17.6 ms after start-up,
  including bursts, impacts, pops and the collapse. No console errors, nothing wrong in the
  screenshots.
- A frame costs 1.2 to 2.0 ms per effect at 1080p and 3.5 to 4.7 ms at 5K (the nebula is the
  dearest). All twenty together cost 10 to 12 ms, about 7 ms of it JavaScript: that fits 60 Hz
  and would not fit 144 Hz.
- It found the governor reading page start-up as a slow machine (79 to 88% budget for the first
  eight to ten seconds of every load). That is engine code and has its own fix (`warmupMs`).
- With the browser's frame-rate cap removed, snow at 5K and confetti showed stalls that do not
  appear at 60 Hz. Probably an artefact of that mode; unchecked on a 120 or 144 Hz display.
- `g` moves the singularity slowly: a drift toward the pointer, not a summons.

The documentation site was brought up to date from the merged `main` and deployed the same day.

## Not checked

- How the motion looks to the eye. Both sessions judged from frame timings and still frames.
- Anything above 60 Hz, a weak GPU, a phone, a screen reader, forced colours.
