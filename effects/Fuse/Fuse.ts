import { Container, Graphics } from 'pixi.js';
import { Effect } from '../../src/Effect';
import { approach, clamp, mixColor } from '../../src/math';
import type { EffectContext, Theme, TickContext, TimedContext, Vector3 } from '../../src/types';
import type { FuseContext } from '../contracts';
import { FieldLayer } from '../Field/FieldLayer';
import { FieldSet, type Field } from '../Field/FieldSet';
import { Border, makeBorderPoint, type BorderPoint } from './border';

export interface FuseOptions {
    /** How fast the spark runs, in px/ms. Short borders run a little slower and long ones faster, so a lap takes about two seconds. Default `SPEED` (0.12). */
    speed?: number;
    /** Whether the spark sheds embers that fall into the page. Default true. */
    embers?: boolean;
    /** Half-life of the glow the spark leaves on the border, in seconds. Default `TRAIL_SECONDS` (0.8). */
    trail?: number;
}

/** One spark running round a border. */
interface Spark {
    /** Distance along the border, in pixels. */
    d: number;
    /** Where it is, in the element's own pixels, and which way is out. */
    x: number;
    y: number;
    nx: number;
    ny: number;
    /** Brightness this tick, 0..1, with its flicker. */
    glow: number;
    /** Heat cell it was last in. */
    cell: number;
    /** Milliseconds until the next ember. */
    nextEmber: number;
}

/** What the effect keeps for one element. */
interface Fire {
    border: Border;
    width: number;
    height: number;
    radius: number;
    /** Heat per cell along the border, 0..1; cell `i` sits at `(i + 0.5) * cellLength`. */
    heat: Float32Array;
    /** Where each cell is and which way the border runs there, so drawing needs no trigonometry. */
    cellX: Float32Array;
    cellY: Float32Array;
    cellTX: Float32Array;
    cellTY: Float32Array;
    cells: number;
    cellLength: number;
    sparks: [Spark, Spark];
    /** +1 clockwise, -1 after a press turned it round. */
    direction: number;
    /** 0..1 eased `busy`: the second spark and the double speed. */
    busy: number;
    /** A strike lights it up for a moment: 1 falling to 0. */
    flare: number;
    /** Whether anything is warm, so a cold border costs nothing. */
    warm: boolean;
    time: number;
}

const CELL = 3.5;
/** Embers, across all elements, at a full budget. */
const MAX_EMBERS = 240;
const GRAVITY = 0.0004;

/**
 * A spark that runs round the border of an input. The border is a fuse: the spark leaves a line
 * that glows and slowly cools behind it, and it sheds embers that fall out of the element and
 * are carried off by the scene's wind.
 *
 * Any element tagged `fuse` is lit while it is on or focused (a button or text field that has
 * neither word is always lit). While it is `busy` a second spark runs half a lap behind, and both
 * go twice as fast: a loading indicator made of fire. Turned off, the spark keeps running for a
 * moment while it shrinks and goes out, and the trace cools to dark. The element's state comes
 * from its tags (`on`, `off`, `focus`, `busy`, `knob`, `r:10`).
 *
 *     <span class="track" data-fx-anchor="power" data-fx-tags="fuse knob"></span>
 *
 * What it listens to:
 *   - elements tagged `fuse`: turning on lights the spark where the pointer is (or at the
 *     start) with a burst of embers; the pointer over it speeds the spark and sheds more embers;
 *     a press makes a burst and turns the spark round.
 *   - the force field: every ember is carried by it (wind blows the trail sideways, a shock ring
 *     scatters it).
 *   - `lightning:strike`: every lit fuse flares and throws a few embers.
 * It tells the others how many elements it is drawing in, how many are lit and how many embers
 * are in the air; it adds no forces and sends no events. It has no keys.
 */
export class Fuse extends Effect<FuseContext> {
    public effectName = 'fuse';

    public static readonly SPEED = 0.12;
    public static readonly TRAIL_SECONDS = 0.8;
    /** Where the path runs, in pixels in from the element's edge. */
    private static readonly INSET = 2.5;

