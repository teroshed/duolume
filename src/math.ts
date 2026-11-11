import type { Vector3 } from './types';

export function randomNumber(min: number, max: number): number {
    return Math.random() * (max - min) + min;
}

/** 2D distance. Unlike the original, a coordinate of exactly 0 is a real coordinate. */
export function distanceV2(v1: Vector3 | undefined | null, v2: Vector3 | undefined | null): number {
    if (!v1 || !v2) {
        return 0;
    }
    const dx = v1.x - v2.x;
    const dy = v1.y - v2.y;
    return Math.sqrt(dx * dx + dy * dy);
}

export function clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}

/** Frame-rate independent easing toward a target. `rate` is per second, `dtMs` in milliseconds. */
export function approach(current: number, target: number, rate: number, dtMs: number): number {
    return target + (current - target) * Math.exp((-rate * dtMs) / 1000);
}

/** Blend two 0xRRGGBB colours. */
export function mixColor(a: number, b: number, t: number): number {
    const ar = (a >> 16) & 255;
    const ag = (a >> 8) & 255;
    const ab = a & 255;
    const br = (b >> 16) & 255;
    const bg = (b >> 8) & 255;
    const bb = b & 255;
    const r = Math.round(ar + (br - ar) * t);
    const g = Math.round(ag + (bg - ag) * t);
    const bl = Math.round(ab + (bb - ab) * t);
    return (r << 16) | (g << 8) | bl;
}

export function rgbToHex(r: number, g: number, b: number): number {
    return (clamp(Math.floor(r), 0, 255) << 16) | (clamp(Math.floor(g), 0, 255) << 8) | clamp(Math.floor(b), 0, 255);
}
