import { Graphics } from 'pixi.js';
import {
    BufferAttribute,
    Color,
    DodecahedronGeometry,
    DoubleSide,
    DynamicDrawUsage,
    Euler,
    IcosahedronGeometry,
    Mesh,
    OctahedronGeometry,
    Quaternion,
    ShaderMaterial,
    Vector3 as ThreeVector3,
    type BufferGeometry,
} from 'three';
import type { EffectHost } from '../../src/Effect';
import { approach, mixColor, randomNumber } from '../../src/math';
import { Particle } from '../../src/Particle';
import type { AnchorRect } from '../../src/Stage';
import type { TickContext, TimedContext, Vector3 } from '../../src/types';

export type CrystalShape = 'gem' | 'icosahedron' | 'octahedron' | 'dodecahedron';

export interface CrystalBodyOptions {
    /** Radius in stage pixels. */
    radius: number;
    shape?: CrystalShape;
    /** How far each axis swells and shrinks as the crystal morphs, 0..0.4. */
    morph?: number;
}

export type ShardState = 'attached' | 'flying' | 'stuck' | 'returning';

/**
 * One facet of a crystal. Attached, it is just part of the mesh. Once the crystal breaks it
 * is a particle like any other — position, velocity, the force field — until it finds its
 * way back to its place.
 */
export class Shard extends Particle {
    public state: ShardState = 'attached';
    /** Depth toward the viewer, in stage pixels, and its velocity. */
    public depth = 0;
    public depthVelocity = 0;
    /** Rotation about the facet's own axis, in radians. */
    public tumble = 0;
    public tumbleRate = 0;
    /** Half the shards notice the page: they can be stopped by an element. */
    public interactive = false;
    /** Chance of being stopped when crossing an element's edge. */
    public edgeChance = 0;
    /** The element this shard is currently flying over without having been stopped. */
    public over?: string;
    public stuckFor = 0;
    public stuckAnchor?: string;
    public readonly stuckOffset: Vector3 = { x: 0, y: 0 };

    /** Where the facet belongs on the crystal, in the model's own space (y up). */
    public readonly home: ThreeVector3;

    constructor(home: ThreeVector3) {
        super({ position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, acceleration: { x: 0, y: 0 }, priority: 6 });
        this.home = home;
    }
}

interface Ring {
    x: number;
    y: number;
    age: number;
}

/**
 * A glass crystal that can break into shards and put itself back together.
 *
 * It is a building block, not an effect: an effect owns one or more bodies, tells each where
 * its centre is every tick, and decides when to break it. The body does the rest — the mesh,
 * the glass shader (which looks through the facets at the Pixi layer behind them), and the
 * shards' flight.
 *
 * Shards and the page: half the shards of a broken crystal are "interactive". When one
 * crosses the edge of a page element tagged `ledge` it is stopped there with a 20–50% chance;
 * while it is over the element it has a small chance each tick of stopping where it is. A
 * stopped shard stays on the element (and scrolls with it), sends a `page:hit` event, and
 * after a few seconds flies home. Until then the crystal has a hole where that facet was.
 */
export class CrystalBody {
    /** Milliseconds shards fly before they turn for home. */
    public static readonly SCATTER_MS = 2100;
    /** Milliseconds a stopped shard stays on the element. */
    public static readonly STUCK_MS = 5200;
    public static readonly GRAVITY = 0.00012;
    /** Velocity kept per millisecond of flight. */
    public static readonly DRAG = 0.9988;
    public static readonly MIN_EDGE_CHANCE = 0.2;
    public static readonly MAX_EDGE_CHANCE = 0.5;
    /** Chance per millisecond of stopping while over an element (about 2.5% per tick). */
    public static readonly INSIDE_CHANCE_PER_MS = 0.0015;
    public static readonly RING_MS = 520;

    public readonly radius: number;
    public readonly shards: Shard[] = [];

    private readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
    private readonly shardAttribute: BufferAttribute;
    private readonly rings: Ring[] = [];
    private readonly ringGraphics: Graphics;
    private readonly morphAmount: number;
    private readonly morphPhase: [number, number, number];
    private flightFor = 0;
    private moving = 0;
    private detachedCount = 0;
    private attributeDirty = false;

    private readonly euler = new Euler();
    private readonly quaternion = new Quaternion();
    private readonly scale = new ThreeVector3();
    private readonly scratch = new ThreeVector3();
    private readonly scratchWorld = new ThreeVector3();
    private readonly homeStage = { x: 0, y: 0, z: 0 };
    private readonly force: Vector3 = { x: 0, y: 0 };

