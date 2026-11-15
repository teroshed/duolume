import { clamp, mixColor, randomNumber } from '../../../src/math';
import type { Mini } from '../Mini';

interface Fly {
    /** Its home, as fractions of the free part's width and the element's height. */
    u: number;
    v: number;
    /** 0..1 through its cycle: at 1 it flashes and starts again. */
    phase: number;
    /** Milliseconds one cycle takes by itself. */
    period: number;
    /** 1 at the flash, fading to 0. */
    flash: number;
    wander: number;
    violet: boolean;
}

interface Swarm {
    flies: Fly[];
    /** How many times in a row they have all flashed in the same tick. */
    together: number;
}

/**
 * Fireflies: a few points that blink. Each runs through its own cycle and flashes at the end of
 * it, and every flash pulls the others a step along theirs, so from random phases they fall
 * into step until all blink as one; after a few beats together they lose it and start over.
 * When the real swarm falls into step so do these, at once. A press makes them all flash and
 * scatters their phases; under the pointer they blink faster. The wind carries them.
 */
export const fireflies: Mini<Swarm> = {
    create(box) {
        const count = clamp(Math.round((box.w * box.height) / 120), 6, 22);
        const flies: Fly[] = [];
        for (let i = 0; i < count; i++) {
            flies.push({
                u: (i + 0.2 + Math.random() * 0.6) / count,
                v: randomNumber(0.2, 0.8),
                phase: Math.random(),
                period: randomNumber(1000, 1250),
                flash: 0,
                wander: Math.random() * 6.28,
                violet: i % 3 === 1,
            });
        }
        return { flies, together: 0 };
    },

    tick(swarm, _box, signal) {
        const dt = signal.dt;
        const flies = swarm.flies;
        if (signal.kick || swarm.together >= 3) {
            for (const fly of flies) {
                fly.flash = signal.kick ? 1 : fly.flash;
                fly.phase = Math.random() * 0.9;
            }
            swarm.together = 0;
        }
        if (signal.pulse > 0) {
            for (const fly of flies) {
                fly.phase = 1;
            }
            swarm.together = 0;
        }
        for (const fly of flies) {
            fly.flash = Math.max(0, fly.flash - dt / 420);
            fly.phase += (dt * (signal.hover ? 1.6 : 1)) / fly.period;
            fly.u = (fly.u + signal.wind * dt * 0.00004 + 1) % 1;
        }
        // A flash pulls every other fly along its cycle; one that is pulled to the end flashes too.
        const pull = 1 + 0.3 / flies.length;
        let flashed = 0;
        for (let pass = 0; pass < 2; pass++) {
            for (const fly of flies) {
                if (fly.phase < 1) {
                    continue;
                }
                fly.phase = 0;
                fly.flash = 1;
                flashed++;
                for (const other of flies) {
                    if (other !== fly && other.phase > 0.12) {
                        other.phase = Math.min(1, other.phase * pull);
                    }
                }
            }
        }
        if (flashed >= flies.length * 0.8) {
            swarm.together++;
        } else if (flashed > 0) {
            swarm.together = 0;
        }
    },

    draw(g, swarm, box, theme, signal) {
        for (const fly of swarm.flies) {
            const x = box.x + fly.u * box.w + Math.sin(signal.time * 0.0011 + fly.wander) * 2.2;
            const y = fly.v * box.height + Math.cos(signal.time * 0.0013 + fly.wander * 1.7) * 1.8;
            const tone = fly.violet ? theme.accentAlt : theme.accent;
            if (fly.flash > 0.05) {
                g.circle(x, y, 1.6 + 2.4 * fly.flash).fill({ color: tone, alpha: 0.3 * fly.flash });
            }
            g.circle(x, y, 1 + 1.2 * fly.flash).fill({ color: mixColor(tone, theme.ink, fly.flash * 0.6), alpha: 0.5 + 0.5 * fly.flash });
        }
    },
};
