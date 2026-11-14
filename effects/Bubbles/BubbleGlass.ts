import {
    BufferAttribute,
    BufferGeometry,
    Color,
    DynamicDrawUsage,
    InstancedBufferAttribute,
    InstancedBufferGeometry,
    Mesh,
    Points,
    ShaderMaterial,
    Vector2,
} from 'three';
import type { EffectHost } from '../../src/Effect';
import type { TimedContext } from '../../src/types';
import { SQUASH_FLAT, SQUASH_WIDE } from './ledge';

/** How far the quad reaches past the bubble's edge, in radii: room for the ring of a pop. */
const MARGIN = 1.32;

/**
 * What the bubbles are drawn with. Not an effect: `Bubbles` owns one, and each frame calls
 * `begin`, then `bubble` / `droplet` for everything alive, then `end`.
 *
 * Every bubble is one flat square facing the viewer; the fragment shader turns it into a
 * sphere. It is drawn twice. First the lens, which replaces what is behind the bubble with a
 * bent view of the backdrop and the Pixi layer. Then the film (rim colours, highlights, the
 * ring of a pop), which only adds light and is drawn over everything else, so bubbles that
 * overlap keep both their rims and a crystal passing in front still shows the bubble's shine.
 */
export class BubbleGlass {
    /** Most bubbles (whole and popping) drawn in one frame. */
    public static readonly MAX_BUBBLES = 160;
    /** Most spray droplets drawn in one frame. */
    public static readonly MAX_DROPLETS = 640;

    private readonly geometry: InstancedBufferGeometry;
    private readonly bubbles: InstancedBufferAttribute; // x, y (world), radius, squash
    private readonly looks: InstancedBufferAttribute; // phase, pop progress, jiggle, fade
    private readonly lens: Mesh<InstancedBufferGeometry, ShaderMaterial>;
    private readonly film: Mesh<InstancedBufferGeometry, ShaderMaterial>;
    private readonly spray: Points<BufferGeometry, ShaderMaterial>;
    private readonly sprayPositions: BufferAttribute;
    private readonly sprayLooks: BufferAttribute; // size in pixels, brightness

    private readonly stageSize = new Vector2(1, 1);
    private readonly timeS = { value: 0 };
    private readonly accent = new Color();
    private readonly accentAlt = new Color();
    private readonly ink = new Color();
    private bubbleCount = 0;
    private dropletCount = 0;

    constructor(host: EffectHost) {
        const surfaces = host.surfaces;

        const geometry = new InstancedBufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
        geometry.setIndex([0, 1, 2, 0, 2, 3]);
        this.bubbles = new InstancedBufferAttribute(new Float32Array(BubbleGlass.MAX_BUBBLES * 4), 4);
        this.bubbles.setUsage(DynamicDrawUsage);
        this.looks = new InstancedBufferAttribute(new Float32Array(BubbleGlass.MAX_BUBBLES * 4), 4);
        this.looks.setUsage(DynamicDrawUsage);
        geometry.setAttribute('aBubble', this.bubbles);
        geometry.setAttribute('aLook', this.looks);
        geometry.instanceCount = 0;
        this.geometry = geometry;

        const shared = {
            uTimeS: this.timeS,
            uStage: { value: this.stageSize },
            uAccent: { value: this.accent },
            uAccentAlt: { value: this.accentAlt },
            uInk: { value: this.ink },
        };
        const flat = { transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false } as const;

        this.lens = new Mesh(
            geometry,
            new ShaderMaterial({
                uniforms: { ...surfaces.behind, ...shared },
                vertexShader: VERTEX,
                fragmentShader: lensFragment(surfaces.glsl.background, surfaces.glsl.pixiSample),
                ...flat,
            }),
        );
        this.film = new Mesh(geometry, new ShaderMaterial({ uniforms: shared, vertexShader: VERTEX, fragmentShader: FILM_FRAGMENT, ...flat }));
        // The lens goes under the other 3D things (a crystal in front hides it); the shine goes over them.
        this.lens.renderOrder = -1;
        this.film.renderOrder = 6;

        const sprayGeometry = new BufferGeometry();
        this.sprayPositions = new BufferAttribute(new Float32Array(BubbleGlass.MAX_DROPLETS * 3), 3);
        this.sprayPositions.setUsage(DynamicDrawUsage);
        this.sprayLooks = new BufferAttribute(new Float32Array(BubbleGlass.MAX_DROPLETS * 2), 2);
        this.sprayLooks.setUsage(DynamicDrawUsage);
        sprayGeometry.setAttribute('position', this.sprayPositions);
        sprayGeometry.setAttribute('aLook', this.sprayLooks);
        sprayGeometry.setDrawRange(0, 0);
        this.spray = new Points(
            sprayGeometry,
            new ShaderMaterial({
                uniforms: { uResolution: surfaces.behind.uResolution, ...shared },
                vertexShader: SPRAY_VERTEX,
                fragmentShader: SPRAY_FRAGMENT,
                ...flat,
            }),
        );
        this.spray.renderOrder = 6;

        for (const object of [this.lens, this.film, this.spray]) {
            object.frustumCulled = false;
            object.visible = false;
            host.three.add(object);
        }
    }

