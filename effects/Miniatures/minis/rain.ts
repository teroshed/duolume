import { clamp, mixColor } from '../../../src/math';
import type { Mini } from '../Mini';

/**
 * Rain: thin streaks in the theme's two accents that fall, slant with the scene's wind and end
 * in a tiny splash on the element's floor. `level` is how hard it rains; a press is a cloudburst.
 */
interface Drop {
    /** The streak's head, in pixels of the knob-free part. Above the top while it waits. */
    x: number;
    y: number;
    /** Pixels per millisecond, and the streak's length in pixels. */
    speed: number;
    length: number;
    alt: boolean;
    /** Milliseconds left of the splash it made, and where it landed. */
    splash: number;
    splashX: number;
}

interface Rain {
    drops: Drop[];
    /** 1 just after a press or a switch-on, easing to 0: the rain comes down harder. */
    pour: number;
}

const SPLASH = 190;

export const rain: Mini<Rain> = {
    create(box) {
        const drops: Drop[] = [];
        const count = clamp(Math.round((box.w * box.height) / 85), 6, 40);
        for (let i = 0; i < count; i++) {
            drops.push({
                x: Math.random() * box.w,
                y: Math.random() * box.height,
                speed: 0.05 + Math.random() * 0.035,
                length: 5 + Math.random() * 4,
                alt: i % 3 === 1,
                splash: 0,
                splashX: 0,
            });
        }
        return { drops, pour: 0 };
    },

    tick(state, box, signal) {
        const slant = clamp(signal.wind * 1.5, -1.1, 1.1);
        const floor = box.height - 2;
        if (signal.kick) {
            state.pour = 1;
        }
        state.pour = Math.max(0, state.pour - signal.dt / 600);
        const hurry = (signal.hover ? 1.5 : 1) * (1 + state.pour * 1.2);
        // A low level leaves some of the drops waiting above the top: it rains thinner.
        const falling = Math.max(2, Math.round(state.drops.length * (signal.hover ? 1 : 0.25 + 0.75 * signal.level)));
        for (let i = 0; i < state.drops.length; i++) {
            const drop = state.drops[i];
            drop.splash = Math.max(0, drop.splash - signal.dt);
            if (signal.kick) {
                drop.splash = SPLASH;
                drop.splashX = Math.random() * box.w;
            }
            if (drop.y < 0 && i >= falling) {
                continue;
            }
            const fall = drop.speed * signal.dt * hurry;
            drop.y += fall;
            drop.x += fall * slant;
            if (drop.y >= floor) {
                if (drop.x > 0 && drop.x < box.w) {
                    drop.splash = SPLASH;
                    drop.splashX = drop.x;
                }
                // Start again above the top, far enough upwind to land anywhere on the floor.
                drop.y = -Math.random() * box.height * 0.5;
                drop.x = Math.random() * (box.w + Math.abs(slant) * box.height) - Math.max(0, slant) * box.height;
            }
        }
    },

    draw(g, state, box, theme, signal) {
        const slant = clamp(signal.wind * 1.5, -1.1, 1.1);
        const floor = box.height - 2;
        // A switch shows it plainly; a wider element has words in it, so the rain stays quieter there.
        const strength = box.w < box.width || box.height > 60 ? 1 : 0.6;
        for (let pass = 0; pass < 4; pass++) {
            const alt = pass >= 2;
            const head = pass % 2 === 1;
            let any = false;
            for (const drop of state.drops) {
                if (drop.alt !== alt || drop.y <= 0) {
                    continue;
                }
                // The lower third is the bright head, the rest a fainter tail.
                const from = head ? drop.length * 0.4 : drop.length * (1 + state.pour * 0.6);
                const to = head ? 0 : drop.length * 0.4;
                g.moveTo(box.x + drop.x - slant * from, drop.y - from).lineTo(box.x + drop.x - slant * to, drop.y - to);
                any = true;
            }
            if (any) {
                g.stroke({ width: 1, color: alt ? theme.accentAlt : theme.accent, alpha: (head ? 1 : 0.5) * strength });
            }
        }
        // The splash: two specks hopping apart from where the drop landed.
        const speck = mixColor(theme.accent, theme.ink, 0.6);
        for (const drop of state.drops) {
            if (drop.splash <= 0) {
                continue;
            }
            const p = 1 - drop.splash / SPLASH;
            const hop = floor - 4 * p * (1 - p) * 3.2;
            const reach = 1 + p * 3;
            g.rect(box.x + drop.splashX - reach - 0.5, hop - 0.5, 1.2, 1.2).rect(box.x + drop.splashX + reach - 0.5, hop - 0.5, 1.2, 1.2);
            g.fill({ color: speck, alpha: (1 - p * p) * strength });
        }
    },
};
