import { AdditiveBlending, Color, Mesh, PlaneGeometry, ShaderMaterial, Vector2, Vector4 } from 'three';
import { Effect } from '../../src/Effect';
import { approach, clamp, mixColor } from '../../src/math';
import type { EffectContext, TickContext, TimedContext, Vector3 } from '../../src/types';
import type { NebulaContext } from '../contracts';
import { CloudLights } from './CloudLights';

/** Event lights in the pool. The shader takes one more: the pointer's lantern, always the last. */
const POOL = 6;
const LIGHTS = POOL + 1;
/** Size of one cell of the coarsest cloud noise, in pixels. Wider than tall: banks, not blobs. */
const CELL_X = 440;
const CELL_Y = 270;
/** The noise repeats every this many cells, so the drift can wrap and never grows without bound. */
const NOISE_PERIOD = 512;

export interface NebulaOptions {
    /** Share of the stage height, from the top, that cloud may occupy, 0.1..1. 1 = the whole stage. Default 0.6 (`Nebula.COVERAGE`). */
    coverage?: number;
    /** How much cloud there is, 0..1, before the rain adds to it. Default 0.5 (`Nebula.DENSITY`). */
    density?: number;
    /** Multiplier on how fast the cloud moves and changes shape, 0..20. 0 = still. Default 1 (`Nebula.DRIFT`). */
    drift?: number;
    /** True: the pointer carries a faint light through the cloud. Default true (`Nebula.POINTER_LIGHT`). */
    pointerLight?: boolean;
    /** True: the cloud gathers in proportion to the droplets the `rain` effect has in the air (full at 600) and clears afterwards. Default true (`Nebula.RAIN_THICKENS`). */
    rainThickens?: boolean;
}

/**
 * Cloud that is dark until something lights it from inside: a faint, slowly drifting veil in the
 * upper part of the stage, drawn by one Three.js quad that only ever adds light. Every flash in
 * the scene becomes a light source within it, so for a moment the cloud's structure shows around
 * a lightning bolt, a firework burst or an impact, in that light's colour.
 *
 * What it listens to:
 * - the force field, sampled across the sky: wind carries the cloud along
 * - the `rain` context: the cloud thickens by up to 0.35 as its droplet count rises to 600, and
 *   thins when the rain stops (option `rainThickens`)
 * - `lightning:strike`: a light in the theme's ink colour at the end and the middle of the bolt,
 *   with one flicker
 * - `firework:exploded`, `meteor:impact`, `crystal:exploded`, `rainEater:exploded`,
 *   `singularity:collapsed`, `fireflies:synced`: a coloured light where it happened
 * - the pointer: it carries a faint lantern through the cloud (option `pointerLight`); a press
 *   (not on a button or link) brightens it briefly. The lights share a pool of six: a new one
 *   takes the place of the weakest
 *
 * What it tells the others: the `nebula` context (how much cloud there is, how many lights are
 * glowing in it). It emits no events and adds no forces.
 *
 * Keys: none.
 */
export class Nebula extends Effect<NebulaContext> {
    public effectName: string = 'nebula';

    public static readonly COVERAGE = 0.6;
    public static readonly DENSITY = 0.5;
    public static readonly DRIFT = 1;
    public static readonly POINTER_LIGHT = true;
    public static readonly RAIN_THICKENS = true;

    /** Drift with no wind at all, in px/ms: slowly to the right and a touch upward. */
    private static readonly BASE_DRIFT_X = 0.011;
    private static readonly BASE_DRIFT_Y = -0.0012;
    /** Cloud speed per unit of wind acceleration, in ms: the wind effect's hand-push (0.0011 px/ms²) gives about 120 px/s. */
    private static readonly WIND_CARRY = 110;
    /** How quickly the cloud takes up a change of wind, per second. */
    private static readonly WIND_EASE = 0.9;
    /** How fast the shapes change while they travel, in noise cells per ms. */
    private static readonly EVOLVE_RATE = 0.000014;
    /** Extra density at full rain, and the droplet count that counts as full rain. */
    private static readonly RAIN_DENSITY = 0.35;
    private static readonly RAIN_FULL = 600;
    /** How quickly cloud gathers and clears, per second (a time constant of about four seconds). */
    private static readonly DENSITY_EASE = 0.25;
    private static readonly POINTER_INTENSITY = 0.22;
    private static readonly POINTER_RADIUS = 260;
    private static readonly POINTER_PRESS = 0.4;

