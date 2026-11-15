import { clamp, mixColor, randomNumber } from '../../../src/math';
import type { Mini, MiniBox } from '../Mini';

interface Serpent {
    /** The centre of each gem, head first, in pixels from the left of the free part and the element's top. */
    xs: Float32Array;
    ys: Float32Array;
    /** Width of the gem behind the head, and the distance from one gem to the next. */
    size: number;
    gap: number;
    /** Where its lure is on the figure of eight it swims, in radians. */
    path: number;
    /** The gem a band of light has reached, counted from the head; negative when there is none. */
    band: number;
    /** Milliseconds of darting left. */
    dart: number;
    /** Milliseconds until it shimmers by itself. */
    next: number;
}

/**
 * One step of swimming. The lure runs round a figure of eight as wide as the element at a
 * steady pace, or circles the point given; the head
 * swims after it and each gem is pulled along by the one in front.
 */
function swim(serpent: Serpent, box: MiniBox, distance: number, aroundX?: number, aroundY?: number): void {
    const { xs, ys, size } = serpent;
    const roomX = Math.max(1, box.w / 2 - size * 0.5);
    const roomY = Math.max(1, box.height / 2 - size * 1.3 - 1);
    const pace = Math.hypot(Math.cos(serpent.path) * roomX, 2 * Math.cos(2 * serpent.path + 0.6) * roomY);
    serpent.path += distance / Math.max(pace, 0.4 * roomX);
    let lureX = box.w / 2 + Math.sin(serpent.path) * roomX;
    let lureY = box.height / 2 + Math.sin(2 * serpent.path + 0.6) * roomY;
    if (aroundX !== undefined && aroundY !== undefined) {
        lureX = aroundX + Math.cos(serpent.path * 3) * size * 2.4;
        lureY = aroundY + Math.sin(serpent.path * 3) * size * 2;
    }
    const dx = lureX - xs[0];
    const dy = lureY - ys[0];
    const d = Math.hypot(dx, dy) || 1;
    const move = Math.min(d, distance * 1.15);
    xs[0] += (dx / d) * move;
    ys[0] += (dy / d) * move;
    for (let i = 1; i < xs.length; i++) {
        const bx = xs[i - 1] - xs[i];
        const by = ys[i - 1] - ys[i];
        const stretch = Math.hypot(bx, by) || 1;
        if (stretch > serpent.gap) {
            xs[i] += bx * (1 - serpent.gap / stretch);
            ys[i] += by * (1 - serpent.gap / stretch);
        }
    }
}

/**
 * Serpent: a chain of tapering gems behind an arrow of a head, teal at the head and violet at
 * the tail, weaving through the element on a figure of eight, so its body lies in an S as it
 * crosses the middle. A wider element gets a longer one. Under the pointer it comes over and
 * circles it. Lightning in the scene, or a press, sends a band of light from head to tail and
 * makes it dart; it shimmers by itself now and then.
 */
export const serpent: Mini<Serpent> = {
    create(box) {
        const size = clamp(box.height * 0.12, 3.4, 5.5);
        const gap = size * 0.92;
        const count = clamp(Math.round((box.w * 0.75) / gap), 8, 28);
        const serpent: Serpent = { xs: new Float32Array(count), ys: new Float32Array(count), size, gap, path: Math.random() * 6.28, band: -1, dart: 0, next: randomNumber(2000, 4000) };
        serpent.xs.fill(box.w / 2);
        serpent.ys.fill(box.height / 2);
        // Swim a while before anyone looks, so the body already lies along its path.
        for (let step = 0; step < 300; step++) {
            swim(serpent, box, size * 0.14);
        }
        return serpent;
    },

    tick(serpent, box, signal) {
        const dt = signal.dt;
        const struck = signal.pulse > 0 || signal.kick;
        serpent.next -= dt;
        if (struck || serpent.next <= 0) {
            serpent.next = randomNumber(4000, 7000);
            serpent.band = 0;
            serpent.dart = struck ? 450 : 0;
        }
        if (serpent.band >= 0) {
            serpent.band += dt * 0.03;
            if (serpent.band > serpent.xs.length + 2) {
                serpent.band = -1;
            }
        }
        serpent.dart = Math.max(0, serpent.dart - dt);
        const speed = 0.0085 * serpent.size * (serpent.dart > 0 ? 2.6 : 1) * (signal.hover ? 1.3 : 1);
        if (signal.hover) {
            swim(serpent, box, speed * dt, signal.pointerX - box.x, signal.pointerY);
        } else {
            swim(serpent, box, speed * dt);
        }
    },

    draw(g, serpent, box, theme) {
        const { xs, ys, size } = serpent;
        const last = xs.length - 1;
        // Tail first, so the head is on top. Each gem is a diamond lying along the body.
        for (let i = last; i >= 0; i--) {
            const front = Math.max(0, i - 1);
            let ux = xs[front] - xs[front + 1];
            let uy = ys[front] - ys[front + 1];
            const length = Math.hypot(ux, uy) || 1;
            ux /= length;
            uy /= length;
            const lit = serpent.band < 0 ? 0 : Math.max(0, 1 - Math.abs(i - serpent.band) / 2);
            const tone = mixColor(theme.accent, theme.accentAlt, i / last);
            const x = box.x + xs[i];
            const y = ys[i];
            if (i === 0) {
                // The head: an arrow, wider than the body.
                g.moveTo(x + ux * size * 1.5, y + uy * size * 1.5)
                    .lineTo(x - ux * size * 0.6 - uy * size, y - uy * size * 0.6 + ux * size)
                    .lineTo(x - ux * size * 0.15, y - uy * size * 0.15)
                    .lineTo(x - ux * size * 0.6 + uy * size, y - uy * size * 0.6 - ux * size)
                    .closePath()
                    .fill({ color: mixColor(tone, theme.ink, Math.max(lit, 0.3)), alpha: 1 });
                continue;
            }
            const along = serpent.gap * 0.66;
            const across = (size * 0.5 * (1 - (0.75 * i) / last) + 0.35) * (1 + 0.5 * lit);
            g.moveTo(x + ux * along, y + uy * along)
                .lineTo(x - uy * across, y + ux * across)
                .lineTo(x - ux * along, y - uy * along)
                .lineTo(x + uy * across, y - ux * across)
                .closePath()
                // Every third gem catches the light.
                .fill({ color: mixColor(tone, theme.ink, Math.max(lit, i % 3 === 1 ? 0.45 : 0)), alpha: 0.95 });
        }
    },
};
