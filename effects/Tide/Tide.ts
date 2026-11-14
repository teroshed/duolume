import { Graphics, Mesh, MeshGeometry, Texture } from 'pixi.js';
import { Effect } from '../../src/Effect';
import { approach, clamp, mixColor } from '../../src/math';
import type { EffectContext, Theme, TickContext, TimedContext, Vector3 } from '../../src/types';
import type { TideContext } from '../contracts';
import { WaterSurface } from './WaterSurface';

export interface TideOptions {
    /** Resting height of the water above the bottom of the stage, in px. Default `LEVEL` (70). */
    level?: number;
    /** Most the rain can raise it above the resting level, in px. Default `MAX_RISE` (120). */
    maxRise?: number;
    /** Pixels one landed raindrop adds to the level. Default `RISE_PER_DROP` (0.019): the default `Rain` fills `maxRise` in about 50 s. */
    risePerDrop?: number;
    /** How fast the raised water falls back to rest, in px per second. Default `DRAIN` (4). */
    drain?: number;
    /** Throw spray droplets on big splashes. Default true. */
    splashes?: boolean;
}

/** One band of water: its mesh, its gradient and how it follows the surface. */
interface Band {
    mesh: Mesh;
    geometry: MeshGeometry;
    canvas: HTMLCanvasElement;
    texture: Texture;
    /** Pixels above the front band's surface. */
    lift: number;
    /** How much of the spring ripples it carries, 0..1. */
    ripple: number;
    /** Swell amplitude and speed relative to the front band. */
    swell: number;
    speed: number;
    /** Phase offset, so the bands do not crest together. */
    offset: number;
}

interface Reflection {
    x: number;
    age: number;
    life: number;
    strength: number;
    seed: number;
}

/** Depth below a band's crest, in px, over which its gradient runs from crest line to solid. */
const GRADIENT_DEPTH = 110;
/** Swell wavelengths in px and their weights: three sines, plus a short chop that only the wind raises. */
const WAVES = [
    { length: 420, weight: 1, windWeight: 0 },
    { length: 230, weight: 0.45, windWeight: 0 },
    { length: 131, weight: 0.22, windWeight: 0.05 },
    { length: 63, weight: 0, windWeight: 0.2 },
];
const MAX_RINGS = 48;
const MAX_SPRAY = 300;
const MAX_REFLECTIONS = 4;
const GRAVITY = 0.0011;
/** The `wind` effect's hand push, in px/ms²: the strongest wind the sea is tuned for. */
const STRONG_WIND = 0.0011;

/**
 * A night sea along the bottom of the stage, drawn as three bands of water that slide past each
 * other. The rest of the scene fills it and disturbs it: rain raises the level and rings the
 * surface, the wind sets which way the swell runs and how choppy it is, and anything that bursts
 * close to the water throws up a splash. Lightning, fireworks and meteors leave a broken streak
 * of reflected light on the water under them.
 *
 * What it listens to:
 *   - `rain:landed`: every landed droplet raises the water a little (it drains back when the rain
 *     stops); droplets landing at or near the surface ring it.
 *   - the force field: the wind (sampled above the water) sets the swell; shock rings passing
 *     over the surface push it up and down.
 *   - presses at or just above the surface: a splash.
 *   - `crystal:exploded`, `rainEater:exploded`, `meteor:impact`, `singularity:collapsed`,
 *     `firework:exploded`, `bubble:popped`, `lightning:strike` within reach of the surface: a
 *     splash and spray, sized by how close it was and how big.
 *   - `lightning:strike`, `firework:exploded`, `meteor:impact`: a reflection on the water.
 * What it tells the others: its `level`, `surfaceY` and `raised` (no forces, no events).
 * Keys: none.
 */
export class Tide extends Effect<TideContext> {
    public effectName = 'tide';

    public static readonly LEVEL = 70;
    public static readonly MAX_RISE = 120;
    public static readonly RISE_PER_DROP = 0.019;
    public static readonly DRAIN = 4;
    /** Rain landing this far above the surface (px) still rings it; higher up it only raises the level. */
    public static readonly RING_REACH = 60;
    /** Presses this far above the surface (px) still splash it. */
    public static readonly PRESS_REACH = 40;
    /** Bursts further than this above the surface (px) leave it alone. */
    public static readonly SPLASH_REACH = 250;

