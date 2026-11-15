import { clamp, mixColor, randomNumber } from '../../../src/math';
import type { Mini, MiniBox, MiniSignal } from '../Mini';

interface Flake {
    x: number;
    y: number;
    fall: number;
    size: number;
    sway: number;
}

interface Snowfall {
    flakes: Flake[];
    /** The drift along the bottom: how full each column is, from 0 (the thin layer that always lies) to 1. */
    pile: Float32Array;
    /** Width of a column in pixels, and how much one landing flake adds. */
    column: number;
    grain: number;
    /** Milliseconds of slumping left. */
    slump: number;
}

/** How high a full column stands, in pixels: `level` is how much snow lies. */
function ceiling(box: MiniBox, signal: MiniSignal): number {
    return Math.max(11, box.height * 0.3) * (0.25 + 0.75 * signal.level) * signal.presence;
}

/** The top of the drift at column `i`, in pixels from the element's top. */
function top(snow: Snowfall, box: MiniBox, full: number, i: number): number {
    return box.height - full * (0.25 + 0.75 * Math.min(1, snow.pile[i]));
}

/**
 * Snow: flakes drifting down over the whole element and a drift along the bottom that every
 * landing flake adds to. Where it gets too steep it slumps sideways, and when it is full it
 * slumps altogether and starts again. The wind slants the flakes and, when strong, shaves the
 * drift; the pointer wipes the snow away under it; a press knocks it all down.
 */
export const snow: Mini<Snowfall> = {
    create(box) {
        const columns = Math.max(4, Math.ceil(box.width / 2));
        const count = clamp(Math.round((box.width * box.height) / 170), 7, 26);
        const flakes: Flake[] = [];
        for (let i = 0; i < count; i++) {
            flakes.push({ x: Math.random() * box.width, y: Math.random() * box.height * 0.7, fall: randomNumber(0.009, 0.016), size: randomNumber(0.7, 1.3), sway: Math.random() * 6.28 });
        }
        const pile = new Float32Array(columns);
        for (let i = 0; i < columns; i++) {
            pile[i] = 0.3 + 0.2 * Math.sin(i * 0.55) + Math.random() * 0.1;
        }
        // Sized so that an empty drift fills in about nine seconds, whatever the element's size.
        const fallSeconds = (box.height * 0.6) / 12.5;
        return { flakes, pile, column: box.width / columns, grain: (0.8 * columns * fallSeconds) / (9 * count), slump: 0 };
    },

    tick(snow, box, signal) {
        const dt = signal.dt;
        const pile = snow.pile;
        const last = pile.length - 1;
        const full = ceiling(box, signal);
        for (const flake of snow.flakes) {
            flake.sway += dt * 0.003;
            flake.x = (flake.x + (signal.wind * 0.035 + Math.sin(flake.sway) * 0.006) * dt + box.width) % box.width;
            flake.y += flake.fall * dt * (signal.hover ? 1.5 : 1);
            const i = Math.min(last, Math.floor(flake.x / snow.column));
            if (flake.y >= top(snow, box, full, i)) {
                pile[i] += snow.grain * 0.5;
                pile[Math.max(0, i - 1)] += snow.grain * 0.25;
                pile[Math.min(last, i + 1)] += snow.grain * 0.25;
                flake.y = -2;
                flake.x = Math.random() * box.width;
            }
        }
        const shave = Math.max(0, Math.abs(signal.wind) - 0.5) * 0.0003 * dt;
        const sink = snow.slump > 0 ? Math.exp(-dt * 0.006) : 1;
        let sum = 0;
        for (let i = 0; i <= last; i++) {
            // Too steep between two columns: snow slides to the lower one.
            const step = i < last ? pile[i] - pile[i + 1] : 0;
            if (Math.abs(step) > 0.16) {
                const slide = (step - Math.sign(step) * 0.16) * 0.3;
                pile[i] -= slide;
                pile[i + 1] += slide;
            }
            let height = pile[i] > 0 ? Math.max(0, pile[i] * sink - shave) : pile[i];
            if (signal.hover) {
                // The pointer wipes it away, down to nothing.
                const away = ((i + 0.5) * snow.column - signal.pointerX) / 5;
                height -= dt * 0.005 * Math.exp(-away * away);
            }
            pile[i] = clamp(height, -0.33, 1.2);
            sum += pile[i];
        }
        snow.slump = Math.max(0, snow.slump - dt);
        if (signal.kick || sum / pile.length > 0.8) {
            snow.slump = 500;
        }
    },

    draw(g, snow, box, theme, signal) {
        const full = ceiling(box, signal);
        const last = snow.pile.length - 1;
        g.moveTo(0, box.height).lineTo(0, top(snow, box, full, 0));
        for (let i = 0; i <= last; i++) {
            g.lineTo((i + 0.5) * snow.column, top(snow, box, full, i));
        }
        g.lineTo(box.width, top(snow, box, full, last)).lineTo(box.width, box.height).closePath();
        // A flat grey-blue well under the bloom threshold; only the line along its top is bright.
        g.fill({ color: mixColor(theme.ink, theme.accentAlt, 0.3), alpha: 0.36 });
        g.moveTo(0, top(snow, box, full, 0));
        for (let i = 0; i <= last; i++) {
            g.lineTo((i + 0.5) * snow.column, top(snow, box, full, i));
        }
        g.lineTo(box.width, top(snow, box, full, last)).stroke({ width: 1, color: theme.ink, alpha: 0.8 });
        for (const flake of snow.flakes) {
            g.circle(flake.x, flake.y, flake.size);
        }
        g.fill({ color: theme.ink, alpha: 0.9 });
    },
};
