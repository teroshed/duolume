import { clamp, mixColor } from '../../../src/math';
import type { Mini, MiniBox } from '../Mini';

/**
 * Fireworks: a stem climbs from the element's floor, stops, and opens into a round burst of
 * rays in one colour, which widens, sags and fades; then the next shell. A shell bursts when a
 * real one does, and a press launches a new one. Wider elements fire several side by side.
 */
interface Shell {
    /** Where it bursts, in pixels of the knob-free part, and how wide the burst gets. */
    x: number;
    y: number;
    radius: number;
    /** Milliseconds: negative while it waits, 0..rise while it climbs, then the burst. */
    age: number;
    rise: number;
    /** Which colour, and how the rays are turned. */
    tone: number;
    turn: number;
}

const RAYS = 12;
const BURST = 800;

/** Send a shell up (or, with `open`, straight into its burst) somewhere new along the element. */
function launch(shell: Shell, box: MiniBox, open: boolean): void {
    const edge = Math.min(shell.radius * 0.8 + 2, box.w / 2);
    shell.x = edge + Math.random() * (box.w - edge * 2);
    shell.y = box.height * (0.36 + Math.random() * 0.1);
    shell.rise = 420 + Math.random() * 160;
    shell.age = open ? shell.rise : 0;
    shell.tone = (shell.tone + 1) % 3;
    shell.turn = Math.random() * 6;
}

export const fireworks: Mini<Shell[]> = {
    create(box) {
        const shells: Shell[] = [];
        // One more than fits side by side: while one burst fades, the next stem is already climbing.
        const count = clamp(Math.round(box.w / 45), 1, 5) + 1;
        const radius = Math.min(box.height * 0.34, box.w * 0.32, 22);
        for (let i = 0; i < count; i++) {
            shells.push({ x: box.w / 2, y: box.height * 0.4, radius, age: -100 - (i / count) * 1500, rise: 500, tone: i, turn: 0 });
        }
        return shells;
    },

    tick(shells, box, signal) {
        const dt = signal.dt * (signal.hover ? 1.6 : 1);
        // A real shell burst: the one that is climbing bursts now; with none climbing, one that waits opens at once.
        let burstNow = signal.pulse > 0;
        let launchNow = signal.kick;
        for (const shell of shells) {
            if (burstNow && shell.age >= 0 && shell.age < shell.rise) {
                shell.y = box.height - (box.height - shell.y) * (1 - (1 - shell.age / shell.rise) ** 2);
                shell.age = shell.rise;
                burstNow = false;
            }
        }
        for (const shell of shells) {
            const spent = shell.age < 0 || shell.age > shell.rise + BURST * 0.7;
            if (burstNow && spent) {
                launch(shell, box, true);
                burstNow = false;
            } else if (launchNow && spent) {
                launch(shell, box, false);
                launchNow = false;
            }
            const before = shell.age;
            shell.age += dt;
            if (before < 0 && shell.age >= 0) {
                launch(shell, box, false);
            } else if (shell.age > shell.rise + BURST) {
                shell.age = -(100 + Math.random() * 300);
            }
        }
    },

    draw(g, shells, box, theme, signal) {
        const floor = box.height - 1;
        for (const shell of shells) {
            if (shell.age < 0) {
                continue;
            }
            const color = shell.tone === 0 ? theme.accent : shell.tone === 1 ? theme.accentAlt : mixColor(theme.ink, theme.accentAlt, 0.2);
            if (shell.age < shell.rise) {
                // The stem: a bright head climbing, slowing, with a fading tail below it. It leans with the wind.
                const climb = 1 - (1 - shell.age / shell.rise) ** 2;
                const y = floor - (floor - shell.y) * climb;
                const x = box.x + shell.x + signal.wind * 5 * climb;
                const tail = Math.min(floor - y, box.height * 0.3);
                g.moveTo(x - signal.wind * 2, y + tail).lineTo(x, y + 2).stroke({ width: 1, color: theme.ink, alpha: 0.45 });
                g.rect(x - 1, y - 1, 2, 3).fill({ color: theme.ink, alpha: 1 });
                continue;
            }
            // The burst: rays that fly out fast and slow down, let go of the middle, and droop as they fade.
            const p = (shell.age - shell.rise) / BURST;
            const out = shell.radius * (1 - (1 - p) ** 4);
            const inner = out * (0.12 + 0.6 * p * p);
            const droop = p * p * shell.radius * 0.6;
            const cx = box.x + shell.x + signal.wind * (5 + 6 * p);
            const cy = shell.y;
            for (let i = 0; i < RAYS; i++) {
                const angle = shell.turn + (i / RAYS) * Math.PI * 2;
                // Every other ray is shorter, so the burst reads as a star and not as a wheel.
                const far = i % 2 === 0 ? out : out * 0.68;
                const near = Math.max(0, Math.min(inner, far - 1));
                const half = (near + far) / 2;
                g.moveTo(cx + Math.cos(angle) * near, cy + Math.sin(angle) * near + droop * 0.2)
                    .lineTo(cx + Math.cos(angle) * half, cy + Math.sin(angle) * half + droop * 0.5)
                    .lineTo(cx + Math.cos(angle) * far, cy + Math.sin(angle) * far + droop);
            }
            g.stroke({ width: 1.4, color, alpha: 1 - p * p });
            if (p < 0.15) {
                g.circle(cx, cy, 1.6).fill({ color: theme.ink, alpha: 1 - p / 0.15 });
            }
        }
    },
};
