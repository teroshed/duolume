import {
    AdditiveBlending,
    BufferAttribute,
    BufferGeometry,
    Color,
    DynamicDrawUsage,
    InstancedBufferAttribute,
    InstancedMesh,
    Points,
    ShaderMaterial,
    Vector3 as ThreeVector3,
} from 'three';
import type { EffectHost } from '../../src/Effect';
import type { TimedContext } from '../../src/types';

/** What the simulation hands the drawing: where every segment is, and the creature's mood. */
export interface SerpentPose {
    /** Segment positions in stage pixels, head first. `z` is depth toward the viewer. */
    x: Float32Array;
    y: Float32Array;
    z: Float32Array;
    /** Where the segments were one tick earlier, for drawing between ticks. */
    prevX: Float32Array;
    prevY: Float32Array;
    prevZ: Float32Array;
    /** Phase of the swimming wave, in radians: the body rocks with it. */
    phase: number;
    /** 0..1: the inner glow burns brighter with it. */
    excited: number;
    /** Where the lightning surge is along the body, 0 at the head and 1 at the tail; below -1 when there is none. */
    surge: number;
    /** How far the serpent ranges in depth, in pixels. Parts that far behind the stage are sunk into the backdrop. */
    depth: number;
}

/** Sides of the gem's widest ring. Six reads as a cut stone at twenty pixels across; more turns to noise. */
const SIDES = 6;
/** Two eyes and two swept-back horns, drawn as extra gems after the segments. */
const EXTRAS = 4;
const HEAD_WIDTH = 23;
const HEAD_HEIGHT = 15;
const HEAD_LENGTH = 40;
/** Each gem is this many spacings long, so neighbours overlap like scales. */
const OVERLAP = 3;
/** How far each gem is turned about the body's axis from the one in front, in radians. */
const ROLL_STEP = 0.37;
/** The horns: how long they are in pixels, and how far they sweep out from the body's axis, in radians. */
const HORN_LENGTH = 17;
const HORN_SWEEP = 0.5;
/** One soft glow sprite for every this many segments. */
const HALO_STEP = 2;

/**
 * The serpent as Three.js sees it: one instanced mesh of faceted gems, one per segment, each
 * turned to face the segment in front and scaled by the body's taper; two more gems for eyes;
 * and a few soft additive sprites underneath that feed the bloom.
 *
 * It is a view, not an effect: `render` reads a pose and changes nothing in it.
 */
export class SerpentBody {
    private readonly count: number;
    private readonly widths: Float32Array;
    private readonly spacing: Float32Array;
    private readonly mesh: InstancedMesh<BufferGeometry, ShaderMaterial>;
    private readonly halo: Points<BufferGeometry, ShaderMaterial>;
    private readonly haloPositions: BufferAttribute;
    private readonly haloLooks: BufferAttribute; // x = size in px, y = strength, z = place along the body

    /** Segment positions in world units, already led between ticks. */
    private readonly wx: Float32Array;
    private readonly wy: Float32Array;
    private readonly wz: Float32Array;
    private readonly tangent = new ThreeVector3();
    private readonly up = new ThreeVector3();
    private readonly side = new ThreeVector3();
    private readonly headTangent = new ThreeVector3();
    private readonly headUp = new ThreeVector3();
    private readonly headSide = new ThreeVector3();

