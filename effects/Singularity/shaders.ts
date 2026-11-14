/**
 * GLSL for the singularity's two quads.
 *
 * Both shaders work in stage pixels measured from the hole's centre. They get there from
 * `gl_FragCoord`, the render target's size and the stage's size, so the device pixel ratio never
 * has to be known: `uv = gl_FragCoord.xy / uResolution` has its origin bottom-left, the stage has
 * its origin top-left, and that one flip is all there is between them.
 */

export const QUAD_VERTEX = /* glsl */ `
void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SHARED = /* glsl */ `
uniform vec2 uResolution; // the render target, in device pixels
uniform vec2 uStage;      // the stage, in stage pixels
uniform vec2 uCentre;     // the hole, in stage pixels
uniform float uRadius;    // radius of the dark disc, in stage pixels
uniform float uReach;     // half the quad's side: nothing is drawn or bent beyond it

// Einstein radius over disc radius: light from straight behind the hole arrives as a ring this far out.
const float EINSTEIN = 1.45;

// This fragment relative to the hole, in stage pixels (y down).
vec2 sgFromCentre() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    return vec2(uv.x, 1.0 - uv.y) * uStage - uCentre;
}
`;

/**
 * The lens: what is behind the hole (backdrop and Pixi layer), bent around it.
 *
 * A fragment at distance r shows the picture from r - rE²/r along the same radius, the equation of
 * a point-mass lens. Outside the Einstein radius rE that is a nearer point on the same side, so
 * the picture is squeezed inward and stretched around the circle; inside it the result is
 * negative, which is the far side of the hole, mirrored. The bend is eased to nothing well before
 * the quad's rim, where the output matches the unbent picture exactly and fades out.
 */
export function lensFragment(backgroundGlsl: string, pixiSampleGlsl: string): string {
    return /* glsl */ `
uniform sampler2D uPixiBack;
${SHARED}
${backgroundGlsl}
${pixiSampleGlsl}

void main() {
    vec2 rel = sgFromCentre();
    float r = length(rel);
    float rim = r / uReach;
    if (rim >= 1.0) {
        gl_FragColor = vec4(0.0);
        return;
    }
    vec2 outward = rel / max(r, 0.001);
    float rE = uRadius * EINSTEIN;
    float ease = 1.0 - smoothstep(0.3, 0.86, rim);
    float bend = rE * rE / max(r, max(uRadius * 0.6, 0.5)) * ease; // stage pixels, toward the hole

    // Stage pixels to uv: divide by the stage, and uv's y points up.
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec2 shift = outward * bend * vec2(1.0, -1.0) / uStage;

    // Colours bend by slightly different amounts, so edges near the ring split into fringes.
    vec3 backdrop = fxBackground(uv - shift);
    vec4 pr = fxPixi(uPixiBack, uv - shift * 0.93);
    vec4 pg = fxPixi(uPixiBack, uv - shift);
    vec4 pb = fxPixi(uPixiBack, uv - shift * 1.07);
    vec3 layer = vec3(pr.r, pg.g, pb.b);

    // What is stretched into the ring is also gathered there: a little brighter along it.
    float ringward = (r - rE) / max(uRadius * 0.45, 1.0);
    float gather = 1.0 + 0.8 * exp(-ringward * ringward) * ease;

    vec3 col = backdrop * (1.0 - pg.a) + layer * gather;
    float cover = 1.0 - smoothstep(0.86, 1.0, rim);
    gl_FragColor = vec4(col * cover, cover);
}
`;
}

/**
 * The body: the dark disc, the photon ring hugging it, the tilted band of gas around it, and the
 * point and ring of light of a collapse. Everything but the disc is added light (alpha 0).
 */
export function bodyFragment(backgroundGlsl: string): string {
    return /* glsl */ `
uniform float uMass;
uniform float uTimeS;
uniform float uTurn;   // +1 or -1: which way the gas goes round
uniform vec2 uAxis;    // unit vector along the band's long axis, in stage pixels
uniform float uGlow;   // 0..1 and beyond: strength of all the light it gives off
uniform vec3 uBurst;   // collapse: x = ring radius in px, y = ring strength, z = point strength
uniform vec3 uAccent;
uniform vec3 uAccentAlt;
uniform vec3 uInk;
${SHARED}
${backgroundGlsl}

const float TAU = 6.2831853;
// The band is a flat ring of gas seen from 15 degrees above its plane: sine, cosine, tangent of that.
const vec3 VIEW = vec3(0.2588, 0.9659, 0.2679);

// Value noise along one lane of gas. It repeats every 'period' cells, so it closes round the circle.
float sgLane(float x, float lane, float period) {
    x = mod(x, period);
    float i = floor(x);
    float f = fract(x);
    float u = f * f * (3.0 - 2.0 * f);
    return mix(fxHash(vec2(i, lane) + 0.37), fxHash(vec2(mod(i + 1.0, period), lane) + 0.37), u);
}

