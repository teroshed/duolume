import type { Graphics } from 'pixi.js';
import { approach, clamp, mixColor, randomNumber } from '../../../src/math';
import type { Mini } from '../Mini';

interface Hole {
    /** Centre, in pixels from the left of the free part and the element's top. */
    x: number;
    y: number;
    /** The disc's radius in pixels when it is full, for this element. */
    radius: number;
    /** 0..1: what it has eaten. At 1 it collapses. */
    mass: number;
    /** 0..1, eased: how much of the disc is there (0 after a collapse, until it forms again). */
    size: number;
    /** Milliseconds since it collapsed; negative while it exists. */
    collapsed: number;
    /** Where the bright clumps are on the band, and where the hole is on its loop, in radians. */
    turn: number;
    loop: number;
    /** Dust falling in: x and y of each speck. */
    dustX: Float32Array;
    dustY: Float32Array;
}

const TILT = -0.3;
const GONE_MS = 450;

/** The point at angle `a` on the tilted band of half-width `rx`. Returns x; y through `bandY`. */
function bandX(a: number, rx: number): number {
    return Math.cos(a) * rx * Math.cos(TILT) - Math.sin(a) * rx * 0.28 * Math.sin(TILT);
}
function bandY(a: number, rx: number): number {
    return Math.cos(a) * rx * Math.sin(TILT) + Math.sin(a) * rx * 0.28 * Math.cos(TILT);
}

/** Half of the band as a line: the far half (`from` = π) goes behind the disc, the near half (0) in front. */
function band(g: Graphics, x: number, y: number, rx: number, from: number): void {
    g.moveTo(x + bandX(from, rx), y + bandY(from, rx));
    for (let i = 1; i <= 10; i++) {
        const a = from + (i / 10) * Math.PI;
        g.lineTo(x + bandX(a, rx), y + bandY(a, rx));
    }
}

/**
 * Singularity: a small black disc inside a bright ring, with a tilted band of gas whose bright
 * clumps turn round it, and dust spiralling in. It swells as it feeds (faster under the
 * pointer, which it leans toward), then collapses in a ring of light and forms again, small. It
 * collapses with the real one, and when the element is pressed.
 */
