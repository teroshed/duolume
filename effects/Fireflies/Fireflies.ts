import { Particle as PixiParticle, ParticleContainer, Rectangle, Texture } from 'pixi.js';
import { Effect } from '../../src/Effect';
import { approach, clamp, mixColor } from '../../src/math';
import type { EffectContext, TickContext, TimedContext, Vector3 } from '../../src/types';
import type { FirefliesContext } from '../contracts';
import { createSwarm, orderParameter, stepSwarm, type Swarm } from './sync';

export interface FirefliesOptions {
    /** Fireflies at full budget. 0..300. Default `Fireflies.COUNT` (90). */
    count?: number;
    /** Milliseconds between one firefly's own flashes (each gets this ±12%), 300..30000. Default `Fireflies.PERIOD_MS` (2200). */
    period?: number;
    /** How hard a seen flash pulls a firefly forward, as a share of its own phase. 0 never syncs. Default `Fireflies.COUPLING` (0.1). */
    coupling?: number;
    /** Pixels within which one firefly sees another's flash; 0 or less means none sees any. Default `Fireflies.REACH` (170). */
    reach?: number;
    /** Hide under page elements tagged "ledge" while it rains. Default `Fireflies.SHELTER` (true). */
    shelter?: boolean;
}

const HALO_TEX = 64;
const CORE_TEX = 16;
const MAX_COUNT = 300;
/** Share of fireflies that colour themselves from `theme.accentAlt`. */
const ALT_SHARE = 0.28;
/** Halo size across, in pixels, asleep and at the top of a flash. */
const HALO_SIZE = 17;
const HALO_BLOOM = 0.75;
const CORE_SIZE = 4.2;
/** Brightness lost per millisecond: e-fold every 140 ms, so a flash is gone in about 400 ms. */
const FLASH_DECAY_MS = 140;
/** Share of a period after a flash in which a firefly ignores flashes it sees. */
const REST_SHARE = 0.15;
/** Acceleration from the force field is multiplied by this: they weigh almost nothing. */
const FORCE_GAIN = 6;
const MAX_SPEED = 0.7;

/** Events that scramble the fireflies near them: type, and how far (pixels) their reach goes. */
const SCARES: readonly (readonly [string, number])[] = [
    ['lightning:strike', 260],
    ['firework:exploded', 260],
    ['crystal:exploded', 260],
    ['rainEater:exploded', 260],
    ['meteor:impact', 260],
    ['bubble:popped', 80],
    ['singularity:collapsed', Infinity],
    ['flock:startled', 200],
];

/**
 * Fireflies that learn to blink together, drawn with Pixi as small additive glows.
 *
 * Each one is a pulse-coupled oscillator: a phase runs from 0 to 1 over its own period, at 1 it
 * flashes, and every firefly within reach that sees the flash is pushed a little further along its
 * own cycle. From random phases the swarm falls into step in spreading patches until the whole
 * stage pulses together. Anything violent scrambles the fireflies near it, and the sync has to grow
 * back. They wander slowly, are carried by wind and shock rings, and keep off the edges of the stage.
 *
 * What it listens to:
 *   - `lightning:strike`, `firework:exploded`, `crystal:exploded`, `rainEater:exploded` and
 *     `meteor:impact` (each within 260 px), `flock:startled` (200 px), `bubble:popped` (80 px) and
 *     `singularity:collapsed` (everywhere): fireflies in reach get a random phase and a shove.
 *   - a press of the pointer (not on a button or link): the same, within 150 px. A hand that only moves is no threat.
 *   - the `rain` context: while `dropCount` is above 20 (until it falls below 8), most fireflies
 *     gather in the dry strip under the nearest element tagged "ledge" (option `shelter`), and
 *     wander off when it stops.
 *   - the `serpent` context: they steer away from its head when it comes within 180 px.
 *   - the force field: wind and shock rings carry them, then they settle back to wandering.
 *   - the frame budget: fewer fireflies are shown when frames are slow, the extras fade out.
 *
 * What it tells the others: the `fireflies` context (`count`, `sync`), and the event
 * `fireflies:synced` (`sync`, centre `x`, `y`) once each time `sync` rises above 0.9, armed again
 * after it has fallen below 0.6. It has no keys.
 */