    private readonly rest: number;
    private readonly maxRise: number;
    private readonly risePerDrop: number;
    private readonly drain: number;
    private readonly splashes: boolean;

    private readonly context: TideContext = { level: 0, surfaceY: 0, raised: 0 };
    private readonly surface = new WaterSurface(0);
    private readonly force: Vector3 = { x: 0, y: 0 };
    private readonly bands: Band[] = [];
    private overlay!: Graphics;

    private target: number;
    private level: number;
    private height = 0;
    private seeded = false;
    /** Swell state: travel direction -1..1, wind 0..~1.5, phase per wave (radians), phase speed per ms. */
    private direction = 1;
    private wind = 0;
    private readonly phases = new Float64Array(WAVES.length);
    private readonly phaseSpeed = new Float64Array(WAVES.length);
    private shockOffset = 0;

    // Rings on the surface (structure of arrays).
    private readonly ringX = new Float32Array(MAX_RINGS);
    private readonly ringAge = new Float32Array(MAX_RINGS);
    private readonly ringSize = new Float32Array(MAX_RINGS);
    private ringCount = 0;
    // Spray droplets (structure of arrays).
    private readonly sprayX = new Float32Array(MAX_SPRAY);
    private readonly sprayY = new Float32Array(MAX_SPRAY);
    private readonly sprayVX = new Float32Array(MAX_SPRAY);
    private readonly sprayVY = new Float32Array(MAX_SPRAY);
    private sprayCount = 0;
    private readonly reflections: Reflection[] = [];
    private lastTheme = '';

    constructor(options: TideOptions = {}) {
        super();
        this.rest = clamp(finite(options.level, Tide.LEVEL), 0, 2000);
        this.maxRise = clamp(finite(options.maxRise, Tide.MAX_RISE), 0, 2000);
        this.risePerDrop = clamp(finite(options.risePerDrop, Tide.RISE_PER_DROP), 0, 10);
        this.drain = clamp(finite(options.drain, Tide.DRAIN), 0, 1000);
        this.splashes = options.splashes ?? true;
        this.target = this.rest;
        this.level = this.rest;
    }

    public initialize(): void {
        // Back to front: highest, palest and slowest first.
        const specs = [
            { lift: 26, ripple: 0.3, swell: 0.8, speed: 0.55, offset: 2.1 },
            { lift: 12, ripple: 0.6, swell: 0.9, speed: 0.8, offset: 4.4 },
            { lift: 0, ripple: 1, swell: 1, speed: 1, offset: 0 },
        ];
        for (const spec of specs) {
            const canvas = document.createElement('canvas');
            canvas.width = 4;
            canvas.height = GRADIENT_DEPTH;
            const texture = Texture.from(canvas);
            const geometry = makeGeometry(2);
            const mesh = new Mesh({ geometry, texture });
            this.host.pixi.addChild(mesh);
            this.bands.push({ mesh, geometry, canvas, texture, ...spec });
        }
        this.overlay = new Graphics();
        this.overlay.blendMode = 'add';
        this.host.pixi.addChild(this.overlay);
    }

    public cleanup(): void {
        for (const band of this.bands) {
            band.mesh.texture = Texture.EMPTY;
            band.mesh.destroy();
            band.geometry.destroy();
            band.texture.destroy(true);
        }
        this.bands.length = 0;
        this.overlay?.destroy();
        this.surface.resize(0);
        this.surface.reset();
        this.reflections.length = 0;
        this.ringCount = 0;
        this.sprayCount = 0;
        this.target = this.rest;
        this.level = this.rest;
        this.seeded = false;
        this.lastTheme = '';
        this.direction = 1;
        this.wind = 0;
        this.phases.fill(0);
    }

