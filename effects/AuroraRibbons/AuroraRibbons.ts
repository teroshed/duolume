import { MeshRope, Point, Texture } from 'pixi.js';
import { Effect } from '../../src/Effect';
import { approach, mixColor } from '../../src/math';
import type { EffectContext, Theme, TickContext, TimedContext, Vector3 } from '../../src/types';
import type { AuroraRibbonsContext } from '../contracts';
import { Ribbon } from './Ribbon';

const TEX_W = 512;
const POINT_COUNT = 48;

/** Mesh alpha before breathing and the rain-eater glow; ribbons stay subtle so text can sit on top. */
const BASE_ALPHA = 0.5;

interface RibbonView {
    canvas: HTMLCanvasElement;
    texture: Texture;
    mesh: MeshRope;
    points: Point[];
}

interface Entry {
    ribbon: Ribbon;
    view: RibbonView | undefined;
}

export interface AuroraRibbonsOptions {
    /** Ribbons at the start. Default `START_COUNT` (3). */
    count?: number;
    /** Most ribbons the W key can add up to. Default `MAX_RIBBONS` (24). */
    maxRibbons?: number;
}

/**
 * Light, wavy ribbons drifting across the sky, drawn with one Pixi rope mesh per ribbon.
 *
 * What it listens to:
 *   - `lightning:strike`, `firework:exploded`, `rainEater:exploded`, `meteor:impact` and
 *     `singularity:collapsed` events: each sends a pulse rippling along every ribbon from where
 *     it happened.
 *   - the force field: wind and shock rings push the ribbons along.
 *   - `rainEater` (a Three.js effect): the ribbons brighten as it fills up.
 * Keys: `w` adds a ribbon, `s` removes one. A click pulses at the mouse.
 */
export class AuroraRibbons extends Effect<AuroraRibbonsContext> {
    public effectName = 'auroraRibbons';

    public static readonly START_COUNT = 3;
    public static readonly MAX_RIBBONS = 24;
    public static readonly MIN_RIBBONS = 0;

    private readonly entries: Entry[] = [];
    /** Ribbons removed in a tick; their views are released on the next render, not mid-simulation. */
    private readonly retired: RibbonView[] = [];
    private readonly context: AuroraRibbonsContext = { count: 0 };
    private readonly scratch: Vector3 = { x: 0, y: 0 };
    private readonly origin: Vector3 = { x: 0, y: 0 };
    private readonly startCount: number;
    private readonly maxRibbons: number;
    private glow = 0.5;
    private seeded = false;
    private lastAccent = -1;
    private lastAccentAlt = -1;

    constructor(options: AuroraRibbonsOptions = {}) {
        super();
        this.maxRibbons = Math.max(AuroraRibbons.MIN_RIBBONS, options.maxRibbons ?? AuroraRibbons.MAX_RIBBONS);
        this.startCount = Math.min(this.maxRibbons, Math.max(AuroraRibbons.MIN_RIBBONS, options.count ?? AuroraRibbons.START_COUNT));
    }

    public initialize(): void {}

    public cleanup(): void {
        for (const entry of this.entries) {
            if (entry.view) {
                this.destroyView(entry.view);
            }
        }
        this.entries.length = 0;
        for (const view of this.retired) {
            this.destroyView(view);
        }
        this.retired.length = 0;
        this.seeded = false;
        this.lastAccent = -1;
        this.lastAccentAlt = -1;
    }

    public onTick(tick: TickContext): EffectContext<AuroraRibbonsContext> {
        const dims = tick.canvasDimensions;
        const width = dims?.x ?? 0;
        const entries = this.entries;

        // Seeded here rather than in initialize() so the 12%..55% height range uses the real stage size.
        if (!this.seeded) {
            this.seeded = true;
            for (let i = 0; i < this.startCount; i++) {
                entries.push({ ribbon: Ribbon.random(tick.stage.height), view: undefined });
            }
        }

        const pressed = tick.justPressedKeys;
        if (pressed) {
            for (const key of pressed) {
                const k = key.toLowerCase();
                if (k === 'w' && entries.length < this.maxRibbons) {
                    entries.push({ ribbon: Ribbon.random(tick.stage.height), view: undefined });
                } else if (k === 's' && entries.length > AuroraRibbons.MIN_RIBBONS) {
                    const removed = entries.pop();
                    if (removed?.view) {
                        this.retired.push(removed.view);
                    }
                }
            }
        }

        const mouse = tick.mousePosition;
        const dt = tick.timeDelta;
        for (const { ribbon } of entries) {
            tick.forces.sample(ribbon.anchor.x, ribbon.anchor.y, this.scratch);
            ribbon.update(tick, this.scratch.x);

            // gentle attraction towards the mouse
            if (mouse) {
                const pull = 0.00006 * dt;
                ribbon.anchor.x += (mouse.x - ribbon.anchor.x) * pull;
                ribbon.anchor.y += (mouse.y - ribbon.anchor.y) * pull;
            }

            // wrap horizontally for endless drift
            if (width > 0) {
                if (ribbon.anchor.x > width + 50) ribbon.anchor.x = -50;
                if (ribbon.anchor.x < -50) ribbon.anchor.x = width + 50;
            }
        }

        // Pulses now come from the rest of the scene, not from holding the button.
        if (tick.mouseJustPressed && !tick.mouseOnInteractive && mouse) {
            this.pulseAll(mouse.x, mouse.y, 1);
        }
        for (const e of tick.events('lightning:strike')) {
            this.pulseAll(e.payload.x, e.payload.y, 1);
        }
        for (const e of tick.events('firework:exploded')) {
            this.pulseAll(e.payload.x, e.payload.y, 0.4 + 0.6 * e.payload.power);
        }
        for (const e of tick.events('rainEater:exploded')) {
            this.pulseAll(e.payload.x, e.payload.y, 1.5);
        }
        for (const e of tick.events('meteor:impact')) {
            this.pulseAll(e.payload.x, e.payload.y, 0.5 + 0.7 * e.payload.power);
        }
        for (const e of tick.events('singularity:collapsed')) {
            this.pulseAll(e.payload.x, e.payload.y, 1.5);
        }

        const eater = tick.read('rainEater');
        const glowTarget = eater ? 0.5 + eater.energy * 0.5 : 0.5;
        this.glow = approach(this.glow, glowTarget, 1.5, dt);

        this.context.count = entries.length;
        return this.publish(this.context);
    }

