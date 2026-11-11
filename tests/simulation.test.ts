import { describe, expect, test } from 'bun:test';
import { Effect } from '../src/Effect';
import { ForceField } from '../src/ForceField';
import { ParticleSet, PopulationGovernor } from '../src/Governor';
import { Particle } from '../src/Particle';
import { Simulation, type TickInput } from '../src/Simulation';
import type { Stage } from '../src/Stage';
import type { BudgetState, EffectContext, Theme, TickContext } from '../src/types';

// The simulation never touches a renderer, so a bare object stands in for the stage.
const stage = {} as Stage;
const theme = {} as Theme;

function input(overrides: Partial<TickInput> = {}): TickInput {
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
        ...overrides,
    };
}

function simulation(budget: BudgetState = { budget: 1, averageFps: 60, emergency: false }): Simulation {
    return new Simulation(stage, theme, budget);
}

class Probe extends Effect<{ value: number }> {
    public value = 0;
    public seen: unknown[] = [];
    constructor(
        public effectName: string,
        private readonly body: (self: Probe, tick: TickContext) => void = () => {},
    ) {
        super();
    }
    initialize(): void {}
    onTick(tick: TickContext): EffectContext<{ value: number }> {
        this.body(this, tick);
        return this.publish({ value: this.value });
    }
    onRender(): void {}
    cleanup(): void {}
}

class Dot extends Particle {}

describe('context exchange', () => {
    test('a later effect reads what an earlier effect returned this tick', () => {
        const sim = simulation();
        const first = new Probe('first', (self) => {
            self.value += 1;
        });
        const second = new Probe('second', (self, tick) => {
            self.seen.push(tick.previousEffectsContext?.get('first')?.effectContext.value);
        });
        sim.addEffect(first);
        sim.addEffect(second);
        sim.tickCycle(input());
        sim.tickCycle(input());
        expect(second.seen).toEqual([1, 2]);
    });

    test('an earlier effect sees a later effect through the previous tick', () => {
        const sim = simulation();
        const first = new Probe('first', (self, tick) => {
            self.seen.push({
                current: tick.previousEffectsContext?.get('second')?.effectContext.value,
                previous: tick.previousTickContext?.get('second')?.effectContext.value,
                read: (tick.read('second') as { value: number } | undefined)?.value,
            });
        });
        const second = new Probe('second', (self) => {
            self.value += 10;
        });
        sim.addEffect(first);
        sim.addEffect(second);
        sim.tickCycle(input());
        sim.tickCycle(input());
        sim.tickCycle(input());
        expect(first.seen).toEqual([
            { current: undefined, previous: undefined, read: undefined },
            { current: undefined, previous: 10, read: 10 },
            { current: undefined, previous: 20, read: 20 },
        ]);
    });

    test('a disabled effect is not ticked and its context expires', () => {
        const sim = simulation();
        const a = new Probe('a', (self) => {
            self.value += 1;
        });
        const b = new Probe('b', (self, tick) => {
            self.seen.push((tick.read('a') as { value: number } | undefined)?.value);
        });
        sim.addEffect(a);
        sim.addEffect(b);
        sim.tickCycle(input());
        sim.setEffectEnabled('a', false);
        sim.tickCycle(input());
        sim.tickCycle(input());
        expect(a.value).toBe(1);
        expect(b.seen).toEqual([1, 1, undefined]);
    });

    test('an effect that throws is switched off and the rest carry on', () => {
        const sim = simulation();
        const errors: string[] = [];
        sim.onEffectError = (name) => errors.push(name);
        const bad = new Probe('bad', () => {
            throw new Error('boom');
        });
        const good = new Probe('good', (self) => {
            self.value += 1;
        });
        sim.addEffect(bad);
        sim.addEffect(good);
        sim.tickCycle(input());
        sim.tickCycle(input());
        expect(errors).toEqual(['bad']);
        expect(good.value).toBe(2);
        expect(sim.isEnabled('bad')).toBe(false);
    });
});

