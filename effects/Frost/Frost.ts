import { Graphics } from 'pixi.js';
import { Effect } from '../../src/Effect';
import { approach, clamp, mixColor, smoothstep } from '../../src/math';
import type { EffectContext, TickContext, TimedContext, Vector3 } from '../../src/types';
import type { FrostContext } from '../contracts';
import { FieldLayer } from '../Field/FieldLayer';
import { FieldSet, type Field } from '../Field/FieldSet';
import { MAX_SEGMENTS, bottomAt, growDendrites, iceSeed, seededRandom, type Dendrites } from './dendrites';

export interface FrostOptions {
    /** Seconds an element takes to frost over completely. Default `FREEZE_SECONDS` (2.5). */
    freezeSeconds?: number;
    /** Seconds the ice takes to clear when the element comes on. Default `THAW_SECONDS` (0.9). */
    thawSeconds?: number;
    /** Meltwater runs down the inside, hangs on the bottom edge and falls into the page. Default true. */
    drips?: boolean;
    /** Also frost elements with no on/off state (buttons, text fields) while they do not have the focus. Default false. */
    idle?: boolean;
}

/** What the effect keeps for one element. */
interface Ice {
    shape: Dendrites;
    radius: number;
    /** 0 clear .. 1 frosted over. */
    coverage: number;
    /** 0..1: how much the thaw runs from the knob's end (a switch being turned on). */
    tilt: number;
    /** Warmth left by the pointer, on a grid of CELL px. Ice hides where it is above 0.5. */
    heat: Float32Array;
    columns: number;
    rows: number;
    warm: boolean;
    /** Meltwater waiting to become drops: from the thawing front, and from the pointer's hole. */
    water: number;
    holeWater: number;
    /** The element has an on/off state (a switch), as opposed to a button or a text field. */
    switched: boolean;
}

/** Heat grid cell, px. */
const CELL = 4;
const MAX_DROPS = 60;
/** Drop states. */
const BEAD = 0;
const RUN = 1;
const HANG = 2;
const FALL = 3;

/**
 * Frost: an input that is off, or disabled, freezes over. Fern-like ice crystals creep in from
 * its edges until the whole thing is frosted; switch it on, focus it, or rest the pointer on it,
 * and the ice retreats from the warmth, beads into droplets, and the droplets run down and drip
 * off the bottom edge into the page. It gives the dullest state an input has the most to look at.
 *
 * It is the other way round from most input effects: it shows while the element is NOT active.
 * A switch frosts while it is `off` (or `disabled`) and clears while `on` or focused. An element
 * with no on/off state (a button, a text field) stays clear unless `disabled`, or, with `idle`,
 * while it does not have the focus.
 *
 *     <span class="track" data-fx-anchor="wifi" data-fx-tags="frost knob"></span>
 *
 * What it listens to:
 *   - elements tagged `frost` and their state words (`on`, `off`, `focus`, `disabled`, `knob`, `r:`).
 *   - the pointer over them: it melts a hole around itself that creeps closed again once it
 *     leaves; a press cracks a wider patch clear for a moment.
 *   - the force field: falling drops are bent by wind and flicked by shock rings.
 * It tells the others how many elements it is in, how many of those are active, and how many are
 * frosted over (`frozen`). No forces, no events. It has no keys.
 */
export class Frost extends Effect<FrostContext> {
    public effectName = 'frost';

    public static readonly FREEZE_SECONDS = 2.5;
    public static readonly THAW_SECONDS = 0.9;
    /** How fast the pointer's hole closes again, heat per second. */
    private static readonly REGROW = 0.6;
    /** Gravity on a falling drop, px/ms², and the drag that gives it a terminal speed, per ms. */
    private static readonly GRAVITY = 0.0007;
    private static readonly DRAG = 0.002;