    constructor(host: EffectHost, options: CrystalBodyOptions) {
        this.radius = options.radius;
        this.morphAmount = options.morph ?? 0.14;
        this.morphPhase = [Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28];

        const geometry = buildCrystal(options.shape ?? 'gem');
        const centers = geometry.getAttribute('aCenter') as BufferAttribute;
        for (let i = 0; i < centers.count; i += 3) {
            this.shards.push(new Shard(new ThreeVector3().fromBufferAttribute(centers, i)));
        }
        this.shardAttribute = new BufferAttribute(new Float32Array(centers.count * 4), 4);
        this.shardAttribute.setUsage(DynamicDrawUsage);
        geometry.setAttribute('aShard', this.shardAttribute);

        const surfaces = host.surfaces;
        const material = new ShaderMaterial({
            uniforms: {
                ...surfaces.behind,
                uEnergy: { value: 0 },
                uTimeS: { value: 0 },
                uFade: { value: 1 },
                uRefract: { value: 0.085 },
                uAccent: { value: new Color() },
                uAccentAlt: { value: new Color() },
                uInk: { value: new Color() },
                uKeyDir: { value: new ThreeVector3(-0.45, 0.7, 0.55).normalize() },
            },
            vertexShader: VERTEX,
            fragmentShader: fragment(surfaces.glsl.background, surfaces.glsl.pixiSample),
            side: DoubleSide,
            transparent: true,
            premultipliedAlpha: true,
        });
        this.mesh = new Mesh(geometry, material);
        this.mesh.frustumCulled = false;
        host.three.add(this.mesh);

        this.ringGraphics = new Graphics();
        this.ringGraphics.blendMode = 'add';
        host.pixi.addChild(this.ringGraphics);
    }

    /** True while shards are in the air or on their way back. Stopped shards do not count. */
    public get scattered(): boolean {
        return this.moving > 0;
    }

    /** Share of facets currently away from the crystal, 0..1. */
    public get missing(): number {
        return this.detachedCount / this.shards.length;
    }

    /** Break the crystal. `center` and `velocity` are the body's, in stage pixels and px/ms. */
    public explode(center: Vector3, velocity: Vector3, spin: number, sizeScale: number, timeMs: number): void {
        this.flightFor = 0;
        for (let i = 0; i < this.shards.length; i++) {
            const shard = this.shards[i];
            if (shard.state !== 'attached') {
                continue;
            }
            const home = this.homeOf(shard, center, spin, sizeScale, timeMs);
            // Outward from the centre, in all three dimensions: some come at the viewer.
            let dx = home.x - center.x;
            let dy = home.y - center.y;
            let dz = home.z;
            const length = Math.hypot(dx, dy, dz) || 1;
            dx /= length;
            dy /= length;
            dz /= length;
            const speed = randomNumber(0.1, 0.42);
            shard.position.x = home.x;
            shard.position.y = home.y;
            shard.depth = home.z;
            shard.velocity.x = dx * speed + velocity.x;
            shard.velocity.y = dy * speed + velocity.y - 0.03;
            shard.depthVelocity = dz * speed;
            shard.tumble = 0;
            shard.tumbleRate = randomNumber(-0.012, 0.012);
            shard.interactive = Math.random() < 0.5;
            shard.edgeChance = randomNumber(CrystalBody.MIN_EDGE_CHANCE, CrystalBody.MAX_EDGE_CHANCE);
            shard.over = undefined;
            shard.state = 'flying';
        }
    }

