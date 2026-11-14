import { Graphics, MeshSimple, Texture } from 'pixi.js';
import { Effect } from '../../src/Effect';
import { approach, clamp, mixColor } from '../../src/math';
import type { AnchorRect } from '../../src/Stage';
import type { EffectContext, Theme, TickContext, TimedContext, Vector3 } from '../../src/types';
import type { MeadowContext } from '../contracts';
import { BladeRow, bladeIndices, SEGMENTS, VERTS_PER_BLADE, writeBlade } from './BladeRow';

export interface MeadowOptions {
    /** Blades per 100 px of ground, 0..90. Default `DENSITY` (36). */
    density?: number;
    /** Typical blade height on the stage floor, in px (page elements grow about 55% of it). Default `HEIGHT` (46). */
    height?: number;
    /** Grow along the bottom of the stage. Default true. */
    ground?: boolean;
    /** Grow along the top edge of page elements tagged "ledge". Default true. */
    ledges?: boolean;
    /** Milliseconds for a cut or scorched blade to grow back. Default `REGROW_MS` (9000). */
    regrow?: number;
}

interface RowView {
    row: BladeRow;
    mesh: MeshSimple;
    positions: Float32Array;
    uvs: Float32Array;
    /** Phase of the travelling gust pattern, so rows do not move in lockstep. */
    wavePhase: number;
}

interface Clipping {
    x: number;
    y: number;
    vx: number;
    vy: number;
    spin: number;
    angle: number;
    life: number;
    color: number;
}

const PALETTE_COLS = 16;
const PALETTE_ROWS = 16;
const MAX_CLIPPINGS = 48;
/** Ledge blades are this share of the floor height. */
const LEDGE_SCALE = 0.55;

/**
 * Grass along the bottom of the stage and on top of every page element tagged "ledge". It does
 * nothing on its own: every movement is a reaction to the force field, so wind gusts roll through
 * it as travelling waves, shock rings flatten circles that spring back, and attractors make it lean.
 * Each blade is a damped spring on its tip; each row is one Pixi mesh.
 *
 * What it listens to:
 *   - the force field, sampled at every blade's tip: wind, shock rings, attract/repel/vortex.
 *   - the pointer: blades part around it, more when it moves fast. A press mows the grass under it.
 *   - `lightning:strike` and `meteor:impact` events: blades nearby are scorched to stubble.
 *   - `rain:landed` events: a droplet flicks the blade it lands on.
 *   - elements tagged "ledge": grass grows on their top edges and follows them.
 * It tells the others how many blades stand and how far the grass leans. Cut and scorched
 * blades grow back. No keys.
 */
export class Meadow extends Effect<MeadowContext> {
    public effectName = 'meadow';

    public static readonly DENSITY = 36;
    public static readonly HEIGHT = 46;
    public static readonly REGROW_MS = 9000;

    private readonly density: number;
    private readonly bladeHeight: number;
    private readonly ground: boolean;
    private readonly ledges: boolean;
    private readonly regrow: number;

    private readonly rows = new Map<string, RowView>();
    private readonly seen = new Set<string>();
    private readonly context: MeadowContext = { blades: 0, sway: 0 };
    private readonly force: Vector3 = { x: 0, y: 0 };
    private readonly clippings: Clipping[] = [];
    private clippingView: Graphics | undefined;
    private palette: Texture | undefined;
    private paletteCanvas: HTMLCanvasElement | undefined;
    private paletteKey = '';
    private clippingColor = 0x4f8f88;
    /** Share of blades shown, eased toward what the frame budget allows. */
    private shown = 1;
    private lastMouseX = NaN;
    private handSpeed = 0;
    private lastMouseY = NaN;