    public onTick(tick: TickContext): EffectContext<TideContext> {
        const dt = tick.timeDelta;
        const width = tick.stage.width;
        const height = tick.stage.height;
        this.height = height;
        this.surface.resize(width);
        if (!this.seeded) {
            this.seeded = true;
            for (let i = 0; i < WAVES.length; i++) this.phases[i] = i * 1.9;
        }

        // ---- level: rain fills it, it drains back, the visible level eases after the target ----
        const surfaceY = height - this.level;
        for (const e of tick.events('rain:landed')) {
            const points = e.payload.points;
            this.target += points.length * this.risePerDrop;
            for (let i = 0; i < points.length; i++) {
                const p = points[i];
                if (p.y >= surfaceY - Tide.RING_REACH) {
                    this.surface.disturb(p.x, -(0.012 + 0.018 * Math.random()), 12);
                    if (Math.random() < 0.35) this.addRing(p.x, 0.6 + 0.6 * Math.random());
                }
            }
        }
        const top = this.rest + this.maxRise;
        this.target = clamp(this.target - (this.drain * dt) / 1000, this.rest, top);
        this.level = approach(this.level, this.target, 1.2, dt);

        // ---- wind: direction, height and steepness of the swell ----
        tick.forces.sample(width * 0.5, surfaceY - 80, this.force, this.effectName);
        const wx = this.force.x;
        if (Math.abs(wx) > 0.000015) {
            this.direction = approach(this.direction, Math.sign(wx), 0.5, dt);
        }
        this.wind = approach(this.wind, clamp(Math.abs(wx) / STRONG_WIND, 0, 1.5), 0.7, dt);
        for (let i = 0; i < WAVES.length; i++) {
            const k = (Math.PI * 2) / WAVES[i].length;
            // Phase speed in px/ms: shorter waves run a little slower, wind drives them all.
            const px = (0.018 + 0.05 * this.wind) * Math.sqrt(WAVES[i].length / 420);
            this.phaseSpeed[i] = k * px * this.direction;
            this.phases[i] = (this.phases[i] + this.phaseSpeed[i] * dt) % (Math.PI * 200);
        }

        // ---- disturbances ----
        const mouse = tick.mousePosition;
        if (tick.mouseJustPressed && !tick.mouseOnInteractive && mouse && mouse.y >= surfaceY - Tide.PRESS_REACH) {
            this.splash(mouse.x, 0.9, tick);
        }
        for (const e of tick.events('crystal:exploded')) this.burst(e.payload.x, e.payload.y, clamp(e.payload.radius / 50, 0.5, 1.3), tick);
        for (const e of tick.events('rainEater:exploded')) this.burst(e.payload.x, e.payload.y, 1.3, tick);
        for (const e of tick.events('singularity:collapsed')) this.burst(e.payload.x, e.payload.y, 1.4, tick);
        for (const e of tick.events('bubble:popped')) this.burst(e.payload.x, e.payload.y, clamp(e.payload.radius / 60, 0.12, 0.45), tick);
        for (const e of tick.events('meteor:impact')) {
            this.burst(e.payload.x, e.payload.y, 0.5 + 0.8 * e.payload.power, tick);
            this.reflect(e.payload.x, 0.5 + 0.5 * e.payload.power);
        }
        for (const e of tick.events('firework:exploded')) {
            this.burst(e.payload.x, e.payload.y, 0.3 + 0.7 * e.payload.power, tick);
            this.reflect(e.payload.x, 0.35 + 0.55 * e.payload.power);
        }
        for (const e of tick.events('lightning:strike')) {
            const p = e.payload;
            // A bolt into the sky starts low: whichever end is nearer the water counts.
            const low = p.y >= p.fromY;
            this.burst(low ? p.x : p.fromX, low ? p.y : p.fromY, 1, tick);
            this.reflect(low ? p.x : p.fromX, 1);
        }

        // Shock rings (and any other field) push the surface: a few columns per tick, in turn.
        const stride = 5;
        const n = this.surface.count;
        const v = this.surface.velocities;
        const h = this.surface.heights;
        if (tick.forces.shocks.length > 0) {
            for (let i = this.shockOffset; i < n; i += stride) {
                tick.forces.sample(this.surface.columnX(i), surfaceY - h[i], this.force, this.effectName);
                v[i] -= clamp(this.force.y * dt * stride * 0.6, -0.3, 0.3);
            }
        }
        this.shockOffset = (this.shockOffset + 1) % stride;

        this.surface.step(dt);
        this.stepRings(dt);
        this.stepSpray(dt, height);
        for (let i = this.reflections.length - 1; i >= 0; i--) {
            const r = this.reflections[i];
            r.age += dt;
            if (r.age >= r.life) this.reflections.splice(i, 1);
        }

        const ctx = this.context;
        ctx.level = this.level;
        ctx.surfaceY = height - this.level;
        ctx.raised = this.maxRise > 0 ? clamp((this.level - this.rest) / this.maxRise, 0, 1) : 0;
        return this.publish(ctx);
    }

