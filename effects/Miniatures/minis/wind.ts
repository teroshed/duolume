import { approach, clamp, mixColor } from '../../../src/math';
import type { Mini } from '../Mini';

/**
 * Wind: the real effect draws nothing, so this is the air itself. Streaks run across the
 * element and curl over at their heads, and a few specks of dust tumble along with them. They
 * go the way the scene's wind blows and as hard as it blows; in a calm they drift gently right.
 */
interface Streak {
    /** Where its head is: 0..1 across the knob-free part (it runs past both ends), 0..1 down. */
    u: number;
    v: number;
    /** Its length in pixels at full wind, and its pace (elements per millisecond at flow 1). */
    length: number;
    pace: number;
    /** Curls upward (-1) or downward (1) at the head. */
    curl: number;
}

interface Speck {
    u: number;
    v: number;
    pace: number;
    /** Radians: where it is in its bobbing. */
    bob: number;
}

interface Wind {
    streaks: Streak[];
    specks: Speck[];
    /** Signed speed of the air, eased: about 0.35 in a calm, 2 in a hard blow; negative runs left. */
    flow: number;
}

export const wind: Mini<Wind> = {
    create(box) {
        const streaks: Streak[] = [];
        const specks: Speck[] = [];
        const area = box.w * box.height;
        const lanes = clamp(Math.round(area / 330), 3, 12);
        for (let i = 0; i < lanes; i++) {
            streaks.push({
                u: Math.random() * 1.6 - 0.3,
                v: (i + 0.5) / lanes + (Math.random() - 0.5) * (0.3 / lanes),
                length: clamp(box.w * 0.6, 14, 30) * (0.75 + Math.random() * 0.5),
                pace: (0.011 + Math.random() * 0.006) / Math.max(box.w, 24),
                curl: (i + 0.5) / lanes < 0.6 ? -1 : 1,
            });
        }
        for (let i = 0; i < clamp(Math.round(area / 420), 2, 10); i++) {
            specks.push({ u: Math.random(), v: 0.2 + Math.random() * 0.6, pace: (0.02 + Math.random() * 0.012) / Math.max(box.w, 24), bob: Math.random() * 6 });
        }
        return { streaks, specks, flow: 0.35 };
    },

    tick(state, box, signal) {
        // Natural gusts are a seventh of a hand-blown wind: the square root lets them show.
        const strength = Math.sqrt(Math.abs(signal.wind));
        const target = (signal.wind < -0.015 ? -1 : 1) * (0.35 + 1.65 * strength) * (signal.hover ? 1.6 : 1);
        state.flow = approach(state.flow, target, 3, signal.dt);
        if (signal.kick) {
            // A puff.
            state.flow += Math.sign(state.flow || 1) * 2.2;
        }
        for (const streak of state.streaks) {
            streak.u += state.flow * streak.pace * signal.dt;
            // Past the far end with its whole length, it comes in again at the near end.
            const span = streak.length / Math.max(box.w, 24);
            if (streak.u > 1.15 + span) {
                streak.u = -0.15;
            } else if (streak.u < -0.15 - span) {
                streak.u = 1.15;
            }
        }
        for (const speck of state.specks) {
            speck.u += state.flow * speck.pace * signal.dt;
            speck.bob += signal.dt * 0.006 * (0.5 + Math.abs(state.flow));
            if (speck.u > 1.1) {
                speck.u -= 1.2;
                speck.v = 0.2 + Math.random() * 0.6;
            } else if (speck.u < -0.1) {
                speck.u += 1.2;
                speck.v = 0.2 + Math.random() * 0.6;
            }
        }
    },

    draw(g, state, box, theme, signal) {
        const way = state.flow < 0 ? -1 : 1;
        const force = clamp(Math.abs(state.flow) / 2, 0, 1.3);
        // A switch shows it plainly; behind the words of a field or a button it stays quieter.
        const quiet = box.w < box.width || box.height > 60 ? 1 : 0.65;
        const curl = clamp(box.height * 0.1, 2.2, 3.6);
        for (const streak of state.streaks) {
            const length = streak.length * (0.65 + 0.5 * force) * signal.presence;
            const hx = box.x + streak.u * box.w;
            const hy = clamp(streak.v * box.height, curl * 2 + 2, box.height - curl * 2 - 2);
            // From the tail to the head, with a slow wave in it.
            for (let i = 0; i <= 4; i++) {
                const back = length * (1 - i / 4);
                const y = hy + Math.sin(back * 0.35 + streak.v * 20) * 0.9 * (back / length);
                if (i === 0) {
                    g.moveTo(hx - way * back, y);
                } else {
                    g.lineTo(hx - way * back, y);
                }
            }
            // The head curls over: three quarters of a small circle, forward and back on itself.
            const cy = hy + streak.curl * curl;
            for (let i = 1; i <= 7; i++) {
                const angle = (i / 7) * Math.PI * 1.45;
                g.lineTo(hx + way * Math.sin(angle) * curl, cy - streak.curl * Math.cos(angle) * curl);
            }
            g.stroke({ width: 1, color: mixColor(theme.ink, theme.accent, 0.3), alpha: Math.min(1, 0.62 + 0.33 * force) * quiet });
        }
        // The dust: small diamonds that bob as they are carried.
        for (const speck of state.specks) {
            const x = box.x + speck.u * box.w;
            const y = speck.v * box.height + Math.sin(speck.bob) * box.height * 0.09;
            const size = 1.2 + 0.5 * Math.sin(speck.bob * 1.7);
            g.moveTo(x - size, y).lineTo(x, y - size).lineTo(x + size, y).lineTo(x, y + size).closePath();
            g.fill({ color: speck.pace * box.w > 0.026 ? theme.accentAlt : theme.accent, alpha: 0.95 * quiet });
        }
    },
};