    private readonly freezeMs: number;
    private readonly thawMs: number;
    private readonly drips: boolean;
    private readonly idle: boolean;
    private readonly elements = new FieldSet<Ice>('frost', (field) => this.freeze(field), (field) => this.release(field));
    private readonly context: FrostContext = { fields: 0, active: 0, frozen: 0 };
    private layer: FieldLayer | undefined;
    private water: Graphics | undefined;
    private readonly force: Vector3 = { x: 0, y: 0, z: 0 };

    // Drops, structure of arrays. Inside the element (BEAD, RUN, HANG) x/y are the element's own
    // pixels and `owner` is its field; once FALLing they are stage pixels.
    private drops = 0;
    private readonly dx = new Float32Array(MAX_DROPS);
    private readonly dy = new Float32Array(MAX_DROPS);
    private readonly dvx = new Float32Array(MAX_DROPS);
    private readonly dvy = new Float32Array(MAX_DROPS);
    private readonly dsize = new Float32Array(MAX_DROPS);
    private readonly dtime = new Float32Array(MAX_DROPS);
    private readonly dhold = new Float32Array(MAX_DROPS);
    private readonly dtravel = new Float32Array(MAX_DROPS);
    private readonly dfade = new Float32Array(MAX_DROPS);
    private readonly dphase = new Float32Array(MAX_DROPS);
    private readonly dstate = new Uint8Array(MAX_DROPS);
    private readonly downer: (Field<Ice> | undefined)[] = new Array(MAX_DROPS).fill(undefined);

    // Per-frame scratch: the visible part of each segment, as fractions along it.
    private readonly from = new Float32Array(MAX_SEGMENTS);
    private readonly to = new Float32Array(MAX_SEGMENTS);

    constructor(options: FrostOptions = {}) {
        super();
        this.freezeMs = clamp(options.freezeSeconds ?? Frost.FREEZE_SECONDS, 0.05, 60) * 1000;
        this.thawMs = clamp(options.thawSeconds ?? Frost.THAW_SECONDS, 0.05, 60) * 1000;
        this.drips = options.drips ?? true;
        this.idle = options.idle ?? false;
    }

    public initialize(): void {
        this.layer = new FieldLayer(this.host.pixi);
        this.water = new Graphics();
        this.water.label = 'frost drops';
        this.host.pixi.addChild(this.water);
    }

    public onTick(tick: TickContext): EffectContext<FrostContext> {
        this.elements.update(tick);
        const dt = tick.timeDelta;
        const cap = Math.max(4, Math.round(MAX_DROPS * clamp(tick.budget.budget, 0, 1)));

        let active = 0;
        let frozen = 0;
        for (const field of this.elements.fields) {
            let ice = field.data;
            if (Math.abs(ice.shape.width - field.width) > 0.5 || Math.abs(ice.shape.height - field.height) > 0.5 || Math.abs(ice.radius - field.radius) > 0.5) {
                const coverage = ice.coverage;
                ice = field.data = this.freeze(field);
                ice.coverage = coverage;
            }
            const words = field.words;
            ice.switched = words.on || words.off;
            const cold = ice.switched ? !field.active : words.disabled || (this.idle && !words.focus);
            const target = cold ? 1 : 0;
            const before = ice.coverage;
            ice.coverage = target > before ? Math.min(target, before + dt / this.freezeMs) : Math.max(target, before - dt / this.thawMs);
            // A switch being turned on clears from the end its knob slides to.
            ice.tilt = approach(ice.tilt, words.knob && target < before ? 1 : 0, words.knob && target < before ? 12 : 4, dt);

            this.warm(ice, field, dt);
            if (this.drips && before > ice.coverage) {
                ice.water += (before - ice.coverage) * clamp(ice.shape.count / 22, 3, 14);
            }
            while (this.drips && ice.water >= 1 && this.drops < cap) {
                ice.water -= 1;
                this.spawnFromFront(field);
            }
            while (this.drips && ice.holeWater >= 1 && this.drops < cap) {
                ice.holeWater -= 1;
                this.spawnFromHole(field);
            }
            ice.water = Math.min(ice.water, 3);
            ice.holeWater = Math.min(ice.holeWater, 3);

            if (field.active) active++;
            if (ice.coverage > 0.9) frozen++;
        }

        this.moveDrops(tick, dt);

        this.context.fields = this.elements.fields.length;
        this.context.active = active;
        this.context.frozen = frozen;
        return this.publish(this.context);
    }

