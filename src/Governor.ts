import type { Particle } from './Particle';
import type { BudgetState, TickContext } from './types';

export interface GovernorOptions {
    /** Below this average the budget shrinks. */
    lowFps?: number;
    /** Above this average, held for `recoverAfterMs`, the budget grows back. */
    highFps?: number;
    /** Below this average, immediate removal is allowed. */
    emergencyFps?: number;
    minBudget?: number;
    initialBudget?: number;
    windowMs?: number;
    recoverAfterMs?: number;
}

/**
 * Measures delivered frames over elapsed real time and turns that into a population budget.
 *
 * It never derives FPS from simulation time: a slow frame is clamped for the simulation,
 * and reading the clamped value would hide the stall this exists to detect.
 * Shrinking is quick, recovery is slow and only after sustained headroom.
 */
export class PopulationGovernor implements BudgetState {
    public budget: number;
    public averageFps = 60;
    public emergency = false;

    private readonly lowFps: number;
    private readonly highFps: number;
    private readonly emergencyFps: number;
    private readonly minBudget: number;
    private readonly windowMs: number;
    private readonly recoverAfterMs: number;

    private frames = 0;
    private elapsed = 0;
    private headroomMs = 0;
    private observedMs = 0;

    public constructor(options: GovernorOptions = {}) {
        this.lowFps = options.lowFps ?? 44;
        this.highFps = options.highFps ?? 55;
        this.emergencyFps = options.emergencyFps ?? 12.5;
        this.minBudget = options.minBudget ?? 0.2;
        this.budget = options.initialBudget ?? 1;
        this.windowMs = options.windowMs ?? 500;
        this.recoverAfterMs = options.recoverAfterMs ?? 3000;
    }

    /** Call once per rendered frame with the real milliseconds since the previous one. */
    public sample(realDeltaMs: number): void {
        // A gap this long is a hidden tab or a debugger pause, not a slow frame.
        if (realDeltaMs > 1000 || realDeltaMs <= 0) {
            this.frames = 0;
            this.elapsed = 0;
            return;
        }
        this.frames += 1;
        this.elapsed += realDeltaMs;
        if (this.elapsed < this.windowMs) {
            return;
        }
        const fps = (this.frames * 1000) / this.elapsed;
        this.observedMs += this.elapsed;
        this.averageFps = this.observedMs <= this.elapsed ? fps : this.averageFps * 0.6 + fps * 0.4;
        this.frames = 0;
        const windowElapsed = this.elapsed;
        this.elapsed = 0;

        // Needs a minimum observation period before it may call an emergency.
        this.emergency = this.observedMs >= 1500 && this.averageFps < this.emergencyFps;

        // Shrink only while it is still slow: the average lags, and one recovered window is enough to stop.
        if (this.averageFps < this.lowFps && fps < this.lowFps) {
            const shortfall = (this.lowFps - this.averageFps) / this.lowFps;
            this.budget = Math.max(this.minBudget, this.budget - (0.04 + shortfall * 0.2));
            this.headroomMs = 0;
        } else if (this.averageFps > this.highFps) {
            this.headroomMs += windowElapsed;
            if (this.headroomMs >= this.recoverAfterMs && this.budget < 1) {
                this.budget = Math.min(1, this.budget + 0.03);
            }
        } else {
            this.headroomMs = 0;
        }
    }
}

export interface ParticleSetOptions<P extends Particle> {
    /** Population at full budget. */
    capacity: number;
    /** Length of the exit animation in milliseconds. */
    exitDuration?: number;
    /** At most this many may start leaving per tick, so culling never adds load. */
    maxExitsPerTick?: number;
    /** At most this many may be born per tick: refills arrive as entrances, not jumps. */
    maxBirthsPerTick?: number;
    /** Release the particle's view. Called exactly once per particle. */
    onRemove?: (particle: P) => void;
}

const GRID_COLS = 8;
const GRID_ROWS = 6;

/**
 * A population of particles under the governor.
 *
 * When the set is over its allowance it asks the least important particles to leave,
 * starting from the most crowded part of the stage. They play their exit; only below
 * the emergency threshold are they removed outright.
 */
export class ParticleSet<P extends Particle> {
    public readonly items: P[] = [];
    public capacity: number;
    public readonly exitDuration: number;
    private readonly maxExitsPerTick: number;
    private readonly maxBirthsPerTick: number;
    private readonly onRemove?: (particle: P) => void;
    private birthsThisTick = 0;
    private aliveCount = 0;
    private allowedCount = 0;
    private readonly cells = new Uint16Array(GRID_COLS * GRID_ROWS);