export class Fireflies extends Effect<FirefliesContext> {
    public effectName: string = 'fireflies';

    public static readonly COUNT = 90;
    public static readonly PERIOD_MS = 2200;
    public static readonly COUPLING = 0.1;
    public static readonly REACH = 170;
    public static readonly SHELTER = true;

    private readonly capacity: number;
    private readonly period: number;
    private readonly coupling: number;
    private readonly reach: number;
    private readonly shelter: boolean;

    private readonly swarm: Swarm;
    private readonly vx: Float32Array;
    private readonly vy: Float32Array;
    private readonly heading: Float32Array;
    private readonly turn: Float32Array;
    private readonly speed: Float32Array;
    private readonly bob: Float32Array;
    private readonly glow: Float32Array;
    private readonly presence: Float32Array;
    private readonly baseAlpha: Float32Array;
    private readonly sheltering: Uint8Array;
    private readonly slotU: Float32Array;
    private readonly slotV: Float32Array;
    private readonly alt: Uint8Array;

    private seeded = false;
    private raining = false;
    private active = 0;
    private sync = 0;
    private armed = true;
    private readonly force: Vector3 = { x: 0, y: 0 };
    private readonly context: FirefliesContext = { count: 0, sync: 0 };

    private container!: ParticleContainer;
    private atlas!: Texture;
    private haloTexture!: Texture;
    private coreTexture!: Texture;
    private halos: PixiParticle[] = [];
    private cores: PixiParticle[] = [];
    private tints = { accent: -1, alt: -1, ink: -1 };
    private haloTints: [number, number] = [0xffffff, 0xffffff];
    private coreTints: [number, number] = [0xffffff, 0xffffff];

    constructor(options: FirefliesOptions = {}) {
        super();
        this.capacity = Math.round(clamp(options.count ?? Fireflies.COUNT, 0, MAX_COUNT));
        this.period = clamp(options.period ?? Fireflies.PERIOD_MS, 300, 30000);
        this.coupling = clamp(options.coupling ?? Fireflies.COUPLING, 0, 1);
        this.reach = Math.max(0, options.reach ?? Fireflies.REACH);
        this.shelter = options.shelter ?? Fireflies.SHELTER;
        const n = this.capacity;
        this.swarm = createSwarm(n);
        this.vx = new Float32Array(n);
        this.vy = new Float32Array(n);
        this.heading = new Float32Array(n);
        this.turn = new Float32Array(n);
        this.speed = new Float32Array(n);
        this.bob = new Float32Array(n);
        this.glow = new Float32Array(n);
        this.presence = new Float32Array(n);
        this.baseAlpha = new Float32Array(n);
        this.sheltering = new Uint8Array(n);
        this.slotU = new Float32Array(n);
        this.slotV = new Float32Array(n);
        this.alt = new Uint8Array(n);
    }

    public initialize(): void {
        this.atlas = Texture.from(drawAtlas());
        this.haloTexture = new Texture({ source: this.atlas.source, frame: new Rectangle(0, 0, HALO_TEX, HALO_TEX) });
        this.coreTexture = new Texture({ source: this.atlas.source, frame: new Rectangle(HALO_TEX, 0, CORE_TEX, CORE_TEX) });
        this.container = new ParticleContainer({
            texture: this.haloTexture,
            dynamicProperties: { position: true, rotation: false, vertex: true, color: true, uvs: false },
        });
        this.container.blendMode = 'add';
        this.host.pixi.addChild(this.container);
        for (let i = 0; i < this.capacity; i++) {
            const halo = new PixiParticle({ texture: this.haloTexture, anchorX: 0.5, anchorY: 0.5, alpha: 0 });
            this.halos.push(halo);
            this.container.addParticle(halo);
        }
        for (let i = 0; i < this.capacity; i++) {
            const core = new PixiParticle({ texture: this.coreTexture, anchorX: 0.5, anchorY: 0.5, alpha: 0 });
            this.cores.push(core);
            this.container.addParticle(core);
        }
    }

