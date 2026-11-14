import { FillGradient, Graphics, Particle as PixiParticle, ParticleContainer, Texture } from 'pixi.js';
import { Effect } from '../../src/Effect';
import { ParticleSet } from '../../src/Governor';
import { clamp, mixColor, randomNumber, smoothstep } from '../../src/math';
import { Particle } from '../../src/Particle';
import type { SnowContext } from '../contracts';
import type { EffectContext, TickContext, TimedContext, Vector3 } from '../../src/types';
import { SnowCap } from './SnowCap';

export interface SnowOptions {
    /** Flakes in the air at full frame budget (0..1500). Defaults to `Snow.FLAKE_COUNT` (400). */
    flakeCount?: number;
    /** Whether snow settles on page elements tagged `ledge`. Defaults to true. */
    pageInteraction?: boolean;
    /** Deepest a drift gets on an element, in px (0..200). Defaults to `Snow.LEDGE_DEPTH` (26). */
    ledgeDepth?: number;
    /** Deepest a drift gets on the floor, in px (0..300). 0 lets the snow fall off the bottom. Defaults to `Snow.GROUND_DEPTH` (40). */
    groundDepth?: number;
    /** Depth every pile loses, in px per second (0..20). Defaults to `Snow.MELT` (0.15). */
    melt?: number;
}

/** One flake. Layer 0 is far, 1 middle, 2 near. */
class Flake extends Particle {
    public layer = 1;
    /** Own resting fall speed, px/ms. */
    public fall = 0.05;
    /** Sideways flutter: phase (rad), speed of the phase (rad/ms), size (px/ms), and a slow second phase. */
    public phase = 0;
    public phaseRate = 0.002;
    public sway = 0.02;
    public phase2 = 0;
    /** Snow volume it adds to a pile when it lands, px². */
    public area = 20;
    public view?: PixiParticle;
}

/** The snow lying along one surface: the top edge of an element, or the floor. */
interface Surface {
    key: string;
    ground: boolean;
    cap: SnowCap;
    x: number;
    y: number;
    width: number;
    g: Graphics;
    /** Bumped when the heights change; the drawing follows it. */
    version: number;
    drawn: number;
    seen: boolean;
    /** Needs `relax()` until it has come to rest. */
    active: boolean;
    meltDebt: number;
    spindrift: number;
}

const DOT = 32;
const LAYERS = [
    // size px, fall px/ms, alpha, priority, settles
    { size: [1.5, 2.5], fall: [0.025, 0.04], alpha: 0.35, priority: 2, area: 0, settles: false },
    { size: [2.5, 4], fall: [0.04, 0.06], alpha: 0.6, priority: 5, area: 36, settles: true },
    { size: [4, 6], fall: [0.06, 0.09], alpha: 0.85, priority: 8, area: 64, settles: true },
] as const;
const GROUND = '__ground';
/** How hard the force field moves a flake: flakes are very light. */
const LIGHTNESS = 1.4;
/** How fast a flake returns to its own fall speed, per ms. */
const DRAG = 0.003;
const MAX_PUFF_PER_TICK = 30;

/**
 * Snow that settles on the page. Flakes drift down in three depth layers and pile up as rounded
 * caps on top of every element tagged `ledge` and along the bottom of the stage. The piles are
 * real heightfields: they slump when too steep, the wind shaves them, a shock ring or an
 * explosion knocks snow off in a puff, and moving the pointer through one wipes it away. Left
 * alone the piles slowly melt, so they never just fill up.
 *
 * What it listens to:
 * - the force field: flakes are very light, so wind makes them slant and stream, and shock rings blast them;
 *   a strong wind also shaves the tops of the piles and carries the snow off as spindrift
 * - elements tagged `ledge`: snow settles on their top edge (option `pageInteraction`)
 * - the pointer: moving through a pile wipes snow off it; a press near a pile knocks off a bigger scoop
 * - `crystal:exploded`, `rainEater:exploded`, `lightning:strike`, `meteor:impact` near a pile, and
 *   `singularity:collapsed` anywhere: they knock snow off in a puff
 * - `firework:exploded` near a pile: melts it a little
 * - `page:hit` on an element: shakes a little snow loose at that spot
 *
 * What it tells the others: its context (`flakes`, `settled`, `deepest`). It emits no events.
 *
 * Keys: none.
 */