    constructor(options: MeadowOptions = {}) {
        super();
        this.density = clamp(finite(options.density, Meadow.DENSITY), 0, 90);
        this.bladeHeight = clamp(finite(options.height, Meadow.HEIGHT), 4, 400);
        this.ground = options.ground ?? true;
        this.ledges = options.ledges ?? true;
        this.regrow = Math.max(100, finite(options.regrow, Meadow.REGROW_MS));
    }

    public initialize(): void {
        this.paletteCanvas = document.createElement('canvas');
        this.paletteCanvas.width = PALETTE_COLS;
        this.paletteCanvas.height = PALETTE_ROWS;
        this.palette = Texture.from(this.paletteCanvas);
        this.clippingView = new Graphics();
    }

    public cleanup(): void {
        for (const view of this.rows.values()) {
            view.mesh.destroy();
        }
        this.rows.clear();
        this.clippingView?.destroy();
        this.clippingView = undefined;
        this.palette?.destroy(true);
        this.palette = undefined;
        this.paletteCanvas = undefined;
        this.paletteKey = '';
        this.clippings.length = 0;
        this.shown = 1;
        this.handSpeed = 0;
        this.lastMouseX = NaN;
        this.lastMouseY = NaN;
    }

    public onTick(tick: TickContext): EffectContext<MeadowContext> {
        const dt = tick.timeDelta;
        const time = tick.time;
        this.syncRows(tick);
        this.shown = approach(this.shown, 0.25 + 0.75 * clamp(tick.budget.budget, 0, 1), 0.6, dt);

        // The stage-wide wind, kept apart so it can roll through the grass as waves.
        let wind = 0;
        for (const f of tick.forces.list) {
            if (f.kind === 'wind' && f.radius <= 0) {
                const dx = f.dirX ?? 1;
                wind += (dx / (Math.hypot(dx, f.dirY ?? 0) || 1)) * f.strength;
            }
        }
        const dir = wind < 0 ? -1 : 1;

        // Pointer speed from its movement since the last tick.
        const mouse = tick.mousePosition;
        let mouseSpeed = 0;
        if (mouse && Number.isFinite(this.lastMouseX) && dt > 0) {
            mouseSpeed = Math.hypot(mouse.x - this.lastMouseX, mouse.y - this.lastMouseY) / dt;
        }
        this.lastMouseX = mouse ? mouse.x : NaN;
        this.lastMouseY = mouse ? mouse.y : NaN;
        // The hand remembers its speed for a moment, so a sweep leaves a wake rather than a dot.
        this.handSpeed = Math.max(mouseSpeed, approach(this.handSpeed, 0, 4, dt));
        const handPush = 0.0005 + 0.004 * Math.min(1, this.handSpeed / 0.8);

        if (tick.mouseJustPressed && !tick.mouseOnInteractive && mouse) {
            this.cutAround(mouse.x, mouse.y, 55, time, false);
        }
        for (const e of tick.events('lightning:strike')) {
            this.cutAround(e.payload.x, e.payload.y, 90, time, true);
        }
        for (const e of tick.events('meteor:impact')) {
            this.cutAround(e.payload.x, e.payload.y, 90, time, true);
        }
        for (const e of tick.events('rain:landed')) {
            const points = e.payload.points;
            for (let p = 0; p < points.length && p < 16; p++) {
                this.flick(points[p].x, points[p].y);
            }
        }

        const steps = Math.max(1, Math.ceil(dt / 20));
        const h = dt / steps;
        const force = this.force;
        let standing = 0;
        let swaySum = 0;
        let swayCount = 0;
        for (const view of this.rows.values()) {
            const row = view.row;
            row.grow(time, this.regrow);
            for (let i = 0; i < row.count; i++) {
                const shownH = row.shownHeight(i);
                const rootX = row.x + row.rx[i];
                const tipX = rootX + BladeRow.bend(row.lean[i] + row.rest[i], shownH);
                const tipY = row.y - shownH * 0.85;
                tick.forces.sample(tipX, tipY, force);
                // Gusts roll across in the wind's direction: a quick ripple and a slower swell.
                const ripple = 0.6 + 0.4 * Math.sin(rootX * 0.024 - time * 0.0043 * dir + view.wavePhase);
                const swell = 0.78 + 0.34 * Math.sin(rootX * 0.007 - time * 0.0007 * dir + view.wavePhase * 1.7);
                let accel = force.x - wind + wind * ripple * swell;
                // A calm meadow still breathes.
                accel += 0.000012 * Math.sin(time * 0.0021 + row.phase[i]) + 0.000016 * Math.sin(rootX * 0.011 - time * 0.0009);
                if (mouse) {
                    const dx = tipX - mouse.x;
                    const dy = mouse.y < tipY ? tipY - mouse.y : mouse.y > row.y ? mouse.y - row.y : 0;
                    const d = Math.hypot(dx, dy);
                    if (d < 60) {
                        const t = 1 - d / 60;
                        accel += (dx < 0 ? -1 : 1) * handPush * t * t;
                    }
                }
                for (let s = 0; s < steps; s++) {
                    row.spring(i, accel, h);
                }
                const visible = clamp((this.shown - row.rank[i]) / 0.1, 0, 1);
                if (visible > 0.5) {
                    if (row.growth[i] > 0.5) {
                        standing++;
                    }
                    swaySum += BladeRow.bend(row.lean[i], row.height[i]) / row.height[i];
                    swayCount++;
                }
            }
        }

        this.stepClippings(tick);

        this.context.blades = standing;
        this.context.sway = approach(this.context.sway, swayCount > 0 ? clamp(swaySum / swayCount, -1, 1) : 0, 3, dt);
        return this.publish(this.context);
    }

