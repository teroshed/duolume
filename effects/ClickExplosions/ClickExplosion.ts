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
import { randomNumber } from '../../src/math';
import type { EffectContext, TickContext, TimedContext, Vector3 } from '../../src/types';
import type { ClickExplosionContext } from '../contracts';

const MAX_SPARKS = 1600;

export interface ClickExplosionOptions {
    /** Sparks in one press at full budget. Default `PRESS_BURST_COUNT` (34). */
    pressBurst?: number;
    /** Downward pull on sparks in px/ms². Default `GRAVITY` (0.00055). 0 lets them float. */
    gravity?: number;
}

/**
 * The original ClickExplosion, with real depth: sparks are Three.js points that fly
 * toward and away from the viewer as well as across the stage.
 *
 * Mutual effects:
 *   - a press sends a shock ring into the force field: the Pixi rain is thrown outward,
 *     the rain eater is shoved, and the composite ripples.
 *   - it answers `rainEater:exploded` and `singularity:collapsed` with a large burst in the
 *     theme's colours, and `lightning:strike`, `crystal:exploded` and `meteor:impact` with
 *     smaller ones.
 *   - sparks are themselves bent by the force field, so the rain eater's pull curls
 *     their trails.
 */
export class ClickExplosion extends Effect<ClickExplosionContext> {
    public effectName: string = 'clickExplosion';

    public static readonly CLICK_EXPLOSION_PARTICLE_COUNT = 10;
    public static readonly PRESS_BURST_COUNT = 34;
    public static readonly EATER_BURST_COUNT = 190;
    public static readonly STRIKE_BURST_COUNT = 26;
    public static readonly CRYSTAL_BURST_COUNT = 60;
    public static readonly IMPACT_BURST_COUNT = 70;
    public static readonly GRAVITY = 0.00055;
    /** Velocity kept per millisecond. */
    public static readonly DRAG = 0.9991;

    // Structure-of-arrays: these are short-lived and numerous, so they are not Particle objects.
    private readonly px = new Float32Array(MAX_SPARKS);
    private readonly py = new Float32Array(MAX_SPARKS);
    private readonly pz = new Float32Array(MAX_SPARKS);
    private readonly vx = new Float32Array(MAX_SPARKS);
    private readonly vy = new Float32Array(MAX_SPARKS);
    private readonly vz = new Float32Array(MAX_SPARKS);
    private readonly life = new Float32Array(MAX_SPARKS);
    private readonly span = new Float32Array(MAX_SPARKS);
    private readonly size = new Float32Array(MAX_SPARKS);
    private readonly hue = new Float32Array(MAX_SPARKS);
    private count = 0;

    private points!: Points<BufferGeometry, ShaderMaterial>;
    private positions!: BufferAttribute;
    private looks!: BufferAttribute; // x = size, y = alpha, z = hue mix
    private readonly force: Vector3 = { x: 0, y: 0 };
    private readonly context: ClickExplosionContext = { explosions: 0, lastBurst: null };
    private readonly pressBurst: number;
    private readonly gravity: number;

    constructor(options: ClickExplosionOptions = {}) {
        super();
        this.pressBurst = options.pressBurst ?? ClickExplosion.PRESS_BURST_COUNT;
        this.gravity = options.gravity ?? ClickExplosion.GRAVITY;
    }