export class Snow extends Effect<SnowContext> {
    public effectName: string = 'snow';

    /** Flakes in the air at full frame budget. */
    public static readonly FLAKE_COUNT = 400;
    /** Deepest a drift gets on an element, in px. */
    public static readonly LEDGE_DEPTH = 26;
    /** Deepest a drift gets on the floor, in px. */
    public static readonly GROUND_DEPTH = 40;
    /** Depth every pile loses, in px per second. */
    public static readonly MELT = 0.15;

    private readonly flakes: ParticleSet<Flake>;
    private readonly pageInteraction: boolean;
    private readonly ledgeDepth: number;
    private readonly groundDepth: number;
    private readonly melt: number;

    private container!: ParticleContainer;
    private texture!: Texture;
    private readonly viewPool: PixiParticle[] = [];
    private readonly surfaces = new Map<string, Surface>();
    private readonly surfaceList: Surface[] = [];
    private gradient?: FillGradient;
    private themeKey = '';
    private flakeTint = 0xffffff;
    private rimColor = 0xffffff;

    private readonly acc: Vector3 = { x: 0, y: 0 };
    private readonly context: SnowContext = { flakes: 0, settled: 0, deepest: 0 };
    private spawnDebt = 0;
    /** Mean flake speed last tick, px/ms: in a gale flakes cross the stage faster, so more must arrive. */
    private meanSpeed = 0.05;
    private age = 0;
    private puffs = 0;
    private lastMouse: Vector3 | undefined;

    constructor(options: SnowOptions = {}) {
        super();
        this.pageInteraction = options.pageInteraction ?? true;
        this.ledgeDepth = clamp(options.ledgeDepth ?? Snow.LEDGE_DEPTH, 0, 200);
        this.groundDepth = clamp(options.groundDepth ?? Snow.GROUND_DEPTH, 0, 300);
        this.melt = clamp(options.melt ?? Snow.MELT, 0, 20);
        this.flakes = new ParticleSet<Flake>({
            capacity: Math.round(clamp(options.flakeCount ?? Snow.FLAKE_COUNT, 0, 1500)),
            exitDuration: 600,
            maxBirthsPerTick: 60,
            maxExitsPerTick: 20,
            onRemove: (flake) => this.releaseView(flake),
        });
    }

    public initialize(): void {
        this.texture = Texture.from(drawDot());
        this.container = new ParticleContainer({
            texture: this.texture,
            dynamicProperties: { position: true, vertex: true, color: true },
        });
        this.host.pixi.addChild(this.container);
    }

    public onTick(tick: TickContext): EffectContext<SnowContext> {
        const dt = tick.timeDelta;
        const width = tick.stage.width;
        const height = tick.stage.height;
        this.age += dt;
        this.puffs = 0;
        this.readTheme(tick);
        this.flakes.govern(tick);
        this.syncSurfaces(tick, width, height);

        this.hearEvents(tick);
        this.touchWithPointer(tick);
        this.spawn(tick, width, height);
        this.moveFlakes(tick, width, height);
        this.weather(tick);

        this.flakes.sweep(tick);

        let settled = 0;
        let deepest = 0;
        for (const s of this.surfaceList) {
            settled += s.cap.total;
            deepest = Math.max(deepest, s.cap.deepest);
        }
        this.context.flakes = this.flakes.items.length;
        this.context.settled = settled;
        this.context.deepest = deepest;
        return this.publish(this.context);
    }

    public onRender(timed: TimedContext): void {
        const lead = timed.alpha * timed.tickDelta;
        const items = this.flakes.items;
        for (let i = 0; i < items.length; i++) {
            const f = items[i];
            const view = f.view;
            if (!view) {
                continue;
            }
            view.x = f.position.x + f.velocity.x * lead;
            view.y = f.position.y + f.velocity.y * lead;
            const scale = (f.size.x * 2) / DOT;
            view.scaleX = scale;
            view.scaleY = scale;
            view.tint = this.flakeTint;
            view.alpha = LAYERS[f.layer].alpha * (1 - f.exitProgress);
        }
        for (const s of this.surfaceList) {
            s.g.x = s.x;
            s.g.y = s.y;
            if (s.drawn !== s.version) {
                s.drawn = s.version;
                this.drawSurface(s);
            }
        }
    }

