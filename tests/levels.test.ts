import { describe, expect, test } from 'bun:test';
import { Effect } from '../src/Effect';
import { LEVEL_HOLD_MS, LEVEL_MARGIN, nextStep, readLevels, stepFor } from '../src/Levels';
import { Simulation, type TickInput } from '../src/Simulation';
import type { Stage } from '../src/Stage';
import type { EffectContext, Theme, TickContext } from '../src/types';

const stage = {} as Stage;
const theme = {} as Theme;

/** The same shape as MeadowLevel, kept here so the test needs no renderer. */
enum Look {
    Lines,
    Blades,
    Wind,
    Full,
}

function input(): TickInput {
    return {
        canvasDimensions: { x: 800, y: 600 },
        mousePosition: undefined,
        mouseDown: false,
        mouseOnInteractive: false,
        keysPressed: [],
        justPressedKeys: [],
        justReleasedKeys: [],
        mouseJustPressed: false,
        mouseJustReleased: false,
        wheelDelta: 0,
        scrollY: 0,
    };
}

/** Asks for its look every tick, the way an effect with levels does, and remembers each answer. */
class Grass extends Effect {
    public seen: Look[] = [];
    constructor(
        public effectName = 'grass',
        private readonly pinned?: Look,
    ) {
        super();
    }
    initialize(): void {}
    onTick(tick: TickContext): EffectContext {
        const level = tick.level(Look, this.pinned);
        // Typed as the enum: plain comparisons work.
        if (level >= Look.Wind) {
            this.windy++;
        }
        this.seen.push(level);
        return this.publish({});
    }
    public windy = 0;
    onRender(): void {}
    cleanup(): void {}
}

/** Has one look: never asks. */
class Plain extends Effect {
    public effectName = 'plain';
    initialize(): void {}
    onTick(): EffectContext {
        return this.publish({});
    }
    onRender(): void {}
    cleanup(): void {}
}

const HOLD_TICKS = Math.ceil(LEVEL_HOLD_MS / Simulation.TICK_MS);

function setup(pinned?: Look) {
    const budget = { budget: 1, averageFps: 60, emergency: false };
    const sim = new Simulation(stage, theme, budget);
    const grass = new Grass('grass', pinned);
    sim.addEffect(grass);
    const run = (ticks: number): Look => {
        for (let i = 0; i < ticks; i++) {
            sim.tickCycle(input());
        }
        return grass.seen[grass.seen.length - 1];
    };
    return { sim, budget, grass, run };
}

/** Indices in `seen` where the look changed. */
function changes(seen: Look[]): number[] {
    const at: number[] = [];
    for (let i = 1; i < seen.length; i++) {
        if (seen[i] !== seen[i - 1]) {
            at.push(i);
        }
    }
    return at;
}

describe('richness to a step', () => {
    test('richness 1 is the richest step; the range is cut into equal steps', () => {
        expect(stepFor(1, 4)).toBe(3);
        expect(stepFor(0.75, 4)).toBe(3);
        expect(stepFor(0.74, 4)).toBe(2);
        expect(stepFor(0.5, 4)).toBe(2);
        expect(stepFor(0.3, 4)).toBe(1);
        expect(stepFor(0.2, 4)).toBe(0);
        expect(stepFor(0, 4)).toBe(0);
        expect(stepFor(5, 4)).toBe(3);
        expect(stepFor(-1, 4)).toBe(0);
        expect(stepFor(0.4, 1)).toBe(0);
    });

    test('moves one step at a time, down at once, up only past the margin', () => {
        expect(nextStep(3, 0.1, 4)).toBe(2);
        expect(nextStep(3, 0.7, 4)).toBe(2);
        expect(nextStep(1, 1, 4)).toBe(2);
        // Blades → Wind starts at 0.5; it takes 0.5 + margin to step up.
        expect(nextStep(1, 0.5, 4)).toBe(1);
        expect(nextStep(1, 0.5 + LEVEL_MARGIN - 0.01, 4)).toBe(1);
        expect(nextStep(1, 0.5 + LEVEL_MARGIN + 0.01, 4)).toBe(2);
        // Full richness always reaches the top, however many steps there are.
        expect(nextStep(18, 1, 20)).toBe(19);
    });

    test('a numeric enum gives its names and values, cheapest first', () => {
        expect(readLevels(Look)).toEqual({ values: [0, 1, 2, 3], names: ['Lines', 'Blades', 'Wind', 'Full'] });
        enum Odd {
            High = 20,
            Low = 10,
        }
        expect(readLevels(Odd)).toEqual({ values: [10, 20], names: ['Low', 'High'] });
    });
});

