import { Container } from 'pixi.js';
import { Group } from 'three';
import { Compositor, type CompositorOptions } from './Compositor';
import type { AnyEffect } from './Effect';
import { PopulationGovernor, type GovernorOptions } from './Governor';
import { InputState } from './Input';
import { Simulation, type TickInput } from './Simulation';
import { Stage } from './Stage';
import type { EngineEvent, Theme, TimedContext } from './types';

export const DEFAULT_THEME: Theme = {
    bgTop: 0x0b1018,
    bgBottom: 0x06080d,
    glowA: 0x3fd0c9,
    glowB: 0x7c6cff,
    accent: 0x7fe7dc,
    accentAlt: 0xa99bff,
    ink: 0xeaf0f6,
};

export interface VisualsManagerOptions extends CompositorOptions {
    theme?: Partial<Theme>;
    governor?: GovernorOptions;
    /** Where to look for `[data-fx-anchor]` elements. Default: `document`. Pass false to skip. */
    anchors?: ParentNode | false;
    /** Start with the simulation frozen (for reduced motion). Frames are then drawn only on demand. */
    motion?: boolean;
}

interface EffectSlot {
    effect: AnyEffect;
    pixi: Container;
    pixiFront: Container;
    three: Group;
}

const MAX_CATCH_UP_TICKS = 4;
const NO_KEYS: string[] = [];

/**
 * Runs named effects through initialize / onTick / onRender / cleanup — the original
 * manager — on top of two renderers at once.
 *
 * Ticks are fixed-rate (60 per second) and advance the simulation by a constant number
 * of milliseconds, scaled by the time scale, so motion feels the same on any display.
 * Rendering happens once per animation frame and extrapolates between ticks.
 */
export class VisualsManager {
    public static readonly TICK_RATE = Simulation.TICK_RATE;

    public readonly stage: Stage;
    public readonly simulation: Simulation;
    public readonly governor: PopulationGovernor;
    public readonly compositor: Compositor;

    private readonly canvas: HTMLCanvasElement;
    private readonly input: InputState;
    private readonly slots = new Map<string, EffectSlot>();
    private readonly theme: Theme;
    private readonly timedContext: TimedContext;
    private readonly resizeObserver: ResizeObserver;
    private readonly tickInput: TickInput;

    private raf = 0;
    private lastTime = 0;
    private accumulator = 0;
    private isRendering = false;
    private motion: boolean;
    private invalidated = true;
    private sizeDirty = true;
    private lastScrollY = -1;
    private disposed = false;

    /** Called when an effect throws. That effect is switched off; the others keep running. */
    public onEffectError?: (effectName: string, phase: 'tick' | 'render' | 'cleanup', error: unknown) => void;

    public static async create(
        canvasElement: HTMLCanvasElement,
        options: VisualsManagerOptions = {},
    ): Promise<VisualsManager> {
        const stage = new Stage();
        const compositor = await Compositor.create(canvasElement, stage, options);
        return new VisualsManager(canvasElement, stage, compositor, options);
    }