    public onRender(timed: TimedContext): void {
        this.updatePalette(timed.theme);
        const lead = timed.alpha * timed.tickDelta;
        const shown = this.shown;
        for (const view of this.rows.values()) {
            const { row, positions, uvs, mesh } = view;
            mesh.position.set(row.x, row.y);
            for (let i = 0; i < row.count; i++) {
                const visible = clamp((shown - row.rank[i]) / 0.1, 0, 1);
                const h = row.shownHeight(i) * visible;
                const lean = row.lean[i] + row.velocity[i] * lead + row.rest[i];
                const offset = i * VERTS_PER_BLADE * 2;
                writeBlade(positions, offset, row.rx[i], h, row.rootWidth[i], BladeRow.bend(lean, h));
                // Scorched blades slide toward the ash end of the palette as they burn.
                const u = paletteU(row.shade[i] * (1 - row.scorch[i]));
                for (let k = 0; k < VERTS_PER_BLADE; k++) {
                    uvs[offset + k * 2] = u;
                }
            }
            mesh.geometry.getBuffer('aPosition').update();
            mesh.geometry.getBuffer('aUV').update();
        }
        this.drawClippings();
    }

    /** Keep one row per growing surface: the floor, and each visible ledge, keyed by its name. */
    private syncRows(tick: TickContext): void {
        const seen = this.seen;
        seen.clear();
        if (this.ground) {
            const width = tick.stage.width;
            this.ensureRow('floor', -6, width + 12, tick.stage.height + 2, this.bladeHeight);
            seen.add('floor');
        }
        if (this.ledges) {
            const list: readonly AnchorRect[] = tick.stage.tagged('ledge');
            for (const rect of list) {
                if (rect.width < 8) {
                    continue;
                }
                const key = `ledge:${rect.name}`;
                this.ensureRow(key, rect.x + 3, rect.width - 6, rect.y + 1, this.bladeHeight * LEDGE_SCALE);
                seen.add(key);
            }
        }
        for (const [key, view] of this.rows) {
            if (!seen.has(key)) {
                view.mesh.destroy();
                this.rows.delete(key);
            }
        }
    }