    /**
     * Advance the shards one tick. `ledges` are the page elements that can stop a shard;
     * `owner` is the effect's name, so shards ignore that effect's own forces.
     */
    public tick(
        tickContext: TickContext,
        center: Vector3,
        spin: number,
        sizeScale: number,
        ledges: readonly AnchorRect[],
        owner: string,
    ): void {
        const dt = tickContext.timeDelta;

        for (let i = this.rings.length - 1; i >= 0; i--) {
            this.rings[i].age += dt;
            if (this.rings[i].age >= CrystalBody.RING_MS) {
                this.rings.splice(i, 1);
            }
        }

        if (this.detachedCount === 0 && this.moving === 0 && !this.anyDetached()) {
            return;
        }

        this.flightFor += dt;
        const turnHome = this.flightFor >= CrystalBody.SCATTER_MS;
        const keep = Math.pow(CrystalBody.DRAG, dt);
        const force = this.force;
        let moving = 0;
        let detached = 0;

        for (let i = 0; i < this.shards.length; i++) {
            const shard = this.shards[i];
            if (shard.state === 'attached') {
                continue;
            }
            detached++;

            if (shard.state === 'flying') {
                moving++;
                const previousX = shard.position.x;
                const previousY = shard.position.y;
                tickContext.forces.sample(previousX, previousY, force, owner);
                shard.velocity.x = (shard.velocity.x + force.x * dt) * keep;
                shard.velocity.y = (shard.velocity.y + (force.y + CrystalBody.GRAVITY) * dt) * keep;
                shard.depthVelocity *= keep;
                shard.updatePosition(tickContext);
                shard.depth += shard.depthVelocity * dt;
                shard.tumble += shard.tumbleRate * dt;

                if (shard.interactive && ledges.length > 0 && this.meetPage(shard, previousX, previousY, ledges, tickContext)) {
                    continue;
                }
                if (turnHome) {
                    shard.state = 'returning';
                }
                continue;
            }

            if (shard.state === 'stuck') {
                shard.stuckFor += dt;
                shard.depth = approach(shard.depth, 0, 6, dt);
                // Stay on the element as the page scrolls under the stage.
                const anchor = shard.stuckAnchor ? tickContext.stage.anchor(shard.stuckAnchor) : undefined;
                if (anchor && anchor.width > 0) {
                    shard.position.x = anchor.x + shard.stuckOffset.x;
                    shard.position.y = anchor.y + shard.stuckOffset.y;
                }
                if (shard.stuckFor >= CrystalBody.STUCK_MS || !anchor) {
                    shard.state = 'returning';
                    shard.stuckAnchor = undefined;
                }
                continue;
            }

            // Returning: close the distance to where the facet belongs, wherever that is now.
            moving++;
            const home = this.homeOf(shard, center, spin, sizeScale, tickContext.time);
            shard.position.x = approach(shard.position.x, home.x, 4.5, dt);
            shard.position.y = approach(shard.position.y, home.y, 4.5, dt);
            shard.depth = approach(shard.depth, home.z, 4.5, dt);
            shard.tumble = approach(shard.tumble, 0, 5, dt);
            shard.velocity.x = 0;
            shard.velocity.y = 0;
            if (Math.abs(shard.position.x - home.x) + Math.abs(shard.position.y - home.y) < 1.5 && Math.abs(shard.tumble) < 0.05) {
                shard.state = 'attached';
                shard.tumble = 0;
                detached--;
                moving--;
            }
        }

        this.moving = moving;
        this.detachedCount = detached;
    }

    /** Draw. `x`, `y` are the centre in stage pixels; `leanX`/`leanY` tilt it without touching the simulation. */
    public render(
        timedContext: TimedContext,
        x: number,
        y: number,
        spin: number,
        sizeScale: number,
        energy: number,
        leanX = 0,
        leanY = 0,
    ): void {
        const stage = timedContext.stage;
        const mesh = this.mesh;
        stage.toWorld(x, y, 0, mesh.position);
        this.orientation(spin, this.euler);
        this.euler.x += leanX;
        this.euler.y += leanY;
        mesh.rotation.copy(this.euler);
        this.sizeAt(timedContext.time, sizeScale, mesh.scale);

        if (this.detachedCount > 0 || this.attributeDirty) {
            this.writeShards(timedContext);
        }

        const uniforms = mesh.material.uniforms;
        uniforms.uEnergy.value = energy;
        uniforms.uTimeS.value = timedContext.time / 1000;
        (uniforms.uAccent.value as Color).setHex(timedContext.theme.accent);
        (uniforms.uAccentAlt.value as Color).setHex(timedContext.theme.accentAlt);
        (uniforms.uInk.value as Color).setHex(timedContext.theme.ink);

        const rings = this.ringGraphics;
        rings.clear();
        if (this.rings.length > 0) {
            const color = mixColor(timedContext.theme.accent, timedContext.theme.ink, 0.4);
            for (const ring of this.rings) {
                const t = ring.age / CrystalBody.RING_MS;
                rings.circle(ring.x, ring.y, 4 + 42 * t * (2 - t)).stroke({ width: 1.5, color, alpha: 0.55 * (1 - t) });
            }
        }
    }