    /** `widths[i]` is segment i's width across in pixels, `spacing[i]` its distance from segment i - 1. */
    constructor(host: EffectHost, count: number, widths: Float32Array, spacing: Float32Array) {
        this.count = count;
        this.widths = widths;
        this.spacing = spacing;
        this.wx = new Float32Array(count);
        this.wy = new Float32Array(count);
        this.wz = new Float32Array(count);

        // Per gem: x = its place along the body (0 head, 1 tail), y = what it is (0 body, 1 eye),
        // z = how far its widest ring is slid along its axis.
        const total = count + EXTRAS;
        const seg = new Float32Array(total * 3);
        for (let i = 0; i < count; i++) {
            seg[i * 3] = i / Math.max(1, count - 1);
            // Body gems are widest toward the front, so each overlaps the one behind like a scale.
            // The head is widest at the back: a long pointed snout.
            seg[i * 3 + 2] = i === 0 ? -0.34 : 0.3;
        }
        seg[count * 3 + 1] = 1; // the eyes
        seg[(count + 1) * 3 + 1] = 1;
        seg[(count + 2) * 3 + 2] = -0.55; // the horns: thorns, widest at the root
        seg[(count + 3) * 3 + 2] = -0.55;
        const geometry = buildGem(SIDES);
        geometry.setAttribute('aSeg', new InstancedBufferAttribute(seg, 3));

        const surfaces = host.surfaces;
        const material = new ShaderMaterial({
            uniforms: {
                ...surfaces.behind,
                uTimeS: { value: 0 },
                uExcited: { value: 0 },
                uSurge: { value: -9 },
                uDepth: { value: 160 },
                uAccent: { value: new Color() },
                uAccentAlt: { value: new Color() },
                uInk: { value: new Color() },
                uKeyDir: { value: new ThreeVector3(-0.45, 0.7, 0.55).normalize() },
            },
            vertexShader: VERTEX,
            fragmentShader: fragment(surfaces.glsl.background, surfaces.glsl.pixiSample),
        });
        this.mesh = new InstancedMesh(geometry, material, total);
        this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
        this.mesh.frustumCulled = false;
        host.three.add(this.mesh);

        const haloCount = Math.ceil(count / HALO_STEP);
        const haloGeometry = new BufferGeometry();
        this.haloPositions = new BufferAttribute(new Float32Array(haloCount * 3), 3);
        this.haloPositions.setUsage(DynamicDrawUsage);
        this.haloLooks = new BufferAttribute(new Float32Array(haloCount * 3), 3);
        this.haloLooks.setUsage(DynamicDrawUsage);
        haloGeometry.setAttribute('position', this.haloPositions);
        haloGeometry.setAttribute('aLook', this.haloLooks);
        const haloMaterial = new ShaderMaterial({
            uniforms: {
                uResolution: surfaces.behind.uResolution,
                uStageHeight: { value: 1 },
                uAccent: material.uniforms.uAccent,
                uAccentAlt: material.uniforms.uAccentAlt,
            },
            vertexShader: HALO_VERTEX,
            fragmentShader: HALO_FRAGMENT,
            blending: AdditiveBlending,
            premultipliedAlpha: true,
            transparent: true,
            depthWrite: false,
        });
        this.halo = new Points(haloGeometry, haloMaterial);
        this.halo.frustumCulled = false;
        host.three.add(this.halo);
    }

