import { Particle as PixiParticle, ParticleContainer, Texture } from 'pixi.js';
import {
    AdditiveBlending,
    BufferAttribute,
    BufferGeometry,
    Color,
    DynamicDrawUsage,
    Points,
    ShaderMaterial,
} from 'three';
import { Effect } from '../../src/Effect';
import { ParticleSet } from '../../src/Governor';
import { distanceV2, randomNumber } from '../../src/math';
import type { EffectContext, Theme, TickContext, TimedContext, Vector3 } from '../../src/types';
import type { FireworkExplodedEvent, FireworksContext } from '../contracts';
import { Firework, type FireworkHost } from './Firework';
import { FireworkTrail } from './FireworkTrail';

const MAX_SPARKS = 2400;
const TRAIL_CAPACITY = 600;
const DOT_TEX = 32;
const STEM_TINT = 0xffb45a;

export interface FireworksOptions {
    /** Shells in flight at once at full budget. Default `FIREWORK_COUNT` (10). Also `setShellTarget`. */
    shells?: number;
    /** Minimum milliseconds between launches. Default `LAUNCH_INTERVAL` (280). */
    launchInterval?: number;
    /** Sparks in one burst at full budget. Default `FIREWORK_EXPLOSION_PARTICLE_COUNT` (100). */
    sparksPerBurst?: number;
}

/**
 * The original Fireworks, drawn with both renderers.
 *
 *   - stems and trails are Pixi particles behind the 3D scene, so the glass crystal refracts them;
 *   - the burst is a Three.js point cloud with real depth.
 *
 * Mutual effects:
 *   - every burst emits `firework:exploded`, pushes a shock ring through the force field (the rain
 *     is thrown outward and the picture ripples) and lights the sky for a moment;
 *   - stems and sparks are bent by the force field: wind, the rain eater's pull and other shocks;
 *   - a stem that flies into the rain eater's reach bursts early; space bursts every shell.
 */
export class FireworksEffect extends Effect<FireworksContext> implements FireworkHost {
    public effectName: string = 'fireworks';

    public static readonly FIREWORK_COUNT = 10;

    /** How many shells to keep in flight at full budget. */
    public setShellTarget(count: number): void {
        this.shellTarget = Math.max(1, Math.floor(count));
    }

    public static readonly FIREWORK_STEM_MIN_SIZE = 4;
    public static readonly FIREWORK_STEM_MAX_SIZE = 10;
    public static readonly FIREWORK_STEM_MIN_VELOCITY = -0.5;
    public static readonly FIREWORK_STEM_MAX_VELOCITY = -0.05;
    public static readonly FIREWORK_STEM_ACCELERATION = 0.00003;
    public static readonly FIREWORK_STEM_MIN_HEIGHT = 100;

    /** In ticks, as in the original. */
    public static readonly FIREWORK_TRAIL_INTERVAL = 1;
    /** Alpha lost per 16.667 ms. */
    public static readonly FIREWORK_TRAIL_ALPHA_DECAY = 0.01;

    public static readonly FIREWORK_EXPLOSION_PARTICLE_COUNT = 100;
    public static readonly FIREWORK_EXPLOSION_PARTICLE_GRAVITY = 0.001;
    // Point sprites are soft-edged, so they read smaller than their box: 3–9 px looked like dust.
    public static readonly FIREWORK_EXPLOSION_PARTICLE_MIN_SIZE = 7;
    public static readonly FIREWORK_EXPLOSION_PARTICLE_MAX_SIZE = 20;

    /** Minimum time between launches in milliseconds. */
    public static readonly LAUNCH_INTERVAL = 280;
    public static readonly EXPLOSION_MIN_SPEED = 0.08;
    public static readonly EXPLOSION_MAX_SPEED = 0.5;
    public static readonly EXPLOSION_MIN_LIFE = 900;
    public static readonly EXPLOSION_MAX_LIFE = 1700;
    /** Velocity kept per millisecond. */
    public static readonly EXPLOSION_DRAG = 0.9992;
    /** Sparks this far outside the stage are dropped. */
    public static readonly EXPLOSION_EXIT_MARGIN = 100;
    public static readonly FLASH_DURATION = 300;

    private readonly fireworks: Firework[] = [];
    private readonly trails: ParticleSet<FireworkTrail>;