    public onRender(timed: TimedContext): void {
        const layer = this.layer;
        const water = this.water;
        if (!layer || !water) {
            return;
        }
        const theme = timed.theme;
        const ice = mixColor(theme.ink, theme.accent, 0.25);
        const stemColor = mixColor(theme.ink, theme.accent, 0.2);
        const glaze = mixColor(theme.bgTop, ice, 0.3);
        const glint = mixColor(theme.ink, 0xffffff, 0.3);

        for (const field of this.elements.fields) {
            const g = layer.draw(field);
            const frost = field.data;
            const c = frost.coverage;
            if (c < 0.002) {
                continue;
            }
            const shape = frost.shape;
            const w = field.width;
            const h = field.height;

            // The glaze: a faint flat tint where the ice is thick. Lighter over text.
            const tint = smoothstep(0.45, 1, c) * (frost.switched ? 0.16 : 0.06);
            if (tint > 0.004) {
                g.rect(0, 0, w, h).fill({ color: glaze, alpha: tint });
            }

            // Which part of every segment shows: below the coverage (the growing tip partly),
            // and outside the pointer's warm hole.
            const tilt = frost.tilt * 0.4;
            const from = this.from;
            const to = this.to;
            for (let i = 0; i < shape.count; i++) {
                const x1 = shape.x1[i];
                const y1 = shape.y1[i];
                const x2 = shape.x2[i];
                const y2 = shape.y2[i];
                const edge = c * (1 + tilt) - tilt * (x1 / w);
                const r0 = shape.reach0[i];
                const r1 = shape.reach1[i];
                from[i] = 0;
                to[i] = 0;
                if (edge <= r0) {
                    continue;
                }
                let end = r1 > r0 ? Math.min(1, (edge - r0) / (r1 - r0)) : 1;
                let start = 0;
                if (frost.warm) {
                    const h1 = this.heatAt(frost, x1, y1);
                    const h2 = this.heatAt(frost, x2, y2);
                    if (h1 >= 0.5 && h2 >= 0.5) {
                        continue;
                    }
                    if (h1 < 0.5 && h2 >= 0.5) {
                        end = Math.min(end, (0.5 - h1) / (h2 - h1));
                    } else if (h1 >= 0.5 && h2 < 0.5) {
                        start = (h1 - 0.5) / (h1 - h2);
                    }
                }
                if (end - start > 0.02) {
                    from[i] = start;
                    to[i] = end;
                }
            }

            // Stems brightest, twigs faintest; over the middle band of a text field or a button
            // (where its words are) every line is fainter.
            for (let level = 0; level < 3; level++) {
                for (let band = 0; band < 2; band++) {
                    if (band === 1 && frost.switched) {
                        continue;
                    }
                    let any = false;
                    for (let i = 0; i < shape.count; i++) {
                        if (shape.level[i] !== level || to[i] <= from[i]) {
                            continue;
                        }
                        const x1 = shape.x1[i];
                        const y1 = shape.y1[i];
                        const ex = shape.x2[i] - x1;
                        const ey = shape.y2[i] - y1;
                        if (!frost.switched) {
                            const my = y1 + ey * 0.5;
                            const middle = my > h * 0.27 && my < h * 0.73 ? 1 : 0;
                            if (middle !== band) {
                                continue;
                            }
                        }
                        g.moveTo(x1 + ex * from[i], y1 + ey * from[i]).lineTo(x1 + ex * to[i], y1 + ey * to[i]);
                        any = true;
                    }
                    if (any) {
                        const alpha = (level === 0 ? 0.8 : level === 1 ? 0.66 : 0.52) * (band === 1 ? 0.55 : 1);
                        g.stroke({ width: 1, color: level === 0 ? stemColor : ice, alpha });
                    }
                }
            }

            // Glints in the ice, twinkling slowly.
            for (let i = 0; i < shape.sparkles; i++) {
                const reach = shape.sreach[i];
                const x = shape.sx[i];
                const y = shape.sy[i];
                const shown = smoothstep(reach, reach + 0.12, c * (1 + tilt) - tilt * (x / w));
                if (shown <= 0.01 || (frost.warm && this.heatAt(frost, x, y) >= 0.5)) {
                    continue;
                }
                const twinkle = Math.pow(Math.max(0, Math.sin(timed.time * 0.0011 + shape.sphase[i])), 6);
                g.rect(Math.floor(x), Math.floor(y), 1, 1).fill({ color: glint, alpha: shown * (0.25 + 0.65 * twinkle) });
            }
        }
        layer.sweep();

        // Meltwater: tiny bright beads; falling ones with a short tail.
        water.clear();
        const bead = mixColor(theme.ink, theme.accent, 0.15);
        for (let i = 0; i < this.drops; i++) {
            const owner = this.downer[i];
            let x = this.dx[i];
            let y = this.dy[i];
            let alpha = 0.9;
            if (owner) {
                x += owner.x;
                y += owner.y;
            } else {
                alpha *= 1 - smoothstep(this.dfade[i] * 0.55, this.dfade[i], this.dtravel[i]);
                const vx = this.dvx[i];
                const vy = this.dvy[i];
                const speed = Math.hypot(vx, vy);
                if (speed > 0.02) {
                    const tail = Math.min(7, speed * 24) / speed;
                    water.moveTo(x - vx * tail, y - vy * tail).lineTo(x, y).stroke({ width: 1, color: bead, alpha: alpha * 0.4 });
                }
            }
            if (alpha > 0.01) {
                water.circle(x, y, this.dsize[i]).fill({ color: bead, alpha });
            }
        }
    }

