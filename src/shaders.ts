/**
 * GLSL shared by the compositor and by any Three.js material that wants to see
 * "what is behind me" — the procedural backdrop plus the Pixi layer.
 *
 * Colour convention: everything inside the Three.js pipeline is linear, premultiplied.
 * The Pixi canvas arrives display-referred (sRGB) and premultiplied; `fxPixi` converts it.
 */

/** Uniform declarations + `fxBackground(uv)`: the backdrop every layer sits on. `uv` has its origin bottom-left. */
export const BACKGROUND_GLSL = /* glsl */ `
uniform vec3 uBgTop;
uniform vec3 uBgBottom;
uniform vec3 uGlowA;
uniform vec3 uGlowB;
uniform float uFxTime;
uniform float uFxAspect;
uniform float uBgScroll;
uniform vec3 uBgFocus; // xy in uv, z = strength
uniform float uBgFlash; // brief ambient light, e.g. lightning

float fxHash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

float fxNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(fxHash(i), fxHash(i + vec2(1.0, 0.0)), u.x),
               mix(fxHash(i + vec2(0.0, 1.0)), fxHash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fxFbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
        v += a * fxNoise(p);
        p = p * 2.03 + vec2(17.1, 9.2);
        a *= 0.5;
    }
    return v;
}

vec3 fxBackground(vec2 uv) {
    vec2 p = vec2(uv.x * uFxAspect, uv.y + uBgScroll);
    float t = uFxTime * 0.02;
    vec3 col = mix(uBgBottom, uBgTop, smoothstep(0.0, 1.0, uv.y));

    // Two slow curtains of light, warped by noise.
    float warp = fxFbm(p * 0.9 + vec2(t, -t * 0.6));
    float bandA = fxFbm(vec2(p.x * 0.7 + warp * 0.9 + t * 1.4, p.y * 1.7 - t));
    float bandB = fxFbm(vec2(p.x * 0.5 - warp * 0.7 - t * 1.1, p.y * 1.3 + 4.0 + t * 0.7));
    float maskA = smoothstep(0.42, 0.95, bandA) * smoothstep(-0.1, 0.75, uv.y);
    float maskB = smoothstep(0.48, 0.98, bandB) * smoothstep(1.15, 0.2, uv.y);
    col += uGlowA * maskA * 0.22;
    col += uGlowB * maskB * 0.16;

    // Light pooled around the focus point (whatever the scene wants to draw the eye to).
    vec2 d = vec2((uv.x - uBgFocus.x) * uFxAspect, uv.y - uBgFocus.y);
    float pool = exp(-dot(d, d) * 16.0) * uBgFocus.z;
    col += mix(uGlowA, uGlowB, 0.35) * pool * 0.16;

    // A flash lights the whole sky, the curtains most of all.
    col += (mix(uGlowA, uGlowB, 0.5) * (0.03 + maskA * 0.4 + maskB * 0.32) + vec3(0.006)) * uBgFlash;
    return col;
}
`;

/** `fxPixi(sampler, uv)`: sample a Pixi layer as linear premultiplied colour. */
export const PIXI_SAMPLE_GLSL = /* glsl */ `
vec4 fxPixi(sampler2D layer, vec2 uv) {
    vec4 c = texture2D(layer, uv);
    vec3 straight = c.a > 0.0005 ? clamp(c.rgb / c.a, 0.0, 1.0) : vec3(0.0);
    return vec4(pow(straight, vec3(2.2)) * c.a, c.a);
}
`;

export const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Backdrop + Pixi (behind) + Three.js scene + Pixi (front), with shock-ring refraction of the whole picture. */
export const COMBINE_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uPixiBack;
uniform sampler2D uPixiFront;
uniform float uHasFront;
uniform vec2 uStage;
uniform vec4 uShock[4];      // x, y (stage px), radius, amplitude px
uniform float uShockWidth[4];
${BACKGROUND_GLSL}
${PIXI_SAMPLE_GLSL}

vec2 shockOffset(vec2 uv, out float crest) {
    vec2 p = vec2(uv.x, 1.0 - uv.y) * uStage;
    vec2 off = vec2(0.0);
    crest = 0.0;
    for (int i = 0; i < 4; i++) {
        vec4 s = uShock[i];
        if (s.w <= 0.0) continue;
        vec2 d = p - s.xy;
        float len = length(d) + 0.0001;
        float t = (len - s.z) / uShockWidth[i];
        float ring = exp(-t * t * 3.0);
        // Derivative of the ring profile: the picture bends like light through a ripple.
        off += (d / len) * (-t * ring) * s.w * 2.4;
        crest += ring * s.w;
    }
    return vec2(off.x, -off.y) / uStage;
}