    // Sparks, structure-of-arrays. Colour is written straight into its attribute.
    private readonly px = new Float32Array(MAX_SPARKS);
    private readonly py = new Float32Array(MAX_SPARKS);
    private readonly pz = new Float32Array(MAX_SPARKS);
    private readonly vx = new Float32Array(MAX_SPARKS);
    private readonly vy = new Float32Array(MAX_SPARKS);
    private readonly vz = new Float32Array(MAX_SPARKS);
    private readonly life = new Float32Array(MAX_SPARKS);
    private readonly span = new Float32Array(MAX_SPARKS);
    private readonly size = new Float32Array(MAX_SPARKS);
    private readonly phase = new Float32Array(MAX_SPARKS);
    private count = 0;

    private container!: ParticleContainer;
    private dotTexture!: Texture;
    private readonly viewPool: PixiParticle[] = [];

    private points!: Points<BufferGeometry, ShaderMaterial>;
    private positions!: BufferAttribute;
    private looks!: BufferAttribute; // x = size, y = brightness
    private colors!: BufferAttribute;

    private readonly force: Vector3 = { x: 0, y: 0 };
    private readonly shellColor = new Color();
    private readonly context: FireworksContext = { fireworks: 0, sparks: 0 };
    private readonly launchInterval: number;
    private readonly sparksPerBurst: number;
    private launchTimer: number;
    private shellTarget: number;
    private shellsLaunched = 0;
    private flash = 0;
    /** The tick being simulated: `detonate` is called back from inside it and needs its channels. */
    private tick: TickContext | null = null;

    constructor(options: FireworksOptions = {}) {
        super();
        this.launchInterval = options.launchInterval ?? FireworksEffect.LAUNCH_INTERVAL;
        this.sparksPerBurst = options.sparksPerBurst ?? FireworksEffect.FIREWORK_EXPLOSION_PARTICLE_COUNT;
        this.launchTimer = this.launchInterval;
        this.shellTarget = Math.max(1, Math.floor(options.shells ?? FireworksEffect.FIREWORK_COUNT));
        this.trails = new ParticleSet<FireworkTrail>({
            capacity: TRAIL_CAPACITY,
            exitDuration: 220,
            maxBirthsPerTick: 24,
            maxExitsPerTick: 30,
            onRemove: (trail) => {
                this.releaseView(trail);
                trail.owner.liveTrails--;
            },
        });
    }

    public initialize(): void {
        this.dotTexture = Texture.from(drawDot());
        this.container = new ParticleContainer({
            texture: this.dotTexture,
            dynamicProperties: { position: true, vertex: true, color: true },
        });
        this.container.blendMode = 'add';
        this.host.pixi.addChild(this.container);

        const geometry = new BufferGeometry();
        this.positions = new BufferAttribute(new Float32Array(MAX_SPARKS * 3), 3);
        this.positions.setUsage(DynamicDrawUsage);
        this.looks = new BufferAttribute(new Float32Array(MAX_SPARKS * 2), 2);
        this.looks.setUsage(DynamicDrawUsage);
        this.colors = new BufferAttribute(new Float32Array(MAX_SPARKS * 3), 3);
        this.colors.setUsage(DynamicDrawUsage);
        geometry.setAttribute('position', this.positions);
        geometry.setAttribute('aLook', this.looks);
        geometry.setAttribute('aColor', this.colors);
        geometry.setDrawRange(0, 0);

        const material = new ShaderMaterial({
            uniforms: {
                uResolution: this.host.surfaces.behind.uResolution,
                uStageHeight: { value: 1 },
            },
            vertexShader: /* glsl */ `
                attribute vec2 aLook;
                attribute vec3 aColor;
                uniform vec2 uResolution;
                uniform float uStageHeight;
                varying float vAlpha;
                varying vec3 vColor;
                void main() {
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    gl_Position = projectionMatrix * mv;
                    // Size in stage pixels at z = 0, growing as a spark comes toward the viewer.
                    float depthScale = -(modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).z / max(1.0, -mv.z);
                    gl_PointSize = aLook.x * depthScale * (uResolution.y / uStageHeight);
                    vAlpha = aLook.y;
                    vColor = aColor;
                }
            `,
            fragmentShader: /* glsl */ `
                varying float vAlpha;
                varying vec3 vColor;
                void main() {
                    vec2 q = gl_PointCoord - 0.5;
                    float d = length(q) * 2.0;
                    float core = smoothstep(0.3, 0.0, d);
                    float halo = smoothstep(1.0, 0.0, d);
                    vec3 col = vColor * halo * halo * 2.6 + mix(vColor, vec3(1.0), 0.6) * core * 3.2;
                    // Additive: alpha 0 so the composite adds this light instead of covering what is behind.
                    gl_FragColor = vec4(col * vAlpha, 0.0);
                }
            `,
            blending: AdditiveBlending,
            premultipliedAlpha: true,
            transparent: true,
            depthTest: false,
            depthWrite: false,
        });
        this.points = new Points(geometry, material);
        this.points.frustumCulled = false;
        this.points.renderOrder = 10;
        this.host.three.add(this.points);
    }

