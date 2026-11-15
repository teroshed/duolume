import type { Graphics } from 'pixi.js';
import { clamp, mixColor, randomNumber } from '../../../src/math';
import type { Mini } from '../Mini';

interface Cloud {
    /** Centre, in pixels from the left of the free part and the element's top. */
    x: number;
    y: number;
    /** Pixels per millisecond it drifts by itself. */
    drift: number;
    /** Its four lobes: where each is from the centre, and its radius, in pixels. */
    lobeX: Float32Array;
    lobeY: Float32Array;
    lobeR: Float32Array;
    /** 1 when something has just lit it from inside, fading to 0; and the milliseconds since. */
    glow: number;
    since: number;
    violet: boolean;
}

interface Sky {
    clouds: Cloud[];
    /** How far past each end a cloud drifts before it comes round again. */
    margin: number;
    /** Milliseconds until one lights up by itself. */
    next: number;
}

const LOBES = [-1.45, 0.2, 0.7, -0.5, -0.25, 1, 0.5, 0.1, 0.85, 1.35, 0.3, 0.6];

/** The cloud's lobes as circles in the current path: shrunk toward the centre by `pull`, radius times `scale` plus `more`. */
function lobes(g: Graphics, cloud: Cloud, x: number, pull: number, scale: number, more: number, from = 0, to = 4): void {
    for (let i = from; i < to; i++) {
        g.circle(x + cloud.lobeX[i] * pull, cloud.y + cloud.lobeY[i] * pull, cloud.lobeR[i] * scale + more);
    }
}

/**
 * Nebula: dark cloud shapes, each a few flat lobes with a thin lit edge, drifting slowly (the
 * wind carries them). Something lights one from inside now and then: the light shows as two
 * flat steps of brightness within the dark shape, flickers once and fades. Lightning or a
 * firework in the scene lights them all, so does a press, and the pointer carries a lantern
 * through whichever cloud it is over.
 */
export const nebula: Mini<Sky> = {
    create(box) {
        const size = clamp(box.height * 0.21, 4.5, 11);
        const count = clamp(Math.round(box.w / 45), 2, 4);
        const margin = size * 2.3;
        const clouds: Cloud[] = [];
        for (let i = 0; i < count; i++) {
            const cloud: Cloud = {
                x: (box.w / 2 + (i * (box.w + margin * 2)) / count) % (box.w + margin * 2),
                y: box.height * ((i % 2 === 0 ? 0.42 : 0.6) + randomNumber(-0.06, 0.06)),
                drift: randomNumber(0.003, 0.005),
                lobeX: new Float32Array(4),
                lobeY: new Float32Array(4),
                lobeR: new Float32Array(4),
                glow: 0,
                since: 1000,
                violet: i % 2 === 1,
            };
            for (let k = 0; k < 4; k++) {
                cloud.lobeX[k] = LOBES[k * 3] * size * randomNumber(0.9, 1.1);
                cloud.lobeY[k] = LOBES[k * 3 + 1] * size + randomNumber(-0.15, 0.15) * size;
                cloud.lobeR[k] = LOBES[k * 3 + 2] * size * randomNumber(0.9, 1.1);
            }
            clouds.push(cloud);
        }
        return { clouds, margin, next: randomNumber(600, 1600) };
    },

    tick(sky, box, signal) {
        const dt = signal.dt;
        const span = box.w + sky.margin * 2;
        sky.next -= dt * (signal.hover ? 2 : 1);
        let pick = -1;
        if (sky.next <= 0) {
            sky.next = randomNumber(1800, 3600);
            // One that is in view, if any is.
            pick = Math.floor(Math.random() * sky.clouds.length);
            for (let i = 0; i < sky.clouds.length; i++) {
                const candidate = (pick + i) % sky.clouds.length;
                if (sky.clouds[candidate].x > box.w * 0.15 && sky.clouds[candidate].x < box.w * 0.85) {
                    pick = candidate;
                    break;
                }
            }
        }
        for (let i = 0; i < sky.clouds.length; i++) {
            const cloud = sky.clouds[i];
            cloud.x += dt * (cloud.drift + signal.wind * 0.02);
            if (cloud.x > box.w + sky.margin) {
                cloud.x -= span;
            } else if (cloud.x < -sky.margin) {
                cloud.x += span;
            }
            cloud.since += dt;
            cloud.glow *= Math.exp(-dt * 0.0028);
            if (signal.pulse > 0 || signal.kick || i === pick) {
                cloud.glow = 1;
                cloud.since = 0;
            }
        }
    },

    draw(g, sky, box, theme, signal) {
        for (const cloud of sky.clouds) {
            const x = box.x + cloud.x;
            const tone = cloud.violet ? theme.accentAlt : theme.accent;
            // The light inside: a flash that dips once (the flicker), over an ember that never quite goes out.
            let light = cloud.glow * (cloud.since > 90 && cloud.since < 150 ? 0.3 : 1);
            light = Math.max(light, 0.14 + 0.08 * Math.sin(signal.time * 0.002 + cloud.y));
            if (signal.hover && Math.abs(signal.pointerX - x) < sky.margin) {
                light = Math.max(light, 0.5);
            }
            // The lit edge is the same shape a little larger, behind the dark body.
            lobes(g, cloud, x, 1, 1, 0.9);
            g.fill({ color: mixColor(tone, theme.ink, light * 0.6), alpha: 0.45 + 0.55 * light });
            lobes(g, cloud, x, 1, 1, 0);
            g.fill({ color: mixColor(theme.bgTop, tone, 0.3), alpha: 1 });
            lobes(g, cloud, x, 0.8, 0.66, 0);
            g.fill({ color: tone, alpha: 0.7 * light });
            lobes(g, cloud, x, 0.6, 0.36, 0, 1, 3);
            g.fill({ color: mixColor(tone, theme.ink, 0.7), alpha: 0.9 * light });
        }
    },
};