    public onRender(timed: TimedContext): void {
        const width = timed.stage.width;
        const height = this.height || timed.stage.height;
        if (width <= 0 || height <= 0 || this.bands.length === 0) {
            return;
        }
        const theme = timed.theme;
        const key = `${theme.accent},${theme.accentAlt},${theme.ink},${theme.bgBottom},${theme.glowA},${theme.glowB}`;
        if (key !== this.lastTheme) {
            this.lastTheme = key;
            for (let b = 0; b < this.bands.length; b++) {
                paintGradient(this.bands[b], b, theme);
            }
        }

        const lead = timed.alpha * timed.tickDelta;
        const surfaceY = height - this.level;
        const s = this.surface;
        const n = s.count;
        const amp = 4 + 8 * this.wind;
        const chop = clamp(0.15 + 0.6 * this.wind, 0, 0.85);

        for (const band of this.bands) {
            let geometry = band.geometry;
            if (geometry.positions.length !== n * 4) {
                geometry = makeGeometry(n);
                band.mesh.geometry = geometry;
                band.geometry.destroy();
                band.geometry = geometry;
            }
            const pos = geometry.positions;
            const uvs = geometry.uvs;
            for (let i = 0; i < n; i++) {
                const x = Math.min(width, s.columnX(i));
                const y = this.waveY(x, band, surfaceY, amp, chop, lead, s.heights[i]);
                const j = i * 4;
                pos[j] = x;
                pos[j + 1] = y;
                pos[j + 2] = x;
                pos[j + 3] = height;
                uvs[j] = 0.5;
                uvs[j + 1] = 0;
                uvs[j + 2] = 0.5;
                uvs[j + 3] = Math.max(0, (height - y) / GRADIENT_DEPTH);
            }
            geometry.getBuffer('aPosition').update();
            geometry.getBuffer('aUV').update();
        }

        this.drawOverlay(timed, width, height, surfaceY, amp, chop, lead);
    }

    /** Top edge of a band at `x`, in stage pixels. */
    private waveY(x: number, band: Band, surfaceY: number, amp: number, chop: number, lead: number, ripple: number): number {
        let swell = 0;
        for (let w = 0; w < WAVES.length; w++) {
            const k = (Math.PI * 2) / WAVES[w].length;
            const theta = k * x - (this.phases[w] + this.phaseSpeed[w] * lead) * band.speed + band.offset * (w + 1);
            // Second-order (Stokes) term: sharper crests, flatter troughs as the wind rises.
            const weight = WAVES[w].weight + WAVES[w].windWeight * this.wind;
            swell += weight * (Math.cos(theta) + 0.5 * chop * Math.cos(2 * theta));
        }
        return surfaceY - band.lift - amp * band.swell * swell * 0.6 - ripple * band.ripple;
    }