    // ---- FireworkHost ----

    public spawnTrail(owner: Firework, x: number, y: number, size: number): void {
        if (!this.trails.canSpawn()) {
            return;
        }
        const trail = new FireworkTrail({ position: { x, y }, size: { x: size, y: size } }, owner);
        trail.view = this.acquireView();
        owner.liveTrails++;
        this.trails.add(trail);
    }

    public detonate(owner: Firework): void {
        const tick = this.tick;
        if (!tick) {
            return;
        }
        const stem = owner.stem;
        this.releaseView(stem);
        const x = stem.position.x;
        const y = stem.position.y;
        const power = stem.power;

        const amount = Math.round(this.sparksPerBurst * tick.budget.budget);
        this.burst(x, y, amount, this.nextShellColor(tick.theme));

        const event: FireworkExplodedEvent = { x, y, power };
        tick.emit('firework:exploded', event);
        tick.forces.shock(this.effectName, {
            x,
            y,
            strength: 0.0022 + power * 0.0015,
            maxRadius: 260 + power * 120,
            width: 55,
        });
        this.flash = Math.max(this.flash, 0.35 + power * 0.25);
    }

    // ---- simulation ----

    private nextShellColor(theme: Theme): number {
        switch (this.shellsLaunched++ % 5) {
            case 0:
                return theme.accent;
            case 1:
                return theme.accentAlt;
            case 2:
                return theme.ink;
            case 3:
                return STEM_TINT;
            default:
                return 0xff6f91;
        }
    }

    private burst(x: number, y: number, amount: number, hex: number): void {
        // One colour conversion per shell; particles vary around it.
        const base = this.shellColor.setHex(hex);
        const colors = this.colors.array as Float32Array;
        for (let i = 0; i < amount && this.count < MAX_SPARKS; i++) {
            const n = this.count++;
            // Random direction on a sphere, so some sparks come at the viewer and some recede.
            const u = Math.random() * 2 - 1;
            const theta = Math.random() * Math.PI * 2;
            const ring = Math.sqrt(1 - u * u);
            const speed = randomNumber(FireworksEffect.EXPLOSION_MIN_SPEED, FireworksEffect.EXPLOSION_MAX_SPEED);
            this.px[n] = x;
            this.py[n] = y;
            this.pz[n] = 0;
            this.vx[n] = Math.cos(theta) * ring * speed;
            this.vy[n] = Math.sin(theta) * ring * speed - 0.05;
            this.vz[n] = u * speed;
            this.span[n] = randomNumber(FireworksEffect.EXPLOSION_MIN_LIFE, FireworksEffect.EXPLOSION_MAX_LIFE);
            this.life[n] = this.span[n];
            this.size[n] = randomNumber(
                FireworksEffect.FIREWORK_EXPLOSION_PARTICLE_MIN_SIZE,
                FireworksEffect.FIREWORK_EXPLOSION_PARTICLE_MAX_SIZE,
            );
            this.phase[n] = Math.random() * Math.PI * 2;
            const brightness = randomNumber(0.82, 1.18);
            const o = n * 3;
            colors[o] = base.r * brightness * randomNumber(0.94, 1.06);
            colors[o + 1] = base.g * brightness * randomNumber(0.94, 1.06);
            colors[o + 2] = base.b * brightness * randomNumber(0.94, 1.06);
        }
    }

