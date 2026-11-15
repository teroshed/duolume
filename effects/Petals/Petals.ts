import { Graphics } from 'pixi.js';
import { Effect } from '../../src/Effect';
import { clamp, mixColor, smoothstep } from '../../src/math';
import type { EffectContext, Theme, TickContext, TimedContext, Vector3 } from '../../src/types';
import type { PetalsContext } from '../contracts';
import { FieldLayer } from '../Field/FieldLayer';
import { FieldSet, type Field } from '../Field/FieldSet';
import { layoutVine, seededRandom, vineSeed, type Vine } from './vine';

export interface PetalsOptions {
    /** Seconds for a whole vine to grow, from bare to every blossom open. Default `GROW_SECONDS` (1.4). */
    growSeconds?: number;
    /** Multiplier on how many blossoms a vine carries, 0 to 3; 0 gives leaves only. Default `BLOSSOMS` (1). */
    blossoms?: number;
    /** Petals fall out of the element when it turns off or is shaken. Default true. */
    fall?: boolean;
}

/** What the effect keeps for one element. Per-node arrays are indexed like `vine.nodes`. */
interface Plant {
    vine: Vine;
    /** The size and radius the vine was laid out for. */
    w: number;
    h: number;
    r: number;
    /** 0..1: how far along its stems the vine has grown. */
    growth: number;
    /** 0..1: how brightly the growing tip shows (it is lit while the stem is moving forward). */
    tip: number;
    /** Wind at the element, -1..1, eased. */
    lean: number;
    phase: number;
    /** Leaf unfurled / blossom opened, 0..1. */
    amount: Float32Array;
    /** Whether the growth was past the node last tick. */
    grown: Uint8Array;
    /** Which of a blossom's five petals are on it (bits). */
    attached: Uint8Array;
    /** Petals growing back after a shake (bits), and how far, 0..1. */
    regrowMask: Uint8Array;
    regrow: Float32Array;
    /** Simulation time at which shaken-off petals grow back; 0 for none. */
    regrowAt: Float32Array;
    /** A leaf's trembling after a press, 0..1, dying away. */
    tremble: Float32Array;
    /** Anything to draw. */
    live: boolean;
}

const ALL_PETALS = 31;
/** Part of a blossom's opening spent as a bud. */
const BUD = 0.4;
const LEAF_MS = 300;
const BLOSSOM_MS = 700;
/** A leaning green that the theme's accent is mixed toward for the stem and leaves. */
const GREEN = 0x8fcf6a;

/**
 * A vine that grows along the inside of an input when it is switched on: a 1 px wavy stem along
 * the bottom edge, leaves unfurling as it passes, a few five-petalled blossoms opening after it.
 * Switched off, the blossoms close and let go: their petals fall out of the element and drift
 * down the page on the scene's wind while the stem withdraws. A slider or progress bar grows the
 * vine as far as its value. A press shakes a few petals loose; they grow back a moment later.
 *
 *     <span class="track" data-fx-anchor="garden" data-fx-tags="petals"></span>
 *
 * In a switch it grows in the part the knob leaves free while on; in a tall element (a pad) a
 * shoot climbs the left side and the stem carries on up the right.
 *
 * What it listens to:
 *   - elements tagged `petals` and their state words (`on`/`off`, `value:`, `knob`, `r:`,
 *     `disabled`), the pointer over them (leaves lean away from it, blossoms open wider) and
 *     presses on them (open blossoms near the pointer drop a petal or two; leaves tremble).
 *   - the force field (`tick.forces.sample`): the wind sways the plants and carries the falling
 *     petals; a shock ring scatters them.
 *   - elements tagged `ledge`: a falling petal that reaches the top of one rests there a second.
 * It tells the others how many elements it is drawing in and how many petals are falling.
 * No forces, no events, no keys.
 */
export class Petals extends Effect<PetalsContext> {
    public effectName = 'petals';

    public static readonly GROW_SECONDS = 1.4;
    public static readonly BLOSSOMS = 1;
    /** Falling petals across all elements at full budget. */
    public static readonly MAX_PETALS = 160;
    /** The wind effect's hand-push, in px/ms²: the wind treated as full strength. */
    private static readonly FULL_WIND = 0.0011;