describe('levels in the simulation', () => {
    test('full detail and a full budget give the richest look', () => {
        const { run } = setup();
        expect(run(1)).toBe(Look.Full);
    });

    test('a struggling machine steps down one look at a time, holding each', () => {
        const { budget, grass, run } = setup();
        run(HOLD_TICKS);
        budget.budget = 0.2;
        run(HOLD_TICKS * 4);
        expect(grass.seen[grass.seen.length - 1]).toBe(Look.Lines);
        const at = changes(grass.seen);
        expect(at.length).toBe(3);
        for (const i of at) {
            expect(Math.abs(grass.seen[i] - grass.seen[i - 1])).toBe(1);
        }
        for (let k = 1; k < at.length; k++) {
            expect((at[k] - at[k - 1]) * Simulation.TICK_MS).toBeGreaterThanOrEqual(LEVEL_HOLD_MS);
        }
    });

    test('holds a new look before moving again, even when richness asks at once', () => {
        const { budget, grass, run } = setup();
        run(HOLD_TICKS);
        budget.budget = 0.2;
        run(1);
        expect(grass.seen[grass.seen.length - 1]).toBe(Look.Wind);
        run(HOLD_TICKS - 2);
        expect(grass.seen[grass.seen.length - 1]).toBe(Look.Wind);
        run(2);
        expect(grass.seen[grass.seen.length - 1]).toBe(Look.Blades);
    });

    test('needs a clear margin to step back up', () => {
        const { budget, run } = setup();
        budget.budget = 0.2;
        run(HOLD_TICKS * 5);
        // 0.52 asks for Wind (2), but Blades → Wind needs 0.5 + margin.
        budget.budget = 0.52;
        expect(run(HOLD_TICKS * 5)).toBe(Look.Blades);
        budget.budget = 0.5 + LEVEL_MARGIN + 0.02;
        expect(run(HOLD_TICKS + 1)).toBe(Look.Wind);
        budget.budget = 1;
        expect(run(HOLD_TICKS + 1)).toBe(Look.Full);
    });

    test('the scene detail lowers the look on a fast machine', () => {
        const { sim, run } = setup();
        sim.setDetail(0.3);
        expect(sim.getDetail()).toBe(0.3);
        expect(run(HOLD_TICKS * 4)).toBe(Look.Blades);
        sim.setDetail(5);
        expect(sim.getDetail()).toBe(1);
    });

    test('an option pins the look, whatever the machine', () => {
        const { sim, budget, grass, run } = setup(Look.Lines);
        expect(run(1)).toBe(Look.Lines);
        budget.budget = 1;
        expect(run(HOLD_TICKS * 3)).toBe(Look.Lines);
        expect(grass.windy).toBe(0);
        expect(sim.getLevels().grass.pinned).toBe(true);
    });

    test('setLevel pins at once and wins over the option; undefined gives it back', () => {
        const { sim, run } = setup(Look.Lines);
        run(1);
        sim.setLevel('grass', Look.Wind);
        // Shown before the effect next asks.
        expect(sim.getLevels().grass.level).toBe(Look.Wind);
        expect(run(1)).toBe(Look.Wind);
        sim.setLevel('grass', undefined);
        expect(run(1)).toBe(Look.Lines);
    });

    test('unpinned, the machine starts from the pinned look and climbs one step per hold', () => {
        const { sim, grass, run } = setup();
        run(1);
        sim.setLevel('grass', Look.Lines);
        expect(run(1)).toBe(Look.Lines);
        expect(sim.getLevels().grass.pinned).toBe(true);
        sim.setLevel('grass', undefined);
        expect(run(HOLD_TICKS - 1)).toBe(Look.Lines);
        expect(sim.getLevels().grass.pinned).toBe(false);
        const before = grass.seen.length;
        run(HOLD_TICKS * 4);
        expect(grass.seen[grass.seen.length - 1]).toBe(Look.Full);
        expect(changes(grass.seen.slice(before - 1)).length).toBe(3);
    });

    test('getLevels has the names, the current look and the pin, for effects that asked', () => {
        const { sim, run } = setup();
        sim.addEffect(new Plain());
        run(1);
        const levels = sim.getLevels();
        expect(Object.keys(levels)).toEqual(['grass']);
        expect(levels.grass).toEqual({ level: Look.Full, name: 'Full', names: ['Lines', 'Blades', 'Wind', 'Full'], pinned: false });
    });

    test('an effect with one look ignores detail and setLevel, and never appears', () => {
        const { sim, run } = setup();
        sim.addEffect(new Plain());
        sim.setLevel('plain', 0);
        sim.setDetail(0);
        run(3);
        expect(sim.getLevels().plain).toBeUndefined();
        sim.setLevel('nobody', 1);
        expect(sim.getLevels().nobody).toBeUndefined();
    });

    test('a removed effect forgets its look and its pin', () => {
        const { sim, run } = setup();
        run(1);
        sim.setLevel('grass', Look.Lines);
        sim.removeEffect('grass');
        expect(sim.getLevels().grass).toBeUndefined();
        const again = new Grass();
        sim.addEffect(again);
        sim.tickCycle(input());
        expect(again.seen).toEqual([Look.Full]);
    });
});