    private readonly speed: number;
    private readonly shed: boolean;
    private readonly trail: number;
    private readonly fires: FieldSet<Fire>;
    private readonly context: FuseContext = { fields: 0, active: 0, embers: 0 };
    private layer: FieldLayer | undefined;
    private emberLayer: Graphics | undefined;
    private emberRoot: Container | undefined;

    // Embers, structure of arrays, stage pixels and milliseconds.
    private readonly ex = new Float32Array(MAX_EMBERS);
    private readonly ey = new Float32Array(MAX_EMBERS);
    private readonly evx = new Float32Array(MAX_EMBERS);
    private readonly evy = new Float32Array(MAX_EMBERS);
    private readonly eage = new Float32Array(MAX_EMBERS);
    private readonly elife = new Float32Array(MAX_EMBERS);
    private readonly esize = new Float32Array(MAX_EMBERS);
    private count = 0;
    private cap = MAX_EMBERS;

    private readonly point: BorderPoint = makeBorderPoint();
    private readonly force: Vector3 = { x: 0, y: 0 };

    constructor(options: FuseOptions = {}) {
        super();
        this.speed = clamp(options.speed ?? Fuse.SPEED, 0, 2);
        this.shed = options.embers ?? true;
        this.trail = clamp(options.trail ?? Fuse.TRAIL_SECONDS, 0.05, 20);
        this.fires = new FieldSet<Fire>('fuse', (field) => this.light(field));
    }

    public initialize(): void {
        this.layer = new FieldLayer(this.host.pixi);
        this.emberRoot = new Container();
        this.emberRoot.label = 'fuse-embers';
        this.emberLayer = new Graphics();
        this.emberRoot.addChild(this.emberLayer);
        this.host.pixi.addChild(this.emberRoot);
    }

    public onTick(tick: TickContext): EffectContext<FuseContext> {
        this.fires.update(tick);
        const dt = Math.min(tick.timeDelta, 100);
        this.cap = Math.floor(MAX_EMBERS * clamp(tick.budget.budget, 0.1, 1));
        const struck = tick.events('lightning:strike').length > 0;
        const decay = Math.pow(0.5, dt / (this.trail * 1000));

        let active = 0;
        for (const field of this.fires.fields) {
            const fire = field.data;
            this.fit(fire, field);
            fire.time = tick.time;
            if (field.active) {
                active++;
            }
            this.cool(fire, decay);
            fire.busy = approach(fire.busy, field.words.busy && field.active ? 1 : 0, 6, dt);
            fire.flare = Math.max(0, fire.flare - dt / 400);

            const [first, second] = fire.sparks;
            if (field.turnedOn) {
                this.ignite(field, fire);
            }
            if (field.presence < 0.02) {
                continue;
            }
            if (struck && field.active) {
                fire.flare = 1;
                this.burst(field, first, 4 + Math.floor(Math.random() * 3), 0.05);
            }
            if (field.pressed) {
                this.pressBurst(field);
                if (field.active && !field.turnedOn) {
                    fire.direction = -fire.direction;
                }
            }

            const length = fire.border.length;
            if (!(length > 0)) {
                continue;
            }
            const pace = this.speed * clamp(length / 300, 0.8, 1.8) * (1 + fire.busy) * (field.hover ? 1.3 : 1);
            const step = pace * dt * fire.direction;
            const twoSparks = fire.busy > 0.05;
            this.advance(fire, first, step, tick.time, field.presence, 0);
            if (twoSparks) {
                this.advance(fire, second, step, tick.time + 91, field.presence * fire.busy, 1);
            } else {
                second.d = first.d - fire.direction * length * 0.5;
                second.cell = -1;
            }
            this.shedEmbers(field, fire, first, dt, pace, field.presence);
            if (twoSparks && fire.busy > 0.5) {
                this.shedEmbers(field, fire, second, dt, pace, field.presence * fire.busy);
            }
        }

        this.fall(tick, dt);
        this.context.fields = this.fires.fields.length;
        this.context.active = active;
        this.context.embers = this.count;
        return this.publish(this.context);
    }

