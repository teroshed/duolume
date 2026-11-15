import type { Graphics } from 'pixi.js';
import { clamp, mixColor, randomNumber } from '../../../src/math';
import type { Mini } from '../Mini';

interface Flock {
    /** Each bird's place and velocity, in pixels from the left of the free part and the element's top, per millisecond. */
    xs: Float32Array;
    ys: Float32Array;
    vxs: Float32Array;
    vys: Float32Array;
    /** Each bird's place in the formation, from its centre. */
    slotX: Float32Array;
    slotY: Float32Array;
    /** Where the formation is on its round of the element, in radians. */
    wheel: number;
    /** Milliseconds of fright left: while it lasts they fly apart instead of keeping their places. */
    fright: number;
    /** Milliseconds until they take fright by themselves. */
    next: number;
    /** Size of a bird: 1 in a switch, a little more in a taller element. */
    scale: number;
}

/** One bird as a dart pointing the way it flies, added to the current path. `span` is how far its wings are out. */
function dart(g: Graphics, x: number, y: number, vx: number, vy: number, size: number, span: number): void {
    const speed = Math.hypot(vx, vy);
    const ux = speed > 0.0001 ? vx / speed : 1;
    const uy = speed > 0.0001 ? vy / speed : 0;
    g.moveTo(x + ux * 2.8 * size, y + uy * 2.8 * size)
        .lineTo(x - ux * 1.9 * size - uy * span * size, y - uy * 1.9 * size + ux * span * size)
        .lineTo(x - ux * 0.7 * size, y - uy * 0.7 * size)
        .lineTo(x - ux * 1.9 * size + uy * span * size, y - uy * 1.9 * size - ux * span * size)
        .closePath();
}

/**
 * Flock: a handful of tiny darts wheeling round the element together, each keeping its place in
 * the formation and beating its wings. They keep clear of the pointer. When the real flock is
 * startled, when the element is pressed, and now and then by themselves, they scatter in all
 * directions and then find each other again. One of them is the other colour.
 */
export const flock: Mini<Flock> = {
    create(box) {
        const count = clamp(Math.round(box.w / 4.5), 7, 20);
        const spread = clamp(2.2 * Math.sqrt(count), 6, 9);
        const flock: Flock = {
            xs: new Float32Array(count),
            ys: new Float32Array(count),
            vxs: new Float32Array(count),
            vys: new Float32Array(count),
            slotX: new Float32Array(count),
            slotY: new Float32Array(count),
            wheel: Math.random() * 6.28,
            fright: 0,
            next: randomNumber(3500, 6000),
            scale: clamp(box.height / 25, 1.1, 1.5),
        };
        for (let i = 0; i < count; i++) {
            // Places spread evenly over a disc (a sunflower), so no two birds share one.
            const ring = Math.sqrt((i + 0.5) / count);
            flock.slotX[i] = Math.cos(i * 2.4) * spread * ring * 1.3;
            flock.slotY[i] = Math.sin(i * 2.4) * spread * ring;
            flock.xs[i] = box.w / 2 + flock.slotX[i];
            flock.ys[i] = box.height / 2 + flock.slotY[i];
        }
        return flock;
    },

    tick(flock, box, signal) {
        const dt = signal.dt;
        const roomX = Math.max(4, box.w / 2 - 9);
        const roomY = Math.max(3, box.height / 2 - 8);
        const pace = Math.hypot(Math.sin(flock.wheel) * roomX, Math.cos(flock.wheel) * roomY);
        flock.wheel += (dt * 0.028 * (signal.hover ? 1.3 : 1)) / Math.max(3, pace);
        const centreX = box.w / 2 + Math.cos(flock.wheel) * roomX;
        const centreY = box.height / 2 + Math.sin(flock.wheel) * roomY;
        const px = signal.pointerX - box.x;
        const py = signal.pointerY;

        flock.next -= dt;
        flock.fright = Math.max(0, flock.fright - dt);
        const startled = signal.pulse > 0 || signal.kick || flock.next <= 0;
        if (startled) {
            flock.next = randomNumber(5000, 9000);
            flock.fright = 650;
        }
        const fromX = signal.hover ? px : centreX;
        const fromY = signal.hover ? py : centreY;
        const steer = 1 - Math.exp(-dt * (flock.fright > 0 ? 0.0012 : 0.007));
        for (let i = 0; i < flock.xs.length; i++) {
            if (startled) {
                const away = Math.atan2(flock.ys[i] - fromY, flock.xs[i] - fromX) + randomNumber(-0.5, 0.5);
                flock.vxs[i] = Math.cos(away) * 0.085;
                flock.vys[i] = Math.sin(away) * 0.085;
            }
            // Fly toward its own place in the formation, slower as it gets there.
            const dx = centreX + flock.slotX[i] - flock.xs[i];
            const dy = centreY + flock.slotY[i] - flock.ys[i];
            const d = Math.hypot(dx, dy) || 1;
            const want = Math.min(0.07, d * 0.006);
            flock.vxs[i] += ((dx / d) * want - flock.vxs[i]) * steer + signal.wind * 0.00002 * dt;
            flock.vys[i] += ((dy / d) * want - flock.vys[i]) * steer;
            if (signal.hover) {
                const ax = flock.xs[i] - px;
                const ay = flock.ys[i] - py;
                const near = Math.hypot(ax, ay) || 1;
                if (near < 12) {
                    flock.vxs[i] += (ax / near) * (1 - near / 12) * 0.0006 * dt;
                    flock.vys[i] += (ay / near) * (1 - near / 12) * 0.0006 * dt;
                }
            }
            flock.xs[i] += flock.vxs[i] * dt;
            flock.ys[i] += flock.vys[i] * dt;
        }
    },

    draw(g, flock, box, theme, signal) {
        const odd = flock.xs.length > 2 ? 2 : -1;
        for (let i = 0; i < flock.xs.length; i++) {
            if (i !== odd) {
                dart(g, box.x + flock.xs[i], flock.ys[i], flock.vxs[i], flock.vys[i], flock.scale, 1.2 + 0.7 * Math.sin(signal.time * 0.02 + i * 1.7));
            }
        }
        g.fill({ color: mixColor(theme.ink, theme.accent, 0.35), alpha: 0.95 });
        if (odd >= 0) {
            dart(g, box.x + flock.xs[odd], flock.ys[odd], flock.vxs[odd], flock.vys[odd], flock.scale, 1.2 + 0.7 * Math.sin(signal.time * 0.02));
            g.fill({ color: theme.accentAlt, alpha: 1 });
        }
    },
};