    public cleanup(): void {
        this.elements.clear();
        this.layer?.destroy();
        this.layer = undefined;
        this.water?.destroy();
        this.water = undefined;
        this.drops = 0;
        this.downer.fill(undefined);
    }

    /** The ice for an element, grown from its name and size; it starts clear. */
    private freeze(field: Field<Ice>): Ice {
        const width = Math.max(0, field.width);
        const height = Math.max(0, field.height);
        const columns = Math.max(1, Math.ceil(width / CELL) + 1);
        const rows = Math.max(1, Math.ceil(height / CELL) + 1);
        return {
            shape: growDendrites(width, height, field.radius, seededRandom(iceSeed(field.name, width, height))),
            radius: field.radius,
            coverage: 0,
            tilt: 0,
            heat: new Float32Array(columns * rows),
            columns,
            rows,
            warm: false,
            water: 0,
            holeWater: 0,
            switched: field.words.on || field.words.off,
        };
    }

    /** An element went away: the water still inside it goes with it. */
    private release(field: Field<Ice>): void {
        for (let i = this.drops - 1; i >= 0; i--) {
            if (this.downer[i] === field) {
                this.removeDrop(i);
            }
        }
    }

    /** The pointer's warmth: a hole around it while it is over the element, wider for a press, closing again slowly. */
    private warm(ice: Ice, field: Field<Ice>, dt: number): void {
        const heat = ice.heat;
        if (ice.warm) {
            const fall = (Frost.REGROW * dt) / 1000;
            let any = false;
            for (let i = 0; i < heat.length; i++) {
                if (heat[i] > 0) {
                    heat[i] = Math.max(0, heat[i] - fall);
                    any = true;
                }
            }
            ice.warm = any;
        }
        if (!field.hover || !field.pointerKnown) {
            return;
        }
        const reach = clamp(Math.min(field.width, field.height) * 0.75, 16, 26);
        let melted = this.heatUp(ice, field.pointerX, field.pointerY, reach, 2);
        if (field.pressed) {
            melted += this.heatUp(ice, field.pointerX, field.pointerY, reach * 1.8, 2.2);
        }
        if (ice.coverage > 0.4) {
            ice.holeWater += melted * 0.03 * ice.coverage;
        }
    }