    public onRender(timed: TimedContext): void {
        for (const view of this.retired) {
            this.destroyView(view);
        }
        this.retired.length = 0;

        const dims = timed.canvasDimensions;
        if (!dims || dims.x <= 0) {
            return;
        }
        const width = dims.x;
        const theme = timed.theme;
        const time = timed.time;

        const themeChanged = theme.accent !== this.lastAccent || theme.accentAlt !== this.lastAccentAlt;
        this.lastAccent = theme.accent;
        this.lastAccentAlt = theme.accentAlt;

        const entries = this.entries;
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const ribbon = entry.ribbon;
            let view = entry.view;
            if (!view) {
                view = this.createView(ribbon, theme);
                entry.view = view;
            } else if (themeChanged) {
                drawRibbonCanvas(view.canvas, ribbon, theme);
                view.texture.source.update();
            }

            ribbon.layout(view.points, width, time);

            // Each ribbon breathes at its own pace, offset by its index.
            const breathe = 0.78 + 0.22 * Math.sin(time * 0.0005 + i * 1.7);
            // The original also filled a faint 120 px band under each ribbon. On this backdrop it
            // reads as a flat grey bar with a hard top edge, so it is left out.
            view.mesh.alpha = BASE_ALPHA * breathe * this.glow;
        }
    }

    private pulseAll(x: number, y: number, strength: number): void {
        const origin = this.origin;
        origin.x = x;
        origin.y = y;
        for (const { ribbon } of this.entries) {
            ribbon.pulse(origin, strength);
        }
    }

    private createView(ribbon: Ribbon, theme: Theme): RibbonView {
        const height = Math.round(ribbon.thickness * 9);
        const canvas = document.createElement('canvas');
        canvas.width = TEX_W;
        canvas.height = height;
        drawRibbonCanvas(canvas, ribbon, theme);
        const texture = Texture.from(canvas);

        const points: Point[] = [];
        for (let i = 0; i < POINT_COUNT; i++) {
            points.push(new Point(0, 0));
        }
        // The rope's width is the texture's height; `autoUpdate` (default true) re-reads the points every frame.
        const mesh = new MeshRope({ texture, points });
        mesh.blendMode = 'add';
        mesh.alpha = 0;

        this.host.pixi.addChild(mesh);
        return { canvas, texture, mesh, points };
    }

    private destroyView(view: RibbonView): void {
        view.mesh.destroy();
        view.texture.destroy(true);
    }
}

/**
 * Colour runs along the ribbon (accent, blend, accentAlt, blend, accent, ...), then the whole
 * thing is multiplied by a vertical alpha profile: a bright soft core falling to nothing at the edges.
 */
function drawRibbonCanvas(canvas: HTMLCanvasElement, ribbon: Ribbon, theme: Theme): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return;
    }
    const w = canvas.width;
    const h = canvas.height;
    const blend = mixColor(theme.accent, theme.accentAlt, 0.5);
    const cycle = [theme.accent, blend, theme.accentAlt, blend];
    const start = Math.floor(((ribbon.hueShift + 2) / 4) * cycle.length) % cycle.length;

    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    const along = ctx.createLinearGradient(0, 0, w, 0);
    const stops = 9;
    for (let i = 0; i < stops; i++) {
        along.addColorStop(i / (stops - 1), css(cycle[(start + i) % cycle.length]));
    }
    ctx.fillStyle = along;
    ctx.fillRect(0, 0, w, h);

    ctx.globalCompositeOperation = 'destination-in';
    const across = ctx.createLinearGradient(0, 0, 0, h);
    across.addColorStop(0, 'rgba(0,0,0,0)');
    across.addColorStop(0.2, 'rgba(0,0,0,0.12)');
    across.addColorStop(0.43, 'rgba(0,0,0,0.8)');
    across.addColorStop(0.5, 'rgba(0,0,0,1)');
    across.addColorStop(0.57, 'rgba(0,0,0,0.8)');
    across.addColorStop(0.8, 'rgba(0,0,0,0.12)');
    across.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = across;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
}

function css(color: number): string {
    return `#${color.toString(16).padStart(6, '0')}`;
}
