import { FillGradient, type Graphics } from 'pixi.js';
import { Effect } from '../../src/Effect';
import { approach, clamp, mixColor } from '../../src/math';
import type { EffectContext, TickContext, TimedContext, Vector3 } from '../../src/types';
import type { LiquidContext } from '../contracts';
import { FieldLayer } from '../Field/FieldLayer';
import { FieldSet, type Field } from '../Field/FieldSet';
import { Surface } from './Surface';

export interface LiquidOptions {
    /** How solid the liquid is, 0..1 (switches and bars draw it a little stronger, text fields a little weaker). Default `OPACITY` (0.42). */
    opacity?: number;
    /** Multiplier on how fast the surface settles after a disturbance; lower is sloppier. Default `STIFFNESS` (1). */
    stiffness?: number;
    /** Bubbles rising in the liquid and popping at the surface. Default true. */
    bubbles?: boolean;
}

/** Bubbles one element can hold at most, at full budget. */
const MAX_BUBBLES = 16;
/** Pop rings one element can show at once. */
const MAX_POPS = 4;
const POP_LIFE = 260;

/** What the effect keeps for one element. */
interface Vessel {
    surface: Surface;
    /** Filled from the left (a wide flat bar) instead of from the bottom. */
    sideways: boolean;
    /** How full, 0..1 of the vessel's capacity, eased here so that pouring has a pace. */
    fill: number;
    /** How fast `fill` changed in the last tick, per ms. */
    rate: number;
    /** Where a pour lands, 0..1 along the surface. */
    pour: number;
    pointerX: number;
    pointerY: number;
    /** Seconds-ish phase so that neighbouring vessels do not swell in step. */
    phase: number;
    bubbleDebt: number;
    /** Bubbles: structure of arrays, `bubbles` of them alive. */
    bubbles: number;
    bx: Float32Array;
    by: Float32Array;
    br: Float32Array;
    bv: Float32Array;
    bw: Float32Array;
    /** Pop rings: position and age (ms), `pops` of them alive. */
    pops: number;
    px: Float32Array;
    py: Float32Array;
    pa: Float32Array;
}

/**
 * Liquid in an input, as much as it has value. A switch pours full when it is turned on and
 * drains when it is turned off; a slider or a progress bar is filled to its value (a wide flat
 * bar fills from the left, with a wavy upright front); a text field or a button holds a little
 * and fills higher while it has the focus. The surface is a row of spring columns, so it sloshes
 * when the level changes, when it is poked, when the element moves and when a shock ring passes
 * through, and a few bubbles rise and pop at the top.
 *
 *     <label class="switch">
 *         <input type="checkbox" />
 *         <span class="track" data-fx-anchor="sound" data-fx-tags="liquid"></span>
 *         Sound
 *     </label>
 *
 * What it listens to:
 *   - elements tagged `liquid` and their state words (`on`/`off`, `value:`, `focus`, `disabled`,
 *     `knob`; see `effects/Field/words.ts`).
 *   - the pointer: a press pokes the surface where it lands and lets a few bubbles go, moving
 *     through the liquid leaves a small wake, hovering makes it bubble more.
 *   - the element moving (dragged or scrolled): the liquid sloshes the other way, as in a carried glass.
 *   - the force field at each element's centre: wind leans the surface, a shock ring sloshes and bumps it.
 * It tells the others how many elements it is drawing in and how many are showing; no forces, no events.
 * It has no keys.
 */
export class Liquid extends Effect<LiquidContext> {
    public effectName = 'liquid';

    public static readonly TAG = 'liquid';
    public static readonly OPACITY = 0.42;
    public static readonly STIFFNESS = 1;
    /** Fill of a text field or a button at rest, and while it has the focus, 0..1. */
    public static readonly REST_FILL = 0.38;
    public static readonly FOCUS_FILL = 0.8;
    /** Per second: how fast the liquid follows the value (pouring and draining pace). */
    private static readonly POUR_RATE = 4.5;
    /** Bubbles per second per 1000 px² of liquid, at rest; hovering multiplies it. */
    private static readonly BUBBLE_RATE = 0.35;

    private readonly opacity: number;
    private readonly stiffness: number;
    private readonly bubblesOn: boolean;
    private readonly vessels: FieldSet<Vessel>;
    private readonly context: LiquidContext = { fields: 0, active: 0 };
    private readonly force: Vector3 = { x: 0, y: 0, z: 0 };
    private layer: FieldLayer | undefined;
    private gradient: FillGradient | undefined;
    private themeKey = '';
    private meniscus = 0xffffff;
    private bubbleColor = 0xffffff;