    private readonly coverage: number;
    private readonly baseDensity: number;
    private readonly driftScale: number;
    private readonly pointerLight: boolean;
    private readonly rainThickens: boolean;

    // Simulation state. All of it advances in onTick; onRender only reads it.
    private density: number;
    /** Where the cloud has drifted to, in pixels (wrapped at the noise period). */
    private driftX = 0;
    private driftY = 0;
    /** Cloud velocity this tick in px/ms, for leading the picture between ticks. */
    private velocityX = 0;
    private velocityY = 0;
    /** The wind's share of that velocity, eased: cloud is heavy. */
    private carriedX = 0;
    private carriedY = 0;
    /** Phase of the slow change of shape, in noise cells. */
    private evolve = 0;
    private readonly lights = new CloudLights(POOL);
    private fireworkCount = 0;
    private readonly pointer = { x: 0, y: 0, intensity: 0, boost: 0, color: 0xffffff };

    private readonly force: Vector3 = { x: 0, y: 0 };
    private readonly context: NebulaContext = { density: 0, lights: 0 };
    private mesh: Mesh<PlaneGeometry, ShaderMaterial> | undefined;

    constructor(options: NebulaOptions = {}) {
        super();
        this.coverage = clamp(options.coverage ?? Nebula.COVERAGE, 0.1, 1);
        this.baseDensity = clamp(options.density ?? Nebula.DENSITY, 0, 1);
        this.driftScale = clamp(options.drift ?? Nebula.DRIFT, 0, 20);
        this.pointerLight = options.pointerLight ?? Nebula.POINTER_LIGHT;
        this.rainThickens = options.rainThickens ?? Nebula.RAIN_THICKENS;
        this.density = this.baseDensity;
        this.context.density = this.density;
    }

    public initialize(): void {
        const lights: Vector4[] = [];
        const colors: Color[] = [];
        for (let i = 0; i < LIGHTS; i++) {
            lights.push(new Vector4(0, 0, 0, 1));
            colors.push(new Color());
        }
        const material = new ShaderMaterial({
            uniforms: {
                uStage: { value: new Vector2(1, 1) },
                uDrift: { value: new Vector2() },
                uEvolve: { value: 0 },
                uDensity: { value: this.density },
                uCoverage: { value: this.coverage },
                uGlowA: { value: new Color() },
                uGlowB: { value: new Color() },
                uLight: { value: lights },
                uLightColor: { value: colors },
            },
            vertexShader: VERTEX,
            fragmentShader: FRAGMENT,
            blending: AdditiveBlending,
            premultipliedAlpha: true,
            transparent: true,
            depthTest: false,
            depthWrite: false,
        });
        // A unit quad at z = 0, stretched over the stage every frame.
        this.mesh = new Mesh(new PlaneGeometry(1, 1), material);
        this.mesh.frustumCulled = false;
        // Low, so everything else in the 3D scene draws over the cloud.
        this.mesh.renderOrder = -10;
        this.host.three.add(this.mesh);
    }

