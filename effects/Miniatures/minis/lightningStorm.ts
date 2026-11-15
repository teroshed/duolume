import { clamp, mixColor } from '../../../src/math';
import type { Mini, MiniBox } from '../Mini';

/**
 * Lightning: a point of charge swells on the element's floor, and when it is full a jagged
 * bolt comes down on it with a flash, forks once, flickers and cools to a faint trace while the
 * next charge builds somewhere else. It strikes when the real storm does, and when pressed.
 */
interface Bolt {
    /** The bolt's joints from sky to floor: sideways in pixels of the knob-free part, and 0..1 down. */
    xs: number[];
    ys: number[];
    /** Which way it leans (-1 left, 1 right), and the joint its fork leaves from. */
    lean: number;
    forkAt: number;
    /** 1 at the strike, cooling to 0, and the milliseconds since. */
    heat: number;
    age: number;
    /** 1 at the strike, gone in a few frames: the element lights up. */
    flash: number;
    /** 0..1: the charge building for the next strike, where it sits, and how long it takes (ms). */
    charge: number;
    foot: number;
    period: number;
    lane: number;
    stray: number;
}

function jagOf(box: MiniBox): number {
    return clamp(box.height * 0.15, 3, 9);
}

/** Bring a bolt down on its charge, then start the next charge somewhere else in its lane. */
function strike(bolt: Bolt, box: MiniBox): void {
    const last = bolt.xs.length - 1;
    const jag = jagOf(box);
    bolt.lean = Math.random() < 0.5 ? -1 : 1;
    const top = bolt.foot - bolt.lean * jag * Math.random() * 1.2;
    // Long strokes down and to one side, each followed by a short step back: the shape of a bolt.
    let down = 0;
    for (let i = 0; i <= last; i++) {
        const side = i === 0 || i === last ? 0 : (i % 2 === 1 ? 1 : -1) * bolt.lean * jag * (0.4 + Math.random() * 0.75);
        bolt.xs[i] = top + (bolt.foot - top) * (i / last) + side;
        bolt.ys[i] = down;
        down += i % 2 === 0 ? 0.6 + Math.random() * 0.8 : 0.12 + Math.random() * 0.2;
    }
    for (let i = 0; i <= last; i++) {
        bolt.ys[i] /= bolt.ys[last];
    }
    bolt.forkAt = 1 + 2 * Math.floor(Math.random() * ((last - 1) / 2));
    bolt.heat = 1;
    bolt.age = 0;
    bolt.charge = 0;
    bolt.foot = clamp(bolt.lane + (Math.random() - 0.5) * 2 * bolt.stray, 5, box.w - 3);
    bolt.period = 1300 + Math.random() * 1000;
    bolt.flash = 1;
}

export const lightningStorm: Mini<Bolt[]> = {
    create(box) {
        const bolts: Bolt[] = [];
        const count = clamp(Math.round(box.w / 60), 1, 4);
        // An odd number of strokes, so that it begins and ends with a long one.
        const strokes = clamp(2 * Math.round(box.height / 20) + 1, 5, 7);
        for (let i = 0; i < count; i++) {
            const lane = ((i + 0.5) / count) * box.w;
            const bolt: Bolt = { xs: new Array<number>(strokes + 1).fill(lane), ys: new Array<number>(strokes + 1).fill(0), lean: 1, forkAt: 1, heat: 0, age: 0, flash: 0, charge: 0, foot: lane, period: 2000, lane, stray: (box.w / count) * 0.3 };
            // It starts with a trace already there, cooled, and the charge part of the way up.
            strike(bolt, box);
            bolt.heat = 0;
            bolt.flash = 0;
            bolt.age = 1000;
            bolt.charge = 0.4 + (i / count) * 0.5;
            bolts.push(bolt);
        }
        return bolts;
    },

    tick(bolts, box, signal) {
        let fullest = bolts[0];
        for (const bolt of bolts) {
            bolt.age += signal.dt;
            bolt.flash = Math.max(0, bolt.flash - signal.dt / 110);
            bolt.heat *= Math.exp(-signal.dt / 380);
            bolt.charge += (signal.dt / bolt.period) * (signal.hover ? 2.5 : 1);
            if (bolt.charge > fullest.charge) {
                fullest = bolt;
            }
        }
        for (const bolt of bolts) {
            // Its own rhythm; the real storm striking (the fullest one answers); a press (they all do).
            if (bolt.charge >= 1 || signal.kick || (signal.pulse > 0 && bolt === fullest)) {
                strike(bolt, box);
            }
        }
    },

    draw(g, bolts, box, theme) {
        const floor = box.height - 3;
        const jag = jagOf(box);
        // The flash: the whole inside lights up for a moment, more faintly the more bolts share it.
        let flash = 0;
        for (const bolt of bolts) {
            flash = Math.max(flash, bolt.flash);
        }
        if (flash > 0.02) {
            g.rect(0, 0, box.width, box.height).fill({ color: theme.ink, alpha: (0.13 * flash) / Math.sqrt(bolts.length) });
        }
        for (const bolt of bolts) {
            const last = bolt.xs.length - 1;
            // A flicker just after the strike: bright, almost out, bright again.
            const heat = bolt.heat * (bolt.age > 70 && bolt.age < 120 ? 0.25 : 1);
            for (let i = 0; i <= last; i++) {
                if (i === 0) {
                    g.moveTo(box.x + bolt.xs[i], 1);
                } else {
                    g.lineTo(box.x + bolt.xs[i], 1 + (floor - 1) * bolt.ys[i]);
                }
            }
            // The fork: two short strokes that carry on outward from a corner.
            const fx = box.x + bolt.xs[bolt.forkAt];
            const fy = 1 + (floor - 1) * bolt.ys[bolt.forkAt];
            g.moveTo(fx, fy).lineTo(fx + bolt.lean * jag * 0.8, fy + jag * 0.5).lineTo(fx + bolt.lean * jag * 0.9, fy + jag * 1.3);
            g.stroke({ width: 1 + heat, color: mixColor(theme.accentAlt, theme.ink, clamp(heat * 1.6, 0, 1)), alpha: 0.24 + 0.76 * heat });
            // Where it landed: a small spark, while it is hot.
            if (heat > 0.15) {
                const lx = box.x + bolt.xs[last];
                g.moveTo(lx - 4 * heat, floor).lineTo(lx + 4 * heat, floor).moveTo(lx - 2.5 * heat, floor - 3 * heat).lineTo(lx + 2.5 * heat, floor + 1);
                g.stroke({ width: 1, color: theme.ink, alpha: heat });
            }
            // The charge building for the next one.
            const charge = clamp(bolt.charge, 0, 1);
            g.circle(box.x + bolt.foot, floor, 0.8 + charge * 1.5).fill({ color: mixColor(theme.accent, theme.ink, charge * 0.7), alpha: 0.45 + 0.55 * charge });
        }
    },
};
