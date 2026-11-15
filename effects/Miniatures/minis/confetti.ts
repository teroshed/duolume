import { clamp, mixColor, randomNumber } from '../../../src/math';
import type { Theme } from '../../../src/types';
import type { Mini, MiniBox } from '../Mini';

interface Piece {
    /** Centre, in pixels from the left of the free part and the element's top; velocity in pixels per millisecond. */
    x: number;
    y: number;
    vx: number;
    vy: number;
    /** The speed it settles to when it is just falling. */
    fall: number;
    sway: number;
    /** The tumble, in radians: its width is the cosine of this, and past a quarter turn it shows its back. */
    flip: number;
    flipSpeed: number;
    /** Which way its long side points, in radians. */
    spin: number;
    spinSpeed: number;
    length: number;
    tone: number;
}

interface Shower {
    pieces: Piece[];
    /** The piece the next burst takes first, so bursts use them in turn. */
    turn: number;
    /** Milliseconds until a corner fires by itself. */
    next: number;
}

/** The four paper colours, all from the theme. */
function paper(theme: Theme, tone: number): number {
    return tone === 0 ? theme.accent : tone === 1 ? theme.accentAlt : tone === 2 ? theme.ink : mixColor(theme.accent, theme.accentAlt, 0.5);
}

/** Throw `count` pieces up from a point: to the right (`way` 1), to the left (-1) or all round (0). */
function burst(shower: Shower, box: MiniBox, x: number, y: number, count: number, way: number): void {
    for (let k = 0; k < count; k++) {
        const piece = shower.pieces[shower.turn];
        shower.turn = (shower.turn + 1) % shower.pieces.length;
        piece.x = x;
        piece.y = y;
        piece.vx = way === 0 ? randomNumber(-0.07, 0.07) : way * randomNumber(0.02, 0.09);
        piece.vy = -box.height * 0.0022 * randomNumber(0.5, 1);
    }
}

/**
 * Confetti: small paper rectangles in the theme's colours tumbling down: each turns end over end
 * (it narrows to a line and widens again, darker on its back) and flutters sideways. The wind
 * carries them. A corner fires a few back up now and then; a firework in the scene throws a
 * burst from the middle; a press fires both corners, or from the pointer if it is over the element.
 */
export const confetti: Mini<Shower> = {
    create(box) {
        const count = clamp(Math.round((box.w * box.height) / 75), 10, 30);
        const pieces: Piece[] = [];
        for (let i = 0; i < count; i++) {
            pieces.push({
                x: Math.random() * box.w,
                y: Math.random() * box.height,
                vx: 0,
                vy: 0.015,
                fall: randomNumber(0.012, 0.021),
                sway: Math.random() * 6.28,
                flip: Math.random() * 6.28,
                flipSpeed: randomNumber(0.004, 0.009),
                spin: Math.random() * 6.28,
                spinSpeed: randomNumber(-0.002, 0.002),
                length: randomNumber(1.7, 2.4),
                tone: i % 4,
            });
        }
        return { pieces, turn: 0, next: randomNumber(2500, 4500) };
    },

    tick(shower, box, signal) {
        const dt = signal.dt;
        const px = signal.pointerX - box.x;
        const third = Math.ceil(shower.pieces.length / 3);
        shower.next -= dt;
        if (signal.kick && signal.hover) {
            burst(shower, box, px, signal.pointerY, third * 2, 0);
        } else if (signal.kick) {
            burst(shower, box, 1, box.height - 1, third, 1);
            burst(shower, box, box.w - 1, box.height - 1, third, -1);
        } else if (signal.pulse > 0) {
            burst(shower, box, box.w * randomNumber(0.3, 0.7), box.height * 0.5, third * 2, 0);
        } else if (shower.next <= 0) {
            const left = Math.random() < 0.5;
            burst(shower, box, left ? 1 : box.w - 1, box.height - 1, third, left ? 1 : -1);
        }
        if (shower.next <= 0 || signal.kick || signal.pulse > 0) {
            shower.next = randomNumber(3500, 6500);
        }
        const settle = 1 - Math.exp(-dt * 0.004);
        for (const piece of shower.pieces) {
            piece.vy += (piece.fall - piece.vy) * settle;
            piece.vx += (signal.wind * 0.03 - piece.vx) * settle;
            if (signal.hover) {
                // Brushed aside by the pointer.
                const dx = piece.x - px;
                const dy = piece.y - signal.pointerY;
                const d = Math.hypot(dx, dy) || 1;
                if (d < 10) {
                    piece.vx += (dx / d) * (1 - d / 10) * 0.0008 * dt;
                    piece.vy += (dy / d) * (1 - d / 10) * 0.0008 * dt;
                }
            }
            piece.sway += dt * 0.004;
            piece.flip += dt * piece.flipSpeed * (signal.hover ? 1.8 : 1);
            piece.spin += dt * piece.spinSpeed;
            piece.x += (piece.vx + Math.sin(piece.sway) * 0.01) * dt;
            piece.y += piece.vy * dt;
            if (piece.y > box.height + 3) {
                piece.y = -3;
                piece.x = Math.random() * box.w;
            }
            piece.x = ((piece.x + 3 + box.w + 6) % (box.w + 6)) - 3;
        }
    },

    draw(g, shower, box, theme) {
        for (const piece of shower.pieces) {
            const face = Math.cos(piece.flip);
            const cos = Math.cos(piece.spin);
            const sin = Math.sin(piece.spin);
            const ax = cos * piece.length;
            const ay = sin * piece.length;
            const across = 1.3 * Math.abs(face) + 0.25;
            const bx = -sin * across;
            const by = cos * across;
            const x = box.x + piece.x;
            g.moveTo(x + ax + bx, piece.y + ay + by)
                .lineTo(x - ax + bx, piece.y - ay + by)
                .lineTo(x - ax - bx, piece.y - ay - by)
                .lineTo(x + ax - bx, piece.y + ay - by)
                .closePath()
                .fill({ color: face > 0 ? paper(theme, piece.tone) : mixColor(paper(theme, piece.tone), theme.bgBottom, 0.45), alpha: 0.95 });
        }
    },
};