    constructor(options: LiquidOptions = {}) {
        super();
        this.opacity = clamp(options.opacity ?? Liquid.OPACITY, 0, 1);
        this.stiffness = clamp(options.stiffness ?? Liquid.STIFFNESS, 0.1, 4);
        this.bubblesOn = options.bubbles ?? true;
        this.vessels = new FieldSet<Vessel>(Liquid.TAG, (field) => this.makeVessel(field));
    }

    public initialize(): void {
        this.layer = new FieldLayer(this.host.pixi);
    }

    public onTick(tick: TickContext): EffectContext<LiquidContext> {
        this.vessels.update(tick);
        const dt = tick.timeDelta;
        let active = 0;
        for (const field of this.vessels.fields) {
            if (field.active) {
                active++;
            }
            this.simulate(field, tick, dt);
        }
        this.context.fields = this.vessels.fields.length;
        this.context.active = active;
        return this.publish(this.context);
    }

    public onRender(timed: TimedContext): void {
        const layer = this.layer;
        if (!layer) {
            return;
        }
        this.paint(timed);
        for (const field of this.vessels.fields) {
            if (field.data.fill < 0.002) {
                continue;
            }
            this.drawVessel(layer.draw(field), field, timed.time);
        }
        layer.sweep();
    }

    public cleanup(): void {
        this.vessels.clear();
        this.layer?.destroy();
        this.layer = undefined;
        this.gradient?.destroy();
        this.gradient = undefined;
        this.themeKey = '';
    }

    // ---- simulation -----------------------------------------------------------------------

    private makeVessel(field: Field<Vessel>): Vessel {
        const sideways = Liquid.isBar(field);
        const vessel: Vessel = {
            surface: new Surface(sideways ? field.height : field.width, 1, this.stiffness),
            sideways,
            fill: this.target(field),
            rate: 0,
            pour: 0.5,
            pointerX: field.pointerX,
            pointerY: field.pointerY,
            phase: Math.random() * 1000,
            bubbleDebt: Math.random(),
            bubbles: 0,
            bx: new Float32Array(MAX_BUBBLES),
            by: new Float32Array(MAX_BUBBLES),
            br: new Float32Array(MAX_BUBBLES),
            bv: new Float32Array(MAX_BUBBLES),
            bw: new Float32Array(MAX_BUBBLES),
            pops: 0,
            px: new Float32Array(MAX_POPS),
            py: new Float32Array(MAX_POPS),
            pa: new Float32Array(MAX_POPS),
        };
        this.fit(vessel, field);
        return vessel;
    }

    /** A wide flat element with a value (a slider bar, a progress bar) fills from the left. */
    private static isBar(field: Field<Vessel>): boolean {
        return field.words.value !== undefined && field.width > field.height * 4;
    }

    /** How full the element should be, 0..1. */
    private target(field: Field<Vessel>): number {
        const words = field.words;
        if (words.value !== undefined || words.on || words.off) {
            return field.value;
        }
        // A text field or a button: a little at rest, more while it has the focus.
        if (words.disabled) {
            return Liquid.REST_FILL * 0.5;
        }
        return words.focus ? Liquid.FOCUS_FILL : Liquid.REST_FILL;
    }

    /** The element's shape decides which way it fills; its size, how far the surface may move. */
    private fit(vessel: Vessel, field: Field<Vessel>): void {
        const sideways = Liquid.isBar(field);
        if (sideways !== vessel.sideways) {
            vessel.sideways = sideways;
            vessel.surface.calm();
            vessel.bubbles = 0;
            vessel.pops = 0;
        }
        vessel.surface.resize(sideways ? field.height : field.width);
        vessel.surface.limit = Math.max(2, (sideways ? field.width * 0.08 : field.height * 0.3));
    }

    /** Depth of liquid in pixels, measured from the bottom (or from the left when sideways). */
    private depth(vessel: Vessel, field: Field<Vessel>): number {
        if (vessel.sideways) {
            return vessel.fill * field.width;
        }
        // Full keeps a little headroom, so the surface (and what it does) stays in sight below the rim.
        return vessel.fill * (field.height - Math.max(3, field.height * 0.14));
    }