void main() {
    float crest;
    vec2 off = shockOffset(vUv, crest);
    vec2 uv = vUv + off;

    vec3 col = fxBackground(uv);

    // A little dispersion on the ring: the Pixi layer splits by channel.
    vec4 back = fxPixi(uPixiBack, uv);
    if (crest > 0.01) {
        back.r = fxPixi(uPixiBack, uv + off * 0.35).r;
        back.b = fxPixi(uPixiBack, uv - off * 0.35).b;
    }
    col = col * (1.0 - back.a) + back.rgb;

    vec4 scene = texture2D(uScene, uv);
    col = col * (1.0 - scene.a) + scene.rgb;

    if (uHasFront > 0.5) {
        vec4 front = fxPixi(uPixiFront, uv);
        col = col * (1.0 - front.a) + front.rgb;
    }

    col += mix(uGlowA, uGlowB, 0.5) * crest * 0.0035;
    gl_FragColor = vec4(col, 1.0);
}
`;

/** Dual-filter downsample; the first level also thresholds. */
export const BLOOM_DOWN_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSource;
uniform vec2 uHalfPixel;
uniform float uThreshold;

vec3 pre(vec3 c) {
    if (uThreshold <= 0.0) return c;
    float b = max(c.r, max(c.g, c.b));
    float soft = clamp(b - uThreshold + 0.25, 0.0, 0.5);
    soft = soft * soft / 1.0;
    float k = max(soft, b - uThreshold) / max(b, 0.0001);
    return c * k;
}

void main() {
    vec3 sum = pre(texture2D(uSource, vUv).rgb) * 4.0;
    sum += pre(texture2D(uSource, vUv - uHalfPixel).rgb);
    sum += pre(texture2D(uSource, vUv + uHalfPixel).rgb);
    sum += pre(texture2D(uSource, vUv + vec2(uHalfPixel.x, -uHalfPixel.y)).rgb);
    sum += pre(texture2D(uSource, vUv - vec2(uHalfPixel.x, -uHalfPixel.y)).rgb);
    gl_FragColor = vec4(sum / 8.0, 1.0);
}
`;

/** Dual-filter upsample, adding the same-size level from the way down. */
export const BLOOM_UP_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSource;
uniform sampler2D uAdd;
uniform vec2 uHalfPixel;

void main() {
    vec2 h = uHalfPixel;
    vec3 sum = texture2D(uSource, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
    sum += texture2D(uSource, vUv + vec2(-h.x, h.y)).rgb * 2.0;
    sum += texture2D(uSource, vUv + vec2(0.0, h.y * 2.0)).rgb;
    sum += texture2D(uSource, vUv + vec2(h.x, h.y)).rgb * 2.0;
    sum += texture2D(uSource, vUv + vec2(h.x * 2.0, 0.0)).rgb;
    sum += texture2D(uSource, vUv + vec2(h.x, -h.y)).rgb * 2.0;
    sum += texture2D(uSource, vUv + vec2(0.0, -h.y * 2.0)).rgb;
    sum += texture2D(uSource, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
    gl_FragColor = vec4(sum / 12.0 + texture2D(uAdd, vUv).rgb, 1.0);
}
`;

/** Bloom add, soft shoulder, vignette, dither, sRGB encode. */
export const FINAL_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uCombined;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform float uVignette;
uniform float uFxTime;

vec3 toSrgb(vec3 c) {
    vec3 lo = c * 12.92;
    vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
    return mix(lo, hi, step(vec3(0.0031308), c));
}

float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

void main() {
    vec3 c = texture2D(uCombined, vUv).rgb;
    c += texture2D(uBloom, vUv).rgb * uBloomStrength;

    vec2 q = vUv - 0.5;
    c *= 1.0 - dot(q, q) * uVignette;

    // Leave the dark end alone, roll bright values off instead of clipping them.
    vec3 rolled = 1.0 - exp(-c);
    c = mix(c, rolled, smoothstep(0.35, 1.2, max(c.r, max(c.g, c.b))));

    c = toSrgb(c);
    c += (hash(gl_FragCoord.xy + fract(uFxTime) * 61.0) - 0.5) / 255.0;
    gl_FragColor = vec4(c, 1.0);
}
`;