    private ensureRow(key: string, x: number, width: number, y: number, height: number): void {
        let view = this.rows.get(key);
        if (view && Math.abs(view.row.width - width) > 1) {
            view.mesh.destroy();
            this.rows.delete(key);
            view = undefined;
        }
        if (!view) {
            view = this.createRow(new BladeRow(key, width, this.density, height));
            this.rows.set(key, view);
        }
        view.row.x = x;
        view.row.y = y;
    }

    private createRow(row: BladeRow): RowView {
        const vertexFloats = Math.max(1, row.count) * VERTS_PER_BLADE * 2;
        const positions = new Float32Array(vertexFloats);
        const uvs = new Float32Array(vertexFloats);
        for (let i = 0; i < row.count; i++) {
            for (let j = 0; j <= SEGMENTS; j++) {
                const o = (i * VERTS_PER_BLADE + j * 2) * 2;
                const v = paletteV(j / SEGMENTS);
                uvs[o + 1] = v;
                uvs[o + 3] = v;
            }
        }
        const indices = row.count > 0 ? bladeIndices(row.order) : new Uint32Array([0, 0, 0]);
        const mesh = new MeshSimple({ texture: this.palette ?? Texture.WHITE, vertices: positions, uvs, indices });
        mesh.alpha = 0.86;
        // Rows are added in order, so the floor sits behind the ledges; clippings stay on top.
        this.host.pixi.addChild(mesh);
        if (this.clippingView) {
            this.host.pixi.addChild(this.clippingView);
        }
        return { row, mesh, positions, uvs, wavePhase: Math.random() * Math.PI * 2 };
    }

    /** Cut (and optionally scorch) every blade within `radius` of a point. */
    private cutAround(x: number, y: number, radius: number, time: number, scorch: boolean): void {
        for (const { row } of this.rows.values()) {
            if (y > row.y + radius || y < row.y - this.bladeHeight * 1.5 - radius) {
                continue;
            }
            const end = row.lowerBound(x - row.x + radius);
            for (let i = row.lowerBound(x - row.x - radius); i < end; i++) {
                const h = row.shownHeight(i);
                const dy = y < row.y - h ? row.y - h - y : y > row.y ? y - row.y : 0;
                const dx = row.x + row.rx[i] - x;
                if (dx * dx + dy * dy > radius * radius) {
                    continue;
                }
                if (!scorch && row.growth[i] > 0.5 && Math.random() < 0.35) {
                    this.spawnClipping(row, i, x);
                }
                row.cutAt[i] = time;
                if (scorch) {
                    row.scorchAt[i] = time;
                }
            }
        }
    }

    /** A raindrop landing on a blade gives it a small knock. */
    private flick(x: number, y: number): void {
        for (const { row } of this.rows.values()) {
            if (y > row.y + 12 || y < row.y - this.bladeHeight * 2.5) {
                continue;
            }
            const i = row.nearest(x - row.x);
            if (i >= 0 && Math.abs(row.rx[i] + row.x - x) < 5) {
                row.velocity[i] += (Math.random() < 0.5 ? -1 : 1) * (0.025 + Math.random() * 0.025);
            }
        }
    }

    private spawnClipping(row: BladeRow, i: number, fromX: number): void {
        if (this.clippings.length >= MAX_CLIPPINGS) {
            return;
        }
        const x = row.x + row.rx[i];
        const h = row.shownHeight(i);
        const away = x < fromX ? -1 : 1;
        this.clippings.push({
            x: x + BladeRow.bend(row.lean[i] + row.rest[i], h) * 0.5,
            y: row.y - h * 0.6,
            vx: away * (0.04 + Math.random() * 0.12),
            vy: -0.18 - Math.random() * 0.2,
            spin: (Math.random() - 0.5) * 0.02,
            angle: Math.random() * Math.PI,
            life: 1,
            color: this.clippingColor,
        });
    }