    public cleanup(): void {
        this.flakes.clear();
        this.viewPool.length = 0;
        for (const s of this.surfaces.values()) {
            s.g.destroy();
        }
        this.surfaces.clear();
        this.surfaceList.length = 0;
        this.gradient?.destroy();
        this.gradient = undefined;
        this.container?.destroy();
        this.texture?.destroy(true);
        this.themeKey = '';
        this.spawnDebt = 0;
        this.meanSpeed = 0.05;
        this.age = 0;
        this.lastMouse = undefined;
    }

    // ---- theme --------------------------------------------------------------------------

    private readTheme(tick: TickContext): void {
        const t = tick.theme;
        const key = `${t.ink}/${t.accent}/${t.accentAlt}`;
        if (key === this.themeKey) {
            return;
        }
        this.themeKey = key;
        this.flakeTint = mixColor(t.ink, t.accent, 0.15);
        const top = mixColor(0xffffff, t.accent, 0.06);
        const shade = mixColor(mixColor(top, 0x8fa8d6, 0.55), t.accentAlt, 0.1);
        this.rimColor = mixColor(0xffffff, t.ink, 0.1);
        this.gradient?.destroy();
        this.gradient = new FillGradient({
            type: 'linear',
            start: { x: 0, y: 0 },
            end: { x: 0, y: 1 },
            colorStops: [
                { offset: 0, color: top },
                { offset: 0.45, color: mixColor(top, shade, 0.35) },
                { offset: 1, color: shade },
            ],
            textureSpace: 'local',
        });
        for (const s of this.surfaces.values()) {
            s.drawn = -1;
        }
    }

    // ---- flakes -------------------------------------------------------------------------

    private spawn(tick: TickContext, width: number, height: number): void {
        const set = this.flakes;
        const room = Math.floor(set.allowed * 0.92);
        if (this.age < 700) {
            // The first moment: snow already in the air everywhere, not a curtain arriving from the top.
            while (set.canSpawn() && set.alive < room) {
                this.addFlake(this.pickLayer(), randomNumber(-100, width + 100), randomNumber(-20, height), 0, 0);
            }
            return;
        }
        this.spawnDebt += (set.allowed * 0.049 * clamp(this.meanSpeed / 0.055, 1, 8) * tick.timeDelta) / Math.max(200, height + 20);
        const wind = tick.forces.sample(width / 2, height / 2, this.acc, this.effectName).x;
        const side = clamp(Math.abs(wind) * 500, 0, 0.85);
        while (this.spawnDebt >= 1) {
            this.spawnDebt -= 1;
            if (!set.canSpawn() || set.alive >= room) {
                this.spawnDebt = Math.min(this.spawnDebt, 6);
                break;
            }
            if (Math.random() < side) {
                // Wind from one side: flakes also arrive from that edge, so the corners are not bare.
                const x = wind > 0 ? randomNumber(-120, -10) : width + randomNumber(10, 120);
                this.addFlake(this.pickLayer(), x, randomNumber(-20, height * 0.9), 0, 0);
            } else {
                this.addFlake(this.pickLayer(), randomNumber(-150, width + 150), randomNumber(-30, -8), 0, 0);
            }
        }
    }

    private pickLayer(): number {
        const r = Math.random();
        return r < 0.4 ? 0 : r < 0.75 ? 1 : 2;
    }