    /** Start a frame: nothing is drawn until `bubble` and `droplet` say so. */
    public begin(timedContext: TimedContext): void {
        this.bubbleCount = 0;
        this.dropletCount = 0;
        this.stageSize.set(timedContext.stage.width, timedContext.stage.height);
        this.timeS.value = timedContext.time / 1000;
        this.accent.setHex(timedContext.theme.accent);
        this.accentAlt.setHex(timedContext.theme.accentAlt);
        this.ink.setHex(timedContext.theme.ink);
    }

    /**
     * One bubble at a stage position. `squash` 0..1 flattens it (pressed under an element),
     * `phase` 0..1 is its own, `jiggle` 0..1 shakes the outline, `pop` above 0 draws the
     * snapping film instead (0..1 across the pop), `fade` 0..1 scales all of it.
     */
    public bubble(x: number, y: number, radius: number, squash: number, phase: number, jiggle: number, pop: number, fade: number): void {
        if (this.bubbleCount >= BubbleGlass.MAX_BUBBLES) {
            return;
        }
        const o = this.bubbleCount++ * 4;
        const bubbles = this.bubbles.array as Float32Array;
        const looks = this.looks.array as Float32Array;
        bubbles[o] = x - this.stageSize.x / 2;
        bubbles[o + 1] = this.stageSize.y / 2 - y;
        bubbles[o + 2] = radius;
        bubbles[o + 3] = squash;
        looks[o] = phase;
        looks[o + 1] = pop;
        looks[o + 2] = jiggle;
        looks[o + 3] = fade;
    }

    /** One droplet of spray: a small soft dot. `size` is its diameter in pixels. */
    public droplet(x: number, y: number, size: number, brightness: number): void {
        if (this.dropletCount >= BubbleGlass.MAX_DROPLETS) {
            return;
        }
        const n = this.dropletCount++;
        const positions = this.sprayPositions.array as Float32Array;
        const looks = this.sprayLooks.array as Float32Array;
        positions[n * 3] = x - this.stageSize.x / 2;
        positions[n * 3 + 1] = this.stageSize.y / 2 - y;
        positions[n * 3 + 2] = 0;
        looks[n * 2] = size;
        looks[n * 2 + 1] = brightness;
    }

    /** Finish the frame: hand what was listed to the GPU. */
    public end(): void {
        const some = this.bubbleCount > 0;
        this.lens.visible = some;
        this.film.visible = some;
        this.geometry.instanceCount = this.bubbleCount;
        if (some) {
            this.bubbles.needsUpdate = true;
            this.looks.needsUpdate = true;
        }
        this.spray.visible = this.dropletCount > 0;
        this.spray.geometry.setDrawRange(0, this.dropletCount);
        if (this.dropletCount > 0) {
            this.sprayPositions.needsUpdate = true;
            this.sprayLooks.needsUpdate = true;
        }
    }