describe('events', () => {
    test('are delivered to every effect on the next tick, whatever the order', () => {
        const sim = simulation();
        const early = new Probe('early', (self, tick) => {
            self.seen.push(tick.events('ping').map((event) => event.payload));
        });
        const emitter = new Probe('emitter', (self, tick) => {
            if (tick.totalTickCount === 0) {
                tick.emit('ping', 'hello');
            }
        });
        const late = new Probe('late', (self, tick) => {
            self.seen.push(tick.events('ping').map((event) => event.payload));
        });
        sim.addEffect(early);
        sim.addEffect(emitter);
        sim.addEffect(late);
        sim.tickCycle(input());
        sim.tickCycle(input());
        sim.tickCycle(input());
        expect(early.seen).toEqual([[], ['hello'], []]);
        expect(late.seen).toEqual([[], ['hello'], []]);
    });

    test('reach the page after the tick that emitted them, and stop when asked', () => {
        const sim = simulation();
        const heard: string[] = [];
        let ticksWhenHeard = -1;
        sim.addEffect(
            new Probe('speaker', (_self, tick) => {
                tick.emit('note', `tick ${tick.totalTickCount}`);
            }),
        );
        const stop = sim.on('note', (event) => {
            heard.push(event.payload as string);
            ticksWhenHeard = sim.tickContext.totalTickCount ?? -1;
        });
        sim.tickCycle(input());
        // Heard once the tick's effects have all run, before the tick counter moves on.
        expect(heard).toEqual(['tick 0']);
        expect(ticksWhenHeard).toBe(0);
        sim.tickCycle(input());
        stop();
        sim.tickCycle(input());
        expect(heard).toEqual(['tick 0', 'tick 1']);
    });

    test('a listener that throws does not stop the simulation', () => {
        const sim = simulation();
        const errors: string[] = [];
        sim.onEffectError = (name, phase) => errors.push(`${name}:${phase}`);
        const speaker = new Probe('speaker', (self, tick) => {
            self.value += 1;
            tick.emit('note', 1);
        });
        sim.addEffect(speaker);
        sim.on('note', () => {
            throw new Error('page code broke');
        });
        sim.tickCycle(input());
        sim.tickCycle(input());
        expect(speaker.value).toBe(2);
        expect(errors).toEqual(['speaker:tick', 'speaker:tick']);
    });

    test('record who emitted them', () => {
        const sim = simulation();
        const sources: string[] = [];
        sim.addEffect(new Probe('speaker', (_self, tick) => tick.emit('note', 1)));
        sim.addEffect(
            new Probe('listener', (_self, tick) => {
                for (const event of tick.events('note')) {
                    sources.push(event.source);
                }
            }),
        );
        sim.tickCycle(input());
        sim.tickCycle(input());
        expect(sources).toEqual(['speaker']);
    });
});

describe('time', () => {
    test('a tick advances a fixed number of milliseconds scaled by the time scale', () => {
        const sim = simulation();
        const deltas: number[] = [];
        sim.addEffect(new Probe('clock', (_self, tick) => deltas.push(tick.timeDelta)));
        sim.tickCycle(input());
        sim.setTimeScale(2);
        sim.tickCycle(input());
        sim.setTimeScale(99);
        expect(sim.getTimeScale()).toBe(3);
        expect(deltas[0]).toBeCloseTo(1000 / 60);
        expect(deltas[1]).toBeCloseTo(2000 / 60);
        expect(sim.tickContext.time).toBeCloseTo(3000 / 60);
        expect(sim.tickContext.totalTickCount).toBe(2);
    });
});

describe('particle motion', () => {
    test('keeps the original units: pixels and milliseconds', () => {
        const sim = simulation();
        const dot = new Dot({ position: { x: 0, y: 0 }, velocity: { x: 1, y: 0 }, acceleration: { x: 0.01, y: 0.02 } });
        const tick = { ...sim.tickContext, timeDelta: 16 } as TickContext;
        dot.updateMotion(tick);
        expect(dot.velocity.x).toBeCloseTo(1.16);
        expect(dot.velocity.y).toBeCloseTo(0.32);
        expect(dot.position.x).toBeCloseTo(18.56);
        expect(dot.position.y).toBeCloseTo(5.12);
    });

    test('caps speed and reports it', () => {
        const hits: string[] = [];
        class Capped extends Particle {
            onSpeedLimitExceeded(event: { axis: 'x' | 'y'; direction: 'negative' | 'positive' }): void {
                hits.push(`${event.axis}:${event.direction}`);
            }
        }
        const dot = new Capped({
            position: { x: 0, y: 0 },
            velocity: { x: 0, y: 0 },
            acceleration: { x: -1, y: 1 },
            maxAbsoluteVelocity: { x: 0.3, y: 0.3 },
        });
        dot.updateVelocity({ timeDelta: 16 } as TickContext);
        expect(dot.velocity).toEqual({ x: -0.3, y: 0.3 });
        expect(hits).toEqual(['x:negative', 'y:positive']);
    });
});