    private addFlake(layer: number, x: number, y: number, vx: number, vy: number, area?: number): Flake | undefined {
        const spec = LAYERS[layer];
        const size = randomNumber(spec.size[0], spec.size[1]);
        const fall = randomNumber(spec.fall[0], spec.fall[1]);
        const flake = new Flake({
            position: { x, y },
            size: { x: size, y: size },
            velocity: { x: vx, y: vy === 0 ? fall : vy },
            priority: spec.priority,
        });
        flake.layer = layer;
        flake.fall = fall;
        flake.phase = randomNumber(0, Math.PI * 2);
        flake.phase2 = randomNumber(0, Math.PI * 2);
        flake.phaseRate = (Math.PI * 2) / randomNumber(1800, 4200);
        flake.sway = randomNumber(0.008, 0.026) * (layer === 0 ? 0.7 : 1);
        flake.area = area ?? spec.area;
        flake.alpha = 1;
        flake.view = this.acquireView();
        this.flakes.add(flake);
        return flake;
    }

    private moveFlakes(tick: TickContext, width: number, height: number): void {
        const dt = tick.timeDelta;
        const damp = 1 - Math.exp(-DRAG * dt);
        const items = this.flakes.items;
        const acc = this.acc;
        let speedSum = 0;
        for (let i = 0; i < items.length; i++) {
            const f = items[i];
            tick.forces.sample(f.position.x, f.position.y, acc, this.effectName);
            f.phase += f.phaseRate * dt;
            const flutter = Math.sin(f.phase) * f.sway * (0.7 + 0.3 * Math.sin(f.phase * 0.37 + f.phase2));
            f.velocity.x += acc.x * LIGHTNESS * dt;
            f.velocity.y += acc.y * LIGHTNESS * dt;
            f.velocity.x += (flutter - f.velocity.x) * damp;
            f.velocity.y += (f.fall - f.velocity.y) * damp;
            f.position.x += f.velocity.x * dt;
            f.position.y += f.velocity.y * dt;
            speedSum += Math.hypot(f.velocity.x, f.velocity.y);

            const x = f.position.x;
            const y = f.position.y;
            if (y > height + 20 || (x < -150 && f.velocity.x < 0) || (x > width + 150 && f.velocity.x > 0) || x < -400 || x > width + 400) {
                f.removeRequested = true;
                continue;
            }
            if (f.life === 'alive' && LAYERS[f.layer].settles && f.area > 0) {
                this.tryLand(f);
            }
        }
        if (items.length > 0) {
            this.meanSpeed = speedSum / items.length;
        }
    }

    /** A flake that reaches the snow surface of a column becomes part of the pile. */
    private tryLand(f: Flake): void {
        const list = this.surfaceList;
        for (let i = 0; i < list.length; i++) {
            const s = list[i];
            const rel = f.position.x - s.x;
            if (rel < 0 || rel > s.width) {
                continue;
            }
            const top = s.y - s.cap.heightAt(rel);
            if (f.position.y >= top && (s.ground || f.position.y <= s.y + 14)) {
                s.cap.deposit(rel, f.area);
                s.version++;
                s.active = true;
                f.removeRequested = true;
                return;
            }
        }
    }

    // ---- surfaces -----------------------------------------------------------------------

    private syncSurfaces(tick: TickContext, width: number, height: number): void {
        for (const s of this.surfaces.values()) {
            s.seen = false;
        }
        if (this.groundDepth > 0) {
            this.ensureSurface(GROUND, true, 0, height, width, this.groundDepth);
        }
        if (this.pageInteraction && this.ledgeDepth > 0) {
            for (const ledge of tick.stage.tagged('ledge')) {
                if (ledge.width >= 8) {
                    this.ensureSurface(ledge.name, false, ledge.x, ledge.y, ledge.width, this.ledgeDepth);
                }
            }
        }
        let changed = false;
        for (const [key, s] of this.surfaces) {
            if (!s.seen) {
                s.g.destroy();
                this.surfaces.delete(key);
                changed = true;
            }
        }
        if (changed || this.surfaceList.length !== this.surfaces.size) {
            this.surfaceList.length = 0;
            for (const s of this.surfaces.values()) {
                this.surfaceList.push(s);
            }
        }
    }