    private constructor(
        canvasElement: HTMLCanvasElement,
        stage: Stage,
        compositor: Compositor,
        options: VisualsManagerOptions,
    ) {
        this.canvas = canvasElement;
        this.stage = stage;
        this.compositor = compositor;
        this.theme = { ...DEFAULT_THEME, ...options.theme };
        this.governor = new PopulationGovernor(options.governor);
        this.simulation = new Simulation(stage, this.theme, this.governor);
        this.simulation.onEffectError = (name, phase, error) => this.reportError(name, phase, error);
        this.input = new InputState(window);
        this.motion = options.motion ?? true;
        this.compositor.setTheme(this.theme);

        const anchors = options.anchors === undefined ? document : options.anchors;
        if (anchors) {
            stage.observeAll(anchors);
        }

        this.tickInput = {
            canvasDimensions: { x: 1, y: 1 },
            mousePosition: undefined,
            mouseDown: false,
            mouseOnInteractive: false,
            keysPressed: NO_KEYS,
            justPressedKeys: NO_KEYS,
            justReleasedKeys: NO_KEYS,
            mouseJustPressed: false,
            mouseJustReleased: false,
            wheelDelta: 0,
            scrollY: 0,
        };

        this.timedContext = {
            context: compositor.pixiBack,
            front: compositor.pixiFront,
            group: new Group(),
            timeDelta: 0,
            alpha: 0,
            tickDelta: Simulation.TICK_MS,
            time: 0,
            canvasDimensions: this.tickInput.canvasDimensions,
            mousePosition: undefined,
            mouseDown: false,
            keysPressed: NO_KEYS,
            speedMultiplier: 1,
            stage,
            theme: this.theme,
            budget: this.governor,
        };

        this.resizeObserver = new ResizeObserver(() => {
            this.sizeDirty = true;
            this.invalidated = true;
        });
        this.resizeObserver.observe(canvasElement);
        this.syncSize();
    }

    // ---- effects -------------------------------------------------------------------

    public addEffect(effect: AnyEffect): this {
        this.simulation.addEffect(effect);
        const slot: EffectSlot = {
            effect,
            pixi: new Container({ label: effect.effectName }),
            pixiFront: new Container({ label: `${effect.effectName}:front` }),
            three: new Group(),
        };
        slot.three.name = effect.effectName;
        this.compositor.pixiBack.addChild(slot.pixi);
        this.compositor.pixiFront.addChild(slot.pixiFront);
        this.compositor.scene.add(slot.three);
        this.slots.set(effect.effectName, slot);
        effect.attach({
            pixi: slot.pixi,
            pixiFront: slot.pixiFront,
            three: slot.three,
            stage: this.stage,
            surfaces: this.compositor.surfaces,
        });
        try {
            effect.initialize();
        } catch (error) {
            this.simulation.markFailed(effect.effectName);
            this.reportError(effect.effectName, 'tick', error);
        }
        this.invalidated = true;
        return this;
    }

    public removeEffect(effectName: string): void {
        const slot = this.slots.get(effectName);
        if (!slot) {
            return;
        }
        this.simulation.removeEffect(effectName);
        this.releaseSlot(slot);
        this.slots.delete(effectName);
        this.invalidated = true;
    }

    public getEffect<E extends AnyEffect>(effectName: string): E | undefined {
        return this.simulation.getEffect<E>(effectName);
    }

    public setEffectEnabled(effectName: string, enabled: boolean): void {
        this.simulation.setEffectEnabled(effectName, enabled);
        this.invalidated = true;
    }

    public toggleEffect(effectName: string): boolean {
        this.invalidated = true;
        return this.simulation.toggleEffect(effectName);
    }

    public getEffectEnabledState(): Record<string, boolean> {
        return this.simulation.getEffectEnabledState();
    }

    // ---- controls ------------------------------------------------------------------

    public setTimeScale(scale: number): void {
        this.simulation.setTimeScale(scale);
    }

    public getTimeScale(): number {
        return this.simulation.getTimeScale();
    }

    /** Update paint. Effects read the theme each frame, so nothing restarts. */
    public setTheme(theme: Partial<Theme>): void {
        Object.assign(this.theme, theme);
        this.compositor.setTheme(this.theme);
        this.invalidated = true;
    }

    public getTheme(): Readonly<Theme> {
        return this.theme;
    }

    /**
     * Hear an engine event from the page: `manager.on('page:hit', (event) => …)`.
     * Called after the tick that emitted it. Returns a function that stops listening.
     */
    public on<K extends string>(type: K, listener: (event: EngineEvent<K>) => void): () => void {
        return this.simulation.on(type, listener);
    }