    private simulate(field: Field<Vessel>, tick: TickContext, dt: number): void {
        const vessel = field.data;
        const target = this.target(field);
        const before = vessel.fill;
        vessel.fill = approach(before, target, Liquid.POUR_RATE, dt);
        if (Math.abs(vessel.fill - target) < 0.0005) {
            vessel.fill = target;
        }
        vessel.rate = dt > 0 ? (vessel.fill - before) / dt : 0;

        // Off and empty: nothing to simulate.
        if (vessel.fill < 0.002 && target < 0.002) {
            vessel.fill = 0;
            if (vessel.bubbles > 0 || vessel.pops > 0) {
                vessel.bubbles = 0;
                vessel.pops = 0;
                vessel.surface.calm();
            }
            vessel.pointerX = field.pointerX;
            vessel.pointerY = field.pointerY;
            return;
        }

        this.fit(vessel, field);
        const surface = vessel.surface;
        const span = surface.length;
        const across = vessel.sideways ? field.width : field.height;
        const scale = clamp(across / 30, 0.5, 2.5);
        const depth = this.depth(vessel, field);
        // A thin film cannot slosh much.
        const room = clamp(depth / 6, 0, 1);

        // ---- pouring in and draining ----
        const risePx = vessel.rate * dt * across;
        if (risePx > 0.02) {
            vessel.pour = clamp(vessel.pour + (Math.random() - 0.5) * 0.12, 0.2, 0.8);
            surface.poke(vessel.pour * span, -clamp(risePx * 0.1, 0, 0.18), Math.max(6, span * (vessel.sideways ? 0.5 : 0.18)));
            if (Math.random() < 0.35) {
                surface.poke(Math.random() * span, clamp(risePx * 0.06, 0, 0.1), 6);
            }
        } else if (risePx < -0.02) {
            surface.poke(span * 0.5, clamp(risePx * 0.03, -0.06, 0), span * 0.5);
        }

        // ---- moments ----
        if (field.turnedOn && !vessel.sideways) {
            // The knob lands on the right of a switch track.
            const at = field.words.knob ? span - field.height * 0.5 : span * 0.5;
            surface.poke(at, -0.22 * scale, field.height);
        }
        if (field.pressed) {
            const at = vessel.sideways ? field.pointerY : field.pointerX;
            surface.poke(at, -0.3 * scale, Math.max(8, span * 0.12));
            if (this.bubblesOn) {
                const n = 3 + Math.floor(Math.random() * 3 * scale);
                for (let i = 0; i < n; i++) {
                    this.spawnBubble(vessel, field, tick, vessel.sideways ? undefined : field.pointerX);
                }
            }
        }

        // ---- the pointer moving through it ----
        if (field.hover && !field.pressed) {
            const along = vessel.sideways ? field.pointerY : field.pointerX;
            const was = vessel.sideways ? vessel.pointerY : vessel.pointerX;
            const inside = vessel.sideways ? field.pointerX < depth + 2 : field.pointerY > field.height - depth - 2;
            const moved = along - was;
            if (inside && Math.abs(moved) > 0.3 && Math.abs(moved) < 80) {
                surface.poke(along, -clamp(Math.abs(moved) * 0.006, 0, 0.05), 8);
                surface.poke(along - Math.sign(moved) * 6, clamp(Math.abs(moved) * 0.003, 0, 0.025), 6);
            }
        }
        vessel.pointerX = field.pointerX;
        vessel.pointerY = field.pointerY;

        // ---- the element moving: the liquid stays behind, so it sloshes the other way ----
        const carried = vessel.sideways ? field.movedY : field.movedX;
        const lifted = vessel.sideways ? field.movedX : field.movedY;
        if (carried !== 0 && Math.abs(carried) < 200) {
            surface.tilt(clamp(-carried * 0.012, -0.25, 0.25));
        }
        if (lifted !== 0 && Math.abs(lifted) < 200) {
            surface.heave(clamp(lifted * 0.006, -0.12, 0.12));
        }

        // ---- the scene: wind leans it, a shock ring sloshes and bumps it ----
        const f = tick.forces.sample(field.x + field.width * 0.5, field.y + field.height * 0.5, this.force, this.effectName);
        const push = vessel.sideways ? f.y : f.x;
        const bump = vessel.sideways ? f.x : f.y;
        if (push !== 0 || bump !== 0) {
            surface.tilt(clamp(push * dt * 0.45 * scale, -0.2, 0.2));
            // Screen y points down: a push downwards presses the middle down.
            surface.heave(clamp(-bump * dt * 0.35 * scale, -0.15, 0.15) * (vessel.sideways ? -1 : 1));
        }

        surface.limit = Math.max(1, surface.limit * Math.max(0.25, room));
        surface.step(dt);

        // ---- bubbles ----
        this.stepBubbles(vessel, field, tick, dt, depth);
    }