    public setVisible(visible: boolean): void {
        this.mesh.visible = visible;
        this.ringGraphics.visible = visible;
    }

    public dispose(): void {
        this.mesh.removeFromParent();
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
        this.ringGraphics.destroy();
        this.rings.length = 0;
    }

    /** Stop a shard that met a page element. Returns true when it was stopped. */
    private meetPage(
        shard: Shard,
        previousX: number,
        previousY: number,
        ledges: readonly AnchorRect[],
        tickContext: TickContext,
    ): boolean {
        const x = shard.position.x;
        const y = shard.position.y;
        let over: AnchorRect | undefined;
        for (let i = 0; i < ledges.length; i++) {
            const rect = ledges[i];
            if (x > rect.x && x < rect.x + rect.width && y > rect.y && y < rect.y + rect.height) {
                over = rect;
                break;
            }
        }
        if (!over) {
            shard.over = undefined;
            return false;
        }

        if (shard.over !== over.name) {
            // Just crossed the edge: the element is a wall for some of them.
            shard.over = over.name;
            if (Math.random() < shard.edgeChance) {
                // Put it back on the boundary it came through.
                if (previousX <= over.x) {
                    shard.position.x = over.x;
                } else if (previousX >= over.x + over.width) {
                    shard.position.x = over.x + over.width;
                }
                if (previousY <= over.y) {
                    shard.position.y = over.y;
                } else if (previousY >= over.y + over.height) {
                    shard.position.y = over.y + over.height;
                }
                this.stop(shard, over, true, tickContext);
                return true;
            }
            return false;
        }

        if (Math.random() < CrystalBody.INSIDE_CHANCE_PER_MS * tickContext.timeDelta) {
            this.stop(shard, over, false, tickContext);
            return true;
        }
        return false;
    }

    private stop(shard: Shard, rect: AnchorRect, edge: boolean, tickContext: TickContext): void {
        shard.state = 'stuck';
        shard.stuckFor = 0;
        shard.stuckAnchor = rect.name;
        shard.stuckOffset.x = shard.position.x - rect.x;
        shard.stuckOffset.y = shard.position.y - rect.y;
        shard.velocity.x = 0;
        shard.velocity.y = 0;
        shard.depthVelocity = 0;
        shard.tumbleRate = 0;
        if (this.rings.length < 24) {
            this.rings.push({ x: shard.position.x, y: shard.position.y, age: 0 });
        }
        tickContext.emit('page:hit', { x: shard.position.x, y: shard.position.y, anchor: rect.name, edge, kind: 'shard' });
    }

    private anyDetached(): boolean {
        for (let i = 0; i < this.shards.length; i++) {
            if (this.shards[i].state !== 'attached') {
                return true;
            }
        }
        return false;
    }

    /** The crystal's attitude for a given spin. Simulation and drawing both use this. */
    private orientation(spin: number, out: Euler): Euler {
        return out.set(0.35 + Math.sin(spin * 0.7) * 0.25, spin, Math.sin(spin * 0.45) * 0.3);
    }

    /** Size on each axis at a moment in time: the crystal slowly swells and shrinks, axis by axis. */
    private sizeAt(timeMs: number, sizeScale: number, out: ThreeVector3): ThreeVector3 {
        const amount = this.morphAmount;
        const size = this.radius * sizeScale;
        return out.set(
            size * (1 + amount * Math.sin(timeMs * 0.00031 + this.morphPhase[0])),
            size * (1 + amount * Math.sin(timeMs * 0.00027 + this.morphPhase[1])),
            size * (1 + amount * Math.sin(timeMs * 0.00036 + this.morphPhase[2])),
        );
    }

    /** Where a facet belongs right now, in stage pixels (z toward the viewer). */
    private homeOf(shard: Shard, center: Vector3, spin: number, sizeScale: number, timeMs: number): { x: number; y: number; z: number } {
        this.quaternion.setFromEuler(this.orientation(spin, this.euler));
        this.sizeAt(timeMs, sizeScale, this.scale);
        const v = this.scratch.copy(shard.home).multiply(this.scale).applyQuaternion(this.quaternion);
        const home = this.homeStage;
        home.x = center.x + v.x;
        home.y = center.y - v.y; // the model's y points up, the stage's down
        home.z = v.z;
        return home;
    }