    public onTick(tick: TickContext): EffectContext<NebulaContext> {
        const dt = tick.timeDelta;
        const width = tick.stage.width;
        const height = tick.stage.height;
        const theme = tick.theme;

        // Drift: a slow pace of its own plus whatever the wind adds. Three samples across the sky,
        // so a force that only acts in one place (an attractor, a shock ring) hardly moves it.
        const skyY = height * this.coverage * 0.4;
        let windX = 0;
        let windY = 0;
        for (let i = 1; i <= 3; i++) {
            tick.forces.sample(width * i * 0.25, skyY, this.force, this.effectName);
            windX += this.force.x / 3;
            windY += this.force.y / 3;
        }
        this.carriedX = approach(this.carriedX, windX * Nebula.WIND_CARRY, Nebula.WIND_EASE, dt);
        this.carriedY = approach(this.carriedY, windY * Nebula.WIND_CARRY, Nebula.WIND_EASE, dt);
        this.velocityX = (Nebula.BASE_DRIFT_X + this.carriedX) * this.driftScale;
        this.velocityY = (Nebula.BASE_DRIFT_Y + this.carriedY) * this.driftScale;
        this.driftX = wrap(this.driftX + this.velocityX * dt, CELL_X * NOISE_PERIOD);
        this.driftY = wrap(this.driftY + this.velocityY * dt, CELL_Y * NOISE_PERIOD);
        // Fast cloud also churns faster.
        const churn = 1 + Math.hypot(this.carriedX, this.carriedY) / 0.04;
        this.evolve = wrap(this.evolve + Nebula.EVOLVE_RATE * churn * this.driftScale * dt, NOISE_PERIOD);

        // Density: cloud gathers while it rains, and clears again, both slowly.
        let target = this.baseDensity;
        if (this.rainThickens) {
            const dropCount = tick.read('rain')?.dropCount ?? 0;
            target += Nebula.RAIN_DENSITY * clamp(dropCount / Nebula.RAIN_FULL, 0, 1);
        }
        this.density = approach(this.density, Math.min(1, target), Nebula.DENSITY_EASE, dt);

        // Every flash in the scene lights a slot of the pool.
        const lights = this.lights;
        for (const event of tick.events('lightning:strike')) {
            const { x, y, fromX, fromY } = event.payload;
            lights.add(x, y, theme.ink, 1, 420, 350, 120, 0.8);
            lights.add((x + fromX) / 2, (y + fromY) / 2, theme.ink, 1, 420, 350, 120, 0.8);
        }
        for (const event of tick.events('firework:exploded')) {
            const { x, y, power } = event.payload;
            const color = this.fireworkCount++ % 2 === 0 ? theme.accent : theme.accentAlt;
            lights.add(x, y, color, 0.5 + 0.5 * power, 300 + 200 * power, 600);
        }
        for (const event of tick.events('meteor:impact')) {
            const { x, y, power } = event.payload;
            lights.add(x, y, mixColor(theme.ink, theme.accentAlt, 0.5), 0.4 + 0.5 * power, 350, 600);
        }
        for (const event of tick.events('crystal:exploded')) {
            lights.add(event.payload.x, event.payload.y, theme.accent, 0.5, 260, 600);
        }
        for (const event of tick.events('rainEater:exploded')) {
            lights.add(event.payload.x, event.payload.y, theme.accentAlt, 0.9, 500, 900);
        }
        for (const event of tick.events('singularity:collapsed')) {
            lights.add(event.payload.x, event.payload.y, theme.ink, 1, 700, 900);
        }
        for (const event of tick.events('fireflies:synced')) {
            lights.add(event.payload.x, event.payload.y, theme.accent, 0.35, 500, 1500);
        }
        const glowing = lights.step(dt);

        // The pointer's lantern follows with a little lag and fades out when the pointer is gone.
        const pointer = this.pointer;
        const mouse = this.pointerLight ? tick.mousePosition : undefined;
        if (mouse) {
            const arriving = pointer.intensity < 0.01;
            pointer.x = arriving ? mouse.x : approach(pointer.x, mouse.x, 7, dt);
            pointer.y = arriving ? mouse.y : approach(pointer.y, mouse.y, 7, dt);
            if (tick.mouseJustPressed && !tick.mouseOnInteractive) {
                pointer.boost = Nebula.POINTER_PRESS;
            }
        }
        pointer.intensity = approach(pointer.intensity, mouse ? Nebula.POINTER_INTENSITY : 0, 5, dt);
        pointer.boost *= Math.pow(0.5, dt / 250);
        pointer.color = mixColor(theme.accent, theme.ink, 0.5);

        this.context.density = this.density;
        this.context.lights = glowing;
        return this.publish(this.context);
    }