export const singularity: Mini<Hole> = {
    create(box) {
        const dust = clamp(Math.round(box.w / 9), 4, 16);
        const dustX = new Float32Array(dust);
        const dustY = new Float32Array(dust);
        for (let i = 0; i < dust; i++) {
            dustX[i] = randomNumber(0, box.w);
            dustY[i] = randomNumber(0, box.height);
        }
        const radius = clamp(box.height * 0.22, 5, 13);
        return { x: box.w / 2, y: box.height / 2, radius, mass: randomNumber(0.3, 0.6), size: 1, collapsed: -1, turn: 0, loop: Math.random() * 6.28, dustX, dustY };
    },

    tick(hole, box, signal) {
        const dt = signal.dt;
        hole.turn += dt * 0.0024 * (signal.hover ? 2 : 1);
        hole.loop += dt * 0.0004;
        // It drifts on a slow loop, as far as the element has room for, and leans toward the pointer.
        const roomX = Math.max(0, box.w / 2 - hole.radius * 2.4 - 1);
        const roomY = Math.max(0, box.height / 2 - hole.radius - 5);
        let homeX = box.w / 2 + Math.sin(hole.loop) * roomX;
        let homeY = box.height / 2 + Math.sin(hole.loop * 2 + 1) * roomY;
        if (signal.hover) {
            homeX += clamp((signal.pointerX - box.x - homeX) * 0.3, -4, 4);
            homeY += clamp((signal.pointerY - homeY) * 0.3, -3, 3);
        }
        hole.x = approach(hole.x, homeX, 3, dt);
        hole.y = approach(hole.y, homeY, 3, dt);

        if (hole.collapsed < 0) {
            hole.mass += dt * 0.00005 * (signal.hover ? 2.5 : 1);
            if (hole.mass >= 1 || signal.pulse > 0 || signal.kick) {
                hole.collapsed = 0;
            }
        } else {
            hole.collapsed += dt;
            if (hole.collapsed > GONE_MS) {
                hole.collapsed = -1;
                hole.mass = 0.3;
            }
        }
        const exists = hole.collapsed < 0;
        hole.size = approach(hole.size, exists ? 1 : 0, exists ? 6 : 30, dt);

        const mouth = hole.radius * hole.size * 0.9;
        for (let i = 0; i < hole.dustX.length; i++) {
            const dx = hole.x - hole.dustX[i];
            const dy = hole.y - hole.dustY[i];
            const d = Math.hypot(dx, dy) || 1;
            // Dust falls in on a spiral, faster the closer it is; a collapse throws it outward.
            const pull = exists ? 0.006 + 0.18 / d : -0.06;
            hole.dustX[i] += ((dx / d) * pull - (dy / d) * Math.abs(pull) * 0.7) * dt;
            hole.dustY[i] += ((dy / d) * pull + (dx / d) * Math.abs(pull) * 0.7) * dt;
            const eaten = exists && d < mouth;
            if (eaten || d > box.w + box.height) {
                hole.mass += eaten ? 0.012 : 0;
                hole.dustX[i] = randomNumber(0, box.w);
                hole.dustY[i] = Math.random() < 0.5 ? 0 : box.height;
            }
        }
    },

    draw(g, hole, box, theme, signal) {
        const x = box.x + hole.x;
        const y = hole.y;
        const r = hole.radius * (0.62 + 0.38 * hole.mass) * hole.size * (0.5 + 0.5 * signal.presence);
        for (let i = 0; i < hole.dustX.length; i++) {
            g.circle(box.x + hole.dustX[i], hole.dustY[i], 0.8).fill({ color: theme.accent, alpha: 0.8 });
        }
        if (hole.collapsed >= 0) {
            // The collapse: a flash at the centre and a ring of light running outward.
            const t = hole.collapsed / GONE_MS;
            g.circle(x, y, hole.radius * (0.4 + 2.4 * t)).stroke({ width: 1, color: theme.ink, alpha: 1 - t });
            if (t < 0.25) {
                g.circle(x, y, 0.6 + 2.4 * (1 - t * 4)).fill({ color: theme.ink, alpha: 1 });
            }
        }
        if (r < 0.8) {
            return;
        }
        const gas = mixColor(theme.accent, theme.accentAlt, 0.4);
        band(g, x, y, r * 1.9, Math.PI);
        g.stroke({ width: 1.5, color: gas, alpha: 0.75 });
        band(g, x, y, r * 2.3, Math.PI);
        g.stroke({ width: 1, color: theme.accentAlt, alpha: 0.5 });
        g.circle(x, y, r).fill({ color: mixColor(theme.bgBottom, 0x000000, 0.8), alpha: 1 });
        g.circle(x, y, r + 0.3).stroke({ width: 1.2, color: mixColor(theme.ink, theme.accent, 0.35), alpha: 0.95 });
        band(g, x, y, r * 1.9, 0);
        g.stroke({ width: 1.5, color: theme.accent, alpha: 0.95 });
        band(g, x, y, r * 2.3, 0);
        g.stroke({ width: 1, color: theme.accentAlt, alpha: 0.6 });
        // Three bright clumps turning with the gas; the disc hides them while they pass behind it.
        for (let k = 0; k < 3; k++) {
            const a = hole.turn + k * 2.094;
            const cx = bandX(a, r * 1.9);
            const cy = bandY(a, r * 1.9);
            if (Math.sin(a) > 0 || Math.hypot(cx, cy) > r + 1) {
                g.circle(x + cx, y + cy, 1.1).fill({ color: theme.ink, alpha: Math.sin(a) > 0 ? 1 : 0.7 });
            }
        }
    },
};