    public initialize(): void {
        const geometry = new BufferGeometry();
        this.positions = new BufferAttribute(new Float32Array(MAX_SPARKS * 3), 3);
        this.positions.setUsage(DynamicDrawUsage);
        this.looks = new BufferAttribute(new Float32Array(MAX_SPARKS * 3), 3);
        this.looks.setUsage(DynamicDrawUsage);
        geometry.setAttribute('position', this.positions);
        geometry.setAttribute('aLook', this.looks);
        geometry.setDrawRange(0, 0);

        const material = new ShaderMaterial({
            uniforms: {
                uResolution: this.host.surfaces.behind.uResolution,
                uStageHeight: { value: 1 },
                uColorA: { value: new Color() },
                uColorB: { value: new Color() },
                uColorHot: { value: new Color() },
            },
            vertexShader: /* glsl */ `
                attribute vec3 aLook;
                uniform vec2 uResolution;
                uniform float uStageHeight;
                varying float vAlpha;
                varying float vHue;
                void main() {
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    gl_Position = projectionMatrix * mv;
                    // Size in stage pixels at z = 0, growing as a spark comes toward the viewer.
                    float depthScale = -(modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).z / max(1.0, -mv.z);
                    gl_PointSize = aLook.x * depthScale * (uResolution.y / uStageHeight);
                    vAlpha = aLook.y;
                    vHue = aLook.z;
                }
            `,
            fragmentShader: /* glsl */ `
                uniform vec3 uColorA;
                uniform vec3 uColorB;
                uniform vec3 uColorHot;
                varying float vAlpha;
                varying float vHue;
                void main() {
                    vec2 q = gl_PointCoord - 0.5;
                    float d = length(q) * 2.0;
                    float core = smoothstep(0.26, 0.0, d);
                    float halo = smoothstep(1.0, 0.0, d);
                    vec3 col = mix(uColorA, uColorB, vHue) * halo * halo * 2.4 + uColorHot * core * 1.8;
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

    /** Start a burst at a stage position. `power` scales speed and size. */
    public burst(x: number, y: number, amount: number, power = 1): void {
        for (let i = 0; i < amount && this.count < MAX_SPARKS; i++) {
            const n = this.count++;
            // Random direction on a sphere, so some sparks come at the viewer and some recede.
            const u = Math.random() * 2 - 1;
            const theta = Math.random() * Math.PI * 2;
            const ring = Math.sqrt(1 - u * u);
            const speed = randomNumber(0.05, 0.46) * power;
            this.px[n] = x;
            this.py[n] = y;
            this.pz[n] = 0;
            this.vx[n] = Math.cos(theta) * ring * speed;
            this.vy[n] = Math.sin(theta) * ring * speed - 0.05 * power;
            this.vz[n] = u * speed * 1.2;
            this.span[n] = randomNumber(520, 1250) * (0.8 + power * 0.25);
            this.life[n] = this.span[n];
            this.size[n] = randomNumber(4, 15) * (0.7 + power * 0.3);
            this.hue[n] = Math.random();
        }
    }

    public onTick(tickContext: TickContext): EffectContext<ClickExplosionContext> {
        const budget = tickContext.budget.budget;
        const mouse = tickContext.mousePosition;

        if (mouse && !tickContext.mouseOnInteractive) {
            if (tickContext.mouseJustPressed) {
                this.burst(mouse.x, mouse.y, Math.round(this.pressBurst * budget), 1);
                this.context.lastBurst = { x: mouse.x, y: mouse.y };
                tickContext.forces.shock(this.effectName, { x: mouse.x, y: mouse.y, strength: 0.0042, maxRadius: 460 });
            } else if (tickContext.mouseDown) {
                // Holding keeps a thinner stream going, as the original did.
                this.burst(mouse.x, mouse.y, Math.round((ClickExplosion.CLICK_EXPLOSION_PARTICLE_COUNT / 3) * budget), 0.7);
            }
        }

        for (const event of tickContext.events('rainEater:exploded')) {
            const { x, y } = event.payload;
            this.burst(x, y, Math.round(ClickExplosion.EATER_BURST_COUNT * budget), 1.7);
            this.context.lastBurst = { x, y };
        }

        for (const event of tickContext.events('lightning:strike')) {
            this.burst(event.payload.x, event.payload.y, Math.round(ClickExplosion.STRIKE_BURST_COUNT * budget), 1.1);
        }
        for (const event of tickContext.events('crystal:exploded')) {
            const size = event.payload.radius / 40;
            this.burst(event.payload.x, event.payload.y, Math.round(ClickExplosion.CRYSTAL_BURST_COUNT * size * budget), 0.8 + size * 0.5);
        }
        for (const event of tickContext.events('meteor:impact')) {
            const { x, y, power } = event.payload;
            this.burst(x, y, Math.round(ClickExplosion.IMPACT_BURST_COUNT * power * budget), 0.7 + power * 0.7);
        }
        for (const event of tickContext.events('singularity:collapsed')) {
            const { x, y } = event.payload;
            this.burst(x, y, Math.round(ClickExplosion.EATER_BURST_COUNT * budget), 1.9);
            this.context.lastBurst = { x, y };
        }

        const dt = tickContext.timeDelta;
        const keep = Math.pow(ClickExplosion.DRAG, dt);
        const force = this.force;
        const forces = tickContext.forces;
        const { px, py, pz, vx, vy, vz, life } = this;
        for (let i = 0; i < this.count; i++) {
            life[i] -= dt;
            if (life[i] <= 0) {
                this.removeAt(i);
                i--;
                continue;
            }
            forces.sample(px[i], py[i], force, this.effectName);
            vx[i] = (vx[i] + force.x * dt * 1.6) * keep;
            vy[i] = (vy[i] + (force.y * 1.6 + this.gravity) * dt) * keep;
            vz[i] *= keep;
            px[i] += vx[i] * dt;
            py[i] += vy[i] * dt;
            pz[i] += vz[i] * dt;
        }

        this.context.explosions = this.count;
        return this.publish(this.context);
    }

    private removeAt(index: number): void {
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
        this.hue[index] = this.hue[last];
    }

    public onRender(timedContext: TimedContext): void {
        const stage = timedContext.stage;
        const lead = timedContext.alpha * timedContext.tickDelta;
        const halfW = stage.width / 2;
        const halfH = stage.height / 2;
        const positions = this.positions.array as Float32Array;
        const looks = this.looks.array as Float32Array;
        for (let i = 0; i < this.count; i++) {
            const o = i * 3;
            positions[o] = this.px[i] + this.vx[i] * lead - halfW;
            positions[o + 1] = halfH - (this.py[i] + this.vy[i] * lead);
            positions[o + 2] = this.pz[i] + this.vz[i] * lead;
            const t = this.life[i] / this.span[i];
            looks[o] = this.size[i] * (0.45 + 0.55 * t);
            looks[o + 1] = t * t;
            looks[o + 2] = this.hue[i];
        }
        if (this.count > 0) {
            this.positions.needsUpdate = true;
            this.looks.needsUpdate = true;
        }
        this.points.geometry.setDrawRange(0, this.count);

        const uniforms = this.points.material.uniforms;
        uniforms.uStageHeight.value = stage.height;
        (uniforms.uColorA.value as Color).setHex(timedContext.theme.accent);
        (uniforms.uColorB.value as Color).setHex(timedContext.theme.accentAlt);
        (uniforms.uColorHot.value as Color).setHex(timedContext.theme.ink);
    }

    public cleanup(): void {
        if (this.points) {
            this.points.removeFromParent();
            this.points.geometry.dispose();
            this.points.material.dispose();
        }
        this.count = 0;
    }
}