    private stepClippings(tick: TickContext): void {
        const dt = tick.timeDelta;
        const list = this.clippings;
        const force = this.force;
        for (let i = list.length - 1; i >= 0; i--) {
            const c = list[i];
            // The field carries them; air drag keeps them floaty.
            tick.forces.sample(c.x, c.y, force);
            c.vx = (c.vx + force.x * dt * 0.5) * Math.exp(-dt / 900);
            c.vy = (c.vy + (0.00045 + force.y * 0.5) * dt) * Math.exp(-dt / 900);
            c.x += c.vx * dt;
            c.y += c.vy * dt;
            c.angle += c.spin * dt;
            c.life -= dt / 1400;
            if (c.life <= 0) {
                list.splice(i, 1);
            }
        }
    }

    private drawClippings(): void {
        const g = this.clippingView;
        if (!g) {
            return;
        }
        g.clear();
        for (const c of this.clippings) {
            const len = 5;
            const ex = Math.cos(c.angle) * len;
            const ey = Math.sin(c.angle) * len;
            g.moveTo(c.x - ex, c.y - ey).lineTo(c.x + ex, c.y + ey);
            g.stroke({ width: 1.6, color: c.color, alpha: 0.8 * Math.min(1, c.life * 2) });
        }
    }

    /** Redraw the palette when the theme changes: columns run ash → dark → accent → light, rows tip (top) → root. */
    private updatePalette(theme: Theme): void {
        const key = `${theme.accent},${theme.accentAlt},${theme.bgBottom},${theme.ink}`;
        const canvas = this.paletteCanvas;
        const ctx = canvas?.getContext('2d');
        if (key === this.paletteKey || !canvas || !ctx || !this.palette) {
            return;
        }
        this.paletteKey = key;
        const bg = theme.bgBottom;
        const stops = [
            mixColor(0x3a3129, bg, 0.2),
            mixColor(theme.accent, bg, 0.72),
            mixColor(theme.accent, bg, 0.45),
            mixColor(theme.accent, bg, 0.12),
            mixColor(theme.accent, theme.accentAlt, 0.55),
        ];
        const at = [0, 0.22, 0.45, 0.75, 1];
        ctx.clearRect(0, 0, PALETTE_COLS, PALETTE_ROWS);
        for (let c = 0; c < PALETTE_COLS; c++) {
            const s = c / (PALETTE_COLS - 1);
            let k = 0;
            while (k < at.length - 2 && s > at[k + 1]) {
                k++;
            }
            const col = mixColor(stops[k], stops[k + 1], clamp((s - at[k]) / (at[k + 1] - at[k]), 0, 1));
            for (let r = 0; r < PALETTE_ROWS; r++) {
                const along = 1 - r / (PALETTE_ROWS - 1);
                // Dark at the root, the column's colour toward the tip, a faint light rim at the very top.
                let rgb = mixColor(bg, col, 0.3 + 0.7 * Math.pow(along, 0.8));
                if (along > 0.9 && s > 0.6) {
                    rgb = mixColor(rgb, theme.ink, 0.18 * ((along - 0.9) / 0.1) * s);
                }
                const alpha = 0.92 - 0.12 * along;
                ctx.fillStyle = `rgba(${(rgb >> 16) & 255},${(rgb >> 8) & 255},${rgb & 255},${alpha})`;
                ctx.fillRect(c, r, 1, 1);
            }
        }
        this.palette.source.update();
        this.clippingColor = mixColor(stops[2], stops[3], 0.5);
    }
}

function finite(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Centre of a palette column for a shade 0..1, as a texture coordinate. */
function paletteU(shade: number): number {
    return (0.5 + clamp(shade, 0, 1) * (PALETTE_COLS - 1)) / PALETTE_COLS;
}

/** Centre of a palette row for a position along the blade, root 0 → tip 1. */
function paletteV(along: number): number {
    return (0.5 + (1 - clamp(along, 0, 1)) * (PALETTE_ROWS - 1)) / PALETTE_ROWS;
}