    private drawOverlay(timed: TimedContext, width: number, height: number, surfaceY: number, amp: number, chop: number, lead: number): void {
        const g = this.overlay;
        g.clear();
        const theme = timed.theme;
        const front = this.bands[this.bands.length - 1];
        const s = this.surface;
        const n = s.count;
        const crest = mixColor(theme.accent, theme.ink, 0.45);
        const time = timed.time;

        // The crest line of the front band.
        for (let i = 0; i < n; i++) {
            const x = Math.min(width, s.columnX(i));
            const y = this.waveY(x, front, surfaceY, amp, chop, lead, s.heights[i]);
            if (i === 0) g.moveTo(x, y);
            else g.lineTo(x, y);
        }
        g.stroke({ width: 1.2, color: crest, alpha: 0.28 });

        // Foam flicker on the tallest crests once the wind is up.
        if (this.wind > 0.3) {
            const foam = clamp((this.wind - 0.3) / 0.7, 0, 1);
            const limit = surfaceY - amp * 0.4;
            for (let i = 1; i < n - 1; i += 2) {
                const x = s.columnX(i);
                const y = this.waveY(x, front, surfaceY, amp, chop, lead, s.heights[i]);
                if (y > limit) continue;
                const flicker = Math.sin(time * 0.013 + i * 2.39) * Math.sin(time * 0.0071 + i * 0.77);
                if (flicker < 0.25) continue;
                g.circle(x + Math.sin(i * 7.1) * 3, y + 1, 1 + flicker).fill({ color: theme.ink, alpha: 0.3 * foam * flicker });
            }
        }

        // Rings: flat ellipses that widen and fade.
        for (let i = 0; i < this.ringCount; i++) {
            const t = this.ringAge[i] / 900;
            const x = this.ringX[i];
            const r = (4 + 22 * Math.sqrt(t)) * this.ringSize[i];
            const y = this.waveY(x, front, surfaceY, amp, chop, lead, s.heightAt(x)) + 2;
            g.ellipse(x, y, r, r * 0.16).stroke({ width: 1, color: crest, alpha: 0.32 * (1 - t) * (1 - t) });
        }

        // Reflections: a streak of light breaking into short dashes that shimmer with the waves.
        for (const r of this.reflections) {
            const t = r.age / r.life;
            const fade = r.strength * (1 - t) * (1 - t);
            const top = this.waveY(r.x, front, surfaceY, amp, chop, lead, s.heightAt(r.x));
            const depth = Math.min(height - top, 150);
            const color = mixColor(theme.accentAlt, theme.ink, 0.6);
            // A glint on the surface and a faint column under it, then the broken dashes.
            g.ellipse(r.x, top + 1.5, 30, 3).fill({ color, alpha: 0.3 * fade });
            g.ellipse(r.x, top + 1.5, 10, 1.6).fill({ color: theme.ink, alpha: 0.6 * fade });
            g.ellipse(r.x, top + depth * 0.3, 9, depth * 0.3).fill({ color, alpha: 0.07 * fade });
            let y = top + 4;
            for (let k = 0; y < top + depth; k++) {
                // Further down is nearer the viewer: the dashes spread out and widen.
                const near = (y - top) / depth;
                const wobble = Math.sin(time * 0.0042 + k * 1.7 + r.seed) * (2 + 10 * near);
                const len = (8 + 14 * (0.5 + 0.5 * Math.sin(time * 0.009 + k * 2.3 + r.seed))) * (1 + near * 1.2);
                const a = fade * 0.75 * Math.pow(1 - near, 1.3);
                const dy = y + Math.sin(time * 0.005 + k * 1.3 + r.seed) * 1.2;
                const gap = 3 + 4 * (0.5 + 0.5 * Math.sin(time * 0.007 + k * 3.1 + r.seed));
                g.rect(r.x + wobble - len * 0.5, dy, len * 0.55, 1.8).fill({ color, alpha: a });
                g.rect(r.x + wobble - len * 0.5 + len * 0.55 + gap, dy, len * 0.45, 1.8).fill({ color, alpha: a * 0.8 });
                y += 5 + 6 * near;
            }
        }

        // Spray.
        for (let i = 0; i < this.sprayCount; i++) {
            const x = this.sprayX[i] + this.sprayVX[i] * lead;
            const y = this.sprayY[i] + this.sprayVY[i] * lead;
            g.circle(x, y, 1.6).fill({ color: crest, alpha: 0.35 });
        }
    }

    /** Something burst at (x, y): splash if it is close enough above the surface (or under it). */
    private burst(x: number, y: number, size: number, tick: TickContext): void {
        const above = tick.stage.height - this.level - y;
        if (above > Tide.SPLASH_REACH) {
            return;
        }
        // Falls off gently at first, then fast towards the edge of reach.
        const r = above / Tide.SPLASH_REACH;
        const near = above <= 0 ? 1 : 1 - r * r;
        this.splash(x, size * near, tick);
    }

    private splash(x: number, strength: number, tick: TickContext): void {
        if (!(strength > 0.02)) {
            return;
        }
        this.surface.disturb(x, -0.35 * strength, 24 + 50 * strength);
        this.addRing(x, 1.4 + strength);
        if (!this.splashes || strength < 0.35) {
            return;
        }
        const cap = Math.floor(MAX_SPRAY * clamp(tick.budget.budget, 0, 1));
        const count = Math.round(6 + 18 * clamp((strength - 0.35) / 0.9, 0, 1));
        const y = tick.stage.height - this.level - this.surface.heightAt(x);
        for (let i = 0; i < count && this.sprayCount < cap; i++) {
            const j = this.sprayCount++;
            this.sprayX[j] = x + (Math.random() - 0.5) * 20 * strength;
            this.sprayY[j] = y;
            this.sprayVX[j] = (Math.random() - 0.5) * 0.3 * strength;
            this.sprayVY[j] = -(0.15 + 0.35 * Math.random()) * Math.min(1.4, strength);
        }
    }

    private reflect(x: number, strength: number): void {
        if (this.reflections.length >= MAX_REFLECTIONS) {
            this.reflections.shift();
        }
        this.reflections.push({ x, age: 0, life: 600 + 300 * clamp(strength, 0, 1), strength: clamp(strength, 0, 1), seed: Math.random() * 10 });
    }