    public onRender(timed: TimedContext): void {
        const mesh = this.mesh;
        if (!mesh) {
            return;
        }
        const stage = timed.stage;
        mesh.scale.set(stage.width, stage.height, 1);

        const uniforms = mesh.material.uniforms;
        (uniforms.uStage.value as Vector2).set(stage.width, stage.height);
        // Lead the drift by its velocity so the cloud moves smoothly between ticks.
        const lead = timed.alpha * timed.tickDelta;
        (uniforms.uDrift.value as Vector2).set(
            (this.driftX + this.velocityX * lead) / CELL_X,
            (this.driftY + this.velocityY * lead) / CELL_Y,
        );
        uniforms.uEvolve.value = this.evolve;
        uniforms.uDensity.value = this.density;
        uniforms.uCoverage.value = this.coverage;
        (uniforms.uGlowA.value as Color).setHex(timed.theme.glowA);
        (uniforms.uGlowB.value as Color).setHex(timed.theme.glowB);

        const lights = uniforms.uLight.value as Vector4[];
        const colors = uniforms.uLightColor.value as Color[];
        const slots = this.lights.slots;
        for (let i = 0; i < POOL; i++) {
            const light = slots[i];
            lights[i].set(light.x, light.y, light.intensity, light.radius);
            colors[i].setHex(light.color);
        }
        const pointer = this.pointer;
        lights[POOL].set(pointer.x, pointer.y, pointer.intensity + pointer.boost, Nebula.POINTER_RADIUS);
        colors[POOL].setHex(pointer.color);
    }

    public cleanup(): void {
        if (this.mesh) {
            this.mesh.removeFromParent();
            this.mesh.geometry.dispose();
            this.mesh.material.dispose();
            this.mesh = undefined;
        }
        this.lights.clear();
        this.density = this.baseDensity;
        this.driftX = 0;
        this.driftY = 0;
        this.velocityX = 0;
        this.velocityY = 0;
        this.carriedX = 0;
        this.carriedY = 0;
        this.evolve = 0;
        this.fireworkCount = 0;
        this.pointer.intensity = 0;
        this.pointer.boost = 0;
        this.context.density = this.density;
        this.context.lights = 0;
    }
}

/** `value` brought into 0..period. */
function wrap(value: number, period: number): number {
    return value - Math.floor(value / period) * period;
}