    private readonly growSeconds: number;
    private readonly blossoms: number;
    private readonly fall: boolean;
    private readonly plants: FieldSet<Plant>;
    private readonly context: PetalsContext = { fields: 0, active: 0, petals: 0 };
    private readonly sampled: Vector3 = { x: 0, y: 0, z: 0 };
    private layer: FieldLayer | undefined;
    private air: Graphics | undefined;
    private readonly random: () => number = Math.random;

    // The falling petals, structure of arrays.
    private count = 0;
    private readonly px = new Float32Array(Petals.MAX_PETALS);
    private readonly py = new Float32Array(Petals.MAX_PETALS);
    private readonly vx = new Float32Array(Petals.MAX_PETALS);
    private readonly vy = new Float32Array(Petals.MAX_PETALS);
    private readonly startY = new Float32Array(Petals.MAX_PETALS);
    private readonly age = new Float32Array(Petals.MAX_PETALS);
    private readonly rot = new Float32Array(Petals.MAX_PETALS);
    private readonly spin = new Float32Array(Petals.MAX_PETALS);
    private readonly spinRate = new Float32Array(Petals.MAX_PETALS);
    private readonly flutter = new Float32Array(Petals.MAX_PETALS);
    private readonly terminal = new Float32Array(Petals.MAX_PETALS);
    private readonly size = new Float32Array(Petals.MAX_PETALS);
    private readonly shade = new Float32Array(Petals.MAX_PETALS);
    /** Milliseconds left resting on a ledge; 0 while falling. */
    private readonly rest = new Float32Array(Petals.MAX_PETALS);

    constructor(options: PetalsOptions = {}) {
        super();
        this.growSeconds = clamp(options.growSeconds ?? Petals.GROW_SECONDS, 0.1, 30);
        this.blossoms = clamp(options.blossoms ?? Petals.BLOSSOMS, 0, 3);
        this.fall = options.fall ?? true;
        this.plants = new FieldSet<Plant>('petals', (field) => this.plant(field));
    }

    public initialize(): void {
        this.layer = new FieldLayer(this.host.pixi);
        this.air = new Graphics();
        this.air.label = 'falling petals';
        this.host.pixi.addChild(this.air);
    }

    public onTick(tick: TickContext): EffectContext<PetalsContext> {
        this.plants.update(tick);
        const dt = tick.timeDelta;
        const time = tick.time;
        const cap = Math.max(8, Math.round(Petals.MAX_PETALS * clamp(tick.budget.budget, 0, 1)));

        let active = 0;
        for (const field of this.plants.fields) {
            if (field.active) {
                active++;
            }
            const plant = field.data;
            const w = this.layoutWidth(field);
            if (Math.abs(w - plant.w) > 1 || Math.abs(field.height - plant.h) > 1 || Math.abs(field.radius - plant.r) > 1) {
                this.relayout(plant, field);
            }

            const target = clamp(field.level * field.presence, 0, 1);
            const step = dt / (this.growSeconds * 1000);
            const before = plant.growth;
            if (plant.growth < target) {
                plant.growth = Math.min(target, plant.growth + step);
            } else if (plant.growth > target) {
                plant.growth = Math.max(target, plant.growth - step * 1.4);
            }
            const growing = plant.growth > before + 1e-6;
            plant.tip += ((growing ? 1 : 0) - plant.tip) * (1 - Math.exp(-dt / (growing ? 60 : 220)));

            // Nothing grown, nothing fading: rest, and skip the wind.
            if (plant.growth <= 0 && !plant.live && target <= 0) {
                continue;
            }
            const out = tick.forces.sample(field.x + field.width / 2, field.y + field.height / 2, this.sampled, this.effectName);
            const wind = clamp(out.x / Petals.FULL_WIND, -1, 1);
            plant.lean += (wind - plant.lean) * (1 - Math.exp(-dt / 400));

            const vine = plant.vine;
            const nodes = vine.nodes;
            let live = plant.growth > 0;
            for (let i = 0; i < nodes.length; i++) {
                const node = nodes[i];
                const grown = plant.growth >= node.s && plant.growth > 0;
                if (grown) {
                    if (!plant.grown[i] && plant.amount[i] < 0.5) {
                        plant.attached[i] = ALL_PETALS;
                        plant.regrowMask[i] = 0;
                        plant.regrowAt[i] = 0;
                    }
                    plant.amount[i] = Math.min(1, plant.amount[i] + dt / (node.blossom ? BLOSSOM_MS : LEAF_MS));
                } else {
                    if (plant.grown[i] && node.blossom) {
                        this.release(field, i, cap);
                    }
                    plant.amount[i] = Math.max(0, plant.amount[i] - dt / (node.blossom ? 350 : 260));
                }
                plant.grown[i] = grown ? 1 : 0;
                if (plant.regrowAt[i] > 0 && time >= plant.regrowAt[i] && grown) {
                    plant.regrowMask[i] = ALL_PETALS & ~plant.attached[i];
                    plant.attached[i] = ALL_PETALS;
                    plant.regrow[i] = 0;
                    plant.regrowAt[i] = 0;
                }
                plant.regrow[i] = Math.min(1, plant.regrow[i] + dt / 450);
                plant.tremble[i] *= Math.exp(-dt / 380);
                if (plant.amount[i] > 0) {
                    live = true;
                }
            }
            plant.live = live;

            if (field.pressed && live) {
                this.shake(field, time, cap);
            }
        }

        this.fly(tick, dt);

        this.context.fields = this.plants.fields.length;
        this.context.active = active;
        this.context.petals = this.count;
        return this.publish(this.context);
    }