    public render(timed: TimedContext, pose: SerpentPose): void {
        const stage = timed.stage;
        const count = this.count;
        const alpha = timed.alpha;
        const halfW = stage.width / 2;
        const halfH = stage.height / 2;
        const { wx, wy, wz, widths, spacing } = this;
        for (let i = 0; i < count; i++) {
            // Lead each segment by what it moved last tick; the stage's y points down, the world's up.
            wx[i] = pose.x[i] + (pose.x[i] - pose.prevX[i]) * alpha - halfW;
            wy[i] = halfH - (pose.y[i] + (pose.y[i] - pose.prevY[i]) * alpha);
            wz[i] = pose.z[i] + (pose.z[i] - pose.prevZ[i]) * alpha;
        }

        // The head is not rolled, so its eyes stay on top, one either side.
        this.frame(0, 0);
        this.put(0, wx[0], wy[0], wz[0], HEAD_WIDTH / 2, HEAD_HEIGHT / 2, HEAD_LENGTH / 2);
        this.headSide.copy(this.side);
        this.headUp.copy(this.up);
        this.headTangent.copy(this.tangent);
        for (let k = 0; k < 2; k++) {
            const left = k === 0 ? -1 : 1;
            this.putOnHead(count + k, left * HEAD_WIDTH * 0.27, HEAD_HEIGHT * 0.27, HEAD_LENGTH * 0.05, 1.5, 1.5, 3.4);
        }
        for (let k = 0; k < 2; k++) {
            // A horn: the head's frame swung round so its long axis points back and outward.
            const left = k === 0 ? -1 : 1;
            this.frame(0, 0);
            this.swing(left * (Math.PI - HORN_SWEEP));
            this.putOnHead(count + 2 + k, left * HEAD_WIDTH * 0.2, HEAD_HEIGHT * 0.1, -HEAD_LENGTH * 0.34, 2.6, 2.2, HORN_LENGTH / 2);
        }
        for (let i = 1; i < count; i++) {
            // Each gem is turned a little further than the one in front, and the whole body rocks
            // with the swimming wave, so facets catch the light one after another.
            this.frame(i, i * ROLL_STEP + 0.45 * Math.sin(pose.phase - i * 0.42));
            const half = widths[i] / 2;
            this.put(i, wx[i], wy[i], wz[i], half, half * 0.9, (spacing[i] * OVERLAP) / 2);
        }
        this.mesh.instanceMatrix.needsUpdate = true;

        const seconds = timed.time / 1000;
        const positions = this.haloPositions.array as Float32Array;
        const looks = this.haloLooks.array as Float32Array;
        for (let k = 0, i = 0; i < count; k++, i += HALO_STEP) {
            const o = k * 3;
            const t = i / Math.max(1, count - 1);
            positions[o] = wx[i];
            positions[o + 1] = wy[i];
            positions[o + 2] = wz[i];
            const wave = 0.5 + 0.5 * Math.sin(t * GLOW_WAVES - seconds * GLOW_SPEED);
            const band = Math.exp(-(((t - pose.surge) / 0.1) ** 2));
            const depthLight = 1 + 0.45 * Math.max(-1.2, Math.min(1.2, wz[i] / Math.max(1, pose.depth)));
            looks[o] = widths[i] * 3.2 + 44;
            looks[o + 1] = (0.018 + 0.026 * wave * wave * wave) * (1 + pose.excited * 1.4) * depthLight + band * 0.5;
            looks[o + 2] = t;
        }
        this.haloPositions.needsUpdate = true;
        this.haloLooks.needsUpdate = true;

        const uniforms = this.mesh.material.uniforms;
        uniforms.uTimeS.value = seconds;
        uniforms.uExcited.value = pose.excited;
        uniforms.uSurge.value = pose.surge;
        uniforms.uDepth.value = Math.max(1, pose.depth);
        (uniforms.uAccent.value as Color).setHex(timed.theme.accent);
        (uniforms.uAccentAlt.value as Color).setHex(timed.theme.accentAlt);
        (uniforms.uInk.value as Color).setHex(timed.theme.ink);
        this.halo.material.uniforms.uStageHeight.value = stage.height;
    }

    public dispose(): void {
        this.mesh.removeFromParent();
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
        this.mesh.dispose();
        this.halo.removeFromParent();
        this.halo.geometry.dispose();
        this.halo.material.dispose();
    }

    /**
     * Work out segment i's own axes: `tangent` toward the segment in front, `up` toward the
     * viewer (made square to the tangent), `side` across. `roll` turns `up` and `side` about the tangent.
     */
    private frame(i: number, roll: number): void {
        const { wx, wy, wz, tangent, up, side } = this;
        const a = i > 0 ? i - 1 : 0;
        const b = i < this.count - 1 ? i + 1 : i;
        tangent.set(wx[a] - wx[b], wy[a] - wy[b], wz[a] - wz[b]);
        if (tangent.lengthSq() < 1e-8) {
            tangent.set(1, 0, 0);
        }
        tangent.normalize();
        up.set(-tangent.x * tangent.z, -tangent.y * tangent.z, 1 - tangent.z * tangent.z);
        if (up.lengthSq() < 1e-6) {
            up.set(0, 1, 0); // swimming straight at the viewer
        }
        up.normalize();
        side.crossVectors(up, tangent);
        if (roll !== 0) {
            const c = Math.cos(roll);
            const s = Math.sin(roll);
            const sx = side.x * c + up.x * s;
            const sy = side.y * c + up.y * s;
            const sz = side.z * c + up.z * s;
            up.set(up.x * c - side.x * s, up.y * c - side.y * s, up.z * c - side.z * s);
            side.set(sx, sy, sz);
        }
    }