const VERTEX = /* glsl */ `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

/**
 * The cloud. Eight noise samples per fragment: two for the warp, four octaves for the cloud
 * itself, and none for the shading, because the noise hands back its own slope.
 */
const FRAGMENT = /* glsl */ `
    #define LIGHTS ${LIGHTS}
    varying vec2 vUv;
    uniform vec2 uStage;
    uniform vec2 uDrift;      // noise cells
    uniform float uEvolve;    // noise cells
    uniform float uDensity;
    uniform float uCoverage;
    uniform vec3 uGlowA;
    uniform vec3 uGlowB;
    uniform vec4 uLight[LIGHTS];       // x, y (stage px), intensity, radius
    uniform vec3 uLightColor[LIGHTS];

    const vec2 CELL = vec2(${CELL_X.toFixed(1)}, ${CELL_Y.toFixed(1)});
    const float WARP = 1.1;      // how far the warp pushes, in cells
    const float SOFT = 0.17;     // width of the edge between clear air and full cloud, in noise value
    const float RELIEF = 120.0;  // how tall the cloud's forms are, in pixels

    // The lattice repeats every 256 cells, which is what lets the drift wrap without a jump.
    float hash(vec2 i) {
        i = mod(i, 256.0);
        vec3 p = fract(vec3(i.xyx) * 0.1031);
        p += dot(p, p.yzx + 33.33);
        return fract((p.x + p.y) * p.z);
    }

    // Value noise and its slope: x = value 0..1, yz = d/dx, d/dy.
    vec3 noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = p - i;
        vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
        vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        float k1 = b - a;
        float k2 = c - a;
        float k3 = a - b - c + d;
        return vec3(a + k1 * u.x + k2 * u.y + k3 * u.x * u.y, du * vec2(k1 + k3 * u.y, k2 + k3 * u.x));
    }

    // Four octaves. The slope of the fine octaves is damped: they texture the cloud, the coarse ones shape it.
    vec3 fbm(vec2 p) {
        float value = 0.0;
        vec2 slope = vec2(0.0);
        float amplitude = 1.0;
        float frequency = 1.0;
        float relief = 1.0;
        for (int i = 0; i < 4; i++) {
            vec3 n = noise(p * frequency + float(i) * vec2(37.3, 71.9));
            value += amplitude * n.x;
            slope += amplitude * frequency * relief * n.yz;
            amplitude *= 0.56;
            frequency *= 2.0;
            relief *= 0.78;
        }
        return vec3(value, slope) / 2.05;
    }

    void main() {
        vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uStage;   // stage pixels, y down
        vec2 q = p / CELL - uDrift;

        // A slow warp that moves on its own, so the shapes change while they travel.
        vec3 warpA = noise(q * 0.5 + vec2(uEvolve, 3.7));
        vec3 warpB = noise(q * 0.5 + vec2(31.4, 11.9 + uEvolve));
        vec3 field = fbm(q + (vec2(warpA.x, warpB.x) - 0.5) * WARP);
        // The slope of the warped field, by the chain rule (the warp's own slope comes for free).
        vec2 slope = field.yz + 0.5 * WARP * vec2(dot(field.yz, vec2(warpA.y, warpB.y)), dot(field.yz, vec2(warpA.z, warpB.z)));

        // Cloud lives in the upper part of the stage; its lower edge is ragged, not a line.
        float band = uCoverage * uStage.y;
        float mask = 1.0 - smoothstep(0.5, 0.95, p.y / band + (warpB.x - 0.5) * 0.24);

        // More density lowers the threshold: more and thicker cloud, not just brighter cloud.
        float threshold = mix(0.72, 0.26, uDensity) + (1.0 - mask) * 0.25;
        float above = (field.x - threshold) / SOFT;
        float t = clamp(above, 0.0, 1.0);
        // (A curve with no kink at either end: a kink would show as a contour line once it is lit.)
        float cloud = t * t * t * (t * (t * 6.0 - 15.0) + 10.0) * mask;
        // How far inside a bank this is, past the point where the cloud is already full.
        float depth = smoothstep(1.0, 2.4, above);

        // Treat the density as a height and shade it. The height keeps rising into a bank, ever
        // more gently, so the forms are rounded and no bank has a flat top with a rim.
        slope *= (3.0 / (1.0 + above * above) + 0.4) * mask / CELL;
        vec3 normal = normalize(vec3(-slope * RELIEF, 1.0));

        // Its own light is barely there: edges that face the top left catch a little, cores stay dark.
        vec3 tint = mix(uGlowA, uGlowB, smoothstep(0.3, 0.7, warpA.x));
        float facing = 0.5 + 0.5 * dot(normal, normalize(vec3(-0.55, -0.65, 0.5)));
        vec3 colour = tint * cloud * (0.008 + 0.062 * facing * facing) * (1.0 - 0.35 * cloud);

        // Lights inside it: denser cloud is brighter, and the sides that face a light catch it.
        // The cloud keeps a little of its own colour under any light.
        vec3 albedo = mix(vec3(1.0), tint / max(tint.r, max(tint.g, tint.b)), 0.3);
        float body = cloud * (0.6 + 0.4 * depth);
        for (int i = 0; i < LIGHTS; i++) {
            vec4 light = uLight[i];
            if (light.z <= 0.0) continue;
            vec3 toLight = vec3(light.xy - p, light.w * 0.2);
            float fall = exp(-3.0 * dot(toLight.xy, toLight.xy) / (light.w * light.w));
            float lit = max(dot(normal, normalize(toLight)), 0.0);
            // The last term glows in clear air too, so a light is never invisible.
            colour += uLightColor[i] * albedo * light.z * fall * (body * (0.3 + 0.7 * lit) * 0.62 + 0.012 * fall);
        }

        // Alpha 0: this adds light to the picture and never covers anything.
        gl_FragColor = vec4(colour, 0.0);
    }
`;