    public onTick(tick: TickContext): EffectContext<FirefliesContext> {
        const dt = Math.min(tick.timeDelta, 50);
        const width = tick.stage.width || tick.canvasDimensions.x;
        const height = tick.stage.height || tick.canvasDimensions.y;
        const n = this.capacity;
        const swarm = this.swarm;

        if (!this.seeded && width > 0 && height > 0) {
            this.seed(width, height);
        }

        // Fewer fireflies when frames are slow: the last ones fade out and sit out of the sync.
        this.active = Math.min(n, Math.ceil(n * clamp(tick.budget.budget, 0, 1)));
        const active = this.active;

        this.scare(tick);
        this.updateShelter(tick);
        const ledges = this.raining ? tick.stage.tagged('ledge') : [];
        const serpent = tick.read('serpent')?.headPosition;

        for (let i = 0; i < n; i++) {
            swarm.x[i] = swarm.x[i] + this.vx[i] * dt;
            swarm.y[i] = swarm.y[i] + this.vy[i] * dt;
            this.steer(i, dt, width, height, tick, ledges, serpent);
            this.presence[i] = approach(this.presence[i], i < active ? 1 : 0, 1.6, dt);
            this.glow[i] *= Math.exp(-dt / FLASH_DECAY_MS);
        }

        stepSwarm(swarm, active, dt, this.coupling, this.reach, REST_SHARE);
        for (let i = 0; i < active; i++) {
            if (swarm.fired[i] === 1) {
                this.glow[i] = 1;
            }
        }

        this.sync = approach(this.sync, orderParameter(swarm.phase, active), 5, dt);
        if (this.armed && this.sync > 0.9) {
            this.armed = false;
            let cx = 0;
            let cy = 0;
            for (let i = 0; i < active; i++) {
                cx += swarm.x[i];
                cy += swarm.y[i];
            }
            tick.emit('fireflies:synced', { sync: this.sync, x: active ? cx / active : 0, y: active ? cy / active : 0 });
        } else if (!this.armed && this.sync < 0.6) {
            this.armed = true;
        }

        this.context.count = active;
        this.context.sync = this.sync;
        return this.publish(this.context);
    }

    public onRender(timed: TimedContext): void {
        if (!this.container) {
            return;
        }
        this.refreshTints(timed);
        const lead = timed.alpha * timed.tickDelta;
        const swarm = this.swarm;
        for (let i = 0; i < this.capacity; i++) {
            const halo = this.halos[i];
            const core = this.cores[i];
            const x = swarm.x[i] + this.vx[i] * lead;
            const y = swarm.y[i] + this.vy[i] * lead + Math.sin(this.bob[i]) * 3;
            const g = this.glow[i];
            const p = this.presence[i];
            const kind = this.alt[i];

            const haloSize = (HALO_SIZE * (0.85 + this.baseAlpha[i] * 2)) * (1 + HALO_BLOOM * g);
            halo.x = x;
            halo.y = y;
            halo.scaleX = halo.scaleY = haloSize / HALO_TEX;
            halo.alpha = p * Math.min(1, this.baseAlpha[i] + g * 0.85);
            halo.tint = this.haloTints[kind];

            core.x = x;
            core.y = y;
            core.scaleX = core.scaleY = (CORE_SIZE * (1 + 0.5 * g)) / CORE_TEX;
            core.alpha = p * Math.min(1, this.baseAlpha[i] * 1.6 + g);
            core.tint = this.coreTints[kind];
        }
    }

    public cleanup(): void {
        if (this.container) {
            this.container.removeParticles();
            this.container.destroy();
        }
        this.haloTexture?.destroy();
        this.coreTexture?.destroy();
        this.atlas?.destroy(true);
        this.halos = [];
        this.cores = [];
        this.seeded = false;
        this.raining = false;
        this.sync = 0;
        this.armed = true;
        this.active = 0;
        this.tints = { accent: -1, alt: -1, ink: -1 };
        this.context.count = 0;
        this.context.sync = 0;
    }