    /** Scale flashes, shock ripples and glow for viewer comfort (1 = as authored, 0 = off). */
    public setComfort(comfort: Partial<{ flash: number; ripple: number; bloom: number }>): void {
        const target = this.compositor.comfort;
        for (const key of ['flash', 'ripple', 'bloom'] as const) {
            const value = comfort[key];
            if (value !== undefined && Number.isFinite(value)) {
                target[key] = Math.max(0, Math.min(2, value));
            }
        }
        this.invalidated = true;
    }

    public getComfort(): Readonly<{ flash: number; ripple: number; bloom: number }> {
        return this.compositor.comfort;
    }

    /**
     * Freeze or resume the simulation. While frozen the picture is exactly still and a
     * frame is drawn only when something changes (resize, scroll, theme).
     */
    public setMotionEnabled(enabled: boolean): void {
        this.motion = enabled;
        this.accumulator = 0;
        this.lastTime = 0;
        this.invalidated = true;
    }

    public getMotionEnabled(): boolean {
        return this.motion;
    }

    /** Run ticks without drawing, so a still frame shows a settled scene rather than an empty one. */
    public prewarm(ticks: number): void {
        this.syncSize();
        this.stage.measure(...this.canvasOrigin());
        for (let i = 0; i < ticks; i++) {
            this.simulation.tickCycle(this.buildTickInput(false));
        }
        this.invalidated = true;
    }

    // ---- loop ----------------------------------------------------------------------

    public run(): void {
        this.startRender();
    }

    public startRender(): void {
        if (this.isRendering || this.disposed) {
            return;
        }
        this.isRendering = true;
        this.lastTime = 0;
        this.raf = requestAnimationFrame(this.frame);
    }

    public stopRender(): void {
        this.isRendering = false;
        cancelAnimationFrame(this.raf);
    }

    /** Draw a single frame now, without advancing the simulation. */
    public renderOnce(): void {
        this.syncSize();
        this.stage.measure(...this.canvasOrigin());
        this.renderAll(0, 0);
    }

    public cleanup(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.stopRender();
        this.resizeObserver.disconnect();
        this.input.dispose();
        for (const slot of this.slots.values()) {
            this.releaseSlot(slot);
        }
        this.slots.clear();
        this.simulation.forces.clear();
        this.stage.clearAnchors();
        this.compositor.dispose();
    }

    public getDiagnostics(): {
        averageFps: number;
        budget: number;
        emergency: boolean;
        tickCount: number;
        effects: Record<string, boolean>;
        resolution: number;
        contextLost: boolean;
    } {
        return {
            averageFps: this.governor.averageFps,
            budget: this.governor.budget,
            emergency: this.governor.emergency,
            tickCount: this.simulation.tickContext.totalTickCount ?? 0,
            effects: this.getEffectEnabledState(),
            resolution: this.compositor.resolution,
            contextLost: this.compositor.lost,
        };
    }

    private readonly frame = (now: number): void => {
        if (!this.isRendering) {
            return;
        }
        this.raf = requestAnimationFrame(this.frame);

        const realDelta = this.lastTime === 0 ? Simulation.TICK_MS : now - this.lastTime;
        this.lastTime = now;

        this.syncSize();
        const [originX, originY] = this.canvasOrigin();
        this.input.setOrigin(originX, originY);

        if (this.input.scrollY !== this.lastScrollY) {
            this.lastScrollY = this.input.scrollY;
            this.invalidated = true;
        }

        if (!this.motion) {
            // Still mode: nothing advances, and nothing is redrawn unless it has to be.
            if (this.invalidated) {
                this.stage.measure(originX, originY);
                this.renderAll(0, 0);
            }
            return;
        }

        this.governor.sample(realDelta);
        this.stage.measure(originX, originY);

        // A long gap (hidden tab, breakpoint) is clamped: catch up a little, never spiral.
        this.accumulator += Math.min(realDelta, 100);
        let ticks = 0;
        while (this.accumulator >= Simulation.TICK_MS && ticks < MAX_CATCH_UP_TICKS) {
            // Input edges go to the first tick only, so a press is seen exactly once.
            this.simulation.tickCycle(this.buildTickInput(ticks === 0));
            this.accumulator -= Simulation.TICK_MS;
            ticks++;
        }
        if (ticks === MAX_CATCH_UP_TICKS) {
            this.accumulator = 0;
        }

        this.renderAll(realDelta, this.accumulator / Simulation.TICK_MS);
    };