    public onRender(timed: TimedContext): void {
        const layer = this.layer;
        const air = this.air;
        if (!layer || !air) {
            return;
        }
        const theme = timed.theme;
        for (const field of this.plants.fields) {
            if (field.data.live) {
                this.drawPlant(layer.draw(field), field, theme, timed.time);
            }
        }
        layer.sweep();

        air.clear();
        const petal = petalColor(theme);
        const petalDeep = mixColor(theme.accentAlt, theme.bgBottom, 0.15);
        const lead = timed.alpha * timed.tickDelta;
        for (let i = 0; i < this.count; i++) {
            const age = this.age[i];
            let alpha = Math.min(1, age / 100) * (1 - smoothstep(2500, 3300, age)) * (1 - smoothstep(220, 320, this.py[i] - this.startY[i]));
            if (this.rest[i] > 0) {
                alpha *= Math.min(1, this.rest[i] / 600);
            }
            if (alpha <= 0.01) {
                continue;
            }
            const resting = this.rest[i] > 0;
            const x = this.px[i] + (resting ? 0 : this.vx[i] * lead);
            const y = this.py[i] + (resting ? 0 : this.vy[i] * lead);
            const len = this.size[i];
            // It turns as it falls: seen edge-on its width almost vanishes.
            const turn = resting ? 0.7 : Math.abs(Math.cos(this.spin[i]));
            const a = this.rot[i];
            lens(air, x - Math.cos(a) * len * 0.5, y - Math.sin(a) * len * 0.5, a, len, len * (0.12 + 0.3 * turn));
            air.fill({ color: mixColor(petal, petalDeep, this.shade[i] * (1 - turn * 0.5)), alpha: alpha * 0.9 });
        }
    }

    public cleanup(): void {
        this.plants.clear();
        this.layer?.destroy();
        this.layer = undefined;
        this.air?.destroy();
        this.air = undefined;
        this.count = 0;
        this.context.fields = this.context.active = this.context.petals = 0;
    }

    // ---- the plant ---------------------------------------------------------------

    /** The width the vine lives in: the part a switch's knob leaves free while it is on (its left part). */
    private layoutWidth(field: Field<Plant>): number {
        return field.words.knob ? field.width - Math.min(field.height, field.width / 2) : field.width;
    }

    private plant(field: Field<Plant>): Plant {
        const plant: Plant = {
            vine: { width: 0, height: 0, stems: [], nodes: [], blossoms: 0 },
            w: -10,
            h: -10,
            r: -10,
            growth: 0,
            tip: 0,
            lean: 0,
            phase: 0,
            amount: new Float32Array(0),
            grown: new Uint8Array(0),
            attached: new Uint8Array(0),
            regrowMask: new Uint8Array(0),
            regrow: new Float32Array(0),
            regrowAt: new Float32Array(0),
            tremble: new Float32Array(0),
            live: false,
        };
        this.relayout(plant, field);
        return plant;
    }