    /** Spread the fireflies over the stage with random phases, the first time the stage has a size. */
    private seed(width: number, height: number): void {
        const swarm = this.swarm;
        for (let i = 0; i < this.capacity; i++) {
            swarm.x[i] = Math.random() * width;
            swarm.y[i] = Math.random() * height;
            swarm.phase[i] = Math.random();
            swarm.period[i] = this.period * (0.88 + Math.random() * 0.24);
            this.heading[i] = Math.random() * Math.PI * 2;
            this.speed[i] = 0.01 + Math.random() * 0.03;
            this.bob[i] = Math.random() * Math.PI * 2;
            this.baseAlpha[i] = 0.19 + Math.random() * 0.08;
            this.sheltering[i] = Math.random() < 0.7 ? 1 : 0;
            this.slotU[i] = -0.05 + Math.random() * 1.1;
            this.slotV[i] = Math.random();
            this.alt[i] = Math.random() < ALT_SHARE ? 1 : 0;
        }
        this.seeded = true;
    }

    /** Random phase and a shove away from the point, for every firefly within reach of an event or a press. */
    private scare(tick: TickContext): void {
        for (const [type, radius] of SCARES) {
            for (const event of tick.events(type)) {
                const at = event.payload as { x: number; y: number };
                this.scatter(at.x, at.y, radius);
            }
        }
        const mouse = tick.mousePosition;
        if (tick.mouseJustPressed && !tick.mouseOnInteractive && mouse) {
            this.scatter(mouse.x, mouse.y, 150);
        }
    }

    private scatter(x: number, y: number, radius: number): void {
        const swarm = this.swarm;
        for (let i = 0; i < this.capacity; i++) {
            const dx = swarm.x[i] - x;
            const dy = swarm.y[i] - y;
            const d = Math.hypot(dx, dy);
            if (d > radius) {
                continue;
            }
            swarm.phase[i] = Math.random();
            swarm.rest[i] = 0;
            const push = radius === Infinity ? 0.08 : 0.1 + 0.3 * (1 - d / radius);
            const away = d > 0.5 ? 1 / d : 0;
            const angle = Math.random() * Math.PI * 2;
            this.vx[i] += (d > 0.5 ? dx * away : Math.cos(angle)) * push;
            this.vy[i] += (d > 0.5 ? dy * away : Math.sin(angle)) * push;
        }
    }

    /** It is raining when the rain has more than 20 drops; it stops at fewer than 8, so it does not flicker. */
    private updateShelter(tick: TickContext): void {
        if (!this.shelter) {
            this.raining = false;
            return;
        }
        const drops = tick.read('rain')?.dropCount ?? 0;
        if (drops > 20) {
            this.raining = true;
        } else if (drops < 8) {
            this.raining = false;
        }
    }