    private buildTickInput(withEdges: boolean): TickInput {
        const input = this.input;
        const t = this.tickInput;
        t.canvasDimensions.x = this.stage.width;
        t.canvasDimensions.y = this.stage.height;
        t.mousePosition = input.mousePosition;
        t.mouseDown = input.mouseDown;
        t.mouseOnInteractive = input.mouseOnInteractive;
        t.keysPressed = input.keysPressed;
        t.scrollY = input.scrollY;
        if (withEdges) {
            const edges = input.takeEdges();
            t.justPressedKeys = edges.justPressedKeys;
            t.justReleasedKeys = edges.justReleasedKeys;
            t.mouseJustPressed = edges.mouseJustPressed;
            t.mouseJustReleased = edges.mouseJustReleased;
            t.wheelDelta = edges.wheelDelta;
        } else {
            t.justPressedKeys = NO_KEYS;
            t.justReleasedKeys = NO_KEYS;
            t.mouseJustPressed = false;
            t.mouseJustReleased = false;
            t.wheelDelta = 0;
        }
        return t;
    }

    private renderAll(realDelta: number, alpha: number): void {
        this.invalidated = false;
        const sim = this.simulation;
        const tick = sim.tickContext;
        const timed = this.timedContext;
        timed.timeDelta = realDelta;
        timed.alpha = alpha;
        timed.tickDelta = sim.tickDelta;
        timed.time = tick.time + alpha * sim.tickDelta;
        timed.mousePosition = this.input.mousePosition;
        timed.mouseDown = this.input.mouseDown;
        timed.keysPressed = this.input.keysPressed;
        timed.speedMultiplier = sim.getTimeScale();

        for (const slot of this.slots.values()) {
            const enabled = sim.isEnabled(slot.effect.effectName);
            slot.pixi.visible = enabled;
            slot.pixiFront.visible = enabled;
            slot.three.visible = enabled;
            if (!enabled) {
                continue;
            }
            timed.context = slot.pixi;
            timed.front = slot.pixiFront;
            timed.group = slot.three;
            try {
                slot.effect.onRender(timed);
            } catch (error) {
                sim.markFailed(slot.effect.effectName);
                this.reportError(slot.effect.effectName, 'render', error);
            }
        }

        this.compositor.render(timed.time / 1000, sim.forces.shocks, this.input.scrollY);
    }

    private syncSize(): void {
        if (!this.sizeDirty) {
            return;
        }
        this.sizeDirty = false;
        const width = Math.max(1, this.canvas.clientWidth);
        const height = Math.max(1, this.canvas.clientHeight);
        this.stage.resize(width, height);
        this.compositor.resize(width, height);
    }

    private canvasOrigin(): [number, number] {
        const box = this.canvas.getBoundingClientRect();
        return [box.left, box.top];
    }

    private releaseSlot(slot: EffectSlot): void {
        try {
            slot.effect.cleanup();
        } catch (error) {
            this.reportError(slot.effect.effectName, 'cleanup', error);
        }
        slot.pixi.destroy({ children: true });
        slot.pixiFront.destroy({ children: true });
        slot.three.removeFromParent();
    }

    private reportError(effectName: string, phase: 'tick' | 'render' | 'cleanup', error: unknown): void {
        if (this.onEffectError) {
            this.onEffectError(effectName, phase, error);
        } else {
            console.error(`[visuals] effect "${effectName}" failed during ${phase} and was switched off`, error);
        }
    }
}
