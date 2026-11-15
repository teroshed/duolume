import { clamp, mixColor, randomNumber } from '../../../src/math';
import type { Mini, MiniBox } from '../Mini';

interface Spark {
    /** The link it is running along (negative: not in use), the point it left, how far along it is (0..1). */
    link: number;
    from: number;
    along: number;
    /** How many more points the news travels on to after this one. */
    hops: number;
}

interface Net {
    /** Each point's home, as fractions of the free part's width and the element's height. */
    u: Float32Array;
    v: Float32Array;
    phase: Float32Array;
    /** 1 when the news has just reached a point, fading to 0. */
    lit: Float32Array;
    /** The links: the two points each one joins. */
    linkA: number[];
    linkB: number[];
    sparks: Spark[];
    /** Milliseconds until a signal starts by itself. */
    next: number;
}

/** Where point `i` is now, in the element's pixels: it drifts a little around its home. */
function pointX(net: Net, box: MiniBox, i: number, time: number): number {
    return box.x + net.u[i] * box.w + Math.sin(time * 0.0009 + net.phase[i]) * 1.5;
}
function pointY(net: Net, box: MiniBox, i: number, time: number): number {
    return net.v[i] * box.height + Math.cos(time * 0.0011 + net.phase[i] * 1.7) * 1.3;
}

/** Light a point up and send a spark down each of its links, except the one the news came by. */
function spread(net: Net, point: number, hops: number, cameBy: number): void {
    net.lit[point] = 1;
    for (let link = 0; link < net.linkA.length; link++) {
        if (link === cameBy || (net.linkA[link] !== point && net.linkB[link] !== point)) {
            continue;
        }
        const spark = net.sparks.find((candidate) => candidate.link < 0);
        if (spark) {
            spark.link = link;
            spark.from = point;
            spark.along = 0;
            spark.hops = hops;
        }
    }
}

/**
 * Constellation: a few points joined by thin lines, drifting a little. Every so often one lights
 * up and the news runs along the lines as sparks, from point to point, a few hops. Anything that
 * goes off in the scene starts one; a press starts one at the point nearest the pointer; and
 * while the pointer is over the element it is one more point, joined to its two nearest.
 */
