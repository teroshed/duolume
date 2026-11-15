import type { Graphics } from 'pixi.js';
import { clamp, mixColor, randomNumber } from '../../../src/math';
import type { Mini, MiniBox } from '../Mini';

interface Blade {
    /** Where it stands, in pixels from the element's left edge. */
    x: number;
    height: number;
    /** How far its tip leans, in radians from upright (positive is to the right), and how fast that is changing. */
    lean: number;
    speed: number;
    phase: number;
    /** Front blades are drawn over the back ones, in a brighter green. */
    front: boolean;
    /** 1 just after it was cut or scorched to stubble, 0 when it has grown back. */
    cut: number;
}

interface Grass {
    blades: Blade[];
    /** A gust rolling through: where it is and which way it goes (0 when there is none). */
    gustX: number;
    gustWay: number;
    next: number;
}

/** One pass of blades, as one path: each blade a thin curved wedge from its foot to its tip. */
function wedges(g: Graphics, grass: Grass, box: MiniBox, grow: number, front: boolean): void {
    const ground = box.height;
    for (const blade of grass.blades) {
        if (blade.front !== front) {
            continue;
        }
        const height = blade.height * grow * (1 - 0.8 * blade.cut);
        const lean = clamp(blade.lean, -1.4, 1.4);
        const tipX = blade.x + Math.sin(lean) * height;
        const tipY = ground - Math.cos(lean) * height;
        const midX = blade.x + Math.sin(lean * 0.3) * height * 0.5;
        const midY = ground - height * 0.5;
        g.moveTo(blade.x - 0.9, ground)
            .quadraticCurveTo(midX - 0.5, midY, tipX, tipY)
            .quadraticCurveTo(midX + 0.5, midY, blade.x + 0.9, ground)
            .closePath();
    }
}

/**
 * Meadow: a row of grass blades along the bottom of the element, each a damped spring on its
 * tip. They lean with the wind, a gust rolls through them now and then, and they part around
 * the pointer. A bolt or a meteor in the scene, or a press, flattens them outward from one spot
 * and leaves stubble there, which grows back.
 */
export const meadow: Mini<Grass> = {
    create(box) {
        const count = clamp(Math.round(box.width / 2.6), 10, 48);
        const tallest = Math.min(box.height * 0.5, 22);
        const blades: Blade[] = [];
        for (let i = 0; i < count; i++) {
            blades.push({
                x: ((i + 0.2 + Math.random() * 0.6) / count) * box.width,
                height: tallest * randomNumber(0.45, 1),
                lean: 0,
                speed: 0,
                phase: Math.random() * 6.28,
                front: i % 2 === 0,
                cut: 0,
            });
        }
        return { blades, gustX: 0, gustWay: 0, next: randomNumber(800, 2200) };
    },

    tick(grass, box, signal) {
        const dt = signal.dt;
        grass.next -= dt;
        if (grass.next <= 0 && grass.gustWay === 0) {
            grass.gustWay = signal.wind < -0.1 || (signal.wind < 0.1 && Math.random() < 0.3) ? -1 : 1;
            grass.gustX = grass.gustWay > 0 ? -18 : box.width + 18;
        }
        if (grass.gustWay !== 0) {
            grass.gustX += grass.gustWay * dt * 0.07;
            if (grass.gustX < -20 || grass.gustX > box.width + 20) {
                grass.gustWay = 0;
                grass.next = randomNumber(2200, 4800) * (signal.hover ? 0.5 : 1);
            }
        }
        const struck = signal.pulse > 0 || signal.kick;
        const struckX = signal.kick && signal.hover ? signal.pointerX : randomNumber(box.x + 4, box.x + box.w - 4);
        const damp = Math.exp(-dt * 0.006);
        for (const blade of grass.blades) {
            let target = signal.wind * 0.9 + Math.sin(signal.time * 0.0016 + blade.phase) * 0.07;
            if (grass.gustWay !== 0) {
                const fromGust = (blade.x - grass.gustX) / 9;
                target += grass.gustWay * 0.8 * Math.exp(-fromGust * fromGust);
            }
            if (signal.hover) {
                const fromPointer = blade.x - signal.pointerX;
                target += Math.sign(fromPointer) * 0.9 * Math.exp(-(fromPointer * fromPointer) / 110);
            }
            if (struck) {
                const fromStrike = blade.x - struckX;
                blade.speed += Math.sign(fromStrike) * 0.014 * Math.exp(-Math.abs(fromStrike) / 40);
                if (Math.abs(fromStrike) < 6) {
                    blade.cut = 1;
                }
            }
            blade.speed = (blade.speed + (target - blade.lean) * 0.00012 * dt) * damp;
            blade.lean += blade.speed * dt;
            blade.cut = Math.max(0, blade.cut - dt / 2600);
        }
    },

    draw(g, grass, box, theme, signal) {
        wedges(g, grass, box, signal.presence, false);
        g.fill({ color: mixColor(theme.accent, theme.accentAlt, 0.5), alpha: 0.6 });
        wedges(g, grass, box, signal.presence, true);
        g.fill({ color: theme.accent, alpha: 0.92 });
    },
};