    private spawnBubble(vessel: Vessel, field: Field<Vessel>, tick: TickContext, at?: number): void {
        const cap = Math.min(MAX_BUBBLES, Math.max(2, Math.round((field.width * field.height) / 600 * tick.budget.budget)));
        if (vessel.bubbles >= cap) {
            return;
        }
        const i = vessel.bubbles++;
        const depth = this.depth(vessel, field);
        const big = field.height > 60 ? 0.6 : 0;
        vessel.br[i] = 1 + Math.random() * (0.9 + big);
        if (vessel.sideways) {
            vessel.bx[i] = 2 + Math.random() * Math.max(0, depth - 4);
        } else {
            const x = at ?? 3 + Math.random() * Math.max(0, field.width - 6);
            vessel.bx[i] = clamp(x + (Math.random() - 0.5) * (at === undefined ? 0 : 18), 2, field.width - 2);
        }
        vessel.by[i] = field.height - 1.5 - Math.random() * (at === undefined ? 2 : Math.min(10, depth * 0.5));
        vessel.bv[i] = 0.018 + Math.random() * 0.016 + vessel.br[i] * 0.004;
        vessel.bw[i] = Math.random() * Math.PI * 2;
    }

    private stepBubbles(vessel: Vessel, field: Field<Vessel>, tick: TickContext, dt: number, depth: number): void {
        // Pop rings age and go.
        for (let i = vessel.pops - 1; i >= 0; i--) {
            vessel.pa[i] += dt;
            if (vessel.pa[i] >= POP_LIFE) {
                const last = --vessel.pops;
                vessel.px[i] = vessel.px[last];
                vessel.py[i] = vessel.py[last];
                vessel.pa[i] = vessel.pa[last];
            }
        }
        if (!this.bubblesOn) {
            vessel.bubbles = 0;
            return;
        }

        // New ones now and then, more under the pointer.
        if (depth > 5) {
            const area = vessel.sideways ? depth * field.height : depth * field.width;
            const rate = (Liquid.BUBBLE_RATE * area) / 1000 * (field.hover ? 3 : 1) * tick.budget.budget;
            vessel.bubbleDebt += (rate * dt) / 1000;
            while (vessel.bubbleDebt >= 1) {
                vessel.bubbleDebt -= 1;
                this.spawnBubble(vessel, field, tick);
            }
        } else {
            vessel.bubbleDebt = 0;
        }

        const surface = vessel.surface;
        for (let i = vessel.bubbles - 1; i >= 0; i--) {
            const r = vessel.br[i];
            vessel.by[i] -= vessel.bv[i] * dt;
            vessel.bw[i] += dt * 0.008;
            const x = vessel.bx[i] + Math.sin(vessel.bw[i]) * 0.6;
            let top: number;
            if (vessel.sideways) {
                // Filled from the left: the liquid reaches the top edge, the front is upright.
                top = 1.5;
                if (x > depth + surface.heightAt(vessel.by[i]) - r) {
                    top = Number.POSITIVE_INFINITY;
                }
            } else {
                top = field.height - depth - surface.heightAt(x);
            }
            if (vessel.by[i] - r <= top) {
                if (Number.isFinite(top) && top > -2) {
                    this.pop(vessel, x, Math.max(top, 1));
                    if (!vessel.sideways) {
                        surface.poke(x, -0.03, 4);
                    }
                }
                const last = --vessel.bubbles;
                vessel.bx[i] = vessel.bx[last];
                vessel.by[i] = vessel.by[last];
                vessel.br[i] = vessel.br[last];
                vessel.bv[i] = vessel.bv[last];
                vessel.bw[i] = vessel.bw[last];
            }
        }
    }

    private pop(vessel: Vessel, x: number, y: number): void {
        let i = vessel.pops;
        if (i >= MAX_POPS) {
            // Replace the oldest.
            i = 0;
            for (let j = 1; j < MAX_POPS; j++) {
                if (vessel.pa[j] > vessel.pa[i]) {
                    i = j;
                }
            }
        } else {
            vessel.pops++;
        }
        vessel.px[i] = x;
        vessel.py[i] = y;
        vessel.pa[i] = 0;
    }

    // ---- drawing --------------------------------------------------------------------------