    /** Tell the vertex shader how far each loose facet is from its place. */
    private writeShards(timedContext: TimedContext): void {
        const stage = timedContext.stage;
        const lead = timedContext.alpha * timedContext.tickDelta;
        const array = this.shardAttribute.array as Float32Array;
        const mesh = this.mesh;
        mesh.updateMatrixWorld(true);
        const world = this.scratchWorld;
        const attached = this.scratch;
        let any = false;

        for (let i = 0; i < this.shards.length; i++) {
            const shard = this.shards[i];
            const o = i * 12;
            if (shard.state === 'attached') {
                if (array[o] !== 0 || array[o + 1] !== 0 || array[o + 2] !== 0 || array[o + 3] !== 0) {
                    array.fill(0, o, o + 12);
                }
                continue;
            }
            any = true;
            const flying = shard.state === 'flying';
            stage.toWorld(
                shard.position.x + (flying ? shard.velocity.x * lead : 0),
                shard.position.y + (flying ? shard.velocity.y * lead : 0),
                shard.depth,
                world,
            );
            attached.copy(shard.home).applyMatrix4(mesh.matrixWorld);
            const dx = world.x - attached.x;
            const dy = world.y - attached.y;
            const dz = world.z - attached.z;
            for (let k = 0; k < 3; k++) {
                const p = o + k * 4;
                array[p] = dx;
                array[p + 1] = dy;
                array[p + 2] = dz;
                array[p + 3] = shard.tumble;
            }
        }
        this.shardAttribute.needsUpdate = true;
        // One more write after the last facet docks, so its offsets are zeroed on the GPU too.
        this.attributeDirty = any;
    }
}

/**
 * A faceted solid split into independent triangles. Each triangle carries its own centre and
 * a random seed, so every facet can leave and come back on its own.
 */
function buildCrystal(shape: CrystalShape): BufferGeometry {
    const geometry =
        shape === 'octahedron'
            ? new OctahedronGeometry(1, 1)
            : shape === 'dodecahedron'
              ? new DodecahedronGeometry(1, 0)
              : new IcosahedronGeometry(1, shape === 'gem' ? 1 : 0);
    const position = geometry.getAttribute('position') as BufferAttribute;

    // Same jitter for every copy of a shared vertex, so the surface stays closed.
    const v = new ThreeVector3();
    const stretch = shape === 'gem' ? 1.18 : shape === 'octahedron' ? 1.3 : 1.08;
    for (let i = 0; i < position.count; i++) {
        v.fromBufferAttribute(position, i);
        const h = Math.sin(v.x * 12.9898 + v.y * 78.233 + v.z * 37.719) * 43758.5453;
        const jitter = 0.86 + (h - Math.floor(h)) * 0.3;
        v.multiplyScalar(jitter);
        // Slightly taller than wide reads as a crystal rather than a ball.
        v.y *= stretch;
        position.setXYZ(i, v.x, v.y, v.z);
    }
    geometry.deleteAttribute('normal');
    geometry.deleteAttribute('uv');
    geometry.computeVertexNormals(); // non-indexed geometry: one flat normal per face

    const centers = new Float32Array(position.count * 3);
    const seeds = new Float32Array(position.count);
    const bary = new Float32Array(position.count * 3);
    const a = new ThreeVector3();
    const b = new ThreeVector3();
    const c = new ThreeVector3();
    for (let i = 0; i < position.count; i += 3) {
        a.fromBufferAttribute(position, i);
        b.fromBufferAttribute(position, i + 1);
        c.fromBufferAttribute(position, i + 2);
        const cx = (a.x + b.x + c.x) / 3;
        const cy = (a.y + b.y + c.y) / 3;
        const cz = (a.z + b.z + c.z) / 3;
        const seed = Math.random();
        for (let k = 0; k < 3; k++) {
            centers[(i + k) * 3] = cx;
            centers[(i + k) * 3 + 1] = cy;
            centers[(i + k) * 3 + 2] = cz;
            seeds[i + k] = seed;
            bary[(i + k) * 3 + k] = 1;
        }
    }
    geometry.setAttribute('aCenter', new BufferAttribute(centers, 3));
    geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));
    geometry.setAttribute('aBary', new BufferAttribute(bary, 3));
    return geometry;
}