    private removeSpark(index: number): void {
        const last = --this.count;
        if (index === last) {
            return;
        }
        this.px[index] = this.px[last];
        this.py[index] = this.py[last];
        this.pz[index] = this.pz[last];
        this.vx[index] = this.vx[last];
        this.vy[index] = this.vy[last];
        this.vz[index] = this.vz[last];
        this.life[index] = this.life[last];
        this.span[index] = this.span[last];
        this.size[index] = this.size[last];
        this.phase[index] = this.phase[last];
        const colors = this.colors.array as Float32Array;
        colors[index * 3] = colors[last * 3];
        colors[index * 3 + 1] = colors[last * 3 + 1];
        colors[index * 3 + 2] = colors[last * 3 + 2];
    }

    private launch(tickContext: TickContext): void {
        const stage = tickContext.stage;
        const x = randomNumber(30, Math.max(31, stage.width - 30));
        const y = stage.height + 30;
        const firework = new Firework({ x, y });
        firework.stem.view = this.acquireView();
        this.fireworks.push(firework);
    }

    public onTick(tickContext: TickContext): EffectContext<FireworksContext> {
        const dt = tickContext.timeDelta;
        const stage = tickContext.stage;
        this.tick = tickContext;
        this.trails.govern(tickContext);

        // The press edge, not the held key: the original listened while it was held.
        if (tickContext.justPressedKeys?.includes('space')) {
            for (const firework of this.fireworks) {
                firework.explode(this);
            }
        }

        const eater = tickContext.read('rainEater');
        const eaterHead = eater && !eater.exploded ? eater.headPosition : undefined;
        const eatReach = (eater?.eatDistance ?? 0) * 1.2;

        for (const firework of this.fireworks) {
            if (firework.exploded) {
                continue;
            }
            firework.onTick(tickContext, this);
            if (!firework.exploded && eaterHead && distanceV2(firework.stem.position, eaterHead) < eatReach) {
                firework.explode(this);
            }
        }

        for (const trail of this.trails.items) {
            trail.onTick(tickContext);
        }
        this.trails.sweep(tickContext);

        // Finished shells leave; the original never removed them.
        let inFlight = 0;
        for (let i = this.fireworks.length - 1; i >= 0; i--) {
            const firework = this.fireworks[i];
            if (firework.finished) {
                this.fireworks.splice(i, 1);
            } else if (!firework.exploded) {
                inFlight++;
            }
        }

        // One launch at a time: the original refilled to ten in a single tick.
        this.launchTimer += dt;
        const target = Math.max(1, Math.round(this.shellTarget * tickContext.budget.budget));
        if (inFlight < target && this.launchTimer >= this.launchInterval) {
            this.launchTimer = 0;
            this.launch(tickContext);
            inFlight++;
        }

        this.updateSparks(tickContext, stage.width, stage.height);

        this.flash = Math.max(0, this.flash - (dt * 0.6) / FireworksEffect.FLASH_DURATION);

        this.tick = null;
        this.context.fireworks = inFlight;
        this.context.sparks = this.count;
        return this.publish(this.context);
    }

    private updateSparks(tickContext: TickContext, width: number, height: number): void {
        const dt = tickContext.timeDelta;
        const keep = Math.pow(FireworksEffect.EXPLOSION_DRAG, dt);
        const gravity = FireworksEffect.FIREWORK_EXPLOSION_PARTICLE_GRAVITY;
        const margin = FireworksEffect.EXPLOSION_EXIT_MARGIN;
        // Past this a spark would be almost at the camera.
        const nearLimit = tickContext.stage.camera.position.z * 0.8;
        const force = this.force;
        const forces = tickContext.forces;
        const { px, py, pz, vx, vy, vz, life } = this;
        for (let i = 0; i < this.count; i++) {
            life[i] -= dt;
            if (life[i] <= 0) {
                this.removeSpark(i);
                i--;
                continue;
            }
            // Its own shock ring is skipped: the burst should not be thrown by the ring it made.
            forces.sample(px[i], py[i], force, this.effectName);
            vx[i] = (vx[i] + force.x * dt * 1.2) * keep;
            vy[i] = (vy[i] + (force.y * 1.2 + gravity) * dt) * keep;
            vz[i] *= keep;
            px[i] += vx[i] * dt;
            py[i] += vy[i] * dt;
            pz[i] += vz[i] * dt;
            if (
                px[i] < -margin ||
                px[i] > width + margin ||
                py[i] < -margin ||
                py[i] > height + margin ||
                pz[i] > nearLimit
            ) {
                this.removeSpark(i);
                i--;
            }
        }
    }