    private paint(timed: TimedContext): void {
        const t = timed.theme;
        const key = `${t.accent}/${t.accentAlt}/${t.ink}`;
        if (key === this.themeKey && this.gradient) {
            return;
        }
        this.themeKey = key;
        this.gradient?.destroy();
        this.gradient = new FillGradient({
            type: 'linear',
            start: { x: 0, y: 0 },
            end: { x: 0, y: 1 },
            colorStops: [
                { offset: 0, color: t.accent },
                { offset: 1, color: mixColor(t.accentAlt, t.accent, 0.15) },
            ],
            textureSpace: 'local',
        });
        this.meniscus = mixColor(t.accent, 0xffffff, 0.35);
        this.bubbleColor = mixColor(t.accent, 0xffffff, 0.7);
    }

    private drawVessel(g: Graphics, field: Field<Vessel>, time: number): void {
        const vessel = field.data;
        const surface = vessel.surface;
        const w = field.width;
        const h = field.height;
        const n = surface.count;
        const depth = this.depth(vessel, field);
        const words = field.words;
        // Nothing is written in a switch or a bar: it can be more solid there.
        const quiet = words.knob || words.value !== undefined;
        const alpha = clamp(this.opacity * (quiet ? 1.2 : 0.85), 0, 1) * (0.4 + 0.6 * field.presence);
        const room = clamp(depth / 6, 0, 1);
        const phase = vessel.phase + time;
        const heights = surface.heights;

        if (!vessel.sideways) {
            const base = h - depth;
            // The idle swell: a slow travelling wave so a full vessel is not a block.
            const swell = 0.55 * room;
            const k1 = (Math.PI * 2) / Math.max(40, w * 0.9);
            const k2 = (Math.PI * 2) / Math.max(25, w * 0.45);
            const yAt = (i: number): number => {
                const x = surface.columnAt(i);
                const idle = swell * (Math.sin(x * k1 + phase * 0.0021) + 0.45 * Math.sin(x * k2 - phase * 0.0033));
                return Math.min(h + 1, base - (heights[i] + idle) * room);
            };
            g.moveTo(0, h + 1);
            for (let i = 0; i < n; i++) {
                g.lineTo(surface.columnAt(i), yAt(i));
            }
            g.lineTo(w, h + 1);
            g.closePath();
            g.fill({ fill: this.gradient, alpha });
            if (base < h - 0.5) {
                g.moveTo(0, yAt(0) + 0.5);
                for (let i = 1; i < n; i++) {
                    g.lineTo(surface.columnAt(i), yAt(i) + 0.5);
                }
                g.stroke({ width: 1, color: this.meniscus, alpha: clamp(alpha * 1.7, 0, 0.8) });
            }
        } else {
            const swell = 0.5 * room;
            const xAt = (i: number): number => {
                const y = surface.columnAt(i);
                const idle = swell * Math.sin(y * 0.35 + phase * 0.004);
                return Math.max(-1, depth + (heights[i] + idle) * room);
            };
            g.moveTo(-1, 0);
            for (let i = 0; i < n; i++) {
                g.lineTo(xAt(i), surface.columnAt(i));
            }
            g.lineTo(-1, h);
            g.closePath();
            g.fill({ fill: this.gradient, alpha });
            if (depth > 0.5 && depth < w - 0.5) {
                g.moveTo(xAt(0) - 0.5, 0);
                for (let i = 1; i < n; i++) {
                    g.lineTo(xAt(i) - 0.5, surface.columnAt(i));
                }
                g.stroke({ width: 1, color: this.meniscus, alpha: clamp(alpha * 1.7, 0, 0.8) });
            }
        }

        // Bubbles: small rings.
        const bubbleAlpha = clamp(alpha * 1.6, 0, 0.7);
        for (let i = 0; i < vessel.bubbles; i++) {
            const x = vessel.bx[i] + Math.sin(vessel.bw[i]) * 0.6;
            g.circle(x, vessel.by[i], vessel.br[i]).stroke({ width: 1, color: this.bubbleColor, alpha: bubbleAlpha });
        }
        // Pops: a ring that opens and fades.
        for (let i = 0; i < vessel.pops; i++) {
            const t = vessel.pa[i] / POP_LIFE;
            g.circle(vessel.px[i], vessel.py[i], 1.2 + t * 3.5).stroke({ width: 1, color: this.meniscus, alpha: bubbleAlpha * (1 - t) });
        }
    }
}