    /** Raise the heat around (px, py) toward `peak` at the centre, 0 at `radius`. Returns the cells that just melted. */
    private heatUp(ice: Ice, px: number, py: number, radius: number, peak: number): number {
        const heat = ice.heat;
        const c0 = Math.max(0, Math.floor((px - radius) / CELL));
        const c1 = Math.min(ice.columns - 1, Math.ceil((px + radius) / CELL));
        const r0 = Math.max(0, Math.floor((py - radius) / CELL));
        const r1 = Math.min(ice.rows - 1, Math.ceil((py + radius) / CELL));
        let melted = 0;
        for (let row = r0; row <= r1; row++) {
            for (let col = c0; col <= c1; col++) {
                const d = Math.hypot(col * CELL - px, row * CELL - py);
                if (d >= radius) {
                    continue;
                }
                const value = peak * (1 - d / radius);
                const k = row * ice.columns + col;
                if (value > heat[k]) {
                    if (heat[k] < 0.5 && value >= 0.5) {
                        melted++;
                    }
                    heat[k] = value;
                    ice.warm = true;
                }
            }
        }
        return melted;
    }

    /** Bilinear heat at a point in the element. */
    private heatAt(ice: Ice, x: number, y: number): number {
        const fx = clamp(x / CELL, 0, ice.columns - 1);
        const fy = clamp(y / CELL, 0, ice.rows - 1);
        const c = Math.min(ice.columns - 2, Math.floor(fx));
        const r = Math.min(ice.rows - 2, Math.floor(fy));
        if (c < 0 || r < 0) {
            return ice.heat[0] ?? 0;
        }
        const tx = fx - c;
        const ty = fy - r;
        const k = r * ice.columns + c;
        const heat = ice.heat;
        const top = heat[k] + (heat[k + 1] - heat[k]) * tx;
        const bottom = heat[k + ice.columns] + (heat[k + ice.columns + 1] - heat[k + ice.columns]) * tx;
        return top + (bottom - top) * ty;
    }

    /** A drop at the lower end of a branch that has just melted. */
    private spawnFromFront(field: Field<Ice>): void {
        const ice = field.data;
        const shape = ice.shape;
        if (shape.count === 0) {
            return;
        }
        const tilt = ice.tilt * 0.4;
        let best = -1;
        for (let tries = 0; tries < 12; tries++) {
            const i = Math.floor(Math.random() * shape.count);
            const edge = ice.coverage * (1 + tilt) - tilt * (shape.x1[i] / field.width);
            const r = shape.reach1[i];
            if (r >= edge && r < edge + 0.3) {
                best = i;
                break;
            }
            if (best < 0) best = i;
        }
        const low = shape.y2[best] > shape.y1[best];
        this.addDrop(field, low ? shape.x2[best] : shape.x1[best], low ? shape.y2[best] : shape.y1[best]);
    }

    /** A drop from the lower rim of the pointer's hole. */
    private spawnFromHole(field: Field<Ice>): void {
        const reach = clamp(Math.min(field.width, field.height) * 0.75, 16, 26) * 0.7;
        const a = Math.PI * (0.2 + Math.random() * 0.6);
        const x = clamp(field.pointerX + Math.cos(a) * reach, 2, field.width - 2);
        const y = clamp(field.pointerY + Math.sin(a) * reach, 2, field.height - 2);
        this.addDrop(field, x, y);
    }

    private addDrop(field: Field<Ice>, x: number, y: number): void {
        if (this.drops >= MAX_DROPS) {
            return;
        }
        const i = this.drops++;
        this.dx[i] = x;
        this.dy[i] = y;
        this.dvx[i] = 0;
        this.dvy[i] = 0.02 + Math.random() * 0.025;
        this.dsize[i] = 0.6;
        this.dtime[i] = 0;
        this.dhold[i] = 180 + Math.random() * 220;
        this.dtravel[i] = 0;
        this.dfade[i] = 120 + Math.random() * 80;
        this.dphase[i] = Math.random() * 6.28;
        this.dstate[i] = BEAD;
        this.downer[i] = field;
    }

