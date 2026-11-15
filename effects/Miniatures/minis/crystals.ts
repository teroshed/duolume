import { clamp, mixColor } from '../../../src/math';
import type { Mini } from '../Mini';

/**
 * Crystals: a few small wire-and-glass solids of different shapes, turning slowly. Every so
 * often one shatters into its facets, which tumble apart and come home; it shatters with the
 * real ones when they break, and a press breaks them all.
 */
interface Crystal {
    /** Its middle (pixels of the knob-free part) and its radius. */
    x: number;
    y: number;
    radius: number;
    sides: number;
    spin: number;
    /** Radians per millisecond. */
    rate: number;
    /** Milliseconds since it shattered; negative while it is whole. */
    broken: number;
}

interface Crystals {
    list: Crystal[];
    /** Milliseconds until one breaks by itself, and which one is next. */
    wait: number;
    next: number;
}

const SHATTER = 1500;

function shatter(state: Crystals): void {
    for (let i = 0; i < state.list.length; i++) {
        const crystal = state.list[(state.next + i) % state.list.length];
        if (crystal.broken < 0) {
            crystal.broken = 0;
            state.next = (state.next + i + 1) % state.list.length;
            return;
        }
    }
}

export const crystals: Mini<Crystals> = {
    create(box) {
        const list: Crystal[] = [];
        const count = clamp(Math.round((box.w * box.height) / 520), 2, 7);
        const size = clamp(box.height * 0.2, 4.5, 12);
        for (let i = 0; i < count; i++) {
            // Spread along the element, alternately high and low, alternately large and small.
            const radius = size * (i % 2 === 0 ? 1.1 : 0.72) * (0.92 + Math.random() * 0.16);
            const high = i % 2 === 0 ? 0.42 : 0.62;
            list.push({
                x: clamp(((i + 0.5) / count) * box.w + (i % 2 === 0 ? -1 : 1) * box.w * 0.04, radius + 2, box.w - radius),
                y: clamp(box.height * (high + (Math.random() - 0.5) * 0.1), radius + 2, box.height - radius - 2),
                radius,
                sides: 4 + ((i * 2 + 2) % 3),
                spin: Math.random() * 6,
                rate: (0.0007 + Math.random() * 0.0006) * (i % 2 === 0 ? 1 : -1),
                broken: -1,
            });
        }
        return { list, wait: 1200, next: 0 };
    },

    tick(state, _box, signal) {
        const lively = signal.hover ? 2.4 : 1;
        for (const crystal of state.list) {
            crystal.spin += signal.dt * crystal.rate * lively;
            if (signal.kick && crystal.broken < 0) {
                crystal.broken = 0;
            } else if (crystal.broken >= 0) {
                crystal.broken += signal.dt;
                if (crystal.broken > SHATTER) {
                    crystal.broken = -1;
                }
            }
        }
        state.wait -= signal.dt * lively;
        // A real crystal broke: one here breaks with it, and the own rhythm starts over.
        if (signal.pulse > 0 || state.wait <= 0) {
            shatter(state);
            state.wait = (2600 + Math.random() * 1800) / Math.sqrt(state.list.length / 2);
        }
    },

    draw(g, state, box, theme, signal) {
        const wire = mixColor(theme.accent, theme.ink, 0.55);
        for (const crystal of state.list) {
            const p = crystal.broken < 0 ? 0 : crystal.broken / SHATTER;
            // Shattered: out fast, hang a moment, then home.
            const apart = p === 0 ? 0 : (p < 0.18 ? 1 - (1 - p / 0.18) ** 2 : 1 - ((p - 0.18) / 0.82) ** 3) * crystal.radius * 1.1;
            // Its proportions change slowly, and it grows in as the element switches on.
            const squash = 0.16 * Math.sin(signal.time * 0.0011 + crystal.x);
            const rx = crystal.radius * (1 + squash) * signal.presence;
            const ry = crystal.radius * (1 - squash) * signal.presence;
            const cx = box.x + crystal.x;
            const tipX = Math.cos(crystal.spin * 1.9) * rx * 0.3;
            const tipY = Math.sin(crystal.spin * 1.4) * ry * 0.3;
            for (let i = 0; i < crystal.sides; i++) {
                const a0 = crystal.spin + (i / crystal.sides) * Math.PI * 2;
                const a1 = crystal.spin + ((i + 1) / crystal.sides) * Math.PI * 2;
                const mid = (a0 + a1) / 2;
                // A facet flies out along its own direction, a little further for every other one.
                const far = apart * (i % 2 === 0 ? 1 : 0.65);
                const ox = cx + Math.cos(mid) * far;
                const oy = crystal.y + Math.sin(mid) * far + p * (1 - p) * 4;
                const lit = 0.5 + 0.5 * Math.cos(mid + 2.2);
                g.moveTo(ox + tipX, oy + tipY)
                    .lineTo(ox + Math.cos(a0) * rx, oy + Math.sin(a0) * ry)
                    .lineTo(ox + Math.cos(a1) * rx, oy + Math.sin(a1) * ry)
                    .closePath()
                    .fill({ color: theme.accent, alpha: 0.08 + 0.26 * lit })
                    .stroke({ width: 1, color: wire, alpha: 0.9 });
            }
        }
    },
};