    /** Turn the current frame about its `up` axis by `angle` radians. */
    private swing(angle: number): void {
        const { side, tangent } = this;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const tx = tangent.x * c + side.x * s;
        const ty = tangent.y * c + side.y * s;
        const tz = tangent.z * c + side.z * s;
        side.set(side.x * c - tangent.x * s, side.y * c - tangent.y * s, side.z * c - tangent.z * s);
        tangent.set(tx, ty, tz);
    }

    /** Write a gem that sits on the head: `out`, `lift` and `ahead` place it across, above and along the head's own axes. */
    private putOnHead(index: number, out: number, lift: number, ahead: number, across: number, tall: number, long: number): void {
        const { headSide: s, headUp: u, headTangent: t, wx, wy, wz } = this;
        this.put(
            index,
            wx[0] + s.x * out + u.x * lift + t.x * ahead,
            wy[0] + s.y * out + u.y * lift + t.y * ahead,
            wz[0] + s.z * out + u.z * lift + t.z * ahead,
            across,
            tall,
            long,
        );
    }

    /** Write one gem's matrix: at (x, y, z), along the current frame, `across` × `tall` × `long` (half sizes). */
    private put(index: number, x: number, y: number, z: number, across: number, tall: number, long: number): void {
        const m = this.mesh.instanceMatrix.array;
        const o = index * 16;
        const { side, up, tangent } = this;
        m[o] = side.x * across;
        m[o + 1] = side.y * across;
        m[o + 2] = side.z * across;
        m[o + 3] = 0;
        m[o + 4] = up.x * tall;
        m[o + 5] = up.y * tall;
        m[o + 6] = up.z * tall;
        m[o + 7] = 0;
        m[o + 8] = tangent.x * long;
        m[o + 9] = tangent.y * long;
        m[o + 10] = tangent.z * long;
        m[o + 11] = 0;
        m[o + 12] = x;
        m[o + 13] = y;
        m[o + 14] = z;
        m[o + 15] = 1;
    }
}

/** How many glow waves lie along the body at once, and how fast they run toward the tail (radians per second). */
const GLOW_WAVES = 12;
const GLOW_SPEED = 2.3;

/**
 * A double pyramid: a point at each end of the z axis and a ring of `sides` corners between
 * them. Every triangle has its own three corners, so facets can be shaded flat, and each
 * corner knows which one it is (`aBary`), so the seams between facets can be drawn.
 */
function buildGem(sides: number): BufferGeometry {
    const positions = new Float32Array(sides * 2 * 9);
    const bary = new Float32Array(sides * 2 * 9);
    let o = 0;
    const corner = (x: number, y: number, z: number, k: number): void => {
        positions[o] = x;
        positions[o + 1] = y;
        positions[o + 2] = z;
        bary[o + k] = 1;
        o += 3;
    };
    for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        const b = ((i + 1) / sides) * Math.PI * 2;
        const ax = Math.cos(a);
        const ay = Math.sin(a);
        const bx = Math.cos(b);
        const by = Math.sin(b);
        // Counter-clockwise seen from outside, front half then back half.
        corner(0, 0, 1, 0);
        corner(ax, ay, 0, 1);
        corner(bx, by, 0, 2);
        corner(0, 0, -1, 0);
        corner(bx, by, 0, 1);
        corner(ax, ay, 0, 2);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aBary', new BufferAttribute(bary, 3));
    return geometry;
}

const VERTEX = /* glsl */ `
attribute vec3 aBary;
attribute vec3 aSeg; // x: place along the body, y: 0 body / 1 eye, z: how far the widest ring is slid along the axis
varying vec3 vViewPos;
varying vec3 vBary;
varying vec2 vSeg;
varying float vDepth;

void main() {
    vec3 p = position;
    p.z += aSeg.z * (1.0 - abs(position.z));
    vec4 world = modelMatrix * instanceMatrix * vec4(p, 1.0);
    vec4 mv = viewMatrix * world;
    vViewPos = mv.xyz;
    vBary = aBary;
    vSeg = aSeg.xy;
    vDepth = world.z;
    gl_Position = projectionMatrix * mv;
}
`;