    /** Wander, keep off the edges, avoid the serpent, shelter from rain, feel the force field. */
    private steer(
        i: number,
        dt: number,
        width: number,
        height: number,
        tick: TickContext,
        ledges: readonly { x: number; y: number; width: number; height: number }[],
        serpent: Vector3 | undefined,
    ): void {
        const swarm = this.swarm;
        const x = swarm.x[i];
        const y = swarm.y[i];

        // The heading drifts: its turning rate is itself a slow random walk.
        this.turn[i] += (Math.random() - 0.5) * 0.0011 * dt - this.turn[i] * (dt / 1800);
        this.heading[i] += this.turn[i] * dt;
        this.bob[i] += dt * (0.0016 + this.speed[i] * 0.03);

        let wantX = Math.cos(this.heading[i]) * this.speed[i];
        let wantY = Math.sin(this.heading[i]) * this.speed[i];
        let relax = dt / 500;

        // Soft turning near the edges.
        const margin = 90;
        const ex = clamp((margin - x) / margin, 0, 1) - clamp((x - (width - margin)) / margin, 0, 1);
        const ey = clamp((margin - y) / margin, 0, 1) - clamp((y - (height - margin)) / margin, 0, 1);
        if (ex !== 0 || ey !== 0) {
            wantX += ex * 0.05;
            wantY += ey * 0.05;
            const toward = Math.atan2(wantY, wantX);
            this.heading[i] += wrapAngle(toward - this.heading[i]) * Math.min(1, (dt / 400) * Math.hypot(ex, ey));
        }

        // Shelter: arrive at a point just under the nearest ledge's bottom edge and hover there.
        if (this.raining && this.sheltering[i] === 1 && ledges.length > 0) {
            let bestD = Infinity;
            let tx = x;
            let ty = y;
            for (let k = 0; k < ledges.length; k++) {
                const ledge = ledges[k];
                const px = ledge.x + this.slotU[i] * ledge.width + Math.cos(this.bob[i] * 0.45 + this.slotV[i] * 6) * 10;
                // A ragged huddle 10 to 90 px under the element: the depth limit varies along its width.
                const reach = 38 + 36 * (0.5 + 0.5 * Math.sin(this.slotU[i] * 9 + 1.3));
                const py = ledge.y + ledge.height + 16 + this.slotV[i] * reach + Math.sin(this.bob[i] * 0.6) * 6;
                const d = Math.hypot(px - x, py - y);
                if (d < bestD) {
                    bestD = d;
                    tx = px;
                    ty = py;
                }
            }
            if (bestD > 30) {
                wantX = ((tx - x) / bestD) * 0.07;
                wantY = ((ty - y) / bestD) * 0.07;
            } else {
                wantX = (tx - x) * 0.0015 + wantX * 0.3;
                wantY = (ty - y) * 0.0015 + wantY * 0.3;
            }
            relax = dt / 350;
        }

        if (serpent) {
            const dx = x - serpent.x;
            const dy = y - serpent.y;
            const d = Math.hypot(dx, dy);
            if (d < 180 && d > 0.5) {
                const fear = 1 - d / 180;
                wantX += (dx / d) * fear * 0.14;
                wantY += (dy / d) * fear * 0.14;
                relax = Math.max(relax, dt / 250);
            }
        }

        this.vx[i] += (wantX - this.vx[i]) * Math.min(1, relax);
        this.vy[i] += (wantY - this.vy[i]) * Math.min(1, relax);

        // Wind and shock rings.
        tick.forces.sample(x, y, this.force);
        this.vx[i] += this.force.x * FORCE_GAIN * dt;
        this.vy[i] += this.force.y * FORCE_GAIN * dt;

        const v = Math.hypot(this.vx[i], this.vy[i]);
        if (v > MAX_SPEED) {
            this.vx[i] *= MAX_SPEED / v;
            this.vy[i] *= MAX_SPEED / v;
        }
        swarm.x[i] = clamp(swarm.x[i], -30, width + 30);
        swarm.y[i] = clamp(swarm.y[i], -30, height + 30);
    }

    private refreshTints(timed: TimedContext): void {
        const theme = timed.theme;
        const t = this.tints;
        if (theme.accent === t.accent && theme.accentAlt === t.alt && theme.ink === t.ink) {
            return;
        }
        t.accent = theme.accent;
        t.alt = theme.accentAlt;
        t.ink = theme.ink;
        const warm = mixColor(theme.accent, theme.ink, 0.35);
        this.haloTints = [warm, theme.accentAlt];
        this.coreTints = [mixColor(warm, 0xffffff, 0.55), mixColor(theme.accentAlt, 0xffffff, 0.55)];
    }
}

function wrapAngle(a: number): number {
    return Math.atan2(Math.sin(a), Math.cos(a));
}

/** One canvas holds both textures: a soft halo (64 px) and a small bright core (16 px). */
function drawAtlas(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = HALO_TEX + CORE_TEX;
    canvas.height = HALO_TEX;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return canvas;
    }
    const half = HALO_TEX / 2;
    const halo = ctx.createRadialGradient(half, half, 0, half, half, half);
    halo.addColorStop(0, 'rgba(255,255,255,0.9)');
    halo.addColorStop(0.18, 'rgba(255,255,255,0.45)');
    halo.addColorStop(0.45, 'rgba(255,255,255,0.12)');
    halo.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, HALO_TEX, HALO_TEX);

    const c = CORE_TEX / 2;
    const core = ctx.createRadialGradient(HALO_TEX + c, c, 0, HALO_TEX + c, c, c);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(0.5, 'rgba(255,255,255,0.7)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = core;
    ctx.fillRect(HALO_TEX, 0, CORE_TEX, CORE_TEX);
    return canvas;
}