    public onRender(timed: TimedContext): void {
        const layer = this.layer;
        if (!layer) {
            return;
        }
        const theme = timed.theme;
        for (const field of this.fires.fields) {
            const fire = field.data;
            const g = layer.draw(field);
            if (fire.warm || field.presence > 0.02) {
                this.drawTrace(g, fire, theme);
            }
            if (field.presence > 0.02) {
                this.drawSpark(g, fire, fire.sparks[0], field.presence, theme);
                if (fire.busy > 0.05) {
                    this.drawSpark(g, fire, fire.sparks[1], field.presence * fire.busy, theme);
                }
            }
        }
        layer.sweep();
        this.drawEmbers(theme);
    }

    public cleanup(): void {
        this.fires.clear();
        this.layer?.destroy();
        this.layer = undefined;
        this.emberRoot?.destroy({ children: true });
        this.emberRoot = undefined;
        this.emberLayer = undefined;
        this.count = 0;
    }

    // ---- the fire on one element ---------------------------------------------------------

    private light(field: Field<Fire>): Fire {
        const spark = (): Spark => ({ d: 0, x: 0, y: 0, nx: 0, ny: -1, glow: 1, cell: -1, nextEmber: 40 + Math.random() * 50 });
        const fire: Fire = {
            border: new Border(),
            width: -1,
            height: -1,
            radius: -1,
            heat: new Float32Array(0),
            cellX: new Float32Array(0),
            cellY: new Float32Array(0),
            cellTX: new Float32Array(0),
            cellTY: new Float32Array(0),
            cells: 0,
            cellLength: CELL,
            sparks: [spark(), spark()],
            direction: 1,
            busy: field.words.busy ? 1 : 0,
            flare: 0,
            warm: false,
            time: 0,
        };
        this.fit(fire, field);
        // Elements that begin lit do not all begin at the same place.
        fire.sparks[0].d = Math.random() * fire.border.length;
        return fire;
    }

    /** Re-shape the border and the heat cells when the element changed size. */
    private fit(fire: Fire, field: Field<Fire>): void {
        if (Math.abs(fire.width - field.width) < 0.5 && Math.abs(fire.height - field.height) < 0.5 && Math.abs(fire.radius - field.radius) < 0.5) {
            return;
        }
        fire.width = field.width;
        fire.height = field.height;
        fire.radius = field.radius;
        const border = fire.border;
        border.set(field.width, field.height, field.radius, Fuse.INSET);
        const cells = Math.max(1, Math.ceil(border.length / CELL));
        fire.cells = cells;
        fire.cellLength = border.length / cells;
        fire.heat = new Float32Array(cells);
        fire.cellX = new Float32Array(cells);
        fire.cellY = new Float32Array(cells);
        fire.cellTX = new Float32Array(cells);
        fire.cellTY = new Float32Array(cells);
        for (let i = 0; i < cells; i++) {
            border.pointAt((i + 0.5) * fire.cellLength, this.point);
            fire.cellX[i] = this.point.x;
            fire.cellY[i] = this.point.y;
            fire.cellTX[i] = this.point.tx;
            fire.cellTY[i] = this.point.ty;
        }
        fire.warm = false;
        for (const spark of fire.sparks) {
            spark.cell = -1;
        }
    }

    private cool(fire: Fire, decay: number): void {
        if (!fire.warm) {
            return;
        }
        const heat = fire.heat;
        let warm = false;
        for (let i = 0; i < fire.cells; i++) {
            const h = heat[i] * decay;
            if (h < 0.04) {
                heat[i] = 0;
            } else {
                heat[i] = h;
                warm = true;
            }
        }
        fire.warm = warm;
    }

    /** Light the spark: where the pointer is if it is over the element, else at the start. */
    private ignite(field: Field<Fire>, fire: Fire): void {
        const border = fire.border;
        const first = fire.sparks[0];
        fire.direction = 1;
        first.d = field.hover && field.pointerKnown ? border.nearest(field.pointerX, field.pointerY, 2, this.point) : 0;
        first.cell = -1;
        fire.sparks[1].cell = -1;
        border.pointAt(first.d, this.point);
        first.x = this.point.x;
        first.y = this.point.y;
        first.nx = this.point.nx;
        first.ny = this.point.ny;
        this.burst(field, first, 6 + Math.floor(Math.random() * 5), 0.06);
        fire.flare = Math.max(fire.flare, 0.6);
    }