    public dispose(): void {
        for (const object of [this.lens, this.film, this.spray]) {
            object.removeFromParent();
            object.material.dispose();
        }
        this.geometry.dispose();
        this.spray.geometry.dispose();
    }
}

const VERTEX = /* glsl */ `
attribute vec4 aBubble; // xy: centre in world units, z: radius in pixels, w: squash 0..1
attribute vec4 aLook;   // x: phase 0..1, y: pop progress (0 while whole), z: jiggle 0..1, w: fade 0..1
uniform float uTimeS;
varying vec2 vP;        // across the bubble: the centre is 0, the edge is at length 1
varying vec2 vRadii;    // its half width and half height, in pixels
varying vec4 vLook;

void main() {
    float phase = aLook.x * 6.2831;
    // The outline breathes, wider as it gets shorter: a few percent, and quicker just after a bump.
    float breathe = sin(uTimeS * (1.0 + aLook.x) + phase) * 0.03 + sin(uTimeS * 13.0 + phase * 5.0) * 0.08 * aLook.z;
    breathe *= 1.0 - 0.7 * aBubble.w;
    vRadii = aBubble.z * vec2(1.0 + breathe + aBubble.w * ${SQUASH_WIDE.toFixed(3)}, 1.0 - breathe - aBubble.w * ${SQUASH_FLAT.toFixed(3)});
    vP = position.xy * ${MARGIN.toFixed(3)};
    vLook = aLook;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(aBubble.xy + vP * vRadii, 0.0, 1.0);
}
`;

/** The lens: what is behind the bubble, seen through a sphere. Covers (alpha up to 1). */
function lensFragment(backgroundGlsl: string, pixiSampleGlsl: string): string {
    return /* glsl */ `
uniform sampler2D uPixiBack;
uniform vec2 uResolution;
uniform vec2 uStage;
varying vec2 vP;
varying vec2 vRadii;
varying vec4 vLook;
${backgroundGlsl}
${pixiSampleGlsl}

void main() {
    float r = length(vP);
    float pixel = fwidth(r);
    float cover = clamp((1.0 - r) / pixel + 0.5, 0.0, 1.0) * vLook.w * (1.0 - smoothstep(0.0, 0.3, vLook.y));
    if (cover < 0.002) discard;

    // Where this fragment looks. In the middle, straight through. Further out the view is pulled
    // toward the centre, and at the rim past it: the edge shows the far side upside-down, so a
    // streak of rain kinks as it goes behind. Offsets are stage pixels, turned into uv by the
    // stage size, which holds at any device pixel ratio.
    float bend = 1.55 * r * r * r;
    vec2 pull = -vP * vRadii * bend / uStage;
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec3 backdrop = fxBackground(uv + pull);
    // Each colour bends a little differently.
    vec4 pr = fxPixi(uPixiBack, uv + pull * 0.9);
    vec4 pg = fxPixi(uPixiBack, uv + pull);
    vec4 pb = fxPixi(uPixiBack, uv + pull * 1.1);
    vec3 behind = backdrop * (1.0 - pg.a) + vec3(pr.r, pg.g, pb.b) * (1.0 + 1.1 * r * r);

    // Clear in the middle, a shade darker toward the edge, which gives it roundness.
    behind *= 1.0 - 0.14 * r * r;
    gl_FragColor = vec4(behind * cover, cover);
}
`;
}