const VERTEX = /* glsl */ `
attribute vec3 aCenter;
attribute float aSeed;
attribute vec3 aBary;
attribute vec4 aShard; // xyz: how far this facet is from its place, in world units; w: its tumble
uniform float uEnergy;
uniform float uTimeS;
varying vec3 vNormalV;
varying vec3 vViewPos;
varying vec3 vBary;
varying float vSeed;

mat3 rotAxis(vec3 axis, float angle) {
    float s = sin(angle);
    float c = cos(angle);
    float oc = 1.0 - c;
    return mat3(
        oc * axis.x * axis.x + c,          oc * axis.x * axis.y + axis.z * s, oc * axis.z * axis.x - axis.y * s,
        oc * axis.x * axis.y - axis.z * s, oc * axis.y * axis.y + c,          oc * axis.y * axis.z + axis.x * s,
        oc * axis.z * axis.x + axis.y * s, oc * axis.y * axis.z - axis.x * s, oc * axis.z * axis.z + c
    );
}

void main() {
    mat3 tumble = rotAxis(normalize(vec3(aSeed - 0.5, 0.7, fract(aSeed * 7.31) - 0.5)), aShard.w);
    vec3 local = tumble * (position - aCenter);

    float breathe = sin(uTimeS * 1.6 + aSeed * 6.2831) * 0.03 * (0.5 + uEnergy * 1.6);
    vec4 world = modelMatrix * vec4(aCenter * (1.0 + breathe) + local, 1.0);
    world.xyz += aShard.xyz;

    vec4 mv = viewMatrix * world;
    vViewPos = mv.xyz;
    vNormalV = normalize(normalMatrix * (tumble * normal));
    vBary = aBary;
    vSeed = aSeed;
    gl_Position = projectionMatrix * mv;
}
`;

function fragment(backgroundGlsl: string, pixiSampleGlsl: string): string {
    return /* glsl */ `
uniform sampler2D uPixiBack;
uniform vec2 uResolution;
uniform float uEnergy;
uniform float uFade;
uniform float uRefract;
uniform vec3 uAccent;
uniform vec3 uAccentAlt;
uniform vec3 uInk;
uniform vec3 uKeyDir;
varying vec3 vNormalV;
varying vec3 vViewPos;
varying vec3 vBary;
varying float vSeed;
${backgroundGlsl}
${pixiSampleGlsl}

void main() {
    vec3 N = normalize(vNormalV);
    if (!gl_FrontFacing) N = -N;
    vec3 V = normalize(-vViewPos);
    float ndv = max(dot(N, V), 0.0);
    float fres = pow(1.0 - ndv, 2.5);

    // Glass: look through the facet at the backdrop and the Pixi layer, bent by the
    // facet's normal, a little differently per colour channel.
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec2 bend = N.xy * uRefract * vec2(1.0 / uFxAspect, 1.0);
    vec3 backdrop = fxBackground(uv - bend);
    vec4 pr = fxPixi(uPixiBack, uv - bend * 0.8);
    vec4 pg = fxPixi(uPixiBack, uv - bend);
    vec4 pb = fxPixi(uPixiBack, uv - bend * 1.2);
    vec3 rain = vec3(pr.r, pg.g, pb.b);
    vec3 behind = backdrop * (1.0 - pg.a) + rain * 2.4;

    float facet = dot(N, uKeyDir) * 0.5 + 0.5;
    vec3 tint = mix(uAccentAlt, uAccent, facet);

    // Dark tinted glass: each facet passes a different share of what is behind it.
    vec3 col = behind * mix(vec3(1.0), tint * 1.6, 0.4) * (0.62 + 0.55 * facet);
    col += tint * 0.05 * facet * facet * facet;                          // sheen on the lit side
    col += tint * fres * (0.2 + uEnergy * 1.1);                          // rim
    float spec = pow(max(dot(N, normalize(uKeyDir + V)), 0.0), 90.0);
    col += uInk * spec * 1.5;                                            // glint

    // Thin bright seams between facets.
    vec3 w = fwidth(vBary);
    vec3 e = smoothstep(vec3(0.0), w * 1.25, vBary);
    float edge = 1.0 - min(e.x, min(e.y, e.z));
    col += mix(tint, uInk, 0.25) * edge * (0.2 + uEnergy * 0.75);

    // Charge: the core lights up as it fills, flickering facet by facet near the top.
    float charge = uEnergy * uEnergy;
    float flicker = 0.8 + 0.2 * sin(uFxTime * 9.0 + vSeed * 40.0) * smoothstep(0.5, 1.0, uEnergy);
    col += mix(uAccent, uInk, 0.3) * charge * (0.25 + 0.75 * ndv * ndv) * flicker * 0.85;

    gl_FragColor = vec4(col * uFade, uFade);
}
`;
}
