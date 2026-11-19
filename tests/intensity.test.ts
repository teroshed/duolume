import { describe, expect, test } from 'bun:test';
import { Effect } from '../src/Effect';
import { ParticleSet } from '../src/Governor';
import { Particle } from '../src/Particle';
import { Simulation, type TickInput } from '../src/Simulation';
import type { Stage } from '../src/Stage';
import type { BudgetState, EffectContext, Theme, TickContext } from '../src/types';

const stage = {} as Stage;
const theme = {} as Theme;

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

function simulation(budget: BudgetState = { budget: 1, averageFps: 60, emergency: false }): Simulation {
    return new Simulation(stage, theme, budget);
}

/** Remembers the intensity it saw on every tick. */
class Probe extends Effect {
    public seen: number[] = [];
    constructor(public effectName: string) {
        super();
    }
    initialize(): void {}
    onTick(tick: TickContext): EffectContext {
        this.seen.push(tick.intensity);
        return this.publish({});
    }
    onRender(): void {}
    cleanup(): void {}
}

class Dot extends Particle {}

/** A plain particle effect: fills its set as fast as the set allows, nothing else. */
class Dots extends Effect {
    public effectName = 'dots';
    public readonly set = new ParticleSet<Dot>({ capacity: 100, maxBirthsPerTick: 100, maxExitsPerTick: 100, exitDuration: 50 });
    initialize(): void {}
    onTick(tick: TickContext): EffectContext {
        this.set.govern(tick);
        while (this.set.canSpawn()) {
            this.set.add(new Dot({ position: { x: Math.random() * 800, y: Math.random() * 600 }, priority: 5 }));
        }
        this.set.sweep(tick);
        return this.publish({});
    }
    onRender(): void {}
    cleanup(): void {}
}

function setup(): { sim: Simulation; rain: Probe; meadow: Probe } {
    const sim = simulation();
    const rain = new Probe('rain');
    const meadow = new Probe('meadow');
    sim.addEffect(rain);
    sim.addEffect(meadow);
    return { sim, rain, meadow };
}

describe('intensity', () => {
    test('is 1 by default, for every effect and for the scene', () => {
        const { sim, rain, meadow } = setup();
        sim.tickCycle(input());
        expect(rain.seen).toEqual([1]);
        expect(meadow.seen).toEqual([1]);
        expect(sim.getIntensity()).toBe(1);
        expect(sim.getIntensity('rain')).toBe(1);
    });

    test('one effect: tick.intensity is that effect\'s own, the others keep theirs', () => {
        const { sim, rain, meadow } = setup();
        sim.setIntensity('rain', 0.4);
        sim.tickCycle(input());
        expect(rain.seen).toEqual([0.4]);
        expect(meadow.seen).toEqual([1]);
        expect(sim.getIntensity('rain')).toBe(0.4);
    });

    test('several at once, as a plain object', () => {
        const { sim, rain, meadow } = setup();
        sim.setIntensity({ rain: 0.5, meadow: 0.25 });
        sim.tickCycle(input());
        expect(rain.seen).toEqual([0.5]);
        expect(meadow.seen).toEqual([0.25]);
    });

    test('the scene number is multiplied into each effect\'s own', () => {
        const { sim, rain, meadow } = setup();
        sim.setIntensity({ rain: 0.5 });
        sim.setIntensity(0.6);
        sim.tickCycle(input());
        expect(rain.seen[0]).toBeCloseTo(0.3);
        expect(meadow.seen[0]).toBeCloseTo(0.6);
        // Reading back gives what was set, not the product.
        expect(sim.getIntensity()).toBe(0.6);
        expect(sim.getIntensity('rain')).toBe(0.5);
        expect(sim.intensityOf('rain')).toBeCloseTo(0.3);
    });

    test('values are clamped to 0..1; non-numbers and unknown names are ignored', () => {
        const { sim } = setup();
        sim.setIntensity('rain', 7);
        expect(sim.getIntensity('rain')).toBe(1);
        sim.setIntensity('rain', -2);
        expect(sim.getIntensity('rain')).toBe(0);
        sim.setIntensity('rain', 0.5);
        sim.setIntensity('rain', NaN);
        expect(sim.getIntensity('rain')).toBe(0.5);
        sim.setIntensity(3);
        expect(sim.getIntensity()).toBe(1);
        sim.setIntensity(-1);
        expect(sim.getIntensity()).toBe(0);
        sim.setIntensity({ nobody: 0.5 });
        expect(sim.getIntensity('nobody')).toBe(1);
    });

    test('zero switches an effect off, as the switch does; raising it switches it back on', () => {
        const { sim, rain, meadow } = setup();
        sim.setIntensity('rain', 0);
        sim.tickCycle(input());
        expect(rain.seen).toEqual([]);
        expect(meadow.seen).toEqual([1]);
        expect(sim.isEnabled('rain')).toBe(false);
        expect(sim.getEffectEnabledState().rain).toBe(false);

        sim.setIntensity('rain', 0.3);
        sim.tickCycle(input());
        expect(rain.seen).toEqual([0.3]);
        expect(sim.isEnabled('rain')).toBe(true);
    });

    test('a scene intensity of zero switches everything off', () => {
        const { sim, rain, meadow } = setup();
        sim.setIntensity(0);
        sim.tickCycle(input());
        expect(rain.seen.length + meadow.seen.length).toBe(0);
        sim.setIntensity(1);
        sim.tickCycle(input());
        expect(rain.seen).toEqual([1]);
    });

    test('raising the intensity does not undo the switch', () => {
        const { sim, rain } = setup();
        sim.setEffectEnabled('rain', false);
        sim.setIntensity('rain', 1);
        sim.tickCycle(input());
        expect(rain.seen).toEqual([]);
        expect(sim.isEnabled('rain')).toBe(false);
    });

    test('a removed effect forgets its intensity', () => {
        const { sim } = setup();
        sim.setIntensity('rain', 0.2);
        sim.removeEffect('rain');
        sim.addEffect(new Probe('rain'));
        expect(sim.getIntensity('rain')).toBe(1);
    });
});

describe('ParticleSet and intensity', () => {
    test('allows capacity × budget × intensity, and the surplus leaves with its exit', () => {
        const budget = { budget: 1, averageFps: 60, emergency: false };
        const sim = simulation(budget);
        const dots = new Dots();
        sim.addEffect(dots);

        sim.setIntensity('dots', 0.4);
        sim.tickCycle(input());
        expect(dots.set.allowed).toBe(40);
        expect(dots.set.alive).toBe(40);

        budget.budget = 0.5;
        sim.tickCycle(input());
        expect(dots.set.allowed).toBe(20);
        // The twenty over the allowance are leaving, not gone.
        expect(dots.set.alive).toBe(20);
        expect(dots.set.items.length).toBe(40);
        expect(dots.set.items.filter((p) => p.life === 'exiting').length).toBe(20);
        for (let i = 0; i < 10; i++) {
            sim.tickCycle(input());
        }
        expect(dots.set.items.length).toBe(20);

        budget.budget = 1;
        sim.setIntensity('dots', 1);
        sim.tickCycle(input());
        expect(dots.set.alive).toBe(100);
    });
});