/** The film: rim colours, two highlights, and the ring of a pop. Only adds light (alpha 0). */
const FILM_FRAGMENT = /* glsl */ `
uniform float uTimeS;
uniform vec3 uAccent;
uniform vec3 uAccentAlt;
uniform vec3 uInk;
varying vec2 vP;
varying vec2 vRadii;
varying vec4 vLook;

float filmHash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 34.5);
    return fract(p.x * p.y);
}

float filmNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(filmHash(i), filmHash(i + vec2(1.0, 0.0)), u.x),
               mix(filmHash(i + vec2(0.0, 1.0)), filmHash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// A piece of a ring: 1 inside, 0 outside, with rounded ends. Centre line at radius r0 and
// angle a0; halfR and halfT are its half thickness and half length, both in radii.
float arc(float r, float ang, float r0, float a0, float halfR, float halfT, float soft, out float along) {
    along = (mod(ang - a0 + 3.14159, 6.28318) - 3.14159) * r0;
    vec2 q = vec2(abs(r - r0) - halfR, abs(along) - halfT) + halfR;
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - halfR;
    return 1.0 - smoothstep(-soft, soft, d);
}

void main() {
    float r = length(vP);
    float pixel = fwidth(r);
    float ang = atan(vP.y, vP.x);
    float phase = vLook.x * 6.2831;
    float pop = vLook.y;

    // Soap-film colours: the theme's own, chasing each other round the bubble, slowly stirred.
    float stir = filmNoise(vP * 1.7 + vec2(uTimeS * 0.08, -uTimeS * 0.05) + phase);
    float turn = ang + r * 2.4 + stir * 3.4 + uTimeS * 0.21 + phase;
    vec3 film = mix(uAccent, uAccentAlt, 0.5 + 0.5 * sin(turn));
    film = mix(film, uInk, 0.3 + 0.3 * sin(turn * 2.0 + stir * 2.0 + 1.3));

    vec3 col;
    if (pop <= 0.0) {
        float cover = clamp((1.0 - r) / pixel + 0.5, 0.0, 1.0);
        // Almost nothing where the film faces the viewer, strongest where it turns away: the rim.
        float facing = sqrt(max(0.0, 1.0 - r * r));
        float rim = pow(1.0 - facing, 2.6);
        col = film * (0.02 + 0.07 * stir * r + 0.8 * rim);

        // A window's reflection upper-left (two panes), and its faint upside-down twin lower-right.
        float along;
        float window = arc(r, ang, 0.66, 2.3, 0.085, 0.3, pixel, along);
        window *= smoothstep(pixel * 0.5, pixel * 0.5 + 0.03, abs(along + 0.06));
        float twin = arc(r, ang, 0.76, -0.84, 0.035, 0.26, pixel, along);
        col += uInk * (window * 0.95 + twin * 0.22);
        // A soft sheen around the window, so it sits on a curved surface rather than on nothing.
        vec2 lit = vP - vec2(-0.44, 0.47);
        col += mix(film, uInk, 0.5) * exp(-dot(lit, lit) * 7.0) * 0.07;
        col *= cover;
    } else {
        // The film snaps: its rim runs outward a little, thins, breaks into dashes and is gone.
        float ringAt = 1.0 + 0.2 * pop;
        float halfWidth = mix(0.075, 0.012, pop) + pixel;
        float ring = 1.0 - smoothstep(0.0, halfWidth, abs(r - ringAt));
        float dashes = 0.5 + 0.5 * sin(ang * 9.0 + phase * 7.0);
        float kept = smoothstep(pop * 1.25 - 0.3, pop * 1.25, dashes);
        col = mix(film, uInk, 0.45) * ring * kept * (1.0 - pop) * 2.0;
    }
    col *= vLook.w;
    if (max(col.r, max(col.g, col.b)) < 0.0008) discard;
    gl_FragColor = vec4(col, 0.0);
}
`;

const SPRAY_VERTEX = /* glsl */ `
attribute vec2 aLook; // x: diameter in stage pixels, y: brightness
uniform vec2 uResolution;
uniform vec2 uStage;
varying float vBrightness;
void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aLook.x * (uResolution.y / uStage.y);
    vBrightness = aLook.y;
}
`;

const SPRAY_FRAGMENT = /* glsl */ `
uniform vec3 uAccent;
uniform vec3 uInk;
varying float vBrightness;
void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float dot_ = smoothstep(1.0, 0.25, d);
    gl_FragColor = vec4(mix(uAccent, uInk, 0.6) * dot_ * vBrightness, 0.0);
}
`;