describe('force field', () => {
    test('forces act from the tick after they are added', () => {
        const field = new ForceField();
        const out = { x: 0, y: 0 };
        field.add({ kind: 'attract', owner: 'a', x: 100, y: 0, radius: 200, strength: 0.01 });
        expect(field.sample(0, 0, out).x).toBe(0);
        field.step(16);
        expect(field.sample(0, 0, out).x).toBeGreaterThan(0);
        expect(out.y).toBeCloseTo(0);
        // Not re-added: gone again.
        field.step(16);
        expect(field.sample(0, 0, out).x).toBe(0);
    });

    test('an effect can ignore its own forces', () => {
        const field = new ForceField();
        const out = { x: 0, y: 0 };
        field.add({ kind: 'repel', owner: 'me', x: 10, y: 0, radius: 100, strength: 0.01 });
        field.step(16);
        expect(field.sample(0, 0, out).x).toBeLessThan(0);
        expect(field.sample(0, 0, out, 'me').x).toBe(0);
    });

    test('a shock ring expands, pushes outward at its radius, and retires', () => {
        const field = new ForceField();
        const out = { x: 0, y: 0 };
        field.shock('click', { x: 0, y: 0, speed: 1, maxRadius: 100, width: 20, strength: 0.01 });
        field.step(50);
        expect(field.shocks[0].radius).toBe(50);
        expect(field.sample(50, 0, out).x).toBeGreaterThan(0);
        expect(field.sample(5, 0, out).x).toBe(0);
        field.step(60);
        expect(field.shocks.length).toBe(0);
    });
});

describe('governor', () => {
    test('measures real frames, shrinks quickly and recovers slowly', () => {
        const governor = new PopulationGovernor();
        for (let i = 0; i < 60; i++) {
            governor.sample(16.7);
        }
        expect(governor.budget).toBe(1);
        expect(governor.averageFps).toBeGreaterThan(55);

        for (let i = 0; i < 40; i++) {
            governor.sample(50); // 20 fps
        }
        const shrunk = governor.budget;
        expect(shrunk).toBeLessThan(0.8);
        expect(governor.emergency).toBe(false);

        for (let i = 0; i < 120; i++) {
            governor.sample(16.7); // two seconds of headroom: not enough to grow back yet
        }
        expect(governor.budget).toBeCloseTo(shrunk);
        for (let i = 0; i < 300; i++) {
            governor.sample(16.7);
        }
        expect(governor.budget).toBeGreaterThan(shrunk);
    });

    test('calls an emergency below 12.5 frames per second, and ignores hidden-tab gaps', () => {
        const governor = new PopulationGovernor();
        for (let i = 0; i < 30; i++) {
            governor.sample(100); // 10 fps
        }
        expect(governor.emergency).toBe(true);

        const calm = new PopulationGovernor();
        calm.sample(16.7);
        calm.sample(30000);
        calm.sample(16.7);
        expect(calm.budget).toBe(1);
    });

    test('asks the least important particles in the most crowded cell to leave first, with an exit', () => {
        const budget = { budget: 1, averageFps: 60, emergency: false };
        const sim = simulation(budget);
        const removed: Dot[] = [];
        const set = new ParticleSet<Dot>({
            capacity: 6,
            exitDuration: 100,
            maxExitsPerTick: 10,
            maxBirthsPerTick: 10,
            onRemove: (p) => removed.push(p),
        });
        const tick = { ...sim.tickContext, timeDelta: 50, canvasDimensions: { x: 800, y: 600 }, budget } as TickContext;
        set.govern(tick);

        const crowdedLow = [0, 1, 2].map(() => set.add(new Dot({ position: { x: 10, y: 10 }, priority: 2 })));
        const loneLow = set.add(new Dot({ position: { x: 700, y: 500 }, priority: 2 }));
        const important = [0, 1].map(() => set.add(new Dot({ position: { x: 10, y: 10 }, priority: 9 })));
        expect(set.canSpawn()).toBe(false);

        budget.budget = 0.5; // allowance drops from 6 to 3
        set.govern(tick);
        expect(crowdedLow.every((p) => p.life === 'exiting')).toBe(true);
        expect(loneLow.life).toBe('alive');
        expect(important.every((p) => p.life === 'alive')).toBe(true);

        // Nothing disappears at once: the exit plays out over its duration.
        set.sweep(tick);
        expect(removed.length).toBe(0);
        expect(crowdedLow[0].exitProgress).toBeCloseTo(0.5);
        set.sweep(tick);
        expect(removed.length).toBe(3);
        expect(set.items.length).toBe(3);
    });

    test('removes immediately only in an emergency', () => {
        const budget = { budget: 1, averageFps: 60, emergency: false };
        const sim = simulation(budget);
        const set = new ParticleSet<Dot>({ capacity: 4, maxBirthsPerTick: 10 });
        const tick = { ...sim.tickContext, timeDelta: 16, canvasDimensions: { x: 800, y: 600 }, budget } as TickContext;
        set.govern(tick);
        for (let i = 0; i < 4; i++) {
            set.add(new Dot({ position: { x: i * 100, y: 0 }, priority: 5 }));
        }
        budget.budget = 0.5;
        budget.emergency = true;
        set.govern(tick);
        set.sweep(tick);
        expect(set.items.length).toBe(2);
    });
});
