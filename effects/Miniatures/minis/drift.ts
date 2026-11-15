import type { Mini } from '../Mini';

interface Mote {
    u: number;
    v: number;
    speed: number;
    size: number;
}

/**
 * What an element gets when its tags name no effect: a few motes crossing from left to right.
 * It is also the shortest example of a miniature.
 */
export const drift: Mini<Mote[]> = {
    create() {
        const motes: Mote[] = [];
        for (let i = 0; i < 7; i++) {
            motes.push({ u: Math.random(), v: 0.2 + Math.random() * 0.6, speed: 0.00012 + Math.random() * 0.00014, size: 1 + Math.random() * 1.2 });
        }
        return motes;
    },

    tick(motes, _box, signal) {
        for (const mote of motes) {
            // The wind hurries them along or turns them back; hovering stirs them.
            mote.u += signal.dt * mote.speed * (1 + signal.wind * 2) * (signal.hover ? 2.2 : 1);
            if (mote.u > 1) {
                mote.u -= 1;
                mote.v = 0.2 + Math.random() * 0.6;
            } else if (mote.u < 0) {
                mote.u += 1;
            }
        }
    },

    draw(g, motes, box, theme) {
        for (const mote of motes) {
            g.circle(box.x + mote.u * box.w, mote.v * box.height, mote.size).fill({ color: theme.accent, alpha: 0.85 });
        }
    },
};