function fragment(backgroundGlsl: string, pixiSampleGlsl: string): string {
    return /* glsl */ `
uniform sampler2D uPixiBack;
uniform vec2 uResolution;
uniform float uTimeS;
uniform float uExcited;
uniform float uSurge;
uniform float uDepth;
uniform vec3 uAccent;
uniform vec3 uAccentAlt;
uniform vec3 uInk;
uniform vec3 uKeyDir;
varying vec3 vViewPos;
varying vec3 vBary;
varying vec2 vSeg;
varying float vDepth;
${backgroundGlsl}
${pixiSampleGlsl}

void main() {
    // Flat facets: the normal of the triangle itself, from how the surface changes across the screen.
    vec3 N = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
    vec3 V = normalize(-vViewPos);
    if (dot(N, V) < 0.0) N = -N;
    float ndv = dot(N, V);
    float t = vSeg.x;

    // Colour runs from the accent at the head to the alternate accent at the tail.
    float along = smoothstep(0.04, 0.9, t);
    vec3 base = mix(uAccent, uAccentAlt, along);
    vec3 other = mix(uAccentAlt, uAccent, along);
    float key = max(dot(N, uKeyDir), 0.0);
    float fill = max(dot(N, vec3(0.6, -0.55, 0.25)), 0.0);

    // Solid: facets turned from the light go nearly black, the ones facing it carry the colour,
    // and the shadow side picks up a little of the other accent.
    vec3 col = base * (0.02 + 0.8 * key * key * key) + other * fill * 0.07;
    float fres = pow(1.0 - ndv, 2.5);
    col += mix(base, uInk, 0.35) * fres * 0.4;                          // rim
    float spec = pow(max(dot(N, normalize(uKeyDir + V)), 0.0), 36.0);
    col += uInk * spec * 0.9;                                           // a facet flashing as it turns to the light

    // Thin bright seams between facets, as on a cut stone.
    vec3 w = fwidth(vBary);
    vec3 e = smoothstep(vec3(0.0), w * 1.1, vBary);
    float seam = 1.0 - min(e.x, min(e.y, e.z));
    col += mix(base, uInk, 0.3) * seam * 0.13;

    // Light from inside: pulses of brightness running from head to tail, stronger when excited.
    float wave = 0.5 + 0.5 * sin(t * ${GLOW_WAVES.toFixed(1)} - uTimeS * ${GLOW_SPEED.toFixed(1)});
    float glow = (0.035 + 0.3 * wave * wave * wave) * (1.0 + uExcited * 1.6);
    col += base * glow * (0.25 + 0.75 * ndv * ndv);

    // A lightning surge: a white-hot band travelling down the body.
    float band = exp(-pow((t - uSurge) / 0.085, 2.0));
    col += mix(base, uInk, 0.7) * band * 3.0;

    if (vSeg.y > 0.5) {
        col = uInk * (1.3 + 0.9 * uExcited) * (0.5 + 0.5 * ndv);        // an eye
    }

    // Depth: nearer is brighter; far parts sink into what is behind them (backdrop and rain).
    float depth = clamp(vDepth / uDepth, -1.3, 1.3);
    col *= 1.0 + 0.4 * depth;
    float fog = smoothstep(0.15, -1.25, depth) * 0.62;
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec4 rain = fxPixi(uPixiBack, uv);
    vec3 behind = fxBackground(uv) * (1.0 - rain.a) + rain.rgb;
    gl_FragColor = vec4(mix(col, behind, fog), 1.0);
}
`;
}

const HALO_VERTEX = /* glsl */ `
attribute vec3 aLook;
uniform vec2 uResolution;
uniform float uStageHeight;
varying float vStrength;
varying float vAlong;
void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // Size in stage pixels at z = 0, growing as the body comes toward the viewer.
    float depthScale = -(modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).z / max(1.0, -mv.z);
    gl_PointSize = aLook.x * depthScale * (uResolution.y / uStageHeight);
    vStrength = aLook.y;
    vAlong = aLook.z;
}
`;

const HALO_FRAGMENT = /* glsl */ `
uniform vec3 uAccent;
uniform vec3 uAccentAlt;
varying float vStrength;
varying float vAlong;
void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float soft = smoothstep(1.0, 0.0, d);
    vec3 col = mix(uAccent, uAccentAlt, vAlong) * soft * soft * vStrength;
    // Additive: alpha 0, so the composite adds this light instead of covering what is behind.
    gl_FragColor = vec4(col, 0.0);
}
`;
