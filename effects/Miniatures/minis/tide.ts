import { mixColor, randomNumber } from '../../../src/math';
import type { Mini, MiniBox, MiniSignal } from '../Mini';

interface Drop {
    x: number;
    y: number;
    vx: number;
    vy: number;
    live: boolean;
}

interface Sea {
    /** Where the swell is in its travel, in radians. */
    phase: number;
    /** The slosh: how far the surface is tipped (pixels at the ends), and how fast that is changing. */
    tilt: number;
    tiltSpeed: number;
    /** A wave that has just jumped: its height in pixels and where it is. */
    jump: number;
    jumpX: number;
    spray: Drop[];
    /** Milliseconds until it sloshes by itself. */
    next: number;
}

/** How deep the water stands, in pixels. At full level: a third of the element, and at least 12 px. */
function depth(box: MiniBox, signal: MiniSignal): number {
    return Math.min(box.height * 0.7, Math.max(12, box.height * 0.34) * (0.3 + 0.7 * signal.level)) * signal.presence;
}

/** How far the surface stands above its resting line at `x`. `lag` puts a band out of step with the others. */
function swell(sea: Sea, box: MiniBox, signal: MiniSignal, x: number, lag: number): number {
    const k = x * 0.26;
    const chop = 1 + Math.abs(signal.wind) * 0.5 + (signal.hover ? 0.4 : 0);
    let rise = (Math.sin(k - sea.phase + lag) * 1.7 + Math.sin(k * 1.9 + sea.phase * 1.6 + lag) * 0.7) * chop;
    rise += sea.tilt * (x / box.width - 0.5) * 2;
    const fromJump = (x - sea.jumpX) / 6;
    rise += sea.jump * Math.exp(-fromJump * fromJump);
    if (signal.hover) {
        // The water heaps up under the pointer.
        const fromPointer = (x - signal.pointerX) / 7;
        rise += 1.5 * Math.exp(-fromPointer * fromPointer);
    }
    return rise;
}

/**
 * Tide: a waterline across the bottom of the element, two bands of water sliding past each other
 * under a bright crest. The swell runs the way the wind blows; `level` is how high the water
 * stands. It sloshes now and then, and a wave jumps with spray when a meteor or a bolt lands in
 * the scene, or the element is pressed.
 */
export const tide: Mini<Sea> = {
    create() {
        const spray: Drop[] = [];
        for (let i = 0; i < 4; i++) {
            spray.push({ x: 0, y: 0, vx: 0, vy: 0, live: false });
        }
        return { phase: Math.random() * 6.28, tilt: 0, tiltSpeed: 0, jump: 0, jumpX: 0, spray, next: randomNumber(1500, 3500) };
    },

    tick(sea, box, signal) {
        const dt = signal.dt;
        sea.phase += dt * 0.0032 * (0.7 + signal.wind * 2.2);
        // The slosh is a damped spring on the tilt of the whole surface.
        sea.tiltSpeed -= sea.tilt * 0.00003 * dt;
        sea.tiltSpeed *= Math.exp(-dt * 0.0016);
        sea.tilt += sea.tiltSpeed * dt;
        sea.jump *= Math.exp(-dt * 0.0045);

        const waterline = box.height - depth(box, signal);
        const struck = signal.pulse > 0 || signal.kick;
        sea.next -= dt;
        if (struck || sea.next <= 0) {
            sea.next = randomNumber(3200, 6000);
            sea.tiltSpeed += (Math.random() < 0.5 ? -1 : 1) * (struck ? 0.016 : 0.011);
            sea.jump = struck ? 5.5 : 2.5;
            sea.jumpX = signal.kick && signal.hover ? signal.pointerX : randomNumber(box.x + 4, box.x + box.w - 4);
            if (struck) {
                for (const drop of sea.spray) {
                    drop.live = true;
                    drop.x = sea.jumpX;
                    drop.y = waterline - sea.jump;
                    drop.vx = randomNumber(-0.035, 0.035);
                    drop.vy = randomNumber(-0.075, -0.035);
                }
            }
        }
        for (const drop of sea.spray) {
            if (drop.live) {
                drop.vy += dt * 0.00028;
                drop.x += drop.vx * dt;
                drop.y += drop.vy * dt;
                drop.live = drop.vy < 0 || drop.y < waterline + 1;
            }
        }
    },

    draw(g, sea, box, theme, signal) {
        const deep = depth(box, signal);
        if (deep < 0.5) {
            return;
        }
        const base = box.height - deep;
        const step = Math.max(2, box.width / 60);
        const end = box.width + step;
        // The far band stands a little higher and is out of step with the near one.
        g.moveTo(0, box.height);
        for (let x = 0; x <= end; x += step) {
            g.lineTo(x, base - 2 - swell(sea, box, signal, x, 2.1) * 0.8);
        }
        g.lineTo(end, box.height).closePath().fill({ color: theme.accentAlt, alpha: 0.32 });
        g.moveTo(0, box.height);
        for (let x = 0; x <= end; x += step) {
            g.lineTo(x, base - swell(sea, box, signal, x, 0));
        }
        g.lineTo(end, box.height).closePath().fill({ color: mixColor(theme.accent, theme.accentAlt, 0.35), alpha: 0.3 });
        // The crest: one bright line along the near band.
        g.moveTo(0, base - swell(sea, box, signal, 0, 0));
        for (let x = step; x <= end; x += step) {
            g.lineTo(x, base - swell(sea, box, signal, x, 0));
        }
        g.stroke({ width: 1, color: mixColor(theme.accent, theme.ink, 0.35), alpha: 0.9 });
        for (const drop of sea.spray) {
            if (drop.live) {
                g.circle(drop.x, drop.y, 0.8).fill({ color: theme.ink, alpha: 0.9 });
            }
        }
    },
};