    private ensureSurface(key: string, ground: boolean, x: number, y: number, width: number, depth: number): void {
        let s = this.surfaces.get(key);
        if (!s) {
            const g = new Graphics();
            this.host.pixi.addChildAt(g, 0);
            s = {
                key,
                ground,
                cap: new SnowCap(width, depth, !ground),
                x,
                y,
                width,
                g,
                version: 1,
                drawn: 0,
                seen: true,
                active: false,
                meltDebt: 0,
                spindrift: 0,
            };
            this.surfaces.set(key, s);
        }
        s.seen = true;
        s.x = x;
        s.y = y;
        if (Math.abs(width - s.width) > 0.5) {
            s.cap.resize(width);
            s.width = width;
            s.version++;
            s.active = true;
        }
    }

    /** Relax, melt and wind for every surface. */
    private weather(tick: TickContext): void {
        const dt = tick.timeDelta;
        const windPoint = this.acc;
        for (const s of this.surfaceList) {
            const cap = s.cap;
            if (cap.total <= 0) {
                continue;
            }
            s.meltDebt += (this.melt * dt) / 1000;
            if (s.meltDebt >= 0.06) {
                cap.melt(s.meltDebt);
                s.meltDebt = 0;
                s.version++;
            }

            // Strong wind (the hand-push is about 0.0011 px/ms², natural gusts 0.00016) shaves the tops.
            tick.forces.sample(s.x + s.width / 2, s.y - 8, windPoint, this.effectName);
            const strength = smoothstep(0.0005, 0.0011, Math.abs(windPoint.x));
            if (strength > 0.02) {
                const dir = windPoint.x > 0 ? 1 : -1;
                const removed = cap.shave(strength * 0.035 * (dt / 16.67));
                if (removed > 0) {
                    s.version++;
                    s.active = true;
                    s.spindrift += removed;
                    let n = 0;
                    while (s.spindrift >= 5 && n < 3) {
                        s.spindrift -= 5;
                        n++;
                        const lee = Math.pow(Math.random(), 2) * s.width;
                        const rel = dir > 0 ? s.width - lee : lee;
                        this.puff(s, rel, dir * randomNumber(0.1, 0.3), randomNumber(-0.09, 0), 5);
                    }
                }
            }

            if (s.active) {
                const moved = cap.relax(2);
                if (moved > 0.01) {
                    s.version++;
                } else {
                    s.active = false;
                }
                // What slid off the end of an element falls on as flakes.
                if (cap.fellLeft > 0) {
                    this.spill(s, 0, -1, cap.fellLeft);
                }
                if (cap.fellRight > 0) {
                    this.spill(s, s.width, 1, cap.fellRight);
                }
            }
        }
    }

    private spill(s: Surface, rel: number, side: number, volume: number): void {
        const n = Math.min(2, Math.floor(volume / 6 + Math.random()));
        for (let i = 0; i < n; i++) {
            if (this.puffs < MAX_PUFF_PER_TICK && this.flakes.canSpawn()) {
                this.puffs++;
                this.addFlake(Math.random() < 0.5 ? 1 : 2, s.x + rel + side * 2, s.y - 2, side * randomNumber(0.01, 0.05), 0, volume / Math.max(1, n));
            }
        }
    }

    /** Throw one flake of `volume` px² from the snow surface at `rel` along a surface. */
    private puff(s: Surface, rel: number, vx: number, vy: number, volume: number): void {
        if (this.puffs >= MAX_PUFF_PER_TICK || !this.flakes.canSpawn()) {
            return;
        }
        this.puffs++;
        const r = clamp(rel, 0, s.width);
        this.addFlake(Math.random() < 0.45 ? 1 : 2, s.x + r, s.y - s.cap.heightAt(r) - 1, vx, vy, volume);
    }

    // ---- disturbing the piles -----------------------------------------------------------