    // ---- rendering ----

    public onRender(timedContext: TimedContext): void {
        const lead = timedContext.alpha * timedContext.tickDelta;
        const theme = timedContext.theme;

        for (const firework of this.fireworks) {
            const stem = firework.stem;
            const view = stem.view;
            if (!view || stem.exploded) {
                continue;
            }
            view.x = stem.position.x + stem.velocity.x * lead;
            view.y = stem.position.y + stem.velocity.y * lead;
            const scale = (stem.size.x * 2.6) / DOT_TEX;
            view.scaleX = scale;
            view.scaleY = scale;
            view.tint = STEM_TINT;
            view.alpha = 1;
        }

        const trails = this.trails.items;
        for (let i = 0; i < trails.length; i++) {
            const trail = trails[i];
            const view = trail.view;
            if (!view) {
                continue;
            }
            view.x = trail.position.x;
            view.y = trail.position.y;
            const scale = (trail.size.x * 2.6) / DOT_TEX;
            view.scaleX = scale;
            view.scaleY = scale;
            view.tint = trail.tint(theme);
            view.alpha = Math.max(0, trail.alpha) * (1 - trail.exitProgress);
        }

        const stage = timedContext.stage;
        const time = timedContext.time;
        const halfW = stage.width / 2;
        const halfH = stage.height / 2;
        const positions = this.positions.array as Float32Array;
        const looks = this.looks.array as Float32Array;
        for (let i = 0; i < this.count; i++) {
            const o = i * 3;
            positions[o] = this.px[i] + this.vx[i] * lead - halfW;
            positions[o + 1] = halfH - (this.py[i] + this.vy[i] * lead);
            positions[o + 2] = this.pz[i] + this.vz[i] * lead;
            const t = Math.max(0, this.life[i] / this.span[i]);
            // Late in life the flicker takes over as the life runs out.
            const late = Math.min(1, Math.max(0, (0.5 - t) * 2));
            const flicker = 0.55 + 0.45 * Math.sin(time * 0.045 + this.phase[i]);
            looks[i * 2] = this.size[i] * (0.5 + 0.5 * t);
            looks[i * 2 + 1] = t * (0.35 + 0.65 * t) * (1 - late + late * flicker);
        }
        if (this.count > 0) {
            this.positions.needsUpdate = true;
            this.looks.needsUpdate = true;
            this.colors.needsUpdate = true;
        }
        this.points.geometry.setDrawRange(0, this.count);
        this.points.material.uniforms.uStageHeight.value = stage.height;

        if (this.flash > 0) {
            this.host.surfaces.flash.value += this.flash;
        }
    }

    // ---- views ----

    private acquireView(): PixiParticle {
        let view = this.viewPool.pop();
        if (view) {
            view.texture = this.dotTexture;
        } else {
            view = new PixiParticle({ texture: this.dotTexture });
        }
        view.anchorX = 0.5;
        view.anchorY = 0.5;
        view.alpha = 0;
        this.container.addParticle(view);
        return view;
    }

    private releaseView(owner: { view?: PixiParticle }): void {
        const view = owner.view;
        if (!view) {
            return;
        }
        owner.view = undefined;
        this.container.removeParticle(view);
        this.viewPool.push(view);
    }

    public cleanup(): void {
        this.trails.clear();
        for (const firework of this.fireworks) {
            this.releaseView(firework.stem);
        }
        this.fireworks.length = 0;
        this.viewPool.length = 0;
        this.container?.destroy();
        this.dotTexture?.destroy(true);
        if (this.points) {
            this.points.removeFromParent();
            this.points.geometry.dispose();
            this.points.material.dispose();
        }
        this.count = 0;
        this.flash = 0;
        this.tick = null;
    }
}

/** A soft round dot; tinted and scaled per particle. */
function drawDot(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = DOT_TEX;
    canvas.height = DOT_TEX;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return canvas;
    }
    const half = DOT_TEX / 2;
    const dot = ctx.createRadialGradient(half, half, 0, half, half, half);
    dot.addColorStop(0, 'rgba(255,255,255,1)');
    dot.addColorStop(0.35, 'rgba(255,255,255,0.6)');
    dot.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = dot;
    ctx.fillRect(0, 0, DOT_TEX, DOT_TEX);
    return canvas;
}