    private relayout(plant: Plant, field: Field<Plant>): void {
        const w = this.layoutWidth(field);
        const random = seededRandom(vineSeed(field.name, w, field.height));
        plant.vine = layoutVine(w, field.height, field.radius, random, this.blossoms);
        plant.w = w;
        plant.h = field.height;
        plant.r = field.radius;
        plant.phase = random() * Math.PI * 2;
        const n = plant.vine.nodes.length;
        plant.amount = new Float32Array(n);
        plant.grown = new Uint8Array(n);
        plant.attached = new Uint8Array(n);
        plant.regrowMask = new Uint8Array(n);
        plant.regrow = new Float32Array(n).fill(1);
        plant.regrowAt = new Float32Array(n);
        plant.tremble = new Float32Array(n);
        // What was grown stays grown (no petals let go over a resize).
        for (let i = 0; i < n; i++) {
            const grown = plant.growth >= plant.vine.nodes[i].s && plant.growth > 0;
            plant.grown[i] = grown ? 1 : 0;
            plant.amount[i] = grown ? 1 : 0;
            plant.attached[i] = ALL_PETALS;
        }
    }

    /** The blossom closes: its petals come off and fall. */
    private release(field: Field<Plant>, i: number, cap: number): void {
        const plant = field.data;
        const mask = plant.attached[i];
        plant.attached[i] = 0;
        plant.regrowAt[i] = 0;
        const open = clamp((plant.amount[i] - BUD) / (1 - BUD), 0, 1);
        if (!this.fall || open < 0.35) {
            return;
        }
        for (let j = 0; j < 5; j++) {
            if (mask & (1 << j)) {
                this.drop(field, i, j, 1, cap);
            }
        }
    }