    private hearEvents(tick: TickContext): void {
        for (const e of tick.events('crystal:exploded')) {
            this.blast(e.payload.x, e.payload.y, 220, 70, 22, 0.35, 0);
        }
        for (const e of tick.events('rainEater:exploded')) {
            this.blast(e.payload.x, e.payload.y, 220, 80, 24, 0.4, 0);
        }
        for (const e of tick.events('lightning:strike')) {
            this.blast(e.payload.x, e.payload.y, 200, 60, 18, 0.4, 0);
        }
        for (const e of tick.events('meteor:impact')) {
            const p = clamp(e.payload.power, 0, 1);
            this.blast(e.payload.x, e.payload.y, 220 + p * 100, 60 + p * 60, 18 + p * 16, 0.4 + p * 0.2, 0);
        }
        for (const e of tick.events('singularity:collapsed')) {
            this.blast(e.payload.x, e.payload.y, 900, 90, 20, 0.45, 0.25);
        }
        for (const e of tick.events('firework:exploded')) {
            for (const s of this.surfaceList) {
                const px = clamp(e.payload.x, s.x, s.x + s.width);
                const d = Math.hypot(e.payload.x - px, e.payload.y - (s.y - s.cap.heightAt(px - s.x)));
                if (d < 260) {
                    s.cap.meltAt(px - s.x, 170, 3 * (1 - d / 260) * (0.5 + e.payload.power));
                    s.version++;
                }
            }
        }
        for (const e of tick.events('page:hit')) {
            const s = this.surfaces.get(e.payload.anchor);
            if (!s) {
                continue;
            }
            const rel = e.payload.x - s.x;
            const removed = s.cap.carve(rel, 12, 4);
            if (removed > 0) {
                s.version++;
                s.active = true;
                const n = Math.min(4, Math.ceil(removed / 12));
                for (let i = 0; i < n; i++) {
                    this.puff(s, rel + randomNumber(-8, 8), randomNumber(-0.08, 0.08), randomNumber(-0.14, -0.04), removed / n);
                }
            }
        }
        if (tick.mouseJustPressed && !tick.mouseOnInteractive && tick.mousePosition) {
            this.blast(tick.mousePosition.x, tick.mousePosition.y, 120, 45, 18, 0.25, 0);
        }
    }

    /**
     * Knock snow off every pile within `reach` px of a point, as a puff of flakes thrown away from it.
     * `minK` keeps a floor under the strength, so a blast that is felt everywhere still reaches far piles.
     */
    private blast(ex: number, ey: number, reach: number, radius: number, depth: number, speed: number, minK: number): void {
        for (const s of this.surfaceList) {
            if (s.cap.total <= 0) {
                continue;
            }
            const px = clamp(ex, s.x, s.x + s.width);
            const rel = px - s.x;
            const top = s.y - s.cap.heightAt(rel);
            const dx = px - ex;
            const dy = top - ey;
            const d = Math.hypot(dx, dy);
            if (d > reach) {
                continue;
            }
            const k = Math.max(minK, 1 - d / reach);
            const removed = s.cap.carve(rel, radius * (0.6 + 0.8 * k), depth * (0.35 + 0.65 * k));
            if (removed <= 0) {
                continue;
            }
            s.version++;
            s.active = true;
            const n = Math.min(14, Math.ceil(removed / 14));
            const len = d > 1 ? d : 1;
            for (let i = 0; i < n; i++) {
                const away = d > 1 ? 1 : 0;
                const sp = speed * (0.4 + k) * randomNumber(0.5, 1.2);
                const vx = (dx / len) * sp * away + randomNumber(-0.12, 0.12) * (1 + k);
                const vy = (dy / len) * sp * away - 0.08 - randomNumber(0, 0.18) * k;
                this.puff(s, rel + randomNumber(-radius, radius) * 0.6, vx, vy, removed / n);
            }
        }
    }

