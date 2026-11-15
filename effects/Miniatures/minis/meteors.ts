import { clamp, mixColor, randomNumber } from '../../../src/math';
import type { Mini, MiniBox } from '../Mini';

interface Meteor {
    /** 0..1 along its flight; negative while it waits its turn. */
    flight: number;
    /** Milliseconds until it is sent. */
    wait: number;
    /** Where it comes from and where it lands, in the element's pixels. */
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    /** Milliseconds since it landed; negative once its scar has cooled. */
    landed: number;
    scarX: number;
    scarY: number;
    /** A sent one (a press) lands with a bigger spark. */
    big: boolean;
}

const SPEED = 0.045;
const SPARK_MS = 380;
const SCAR_MS = 1800;

/** A landing spot somewhere along the free part of the element. */
function anywhere(box: MiniBox): number {
    return randomNumber(box.x + 5, box.x + box.w - 5);
}

/** Send it: down a steep diagonal to a spot on the bottom edge, the way the wind blows if it does. */
function send(meteor: Meteor, box: MiniBox, wind: number, toX: number): void {
    const way = wind > 0.15 ? 1 : wind < -0.15 ? -1 : Math.random() < 0.75 ? -1 : 1;
    meteor.toX = clamp(toX, box.x + 3, box.x + box.w - 3);
    meteor.toY = box.height - 2.5;
    meteor.fromY = -4;
    meteor.fromX = meteor.toX - way * (meteor.toY - meteor.fromY) * 0.75;
    meteor.flight = 0;
    meteor.big = false;
}

/**
 * Meteors: a streak with a bright head that crosses the element on a steep diagonal and lands on
 * its bottom edge with a spark and an ember that cools. A wider element has several going. One
 * lands the moment a real one does, a press sends a big one to the pointer, and under the pointer
 * they come more often and aim near it. They travel the way the wind blows.
 */
export const meteors: Mini<Meteor[]> = {
    create(box) {
        const list: Meteor[] = [];
        const count = clamp(Math.round(box.w / 70), 1, 4);
        for (let i = 0; i < count; i++) {
            list.push({ flight: -1, wait: randomNumber(100, 400) + i * 500, fromX: 0, fromY: 0, toX: 0, toY: 0, landed: -1, scarX: 0, scarY: 0, big: false });
        }
        return list;
    },

    tick(list, box, signal) {
        const dt = signal.dt;
        for (let i = 0; i < list.length; i++) {
            const meteor = list[i];
            if (i === 0 && signal.kick) {
                // Sent by hand: already on its way down, so it lands while the press is fresh.
                send(meteor, box, signal.wind, signal.hover ? signal.pointerX : anywhere(box));
                meteor.flight = 0.35;
                meteor.big = true;
            } else if (i === 0 && signal.pulse > 0) {
                // A real one has just landed: this one is about to.
                if (meteor.flight < 0) {
                    send(meteor, box, signal.wind, anywhere(box));
                }
                meteor.flight = Math.max(meteor.flight, 0.8);
            }
            if (meteor.landed >= 0) {
                meteor.landed += dt;
                if (meteor.landed > SCAR_MS) {
                    meteor.landed = -1;
                }
            }
            if (meteor.flight < 0) {
                meteor.wait -= dt * (signal.hover ? 2.5 : 1);
                if (meteor.wait <= 0) {
                    send(meteor, box, signal.wind, signal.hover ? signal.pointerX + randomNumber(-8, 8) : anywhere(box));
                }
                continue;
            }
            meteor.flight += (dt * SPEED) / Math.hypot(meteor.toX - meteor.fromX, meteor.toY - meteor.fromY);
            if (meteor.flight >= 1) {
                meteor.flight = -1;
                meteor.wait = randomNumber(350, 900);
                meteor.landed = 0;
                meteor.scarX = meteor.toX;
                meteor.scarY = meteor.toY;
            }
        }
    },

    draw(g, list, box, theme) {
        for (const meteor of list) {
            if (meteor.landed >= 0) {
                const x = meteor.scarX;
                const y = meteor.scarY;
                const cool = 1 - meteor.landed / SCAR_MS;
                g.circle(x, y, 0.5 + 1.5 * cool).fill({ color: mixColor(theme.accent, theme.ink, cool), alpha: cool });
                if (meteor.landed < SPARK_MS) {
                    // The spark: five rays fanned upward and half a ring, both running outward.
                    const t = meteor.landed / SPARK_MS;
                    const size = meteor.big ? 1.4 : 1;
                    for (let k = 0; k < 5; k++) {
                        const cos = Math.cos(-Math.PI * (0.12 + 0.19 * k));
                        const sin = Math.sin(-Math.PI * (0.12 + 0.19 * k));
                        g.moveTo(x + cos * (1.5 + 6 * t) * size, y + sin * (1.5 + 6 * t) * size).lineTo(x + cos * (3.5 + 7.5 * t) * size, y + sin * (3.5 + 7.5 * t) * size);
                    }
                    g.stroke({ width: 1, color: theme.ink, alpha: 1 - t });
                    g.moveTo(x - (2 + 7 * t) * size, y)
                        .arc(x, y, (2 + 7 * t) * size, Math.PI, Math.PI * 2)
                        .stroke({ width: 1, color: theme.accent, alpha: 0.8 * (1 - t) });
                }
            }
            if (meteor.flight >= 0) {
                const dx = meteor.toX - meteor.fromX;
                const dy = meteor.toY - meteor.fromY;
                const length = Math.hypot(dx, dy);
                const ux = dx / length;
                const uy = dy / length;
                const x = meteor.fromX + dx * meteor.flight;
                const y = meteor.fromY + dy * meteor.flight;
                const tail = Math.min(clamp(box.height * 0.8, 18, 36), length * meteor.flight);
                // The tail is a thin wedge behind the head, with a white core down its near half.
                g.moveTo(x - uy * 1.5, y + ux * 1.5)
                    .lineTo(x - ux * tail, y - uy * tail)
                    .lineTo(x + uy * 1.5, y - ux * 1.5)
                    .closePath()
                    .fill({ color: theme.accent, alpha: 0.85 });
                g.moveTo(x, y)
                    .lineTo(x - ux * tail * 0.3, y - uy * tail * 0.3)
                    .stroke({ width: 1, color: theme.ink, alpha: 0.9 });
                g.circle(x, y, 1.6).fill({ color: theme.ink, alpha: 1 });
            }
        }
    },
};
