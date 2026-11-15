import { clamp, mixColor } from '../../../src/math';
import type { Mini, MiniBox } from '../Mini';

/**
 * Aurora ribbons: two or three slow sine ribbons of light crossing the element, each a band
 * that thins where it turns edge-on, with a bright upper edge. The wind carries them along; a
 * press sends a swell running down them, as an event does to the real ones.
 */
interface Ribbon {
    /** Height of its middle line, 0..1 of the element; swing as a share of the height. */
    v: number;
    swing: number;
    /** How many waves fit across the element, and where in the wave it is (radians). */
    waves: number;
    phase: number;
    /** Radians per millisecond; a negative one runs right to left. */
    speed: number;
    /** 0 is the first accent, 1 the second. */
    tone: number;
}

interface Aurora {
    ribbons: Ribbon[];
    /** Where the swell is along the ribbons, 0..1; above 1.3 there is none. */
    swell: number;
    /** Milliseconds until a hovered element sends the next swell. */
    wait: number;
}

/** The ribbon's middle line and half thickness at `u` (0..1 across the free part), into `out`. */
function shape(ribbon: Ribbon, u: number, box: MiniBox, swell: number, level: number, out: { y: number; half: number }): void {
    const angle = u * ribbon.waves * Math.PI * 2 - ribbon.phase;
    const bump = Math.exp(-(((u - swell) / 0.14) ** 2));
    const thick = clamp(box.height * 0.085, 1.6, 4.5);
    out.y = box.height * (ribbon.v + ribbon.swing * (0.45 + 0.55 * level) * (Math.sin(angle) + 0.3 * Math.sin(angle * 0.47 + 1.3))) - bump * box.height * 0.08;
    out.half = thick * (0.3 + 0.7 * Math.abs(Math.sin(angle * 0.5 + ribbon.tone * 2))) + bump * thick * 0.9;
}

const at = { y: 0, half: 0 };

export const auroraRibbons: Mini<Aurora> = {
    create(box) {
        const ribbons: Ribbon[] = [];
        const count = clamp(Math.round(box.height / 22), 2, 4);
        for (let i = 0; i < count; i++) {
            ribbons.push({
                v: (i + 0.5) / count + (Math.random() - 0.5) * 0.08,
                swing: (0.24 + Math.random() * 0.08) / Math.sqrt(count),
                waves: Math.max(0.85, box.w / 62) * (0.8 + Math.random() * 0.5),
                phase: Math.random() * Math.PI * 2,
                speed: (0.0011 + Math.random() * 0.0007) * (i % 2 === 0 ? 1 : -0.7),
                tone: count === 1 ? 0 : i / (count - 1),
            });
        }
        return { ribbons, swell: 2, wait: 0 };
    },

    tick(state, _box, signal) {
        for (const ribbon of state.ribbons) {
            ribbon.phase += signal.dt * (ribbon.speed * (signal.hover ? 2.4 : 1) + signal.wind * 0.006);
        }
        state.wait -= signal.dt;
        if (signal.kick || (signal.hover && state.wait <= 0 && state.swell > 1.3)) {
            state.swell = -0.2;
            state.wait = 1400;
        }
        if (state.swell <= 1.3) {
            state.swell += signal.dt * 0.0019;
        }
    },

    draw(g, state, box, theme, signal) {
        const steps = clamp(Math.round(box.w / 3), 10, 44);
        // A switch shows them plainly; behind the words of a field or a button they stay quieter.
        const strength = box.w < box.width || box.height > 60 ? 1 : 0.6;
        // Switching on, the ribbons unroll from the left.
        const reach = Math.min(1, signal.presence * 1.1);
        for (const ribbon of state.ribbons) {
            const color = mixColor(theme.accent, theme.accentAlt, ribbon.tone);
            // The band: along its upper edge, then back along its lower edge.
            for (let i = 0; i <= steps; i++) {
                const u = (i / steps) * reach;
                shape(ribbon, u, box, state.swell, signal.level, at);
                if (i === 0) {
                    g.moveTo(box.x + u * box.w, at.y - at.half);
                } else {
                    g.lineTo(box.x + u * box.w, at.y - at.half);
                }
            }
            for (let i = steps; i >= 0; i--) {
                const u = (i / steps) * reach;
                shape(ribbon, u, box, state.swell, signal.level, at);
                g.lineTo(box.x + u * box.w, at.y + at.half);
            }
            g.closePath().fill({ color, alpha: 0.5 * strength });
            // Its bright upper edge.
            for (let i = 0; i <= steps; i++) {
                const u = (i / steps) * reach;
                shape(ribbon, u, box, state.swell, signal.level, at);
                if (i === 0) {
                    g.moveTo(box.x + u * box.w, at.y - at.half);
                } else {
                    g.lineTo(box.x + u * box.w, at.y - at.half);
                }
            }
            g.stroke({ width: 1, color: mixColor(color, theme.ink, 0.45), alpha: 0.9 * strength });
        }
    },
};