    private addRing(x: number, size: number): void {
        if (this.ringCount >= MAX_RINGS) {
            return;
        }
        const i = this.ringCount++;
        this.ringX[i] = x;
        this.ringAge[i] = 0;
        this.ringSize[i] = size;
    }

    private stepRings(dt: number): void {
        let n = this.ringCount;
        for (let i = n - 1; i >= 0; i--) {
            this.ringAge[i] += dt;
            if (this.ringAge[i] >= 900) {
                n--;
                this.ringX[i] = this.ringX[n];
                this.ringAge[i] = this.ringAge[n];
                this.ringSize[i] = this.ringSize[n];
            }
        }
        this.ringCount = n;
    }

    private stepSpray(dt: number, height: number): void {
        let n = this.sprayCount;
        const surfaceY = height - this.level;
        for (let i = n - 1; i >= 0; i--) {
            this.sprayVY[i] += GRAVITY * dt;
            this.sprayX[i] += this.sprayVX[i] * dt;
            this.sprayY[i] += this.sprayVY[i] * dt;
            const x = this.sprayX[i];
            if (this.sprayVY[i] > 0 && this.sprayY[i] >= surfaceY - this.surface.heightAt(x)) {
                this.surface.disturb(x, -0.02, 10);
                if (Math.random() < 0.5) this.addRing(x, 0.35);
                n--;
                this.sprayX[i] = this.sprayX[n];
                this.sprayY[i] = this.sprayY[n];
                this.sprayVX[i] = this.sprayVX[n];
                this.sprayVY[i] = this.sprayVY[n];
            }
        }
        this.sprayCount = n;
    }
}

/** A strip of `columns` top/bottom vertex pairs, two triangles per gap. */
function makeGeometry(columns: number): MeshGeometry {
    const n = Math.max(2, columns);
    const indices = new Uint32Array((n - 1) * 6);
    for (let i = 0; i < n - 1; i++) {
        const a = i * 2;
        indices.set([a, a + 1, a + 2, a + 2, a + 1, a + 3], i * 6);
    }
    const geometry = new MeshGeometry({ positions: new Float32Array(n * 4), uvs: new Float32Array(n * 4), indices });
    // Its own draw call: the strip changes every frame, so batching would only copy it.
    geometry.batchMode = 'no-batch';
    return geometry;
}

/** The band's vertical gradient: a light crest line, falling fast to deep water that turns solid. */
function paintGradient(band: Band, index: number, theme: Theme): void {
    const ctx = band.canvas.getContext('2d');
    if (!ctx) {
        return;
    }
    const back = 2 - index; // 2 for the back band, 0 for the front
    const crest = mixColor(theme.accent, theme.ink, 0.3 + 0.1 * back);
    // Deep water: the page's bottom colour, tinted by the violet glow and a breath of the accents.
    const tint = mixColor(theme.glowB, theme.accentAlt, 0.3);
    const deep = mixColor(mixColor(theme.bgBottom, tint, 0.16 + 0.08 * back), theme.glowA, 0.04);
    const deeper = mixColor(theme.bgBottom, deep, 0.45 + 0.15 * back);
    const h = band.canvas.height;
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    const crestAlpha = 0.5 - 0.17 * back;
    grad.addColorStop(0, rgba(crest, crestAlpha));
    grad.addColorStop(1.5 / h, rgba(crest, crestAlpha * 0.7));
    grad.addColorStop(5 / h, rgba(mixColor(crest, deep, 0.75), 0.5 - 0.08 * back));
    grad.addColorStop(14 / h, rgba(deep, 0.6 - 0.1 * back));
    grad.addColorStop(50 / h, rgba(deep, 0.85 - 0.15 * back));
    grad.addColorStop(1, rgba(deeper, 0.97 - 0.12 * back));
    ctx.clearRect(0, 0, band.canvas.width, h);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, band.canvas.width, h);
    band.texture.source.update();
}

function rgba(color: number, alpha: number): string {
    return `rgba(${(color >> 16) & 255},${(color >> 8) & 255},${color & 255},${clamp(alpha, 0, 1).toFixed(3)})`;
}

function finite(value: number | undefined, fallback: number): number {
    return value !== undefined && Number.isFinite(value) ? value : fallback;
}