    private removeDrop(i: number): void {
        const last = --this.drops;
        if (i !== last) {
            this.dx[i] = this.dx[last];
            this.dy[i] = this.dy[last];
            this.dvx[i] = this.dvx[last];
            this.dvy[i] = this.dvy[last];
            this.dsize[i] = this.dsize[last];
            this.dtime[i] = this.dtime[last];
            this.dhold[i] = this.dhold[last];
            this.dtravel[i] = this.dtravel[last];
            this.dfade[i] = this.dfade[last];
            this.dphase[i] = this.dphase[last];
            this.dstate[i] = this.dstate[last];
            this.downer[i] = this.downer[last];
        }
        this.downer[last] = undefined;
    }

    /** Bead, run down the inside, hang on the bottom edge, fall into the page. */
    private moveDrops(tick: TickContext, dt: number): void {
        const width = tick.stage.width;
        const height = tick.stage.height;
        for (let i = this.drops - 1; i >= 0; i--) {
            const state = this.dstate[i];
            const owner = this.downer[i];
            this.dtime[i] += dt;
            if (state === BEAD && owner) {
                this.dsize[i] = Math.min(1.1, this.dsize[i] + dt * 0.002);
                if (this.dtime[i] >= this.dhold[i]) {
                    this.dstate[i] = RUN;
                    this.dtime[i] = 0;
                }
            } else if (state === RUN && owner) {
                // Stick and slip: meltwater runs in starts.
                const slip = 0.35 + 0.65 * Math.abs(Math.sin(this.dtime[i] * 0.006 + this.dphase[i]));
                this.dy[i] += this.dvy[i] * slip * dt;
                this.dx[i] += Math.sin(this.dtime[i] * 0.004 + this.dphase[i]) * 0.004 * dt;
                const bottom = bottomAt(this.dx[i], owner.width, owner.height, owner.radius);
                if (this.dy[i] >= bottom - 1) {
                    this.dy[i] = bottom + 0.6;
                    this.dstate[i] = HANG;
                    this.dtime[i] = 0;
                    this.dhold[i] = 160 + Math.random() * 280;
                }
            } else if (state === HANG && owner) {
                this.dsize[i] = Math.min(1.5, this.dsize[i] + dt * 0.0015);
                this.dy[i] = bottomAt(this.dx[i], owner.width, owner.height, owner.radius) + 0.4 + this.dsize[i] * 0.5;
                if (this.dtime[i] >= this.dhold[i]) {
                    this.dstate[i] = FALL;
                    this.dx[i] += owner.x;
                    this.dy[i] += owner.y;
                    this.dvx[i] = 0;
                    this.dvy[i] = 0.01;
                    this.dsize[i] = 1.2;
                    this.downer[i] = undefined;
                }
            } else {
                // Falling (or orphaned): gravity plus whatever the scene pushes with.
                this.downer[i] = undefined;
                this.dstate[i] = FALL;
                const force = tick.forces.sample(this.dx[i], this.dy[i], this.force, this.effectName);
                const drag = Math.exp(-Frost.DRAG * dt);
                this.dvx[i] = (this.dvx[i] + force.x * dt) * drag;
                this.dvy[i] = (this.dvy[i] + (Frost.GRAVITY + force.y) * dt) * drag;
                const mx = this.dvx[i] * dt;
                const my = this.dvy[i] * dt;
                this.dx[i] += mx;
                this.dy[i] += my;
                this.dtravel[i] += Math.hypot(mx, my);
                if (this.dtravel[i] >= this.dfade[i] || this.dy[i] > height + 10 || this.dx[i] < -10 || this.dx[i] > width + 10) {
                    this.removeDrop(i);
                }
            }
        }
    }
}