    /** A press: open blossoms near the pointer lose a petal or two; leaves near it tremble. */
    private shake(field: Field<Plant>, time: number, cap: number): void {
        const plant = field.data;
        const nodes = plant.vine.nodes;
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            const d = Math.hypot(node.cx - field.pointerX, node.cy - field.pointerY);
            if (!node.blossom) {
                if (d < 50) {
                    plant.tremble[i] = Math.max(plant.tremble[i], 1 - d / 60);
                }
                continue;
            }
            if (d > 40 || plant.amount[i] < 0.9 || plant.attached[i] === 0) {
                continue;
            }
            plant.tremble[i] = 1;
            let drops = 1 + (this.random() < 0.5 ? 1 : 0);
            for (let j = Math.floor(this.random() * 5), k = 0; k < 5 && drops > 0; k++, j = (j + 2) % 5) {
                if (plant.attached[i] & (1 << j)) {
                    plant.attached[i] &= ~(1 << j);
                    drops--;
                    if (this.fall) {
                        this.drop(field, i, j, 1.4, cap);
                    }
                }
            }
            plant.regrowAt[i] = time + 1300 + this.random() * 900;
        }
    }

    /** Start a falling petal from petal j of blossom node i, in stage pixels. */
    private drop(field: Field<Plant>, i: number, j: number, toss: number, cap: number): void {
        if (this.count >= cap) {
            return;
        }
        const plant = field.data;
        const node = plant.vine.nodes[i];
        const a = node.turn + (j * Math.PI * 2) / 5;
        const c = Math.cos(a);
        const s = Math.sin(a);
        const reach = node.size * 0.3;
        const k = this.count++;
        const r = this.random;
        this.px[k] = field.x + node.cx + c * reach;
        this.py[k] = field.y + node.cy + s * reach;
        this.vx[k] = (c * 0.025 + (r() - 0.5) * 0.012) * toss + plant.lean * 0.02;
        this.vy[k] = (s * 0.018 - 0.012 - r() * 0.01) * toss;
        this.startY[k] = this.py[k];
        this.age[k] = 0;
        this.rot[k] = a;
        this.spin[k] = r() * Math.PI;
        this.spinRate[k] = (0.004 + r() * 0.006) * (r() < 0.5 ? -1 : 1);
        this.flutter[k] = r() * Math.PI * 2;
        this.terminal[k] = 0.04 + r() * 0.03;
        this.size[k] = node.size * (0.5 + r() * 0.12);
        this.shade[k] = r();
        this.rest[k] = 0;
    }

    // ---- the petals in the air ---------------------------------------------------

    private fly(tick: TickContext, dt: number): void {
        const ledges = tick.stage.tagged('ledge');
        const out = this.sampled;
        const drag = Math.exp(-dt / 260);
        const settle = 1 - Math.exp(-dt / 320);
        const time = tick.time;
        const height = tick.canvasDimensions.y;
        for (let i = 0; i < this.count; i++) {
            this.age[i] += dt;
            let dead = this.age[i] > 3300 || this.py[i] - this.startY[i] > 320 || this.py[i] > height + 20;
            if (this.rest[i] > 0) {
                this.rest[i] -= dt;
                dead ||= this.rest[i] <= 0;
            } else if (!dead) {
                tick.forces.sample(this.px[i], this.py[i], out, this.effectName);
                // Air: the scene's forces push, drag holds the speed down, it sinks toward its terminal speed.
                this.vx[i] = this.vx[i] * drag + out.x * dt;
                this.vy[i] += (this.terminal[i] - this.vy[i]) * settle + out.y * dt;
                const sway = Math.sin(time * 0.0035 + this.flutter[i]);
                const prevY = this.py[i];
                this.px[i] += (this.vx[i] + sway * 0.022) * dt;
                this.py[i] += this.vy[i] * dt * (1 - Math.abs(sway) * 0.25);
                this.spin[i] += this.spinRate[i] * dt;
                this.rot[i] += this.spinRate[i] * dt * 0.35 + sway * 0.002 * dt;
                for (const ledge of ledges) {
                    if (prevY < ledge.y && this.py[i] >= ledge.y && this.px[i] >= ledge.x && this.px[i] <= ledge.x + ledge.width && this.age[i] < 2400) {
                        this.py[i] = ledge.y - 0.5;
                        this.rest[i] = 1100;
                        this.rot[i] = this.flutter[i] < Math.PI ? 0.15 : Math.PI - 0.15;
                        break;
                    }
                }
            }
            if (dead) {
                this.remove(i);
                i--;
            }
        }
    }

    private remove(i: number): void {
        const last = --this.count;
        if (i === last) {
            return;
        }
        this.px[i] = this.px[last];
        this.py[i] = this.py[last];
        this.vx[i] = this.vx[last];
        this.vy[i] = this.vy[last];
        this.startY[i] = this.startY[last];
        this.age[i] = this.age[last];
        this.rot[i] = this.rot[last];
        this.spin[i] = this.spin[last];
        this.spinRate[i] = this.spinRate[last];
        this.flutter[i] = this.flutter[last];
        this.terminal[i] = this.terminal[last];
        this.size[i] = this.size[last];
        this.shade[i] = this.shade[last];
        this.rest[i] = this.rest[last];
    }

    // ---- drawing -----------------------------------------------------------------

    private drawPlant(g: Graphics, field: Field<Plant>, theme: Theme, time: number): void {
        const plant = field.data;
        const vine = plant.vine;
        const growth = plant.growth;
        const stemColor = mixColor(mixColor(theme.accent, GREEN, 0.5), theme.bgBottom, 0.28);
        const leafColor = mixColor(mixColor(theme.accent, GREEN, 0.6), theme.bgBottom, 0.08);
        const petal = petalColor(theme);
        const breeze = Math.sin(time / 1700 + plant.phase) * 0.5 + plant.lean * 1.6;
        const hover = field.hover && field.pointerKnown;
        const hx = field.pointerX;
        const hy = field.pointerY;

        // The stems, as far as the growth has reached.
        let tipX = -1;
        let tipY = -1;
        for (const stem of vine.stems) {
            const n = stem.s.length;
            if (n < 2 || growth <= stem.s[0]) {
                continue;
            }
            g.moveTo(stem.x[0], stem.y[0]);
            for (let i = 1; i < n; i++) {
                if (stem.s[i] <= growth) {
                    g.lineTo(stem.x[i], stem.y[i]);
                    continue;
                }
                const t = (growth - stem.s[i - 1]) / (stem.s[i] - stem.s[i - 1]);
                tipX = stem.x[i - 1] + (stem.x[i] - stem.x[i - 1]) * t;
                tipY = stem.y[i - 1] + (stem.y[i] - stem.y[i - 1]) * t;
                g.lineTo(tipX, tipY);
                break;
            }
            g.stroke({ width: 1, color: stemColor, alpha: 0.9 });
        }

        // Leaves and blossoms.
        const nodes = vine.nodes;
        for (let i = 0; i < nodes.length; i++) {
            const amount = plant.amount[i];
            if (amount <= 0) {
                continue;
            }
            const node = nodes[i];
            const grown = plant.grown[i] === 1;
            const near = hover ? Math.max(0, 1 - Math.hypot(node.cx - hx, node.cy - hy) / 36) : 0;
            const shiver = plant.tremble[i] * 0.45 * Math.sin(time * 0.055 + i * 1.7);
            if (!node.blossom) {
                // Unfurls with a slight overshoot; wilts by shrinking and drooping.
                const scale = grown ? backOut(amount) : amount * amount;
                let angle = node.angle + breeze * 0.1 + shiver + (grown ? 0 : (1 - amount) * 0.6);
                if (near > 0) {
                    const away = Math.cos(angle) * (node.y - hy) - Math.sin(angle) * (node.x - hx);
                    angle += (away >= 0 ? 1 : -1) * near * 0.4;
                }
                const len = node.size * scale;
                if (len > 0.3) {
                    lens(g, node.x, node.y, angle, len, len * 0.62);
                    g.fill({ color: leafColor, alpha: 0.85 });
                }
                continue;
            }

            // The stalk grows first, then the bud swells, then the petals open one by one.
            const stalk = Math.min(1, amount / 0.25);
            const sway = breeze * 0.6 + shiver * 1.5;
            const cx = node.x + (node.cx + sway - node.x) * stalk;
            const cy = node.y + (node.cy - node.y) * stalk;
            g.moveTo(node.x, node.y).lineTo(cx, cy).stroke({ width: 1, color: stemColor, alpha: 0.8 });
            const radius = node.size * 0.5;
            const open = clamp((amount - BUD) / (1 - BUD), 0, 1);
            const mask = plant.attached[i];
            const budSize = radius * 1.3 * clamp(amount / BUD, 0, 1) * (1 - open * 0.6);
            if (budSize > 0.4) {
                // A closed bud, pointing along its stalk.
                const a = Math.atan2(cy - node.y, cx - node.x);
                lens(g, cx - Math.cos(a) * budSize * 0.4, cy - Math.sin(a) * budSize * 0.4, a, budSize, budSize * 0.5);
                g.fill({ color: mask ? mixColor(leafColor, petal, 0.45) : leafColor, alpha: 0.85 });
            }
            if (open <= 0 || mask === 0) {
                continue;
            }
            const wide = 1 + near * 0.28;
            for (let j = 0; j < 5; j++) {
                if (!(mask & (1 << j))) {
                    continue;
                }
                let p = clamp((open - j * 0.11) / 0.5, 0, 1);
                if (plant.regrowMask[i] & (1 << j)) {
                    p *= plant.regrow[i];
                }
                if (p <= 0) {
                    continue;
                }
                const a = node.turn + (j * Math.PI * 2) / 5 + shiver * 0.5;
                const len = radius * p * wide;
                lens(g, cx + Math.cos(a) * 0.2, cy + Math.sin(a) * 0.2, a, len, len * 0.95);
                g.fill({ color: j & 1 ? petal : mixColor(petal, theme.bgBottom, 0.12), alpha: 0.9 });
            }
            g.circle(cx, cy, 0.5 + 0.3 * open).fill({ color: mixColor(theme.ink, theme.bgBottom, 0.2), alpha: 0.9 });
        }

        // The growing tip: small and bright, only while the stem moves forward.
        if (tipX >= 0 && plant.tip > 0.05) {
            g.circle(tipX, tipY, 0.9).fill({ color: mixColor(theme.accent, theme.ink, 0.55), alpha: plant.tip });
        }
    }
}

function petalColor(theme: Theme): number {
    return mixColor(mixColor(theme.accentAlt, theme.ink, 0.3), theme.bgBottom, 0.3);
}

/** A pointed lens shape from (x, y) along `angle`: length `len`, widest `width / 2` each side. Not filled. */
function lens(g: Graphics, x: number, y: number, angle: number, len: number, width: number): void {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const tx = x + c * len;
    const ty = y + s * len;
    const mx = x + c * len * 0.45;
    const my = y + s * len * 0.45;
    // A quadratic control point twice as far out bulges the curve to `width / 2`.
    const nx = -s * width;
    const ny = c * width;
    g.moveTo(x, y).quadraticCurveTo(mx + nx, my + ny, tx, ty).quadraticCurveTo(mx - nx, my - ny, x, y);
}

/** 0..1 with a slight overshoot near the end. */
function backOut(t: number): number {
    const k = 1.9;
    const u = t - 1;
    return 1 + (k + 1) * u * u * u + k * u * u;
}