export const constellation: Mini<Net> = {
    create(box) {
        const count = clamp(Math.round((box.w * box.height) / 190), 5, 18);
        let height = randomNumber(0.2, 0.8);
        const net: Net = {
            u: new Float32Array(count),
            v: new Float32Array(count),
            phase: new Float32Array(count),
            lit: new Float32Array(count),
            linkA: [],
            linkB: [],
            sparks: [],
            next: randomNumber(500, 1500),
        };
        for (let i = 0; i < count; i++) {
            // Points from one end to the other, each a good step up or down from the last: the chain
            // that joins them wanders, and here and there a link skips a point.
            const step = randomNumber(0.3, 0.55) * (Math.random() < 0.5 ? -1 : 1);
            height = height + step > 0.86 || height + step < 0.14 ? height - step : height + step;
            net.u[i] = clamp((i + 0.5 + randomNumber(-0.3, 0.3)) / count, 0.1, 0.92);
            net.v[i] = clamp(height, 0.14, 0.86);
            net.phase[i] = Math.random() * 6.28;
            if (i > 0) {
                net.linkA.push(i - 1);
                net.linkB.push(i);
            }
            if (i > 1 && (i === 2 || Math.random() < 0.45)) {
                net.linkA.push(i - 2);
                net.linkB.push(i);
            }
        }
        for (let i = 0; i < 10; i++) {
            net.sparks.push({ link: -1, from: 0, along: 0, hops: 0 });
        }
        return net;
    },

    tick(net, box, signal) {
        const dt = signal.dt;
        const count = net.u.length;
        for (let i = 0; i < count; i++) {
            net.lit[i] = Math.max(0, net.lit[i] - dt / 420);
        }
        const struck = signal.pulse > 0 || signal.kick;
        net.next -= dt * (signal.hover ? 2 : 1);
        if (struck || net.next <= 0) {
            net.next = randomNumber(1400, 2800);
            let start = Math.floor(Math.random() * count);
            if (signal.kick && signal.hover) {
                for (let i = 0; i < count; i++) {
                    const nearer = Math.hypot(pointX(net, box, i, signal.time) - signal.pointerX, pointY(net, box, i, signal.time) - signal.pointerY);
                    const best = Math.hypot(pointX(net, box, start, signal.time) - signal.pointerX, pointY(net, box, start, signal.time) - signal.pointerY);
                    start = nearer < best ? i : start;
                }
            }
            spread(net, start, struck ? 3 : 2, -1);
        }
        for (const spark of net.sparks) {
            if (spark.link < 0) {
                continue;
            }
            spark.along += dt / 240;
            if (spark.along >= 1) {
                const link = spark.link;
                const reached = net.linkA[link] === spark.from ? net.linkB[link] : net.linkA[link];
                spark.link = -1;
                if (spark.hops > 0) {
                    spread(net, reached, spark.hops - 1, link);
                } else {
                    net.lit[reached] = Math.max(net.lit[reached], 0.6);
                }
            }
        }
    },

    draw(g, net, box, theme, signal) {
        const time = signal.time;
        const count = net.u.length;
        for (let link = 0; link < net.linkA.length; link++) {
            g.moveTo(pointX(net, box, net.linkA[link], time), pointY(net, box, net.linkA[link], time));
            g.lineTo(pointX(net, box, net.linkB[link], time), pointY(net, box, net.linkB[link], time));
        }
        if (signal.hover) {
            // The pointer is one more point: lines to the two points nearest it.
            let first = 0;
            let second = 1;
            for (let i = 0; i < count; i++) {
                const d = Math.hypot(pointX(net, box, i, time) - signal.pointerX, pointY(net, box, i, time) - signal.pointerY);
                const dFirst = Math.hypot(pointX(net, box, first, time) - signal.pointerX, pointY(net, box, first, time) - signal.pointerY);
                const dSecond = Math.hypot(pointX(net, box, second, time) - signal.pointerX, pointY(net, box, second, time) - signal.pointerY);
                if (i !== first && d < dFirst) {
                    second = first;
                    first = i;
                } else if (i !== first && i !== second && d < dSecond) {
                    second = i;
                }
            }
            g.moveTo(pointX(net, box, first, time), pointY(net, box, first, time)).lineTo(signal.pointerX, signal.pointerY);
            g.lineTo(pointX(net, box, second, time), pointY(net, box, second, time));
        }
        g.stroke({ width: 1, color: theme.accent, alpha: 0.5 });

        // Sparks: a bright dash running along its link.
        for (const spark of net.sparks) {
            if (spark.link < 0) {
                continue;
            }
            const to = net.linkA[spark.link] === spark.from ? net.linkB[spark.link] : net.linkA[spark.link];
            const x0 = pointX(net, box, spark.from, time);
            const y0 = pointY(net, box, spark.from, time);
            const dx = pointX(net, box, to, time) - x0;
            const dy = pointY(net, box, to, time) - y0;
            const tail = Math.max(0, spark.along - 0.4);
            g.moveTo(x0 + dx * tail, y0 + dy * tail).lineTo(x0 + dx * spark.along, y0 + dy * spark.along);
        }
        g.stroke({ width: 1.5, color: theme.ink, alpha: 0.95 });

        for (let i = 0; i < count; i++) {
            const lit = net.lit[i];
            g.circle(pointX(net, box, i, time), pointY(net, box, i, time), 1.1 + 1.3 * lit).fill({ color: mixColor(theme.accent, theme.ink, 0.3 + 0.7 * lit), alpha: 0.95 });
        }
    },
};
