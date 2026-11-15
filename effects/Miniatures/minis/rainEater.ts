import { approach, clamp, mixColor } from '../../../src/math';
import type { Mini } from '../Mini';

/**
 * The rain eater: a faceted glass gem in falling rain. Droplets that come near bend toward it
 * and are swallowed; each one fills it a little, and when it is full it bursts into its facets,
 * which fly out and come home. It gulps when the real one eats, and a press bursts it.
 */
interface Drop {
    x: number;
    y: number;
    vx: number;
    vy: number;
    speed: number;
    alt: boolean;
}

interface Eater {
    drops: Drop[];
    /** The gem: its middle (pixels of the knob-free part), its radius, how far it has turned. */
    x: number;
    y: number;
    radius: number;
    spin: number;
    /** 0..1: how full it is. */
    energy: number;
    /** 1 on a mouthful, easing to 0: the gem swells. */
    gulp: number;
    /** Milliseconds since it burst; negative while it is whole. */
    burst: number;
    seed: number;
}

const SIDES = 7;
const BURST = 1300;

export const rainEater: Mini<Eater> = {
    create(box) {
        const drops: Drop[] = [];
        const count = clamp(Math.round((box.w * box.height) / 105), 8, 32);
        for (let i = 0; i < count; i++) {
            const speed = 0.04 + Math.random() * 0.025;
            drops.push({ x: Math.random() * box.w, y: Math.random() * box.height, vx: 0, vy: speed, speed, alt: i % 3 === 1 });
        }
        const radius = clamp(box.height * 0.22, 5, 16);
        return { drops, x: box.w / 2, y: box.height / 2, radius, spin: Math.random() * 6, energy: 0.3, gulp: 0, burst: -1, seed: Math.random() * 6 };
    },

    tick(state, box, signal) {
        const dt = signal.dt;
        const lively = signal.hover ? 1.6 : 1;
        // It wanders along a wide element, as the real one wanders the stage.
        const room = Math.max(0, box.w / 2 - state.radius * 2.4);
        state.x = box.w / 2 + Math.sin(signal.time * 0.00035 + state.seed) * room;
        state.y = box.height / 2 + Math.sin(signal.time * 0.0009 + state.seed) * Math.min(2, box.height * 0.04);
        state.spin += dt * (0.0011 + state.energy * 0.003) * lively;
        state.gulp = approach(state.gulp, 0, 9, dt);
        // The real one eating: a mouthful, but not more often than the swell can show.
        if (signal.pulse > 0 && state.gulp < 0.2 && state.burst < 0) {
            state.gulp = 1;
            state.energy += 0.03;
        }

        const whole = state.burst < 0;
        const reach = state.radius * 2.3;
        for (const drop of state.drops) {
            // Left alone a droplet settles back into a plain fall, leaning with the wind.
            drop.vx = approach(drop.vx, signal.wind * drop.speed * 1.2, 5, dt);
            drop.vy = approach(drop.vy, drop.speed * lively, 5, dt);
            const dx = state.x - drop.x;
            const dy = state.y - drop.y;
            const distance = Math.hypot(dx, dy) || 1;
            if (whole && distance < reach) {
                const pull = (0.00042 * dt * (1 - distance / reach + 0.3)) / distance;
                drop.vx += dx * pull;
                drop.vy += dy * pull;
            }
            drop.x += drop.vx * dt;
            drop.y += drop.vy * dt;
            const eaten = whole && distance < state.radius * 0.75;
            if (eaten) {
                state.energy += 0.022;
                state.gulp = Math.max(state.gulp, 0.6);
            }
            if (eaten || drop.y > box.height + 2 || drop.y < -box.height) {
                drop.x = Math.random() * box.w;
                drop.y = -Math.random() * 5;
                drop.vx = 0;
                drop.vy = drop.speed;
            }
        }

        if (whole && (state.energy >= 1 || signal.kick)) {
            state.burst = 0;
            state.energy = 0;
            // The burst throws the rain around it outward.
            for (const drop of state.drops) {
                const dx = drop.x - state.x;
                const dy = drop.y - state.y;
                const distance = Math.hypot(dx, dy) || 1;
                if (distance < reach * 1.3) {
                    drop.vx += (dx / distance) * 0.11;
                    drop.vy += (dy / distance) * 0.11;
                }
            }
        } else if (!whole) {
            state.burst += dt;
            if (state.burst > BURST) {
                state.burst = -1;
            }
        }
    },

    draw(g, state, box, theme) {
        // The rain, each droplet a short streak along the way it is going.
        for (let pass = 0; pass < 2; pass++) {
            let any = false;
            for (const drop of state.drops) {
                if (drop.alt !== (pass === 1)) {
                    continue;
                }
                const speed = Math.hypot(drop.vx, drop.vy) || 1;
                g.moveTo(box.x + drop.x - (drop.vx / speed) * 5.5, drop.y - (drop.vy / speed) * 5.5).lineTo(box.x + drop.x, drop.y);
                any = true;
            }
            if (any) {
                g.stroke({ width: 1, color: pass === 1 ? theme.accentAlt : theme.accent, alpha: 0.9 });
            }
        }

        // The gem, seen from above: a ring of facets meeting at a point a little off its middle.
        const p = state.burst < 0 ? 0 : state.burst / BURST;
        // Burst: out fast, hang, then home.
        const apart = p === 0 ? 0 : (p < 0.2 ? 1 - (1 - p / 0.2) ** 2 : 1 - ((p - 0.2) / 0.8) ** 3) * state.radius * 1.15;
        const radius = state.radius * (1 + state.gulp * 0.22 + state.energy * 0.12);
        const cx = box.x + state.x;
        const cy = state.y;
        const tipX = Math.cos(state.spin * 1.7) * radius * 0.28;
        const tipY = Math.sin(state.spin * 1.3) * radius * 0.28;
        const glass = 0.5 + state.energy * 0.7;
        for (let i = 0; i < SIDES; i++) {
            const a0 = state.spin + (i / SIDES) * Math.PI * 2;
            const a1 = state.spin + ((i + 1) / SIDES) * Math.PI * 2;
            const mid = (a0 + a1) / 2;
            const ox = cx + Math.cos(mid) * apart;
            const oy = cy + Math.sin(mid) * apart;
            // Facets facing the upper left catch the light.
            const lit = 0.5 + 0.5 * Math.cos(mid + 2.2);
            g.moveTo(ox + tipX, oy + tipY)
                .lineTo(ox + Math.cos(a0) * radius, oy + Math.sin(a0) * radius)
                .lineTo(ox + Math.cos(a1) * radius, oy + Math.sin(a1) * radius)
                .closePath()
                .fill({ color: i % 2 === 0 ? theme.accent : theme.accentAlt, alpha: clamp((0.2 + 0.3 * lit) * glass, 0, 0.62) })
                .stroke({ width: 1, color: mixColor(theme.accent, theme.ink, 0.3), alpha: 0.85 });
        }
        // The ring of the burst.
        if (p > 0 && p < 0.25) {
            g.circle(cx, cy, state.radius * (1 + p * 7)).stroke({ width: 1, color: theme.ink, alpha: 0.7 * (1 - p / 0.25) });
        }
    },
};
