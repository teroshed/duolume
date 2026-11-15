import { clamp, mixColor } from '../../../src/math';
import type { Mini, MiniBox } from '../Mini';

/**
 * Lightning: a point of charge swells on the element's floor, and when it is full a jagged
 * bolt comes down on it with a flash, forks once, flickers and cools to a faint trace while the
 * next charge builds somewhere else. It strikes when the real storm does, and when pressed.
 */
interface Bolt {
    /** The bolt's joints from top to floor, as sideways positions in pixels of the knob-free part. */
    joints: number[];
    /** Which joint the fork leaves from, and which way it goes (pixels). */
    forkAt: number;
    forkReach: number;
    /** 1 at the strike, cooling to 0. */
    heat: number;
    /** Milliseconds since the strike. */
    age: number;
    /** 0..1: the charge building for the next strike, where it sits, and how long it takes (ms). */
    charge: number;
    foot: number;
    period: number;
    lane: number;
    stray: number;
}

interface Storm {
    bolts: Bolt[];
    /** 1 at a strike, gone in a few frames: the whole element lights up. */
    flash: number;
}

function strike(bolt: Bolt, state: Storm, box: MiniBox): void {
    const last = bolt.joints.length - 1;
    const jag = clamp(box.height * 0.13, 2.5, 8);
    const top = bolt.foot + (Math.random() - 0.5) * jag * 3;
    for (let i = 0; i <= last; i++) {
        // Straight from the sky to the charge, thrown left and right on the way.
        const side = i === 0 || i === last ? 0 : (i % 2 === 0 ? 1 : -1) * jag * (0.5 + Math.random() * 0.7);
        bolt.joints[i] = top + (bolt.foot - top) * (i / last) + side;
    }
    bolt.forkAt = 1 + Math.floor(Math.random() * (last - 2));
    bolt.forkReach = (Math.random() < 0.5 ? -1 : 1) * jag * (1.2 + Math.random());
    bolt.heat = 1;
    bolt.age = 0;
    bolt.charge = 0;
    bolt.foot = clamp(bolt.lane + (Math.random() - 0.5) * 2 * bolt.stray, 4, box.w - 3);
    bolt.period = 2000 + Math.random() * 1400;
    state.flash = 1;
}

export const lightningStorm: Mini<Storm> = {
    create(box) {
        const state: Storm = { bolts: [], flash: 0 };
        const count = clamp(Math.round(box.w / 60), 1, 4);
        const joints = clamp(Math.round(box.height / 5), 4, 9);
        for (let i = 0; i < count; i++) {
            const lane = ((i + 0.5) / count) * box.w;
            const bolt: Bolt = { joints: new Array<number>(joints + 1).fill(lane), forkAt: 1, forkReach: 0, heat: 0, age: 0, charge: 0, foot: lane, period: 2400, lane, stray: (box.w / count) * 0.36 };
            // It starts with a trace already there, cooled, and the charge part of the way up.
            strike(bolt, state, box);
            bolt.heat = 0;
            bolt.age = 1000;
            bolt.charge = 0.35 + (i / count) * 0.5;
            state.bolts.push(bolt);
        }
        state.flash = 0;
        return state;
    },

    tick(state, box, signal) {
        state.flash = Math.max(0, state.flash - signal.dt / 110);
        let fullest = state.bolts[0];
        for (const bolt of state.bolts) {
            bolt.age += signal.dt;
            bolt.heat *= Math.exp(-signal.dt / 260);
            bolt.charge += (signal.dt / bolt.period) * (signal.hover ? 3 : 1);
            if (bolt.charge > fullest.charge) {
                fullest = bolt;
            }
        }
        for (const bolt of state.bolts) {
            // Its own rhythm; the real storm striking (the fullest one answers); a press (they all do).
            if (bolt.charge >= 1 || signal.kick || (signal.pulse > 0 && bolt === fullest)) {
                strike(bolt, state, box);
            }
        }
    },

    draw(g, state, box, theme) {
        const floor = box.height - 3;
        if (state.flash > 0.02) {
            g.rect(box.x, 0, box.w, box.height).fill({ color: theme.ink, alpha: 0.15 * state.flash });
        }
        for (const bolt of state.bolts) {
            const last = bolt.joints.length - 1;
            // A flicker just after the strike: bright, almost out, bright again.
            const flicker = bolt.age > 60 && bolt.age < 110 ? 0.25 : 1;
            const heat = bolt.heat * flicker;
            for (let i = 0; i <= last; i++) {
                const x = box.x + bolt.joints[i];
                const y = 1 + (floor - 1) * (i / last);
                if (i === 0) {
                    g.moveTo(x, y);
                } else {
                    g.lineTo(x, y);
                }
            }
            // The fork: two short strokes off to one side.
            const fx = box.x + bolt.joints[bolt.forkAt];
            const fy = 1 + (floor - 1) * (bolt.forkAt / last);
            const step = (floor - 1) / last;
            g.moveTo(fx, fy).lineTo(fx + bolt.forkReach * 0.6, fy + step * 0.7).lineTo(fx + bolt.forkReach, fy + step * 1.6);
            g.stroke({ width: 1 + heat * 0.8, color: mixColor(theme.accentAlt, theme.ink, clamp(heat * 1.5, 0, 1)), alpha: 0.26 + 0.74 * heat });
            // Where it landed: a small star, while it is hot.
            if (heat > 0.15) {
                const lx = box.x + bolt.joints[last];
                g.moveTo(lx - 3.5 * heat, floor).lineTo(lx + 3.5 * heat, floor).moveTo(lx - 2 * heat, floor - 2.5 * heat).lineTo(lx + 2 * heat, floor + 1.5).stroke({ width: 1, color: theme.ink, alpha: heat });
            }
            // The charge building for the next one.
            const charge = clamp(bolt.charge, 0, 1);
            g.circle(box.x + bolt.foot, floor, 0.8 + charge * 1.5).fill({ color: mixColor(theme.accent, theme.ink, charge * 0.7), alpha: 0.45 + 0.55 * charge });
        }
    },
};