    /** Move one spark, set the cells it crosses and note where it is. */
    private advance(fire: Fire, spark: Spark, step: number, time: number, strength: number, index: number): void {
        const length = fire.border.length;
        spark.d = (((spark.d + step) % length) + length) % length;
        const point = fire.border.pointAt(spark.d, this.point);
        spark.x = point.x;
        spark.y = point.y;
        spark.nx = point.nx;
        spark.ny = point.ny;
        spark.glow = clamp(0.85 + 0.15 * Math.sin(time * 0.045 + index * 2) * Math.sin(time * 0.0173 + 1), 0, 1) * strength;

        // Every cell between where it was and where it is takes full heat.
        const cell = Math.min(fire.cells - 1, Math.floor(spark.d / fire.cellLength));
        const heat = fire.heat;
        const value = Math.min(1, 0.6 + spark.glow * 0.4) * Math.min(1, strength * 1.5);
        if (spark.cell < 0) {
            spark.cell = cell;
        }
        let at = spark.cell;
        const walk = step >= 0 ? 1 : -1;
        let guard = fire.cells;
        while (at !== cell && guard-- > 0) {
            heat[at] = Math.max(heat[at], value);
            at = (at + walk + fire.cells) % fire.cells;
        }
        heat[cell] = Math.max(heat[cell], value);
        spark.cell = cell;
        fire.warm = true;
    }

    private shedEmbers(field: Field<Fire>, fire: Fire, spark: Spark, dt: number, pace: number, strength: number): void {
        if (!this.shed || strength < 0.15) {
            return;
        }
        spark.nextEmber -= dt * (field.hover ? 1.8 : 1);
        let guard = 3;
        while (spark.nextEmber <= 0 && guard-- > 0) {
            spark.nextEmber += 40 + Math.random() * 50;
            this.addEmber(
                field.x + spark.x,
                field.y + spark.y,
                spark.nx * (0.015 + Math.random() * 0.035) + -spark.ny * pace * 0.35 * fire.direction + (Math.random() - 0.5) * 0.02,
                spark.ny * (0.015 + Math.random() * 0.035) + spark.nx * pace * 0.35 * fire.direction + (Math.random() - 0.5) * 0.02 - 0.01,
            );
        }
    }

    /** `count` embers thrown out from a spark in every outward direction. */
    private burst(field: Field<Fire>, spark: Spark, count: number, speed: number): void {
        if (!this.shed) {
            return;
        }
        for (let i = 0; i < count; i++) {
            const angle = Math.atan2(spark.ny, spark.nx) + (Math.random() - 0.5) * 2.6;
            const v = speed * (0.4 + Math.random() * 0.8);
            this.addEmber(field.x + spark.x, field.y + spark.y, Math.cos(angle) * v, Math.sin(angle) * v - 0.02);
        }
    }

