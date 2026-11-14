import { attachPageRipples, Effect, VisualsManager, type AnyEffect, type TickInput } from '../src';

/**
 * Solo: run a chosen few effects on an otherwise empty stage. For working on one effect, and
 * for checking it from a script (see lab/README.md, "Solo page").
 *
 *   /lab/solo.html?effects=wind,rain              the effects to run, by effectName, in run order
 *   &still=600                                    freeze, run 600 ticks, draw one frame
 *   &seed=7                                       repeatable Math.random
 *   &governor=off                                 keep the budget at 100% (software rendering)
 *   &budget=0.4                                   hold the frame budget at 40%, to see an effect thin out
 *   &ledges=0                                     no page elements
 *   &options={"rain":{"dropCount":300}}           constructor options, by effectName
 *
 * Nothing is registered anywhere: every class in effects/ that extends Effect is found by its
 * `effectName`, so a new effect is available here the moment its file exists.
 */

const params = new URLSearchParams(window.location.search);
const label = document.querySelector<HTMLElement>('#label')!;

const seed = params.get('seed');
if (seed !== null) {
    // mulberry32: small, fast, good enough to make two runs draw the same picture.
    let state = Number(seed) >>> 0;
    Math.random = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

if (params.get('ledges') === '0') {
    for (const shelf of document.querySelectorAll('.shelf')) {
        shelf.remove();
    }
}

type EffectClass = new (options?: Record<string, unknown>) => AnyEffect;

/** effectName → class, for every Effect subclass exported from a file in effects/. */
async function findEffects(): Promise<Map<string, EffectClass>> {
    const found = new Map<string, EffectClass>();
    const files = import.meta.glob('../effects/*/*.ts');
    for (const [path, load] of Object.entries(files)) {
        let module: Record<string, unknown>;
        try {
            module = (await load()) as Record<string, unknown>;
        } catch (error) {
            // One file that does not compile must not take the page down for every other effect.
            console.info(`solo: skipped ${path}`, error);
            continue;
        }
        for (const value of Object.values(module)) {
            if (typeof value !== 'function' || !(value.prototype instanceof Effect)) {
                continue;
            }
            const effectClass = value as EffectClass;
            try {
                found.set(new effectClass().effectName, effectClass);
            } catch {
                // A class that cannot be built without arguments is not a library effect.
            }
        }
    }
    return found;
}

const available = await findEffects();
const requested = (params.get('effects') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
const unknown = requested.filter((name) => !available.has(name));

if (requested.length === 0 || unknown.length > 0) {
    const names = Array.from(available.keys()).sort();
    label.innerHTML =
        (unknown.length > 0 ? `Unknown: ${unknown.join(', ')}. ` : 'Add ?effects=name,name to the address. ') +
        'Available: ' +
        names.map((name) => `<a href="?effects=${name}">${name}</a>`).join(', ');
    throw new Error(`solo: ${unknown.length > 0 ? `unknown effects ${unknown.join(', ')}` : 'no effects requested'}`);
}

const options = JSON.parse(params.get('options') ?? '{}') as Record<string, Record<string, unknown>>;
const still = params.get('still');
const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;

const manager = await VisualsManager.create(canvas, {
    motion: still === null,
    // A software renderer delivers a few frames a second; without this the governor would empty the scene.
    governor: params.get('governor') === 'off' ? { lowFps: 0, emergencyFps: 0 } : undefined,
});
const budget = params.get('budget');
if (budget !== null) {
    // Still mode never samples the frame rate, so a budget set here stays as it is.
    manager.governor.budget = Math.min(1, Math.max(0, Number(budget) || 0));
}
for (const name of requested) {
    manager.addEffect(new (available.get(name)!)(options[name]));
}
attachPageRipples(manager);
label.textContent = requested.join(' + ');

export interface SoloInput {
    /** Pointer position in stage pixels. Stays until changed. */
    mouse?: { x: number; y: number } | null;
    /** A press (and release) at the pointer position on the first tick of this step. */
    press?: boolean;
    /** Hold the button for the whole step. */
    hold?: boolean;
    /** Keys held for the whole step, lower-case names: 'space', 'arrowleft', 'e'. */
    keys?: string[];
    /** Keys that count as just pressed on the first tick. */
    tap?: string[];
    wheel?: number;
    /** Events to deliver on the first tick, as if an effect had emitted them: `{ type: 'meteor:impact', payload: { x, y, power } }`. */
    emit?: { type: string; payload: unknown }[];
    /** Switch effects on or off before this step, by effectName: `{ rain: false }`. */
    enabled?: Record<string, boolean>;
}

let pointer: { x: number; y: number } | undefined;

/**
 * Still mode only: advance the simulation by `ticks` with scripted input, then draw one frame.
 * Input edges (press, tap, wheel) reach the first tick only, as they do in the engine.
 */
function step(ticks: number, input: SoloInput = {}): void {
    if (input.mouse !== undefined) {
        pointer = input.mouse ?? undefined;
    }
    for (const [name, on] of Object.entries(input.enabled ?? {})) {
        manager.setEffectEnabled(name, on);
    }
    manager.prewarm(0); // measures the stage and the page elements
    for (const event of input.emit ?? []) {
        // Queued now, delivered to every effect during the first tick below.
        manager.simulation.tickContext.emit(event.type, event.payload as never);
    }
    for (let i = 0; i < ticks; i++) {
        const first = i === 0;
        const tickInput: TickInput = {
            canvasDimensions: { x: manager.stage.width, y: manager.stage.height },
            mousePosition: pointer ? { x: pointer.x, y: pointer.y } : undefined,
            mouseDown: input.hold === true || (first && input.press === true),
            mouseOnInteractive: false,
            keysPressed: input.keys ?? [],
            justPressedKeys: first ? [...(input.tap ?? [])] : [],
            justReleasedKeys: [],
            mouseJustPressed: first && (input.press === true || input.hold === true),
            mouseJustReleased: false,
            wheelDelta: first ? (input.wheel ?? 0) : 0,
            scrollY: 0,
        };
        manager.simulation.tickCycle(tickInput);
    }
    manager.renderOnce();
}

if (still !== null) {
    step(Math.max(0, Number(still) || 0));
} else {
    manager.run();
}

const solo = { manager, step, effects: requested };
Object.assign(window, { solo, visuals: manager });
document.documentElement.dataset.soloReady = 'true';
