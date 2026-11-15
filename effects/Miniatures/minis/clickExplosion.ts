import { clamp } from '../../../src/math';
import type { Mini, MiniBox } from '../Mini';

/**
 * Click sparks: a ring snaps open where the click landed and a handful of sparks fly out of
 * it, arc over under gravity, bounce once on the element's floor and go out. It bursts when
 * the stage is really pressed, and where the pointer is when the element itself is pressed.
 */
interface Burst {
    /** Where it went off, in pixels of the knob-free part. */
    x: number;
    y: number;
    /** Milliseconds since then; past `LIFE` it is spent. */
    age: number;
    /** Milliseconds until it goes off again by itself. */
    wait: number;
    /** The sparks: positions and velocities (pixels, pixels per millisecond). */
    px: Float32Array;
    py: Float32Array;
    vx: Float32Array;
    vy: Float32Array;
}

const SPARKS = 10;
const LIFE = 1000;
const GRAVITY = 0.00013;

function ignite(burst: Burst, box: MiniBox, x: number, y: number): void {
    const push = clamp(box.height / 30, 0.8, 1.8);
    burst.x = clamp(x, 3, box.w - 3);
    burst.y = clamp(y, 3, box.height - 3);
    burst.age = 0;
    burst.wait = 750 + Math.random() * 700;
    for (let i = 0; i < SPARKS; i++) {
        const angle = (i / SPARKS) * Math.PI * 2 + Math.random() * 0.5;
        const speed = (0.022 + Math.random() * 0.03) * push;
        burst.px[i] = burst.x;
        burst.py[i] = burst.y;
        burst.vx[i] = Math.cos(angle) * speed;
        // Thrown a little upward, so the sparks arc.
        burst.vy[i] = Math.sin(angle) * speed - 0.02 * push;
    }
}

export const clickExplosion: Mini<Burst[]> = {
    create(box) {
        const bursts: Burst[] = [];
        const count = clamp(Math.round((box.w * box.height) / 2200), 1, 5);
        for (let i = 0; i < count; i++) {
            bursts.push({
                x: 0,
                y: 0,
                age: LIFE,
                wait: 150 + (i / count) * 900,
                px: new Float32Array(SPARKS),
                py: new Float32Array(SPARKS),
                vx: new Float32Array(SPARKS),
                vy: new Float32Array(SPARKS),
            });
        }
        return bursts;
    },

    tick(bursts, box, signal) {
        const floor = box.height - 2.5;
        // A real press, or one on the element: the burst that has been dark longest goes off now.
        let called = signal.pulse > 0 || signal.kick;
        let oldest = bursts[0];
        for (const burst of bursts) {
            if (burst.age > oldest.age) {
                oldest = burst;
            }
        }
        for (const burst of bursts) {
            burst.wait -= signal.dt * (signal.hover ? 2.2 : 1);
            const own = burst.wait <= 0 && burst.age > LIFE * 0.6;
            if ((called && burst === oldest) || own) {
                const atPointer = signal.hover && (signal.kick || own);
                const x = atPointer ? signal.pointerX - box.x : (0.2 + Math.random() * 0.6) * box.w;
                const y = atPointer ? signal.pointerY : (0.25 + Math.random() * 0.35) * box.height;
                ignite(burst, box, x, y);
                called = called && burst !== oldest;
                continue;
            }
            if (burst.age >= LIFE) {
                continue;
            }
            burst.age += signal.dt;
            for (let i = 0; i < SPARKS; i++) {
                burst.vy[i] += GRAVITY * signal.dt;
                burst.vx[i] += signal.wind * 0.00006 * signal.dt;
                burst.px[i] += burst.vx[i] * signal.dt;
                burst.py[i] += burst.vy[i] * signal.dt;
                if (burst.py[i] > floor && burst.vy[i] > 0) {
                    burst.py[i] = floor;
                    burst.vy[i] *= -0.45;
                    burst.vx[i] *= 0.7;
                }
            }
        }
    },

    draw(g, bursts, box, theme) {
        for (const burst of bursts) {
            if (burst.age >= LIFE) {
                continue;
            }
            const p = burst.age / LIFE;
            // The ring of the click.
            if (burst.age < 240) {
                const open = burst.age / 240;
                g.circle(box.x + burst.x, burst.y, 1.5 + open * Math.min(11, box.height * 0.4)).stroke({ width: 1, color: theme.ink, alpha: 0.75 * (1 - open) });
            }
            // The sparks, in three colours: each a short streak along its flight.
            for (let tone = 0; tone < 3; tone++) {
                for (let i = tone; i < SPARKS; i += 3) {
                    const speed = Math.hypot(burst.vx[i], burst.vy[i]) || 1;
                    const tail = clamp(speed * 55, 1.2, 5);
                    g.moveTo(box.x + burst.px[i] - (burst.vx[i] / speed) * tail, burst.py[i] - (burst.vy[i] / speed) * tail).lineTo(box.x + burst.px[i], burst.py[i]);
                }
                g.stroke({ width: 1.3, color: tone === 0 ? theme.accent : tone === 1 ? theme.accentAlt : theme.ink, alpha: 1 - p * p });
            }
        }
    },
};