    public constructor(options: ParticleSetOptions<P>) {
        this.capacity = options.capacity;
        this.exitDuration = options.exitDuration ?? 420;
        this.maxExitsPerTick = options.maxExitsPerTick ?? 12;
        this.maxBirthsPerTick = options.maxBirthsPerTick ?? 10;
        this.onRemove = options.onRemove;
    }

    /** Particles that have not started leaving. */
    public get alive(): number {
        return this.aliveCount;
    }

    public get allowed(): number {
        return this.allowedCount;
    }

    /**
     * Start of tick: work out the allowance and ask for exits if over it.
     * Call before spawning.
     */
    public govern(tickContext: TickContext): void {
        this.birthsThisTick = 0;
        this.allowedCount = Math.floor(this.capacity * tickContext.budget.budget);
        let alive = 0;
        for (let i = 0; i < this.items.length; i++) {
            if (this.items[i].life === 'alive') {
                alive++;
            }
        }
        this.aliveCount = alive;
        const excess = alive - this.allowedCount;
        if (excess <= 0) {
            return;
        }
        if (tickContext.budget.emergency) {
            this.shed(excess, tickContext, true);
        } else {
            this.shed(Math.min(excess, this.maxExitsPerTick), tickContext, false);
        }
    }

    /** True while there is room and birth budget left this tick. */
    public canSpawn(): boolean {
        return this.aliveCount < this.allowedCount && this.birthsThisTick < this.maxBirthsPerTick;
    }

    public add(particle: P): P {
        this.items.push(particle);
        this.aliveCount++;
        this.birthsThisTick++;
        return particle;
    }

    /**
     * End of tick: advance exits and release what is gone.
     * Particles flagged `removeRequested` by the effect are released here too.
     */
    public sweep(tickContext: TickContext): void {
        const items = this.items;
        let write = 0;
        for (let read = 0; read < items.length; read++) {
            const p = items[read];
            if (p.life === 'exiting') {
                p.advanceExit(tickContext.timeDelta, this.exitDuration);
            }
            if (p.life === 'removed' || p.removeRequested) {
                p.life = 'removed';
                this.onRemove?.(p);
                p.cleanup();
                continue;
            }
            items[write++] = p;
        }
        items.length = write;
    }

    /** Release everything. For effect cleanup. */
    public clear(): void {
        for (const p of this.items) {
            this.onRemove?.(p);
            p.cleanup();
        }
        this.items.length = 0;
        this.aliveCount = 0;
    }

    private shed(count: number, tickContext: TickContext, immediate: boolean): void {
        const items = this.items;
        const width = tickContext.canvasDimensions?.x || 1;
        const height = tickContext.canvasDimensions?.y || 1;
        const cells = this.cells;
        cells.fill(0);

        let lowest = 11;
        for (let i = 0; i < items.length; i++) {
            const p = items[i];
            if (p.life !== 'alive') {
                continue;
            }
            cells[cellOf(p, width, height)]++;
            if (p.priority < lowest) {
                lowest = p.priority;
            }
        }

        let remaining = count;
        // Walk up the priority tiers until enough have been asked to leave.
        for (let tier = lowest; tier <= 10 && remaining > 0; tier++) {
            while (remaining > 0) {
                let best = -1;
                let bestCrowd = -1;
                for (let i = 0; i < items.length; i++) {
                    const p = items[i];
                    if (p.life !== 'alive' || p.priority !== tier) {
                        continue;
                    }
                    const crowd = cells[cellOf(p, width, height)];
                    if (crowd > bestCrowd) {
                        bestCrowd = crowd;
                        best = i;
                    }
                }
                if (best < 0) {
                    break;
                }
                const p = items[best];
                cells[cellOf(p, width, height)]--;
                if (immediate) {
                    p.removeNow();
                } else {
                    p.requestExit();
                }
                this.aliveCount--;
                remaining--;
            }
        }
    }
}

function cellOf(p: Particle, width: number, height: number): number {
    let cx = Math.floor((p.position.x / width) * GRID_COLS);
    let cy = Math.floor((p.position.y / height) * GRID_ROWS);
    cx = cx < 0 ? 0 : cx >= GRID_COLS ? GRID_COLS - 1 : cx;
    cy = cy < 0 ? 0 : cy >= GRID_ROWS ? GRID_ROWS - 1 : cy;
    return cy * GRID_COLS + cx;
}