// Streaks: concentric lanes, each turning at its own steady rate, the inner ones fastest.
// (Lanes rather than one sheared noise field, which would wind itself ever tighter.)
float sgStreaks(float rho, float around, float period, float lanes) {
    float y = rho * lanes;
    float lane = floor(y);
    float g = fract(y);
    g = g * g * (3.0 - 2.0 * g);
    vec2 turns = 0.16 * pow(vec2(1.5 * lanes) / max(vec2(lane, lane + 1.0), vec2(1.0)), vec2(1.5)); // per second
    float a = sgLane((around + uTurn * uTimeS * turns.x) * period + lane * 3.71, lane, period);
    float b = sgLane((around + uTurn * uTimeS * turns.y) * period + (lane + 1.0) * 3.71, lane + 1.0, period);
    return mix(a, b, g);
}

// Light of the gas at a point of its own plane: g.x along the band, g.y toward the viewer, in disc
// radii. 'squeeze' is how many disc radii of the plane one pixel covers there.
vec3 sgGas(vec2 g, float squeeze) {
    float rho = length(g);
    float inner = 1.3;
    float outer = 2.4 + 1.2 * uMass;
    float band = smoothstep(inner, inner + 0.25, rho) * (1.0 - smoothstep(mix(inner, outer, 0.3), outer, rho));
    if (band < 0.001) {
        return vec3(0.0);
    }
    float around = atan(g.y, g.x) / TAU;
    float coarse = sgStreaks(rho, around, 7.0, 5.0);
    float fine = sgStreaks(rho + 0.37, around, 19.0, 9.0);
    float gas = smoothstep(0.2, 0.9, coarse * 0.65 + fine * 0.5);
    // Where the lanes are squeezed thinner than a pixel, show their average instead of a shimmer.
    gas = 0.12 + 0.88 * mix(gas, 0.45, smoothstep(0.04, 0.14, squeeze));
    // The side turning toward the viewer is the brighter one.
    float beam = 1.0 - 0.5 * uTurn * g.x / max(rho, 0.001);
    float heat = 1.0 - smoothstep(inner, outer, rho);
    vec3 colour = mix(mix(uAccentAlt, uAccent, heat), uInk, heat * heat * gas * 0.5);
    return colour * band * gas * beam * (0.5 + 0.75 * uMass) * (0.55 + 0.9 * heat);
}

void main() {
    vec2 rel = sgFromCentre();
    float r = length(rel);
    float rim = r / uReach;
    float rs = max(uRadius, 0.001);

    // The band of gas. b is this fragment in the band's own axes, in disc radii: x along it, y up
    // across it, so the half of the ring on the viewer's side of the hole shows below the centre.
    vec2 b = vec2(dot(rel, uAxis), -dot(rel, vec2(-uAxis.y, uAxis.x))) / rs;
    float bl = max(length(b), 0.001);
    // Near half: the line of sight meets the gas before it reaches the hole, so it is straight.
    vec2 near = vec2(b.x, -b.y / VIEW.x);
    // Far half: the line of sight passes the hole first and is bent toward it, by 'bend' for every
    // disc radius it travels on. It meets the gas at depth 'deep' behind the hole. From above, that
    // lifts the far side of the ring into an arc over the hole; from below, bent hard enough, it
    // finds the underside of the far side: the thinner arc beneath. The dark disc hides the rest.
    float bend = 0.13 / max(bl - 0.9, 0.05);
    float slope = b.y * bend / bl + VIEW.z;
    float deep = b.y / (abs(slope) < 0.0001 ? 0.0001 : slope);
    float pulled = 1.0 - bend * deep / bl;
    vec2 far = vec2(b.x * pulled, -b.y * pulled * VIEW.x - deep * VIEW.y);

    // Screen-space derivatives, taken before any branch.
    float aa = max(fwidth(r), 0.25);
    float nearSqueeze = fwidth(length(near));
    float farSqueeze = fwidth(length(far));
    if (rim >= 1.0) {
        gl_FragColor = vec4(0.0);
        return;
    }

    float disc = (1.0 - smoothstep(rs - aa, rs + aa, r)) * step(0.5, uRadius);
    float outside = 1.0 - disc;

    // Photon ring: thin, bright, uneven round the circle, the bright part slowly going round.
    float turn = atan(rel.y, rel.x);
    float width = rs * 0.022 + 0.6;
    float off = (r - rs - width * 1.4) / width;
    float uneven = 0.55 + 0.45 * sin(turn * 2.0 + uTimeS * 0.31 * uTurn) * sin(turn - uTimeS * 0.12 + 1.7);
    vec3 ringColour = mix(uInk, uAccent, 0.4);
    vec3 light = ringColour * exp(-off * off) * uneven * 0.8;
    light += ringColour * exp(-max(r - rs, 0.0) / (rs * 0.42)) * outside * 0.07;

    if (b.y < 0.0) {
        light += sgGas(near, nearSqueeze);
    }
    if (deep > 0.0 && outside > 0.0) {
        light += sgGas(far, farSqueeze) * outside;
    }

    // Collapse: a point of light where it was, and a ring that leaves it.
    vec3 burstColour = mix(uInk, uAccent, 0.35);
    float ringOff = (r - uBurst.x) / (5.0 + uBurst.x * 0.05);
    light *= uGlow;
    light += burstColour * exp(-ringOff * ringOff) * uBurst.y * 1.3;
    light += burstColour * (exp(-r * r / 40.0) * 3.0 + exp(-r / 26.0) * 0.55) * uBurst.z;

    light *= 1.0 - smoothstep(0.8, 1.0, rim);
    gl_FragColor = vec4(light, disc);
}
`;
}