    /** A press: a ring of embers from the pointer. */
    private pressBurst(field: Field<Fire>): void {
        if (!this.shed || !field.pointerKnown) {
            return;
        }
        const count = 6 + Math.floor(Math.random() * 5);
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const v = 0.03 + Math.random() * 0.06;
            this.addEmber(field.x + field.pointerX, field.y + field.pointerY, Math.cos(angle) * v, Math.sin(angle) * v - 0.03);
        }
    }

    // ---- embers --------------------------------------------------------------------------

    private addEmber(x: number, y: number, vx: number, vy: number): void {
        if (this.count >= this.cap) {
            return;
        }
        const i = this.count++;
        this.ex[i] = x;
        this.ey[i] = y;
        this.evx[i] = vx;
        this.evy[i] = vy;
        this.eage[i] = 0;
        this.elife[i] = 500 + Math.random() * 400;
        this.esize[i] = 1 + Math.random() * 0.5;
    }

    /** Move every ember: gravity, the scene's forces, cooling. */
    private fall(tick: TickContext, dt: number): void {
        const force = this.force;
        let i = 0;
        while (i < this.count) {
            this.eage[i] += dt;
            if (this.eage[i] >= this.elife[i] || this.ey[i] > tick.canvasDimensions.y + 40) {
                const last = --this.count;
                this.ex[i] = this.ex[last];
                this.ey[i] = this.ey[last];
                this.evx[i] = this.evx[last];
                this.evy[i] = this.evy[last];
                this.eage[i] = this.eage[last];
                this.elife[i] = this.elife[last];
                this.esize[i] = this.esize[last];
                continue;
            }
            tick.forces.sample(this.ex[i], this.ey[i], force, this.effectName);
            this.evx[i] += force.x * dt;
            this.evy[i] += (force.y + GRAVITY) * dt;
            const drag = Math.exp(-dt * 0.0012);
            this.evx[i] *= drag;
            this.evy[i] *= drag;
            this.ex[i] += this.evx[i] * dt;
            this.ey[i] += this.evy[i] * dt;
            i++;
        }
        // A tighter budget thins the air: let the surplus go out early.
        while (this.count > this.cap) {
            this.eage[this.count - 1] = this.elife[this.count - 1];
            this.count--;
        }
    }

    // ---- drawing -------------------------------------------------------------------------

    private drawTrace(g: Graphics, fire: Fire, theme: Theme): void {
        const heat = fire.heat;
        const half = fire.cellLength * 0.5;
        const flare = fire.flare;
        for (let i = 0; i < fire.cells; i++) {
            const h = heat[i];
            if (h <= 0) {
                continue;
            }
            const color = h > 0.62 ? mixColor(theme.accent, theme.ink, (h - 0.62) / 0.38) : mixColor(theme.accentAlt, theme.accent, h / 0.62);
            const x = fire.cellX[i];
            const y = fire.cellY[i];
            const tx = fire.cellTX[i] * half;
            const ty = fire.cellTY[i] * half;
            g.moveTo(x - tx, y - ty)
                .lineTo(x + tx, y + ty)
                .stroke({ width: 1.5, color, alpha: Math.min(1, (0.12 + 0.8 * h) * (1 + flare * 0.3)), cap: 'butt' });
        }
    }

    private drawSpark(g: Graphics, fire: Fire, spark: Spark, strength: number, theme: Theme): void {
        const size = clamp(strength, 0, 1);
        const t = fire.time;
        const boost = 1 + fire.flare * 0.5;
        // Two or three tiny rays that jitter: mostly trailing back and in, away from the edge.
        const base = Math.atan2(-spark.ny, -spark.nx);
        for (let i = 0; i < 3; i++) {
            const angle = base + Math.sin(t * 0.031 + i * 2.3) * 1.1 + (i - 1) * 0.5;
            const len = (2 + 2.5 * (0.5 + 0.5 * Math.sin(t * 0.053 + i * 5.1))) * size * boost;
            g.moveTo(spark.x, spark.y)
                .lineTo(spark.x + Math.cos(angle) * len, spark.y + Math.sin(angle) * len)
                .stroke({ width: 1, color: theme.ink, alpha: 0.7 * spark.glow, cap: 'butt' });
        }
        g.circle(spark.x, spark.y, (1.2 + 0.2 * spark.glow) * (0.5 + 0.5 * size) * boost).fill({ color: theme.ink, alpha: Math.min(1, 0.5 + 0.5 * spark.glow) });
    }

    private drawEmbers(theme: Theme): void {
        const g = this.emberLayer;
        if (!g) {
            return;
        }
        g.clear();
        for (let i = 0; i < this.count; i++) {
            const t = this.eage[i] / this.elife[i];
            const size = this.esize[i] * (1 - 0.55 * t);
            g.rect(this.ex[i] - size / 2, this.ey[i] - size / 2, size, size).fill({ color: mixColor(theme.ink, theme.accentAlt, Math.min(1, t * 1.3)), alpha: 1 - t * t });
        }
    }
}