    /** Moving the pointer through a pile wipes snow off it. */
    private touchWithPointer(tick: TickContext): void {
        const m = tick.mousePosition;
        if (!m) {
            this.lastMouse = undefined;
            return;
        }
        const last = this.lastMouse;
        if (!last) {
            this.lastMouse = { x: m.x, y: m.y };
            return;
        }
        const mx = m.x - last.x;
        const my = m.y - last.y;
        const speed = Math.hypot(mx, my);
        last.x = m.x;
        last.y = m.y;
        if (speed < 1.5) {
            return;
        }
        const radius = 18 + Math.min(speed * 0.6, 24);
        const depth = Math.min(14, 4 + speed * 0.3);
        const steps = Math.min(6, Math.ceil(speed / 12));
        for (const s of this.surfaceList) {
            if (s.cap.total <= 0) {
                continue;
            }
            let removed = 0;
            let at = 0;
            for (let i = 1; i <= steps; i++) {
                const px = m.x - (mx * (steps - i)) / steps;
                const py = m.y - (my * (steps - i)) / steps;
                const rel = px - s.x;
                if (rel < -radius || rel > s.width + radius) {
                    continue;
                }
                const top = s.y - s.cap.heightAt(clamp(rel, 0, s.width));
                if (py > top - radius * 0.7 && py < s.y + radius * 0.35) {
                    const r = s.cap.carve(rel, radius, depth);
                    if (r > 0) {
                        removed += r;
                        at = rel;
                    }
                }
            }
            if (removed > 0) {
                s.version++;
                s.active = true;
                const n = Math.min(6, Math.ceil(removed / 12));
                for (let i = 0; i < n; i++) {
                    this.puff(
                        s,
                        at + randomNumber(-radius, radius) * 0.5,
                        (mx / tick.timeDelta) * 0.25 + randomNumber(-0.06, 0.06),
                        (my / tick.timeDelta) * 0.15 - randomNumber(0.05, 0.16),
                        removed / n,
                    );
                }
            }
        }
    }

    // ---- drawing ------------------------------------------------------------------------

    private drawSurface(s: Surface): void {
        const g = s.g;
        g.clear();
        const cap = s.cap;
        const n = cap.cols;
        const cw = cap.colWidth;
        const h = cap.heights;
        if (cap.total < 0.4 || !this.gradient) {
            return;
        }
        const base = s.ground ? 6 : 1;
        const w = n * cw;
        const startY = s.ground ? -h[0] : 0;
        const endY = s.ground ? -h[n - 1] : 0;

        g.moveTo(0, base).lineTo(0, startY);
        g.quadraticCurveTo(0.5 * cw, -h[0], cw, -(h[0] + h[1]) / 2);
        for (let i = 1; i < n - 1; i++) {
            g.quadraticCurveTo((i + 0.5) * cw, -h[i], (i + 1) * cw, -(h[i] + h[i + 1]) / 2);
        }
        g.quadraticCurveTo((n - 0.5) * cw, -h[n - 1], w, endY);
        g.lineTo(w, base).closePath();
        g.fill({ fill: this.gradient, alpha: 0.86 });

        // A brighter rim along the top, only where there is snow to have a top.
        let start = -1;
        for (let i = 0; i <= n; i++) {
            const on = i < n && h[i] > 0.7;
            if (on && start < 0) {
                start = i;
            } else if (!on && start >= 0) {
                g.moveTo((start + 0.5) * cw, -h[start]);
                for (let k = start; k < i - 1; k++) {
                    g.quadraticCurveTo((k + 0.5) * cw, -h[k], (k + 1) * cw, -(h[k] + h[k + 1]) / 2);
                }
                g.lineTo((i - 0.5) * cw, -h[i - 1]);
                start = -1;
            }
        }
        g.stroke({ width: 1.4, color: this.rimColor, alpha: 0.9, cap: 'round', join: 'round' });
    }

    // ---- views --------------------------------------------------------------------------

    private acquireView(): PixiParticle {
        let view = this.viewPool.pop();
        if (!view) {
            view = new PixiParticle({ texture: this.texture, anchorX: 0.5, anchorY: 0.5 });
        }
        view.alpha = 0;
        this.container.addParticle(view);
        return view;
    }

    private releaseView(flake: Flake): void {
        const view = flake.view;
        if (!view) {
            return;
        }
        flake.view = undefined;
        this.container.removeParticle(view);
        this.viewPool.push(view);
    }
}

/** A soft round dot: a bright core fading out to nothing. */
function drawDot(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = DOT;
    canvas.height = DOT;
    const ctx = canvas.getContext('2d');
    if (ctx) {
        const c = DOT / 2;
        const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
        grad.addColorStop(0, 'rgba(255,255,255,1)');
        grad.addColorStop(0.4, 'rgba(255,255,255,0.8)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, DOT, DOT);
    }
    return canvas;
}
