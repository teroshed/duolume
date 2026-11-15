import { clamp, randomNumber } from '../../../src/math';
import type { Mini, MiniBox } from '../Mini';

interface Bubble {
    /** The middle of the lane it rises in, and its centre: pixels from the left of the free part, and from the element's top. */
    lane: number;
    x: number;
    y: number;
    r: number;
    rise: number;
    wobble: number;
    /** Milliseconds since it popped; negative while it is whole. */
    popped: number;
}

interface Bath {
    bubbles: Bubble[];
    /** Milliseconds until one pops by itself. */
    next: number;
}

const POP_MS = 240;

/** The radius of the biggest bubble this element gets. */
function biggest(box: MiniBox): number {
    return clamp(box.height * 0.18, 4.5, 11);
}

/** Send a bubble up again from just below the element, in its own lane. */
function blow(bubble: Bubble, box: MiniBox): void {
    bubble.r = biggest(box) * randomNumber(0.55, 1);
    bubble.x = bubble.lane + randomNumber(-1.5, 1.5);
    bubble.y = box.height + bubble.r * 0.6;
    bubble.rise = randomNumber(0.0042, 0.005);
    bubble.popped = -1;
}

/**
 * Bubbles: a handful of soap bubbles (more in a wider element), each a rim with a highlight,
 * rising and wobbling. One pops when a real one does, when the element is pressed (the one
 * under the pointer), and now and then by itself. They lean with the wind and shy from the pointer.
 */
export const bubbles: Mini<Bath> = {
    create(box) {
        const count = clamp(Math.round(box.w / (biggest(box) * 1.4)), 5, 12);
        const edge = Math.min(6, box.w * 0.12);
        const list: Bubble[] = [];
        for (let i = 0; i < count; i++) {
            // One lane each across the element, and spread out over its height, so some are always in view.
            const bubble: Bubble = { lane: edge + ((i + 0.5) / count) * (box.w - edge * 2), x: 0, y: 0, r: 1, rise: 0, wobble: Math.random() * 6.28, popped: -1 };
            blow(bubble, box);
            bubble.y = ((i * 0.618 + 0.2) % 1) * (box.height + bubble.r * 2) - bubble.r;
            list.push(bubble);
        }
        return { bubbles: list, next: randomNumber(3000, 6000) };
    },

    tick(bath, box, signal) {
        const dt = signal.dt;
        const px = signal.pointerX - box.x;
        const py = signal.pointerY;
        bath.next -= dt;
        const pop = signal.pulse > 0 || signal.kick || bath.next <= 0;
        if (pop) {
            bath.next = randomNumber(5000, 9000);
        }
        let chosen: Bubble | undefined;
        let best = Infinity;
        for (const b of bath.bubbles) {
            if (b.popped >= 0) {
                b.popped += dt;
                if (b.popped > POP_MS) {
                    blow(b, box);
                }
                continue;
            }
            b.wobble += dt * 0.0034;
            b.y -= dt * b.rise * (signal.hover ? 1.6 : 1);
            b.x += dt * signal.wind * 0.008;
            const dx = b.x - px;
            const dy = b.y - py;
            const d = Math.hypot(dx, dy) || 1;
            if (signal.hover && d < b.r + 9) {
                b.x += (dx / d) * dt * 0.02;
                b.y += (dy / d) * dt * 0.02;
            }
            if (b.y < -b.r) {
                blow(b, box);
                continue;
            }
            // Blown out of one side, it comes in at the other.
            b.x = b.x < -b.r ? box.w + b.r : b.x > box.w + b.r ? -b.r : b.x;
            // Which one pops: the nearest to a press, otherwise the biggest that is in view.
            const inView = b.y > b.r * 0.6 && b.y < box.height - b.r * 0.6;
            const score = signal.kick && signal.hover ? d : (inView ? 0 : 100) - b.r;
            if (score < best) {
                best = score;
                chosen = b;
            }
        }
        if (pop && chosen) {
            chosen.popped = 0;
        }
    },

    draw(g, bath, box, theme, signal) {
        const grow = 0.5 + 0.5 * signal.presence;
        for (const b of bath.bubbles) {
            const x = box.x + b.x + Math.sin(b.wobble) * 1.3;
            const y = b.y;
            const r = b.r * grow;
            if (b.popped >= 0) {
                // A pop: six short dashes flying outward.
                const t = b.popped / POP_MS;
                if (t < 1) {
                    for (let k = 0; k < 6; k++) {
                        const cos = Math.cos(k * 1.047 + b.wobble);
                        const sin = Math.sin(k * 1.047 + b.wobble);
                        g.moveTo(x + cos * r * (0.8 + t), y + sin * r * (0.8 + t)).lineTo(x + cos * r * (1.25 + t * 1.3), y + sin * r * (1.25 + t * 1.3));
                    }
                    g.stroke({ width: 1, color: theme.ink, alpha: 1 - t });
                }
                continue;
            }
            g.circle(x, y, r).fill({ color: theme.accentAlt, alpha: 0.12 });
            g.circle(x, y, r).stroke({ width: 1, color: theme.accent, alpha: 0.9 });
            // The soap film's other colour down one side, and the window's reflection top left.
            g.moveTo(x + Math.cos(0.9) * r, y - Math.sin(0.9) * r)
                .arc(x, y, r, -0.9, 0.9)
                .stroke({ width: 1, color: theme.accentAlt, alpha: 0.95 });
            g.circle(x - r * 0.36, y - r * 0.38, Math.max(0.8, r * 0.22)).fill({ color: theme.ink, alpha: 0.95 });
            if (r > 4) {
                g.moveTo(x + Math.cos(0.35) * r * 0.62, y + Math.sin(0.35) * r * 0.62)
                    .arc(x, y, r * 0.62, 0.35, 1.1)
                    .stroke({ width: 1, color: theme.ink, alpha: 0.45 });
            }
        }
    },
};
