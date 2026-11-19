import { Graphics } from 'pixi.js';
import { Effect } from '../../src/Effect';
import { approach, clamp, mixColor } from '../../src/math';
import type { EffectContext, TickContext, TimedContext } from '../../src/types';
import type { ArcContext } from '../contracts';
import { Border, makeBorderPoint, type BorderPoint } from '../Field/border';
import { FieldSet, type Field } from '../Field/FieldSet';
import { jag } from './jag';

export interface ArcOptions {
    /** How close the pointer has to come, in px from the element's edge, for a bolt to reach it, 0..400. Default `REACH` (110). */
    reach?: number;
    /** Small arcs per second on an element that is fully on, 0..20. Default `RATE` (4). */
    rate?: number;
}

const ARCS = 6;
const BURST_MS = 280;
/** The crackle changes shape this often, in ms. */
const FLICKER_MS = 45;

interface Coil {
    border: Border;
    width: number;
    height: number;
    radius: number;
    /** Small arcs: where each leaves the edge and how far along it lands, its height, age and life. */
    from: Float32Array;
    span: Float32Array;
    bulge: Float32Array;
    age: Float32Array;
    life: Float32Array;
    seed: Float32Array;
    /** Fractions of an arc owed since the last one was struck. */
    owed: number;
    /** Age of the discharge in ms; at or past `BURST_MS` there is none. */
    burst: number;
    burstSeed: number;
    /** 0..1: a bolt is reaching for the pointer. */
    pull: number;
    /** Where on the edge that bolt starts. */
    pullAt: number;
    /** Simulation time of the last tick, for the flicker. */
    time: number;
}

/**
 * Electricity that leaves a page element: every element tagged `arc` is a charged thing. While
 * it is on, small arcs jump off its edge and land a little further along it; when the pointer
 * comes near, a bolt reaches out across the page to it; a press discharges it in every
 * direction. All of it is outside the element, drawn on the canvas behind the page, so it shows
 * where the page round the control is see-through.
 *
 * What it listens to: the element's state in its tags (off, it is dead; a slider's value is how
 * often it arcs), the pointer, presses, and `lightning:strike` in the scene, which discharges
 * every element that is on.
 * It tells the others how many arcs are in the air (its context). No events, no forces, no keys.
 */
export class Arc extends Effect<ArcContext> {
    public effectName = 'arc';

    public static readonly REACH = 110;
    public static readonly RATE = 4;

    private readonly reach: number;
    private readonly rate: number;
    private readonly coils: FieldSet<Coil>;
    private readonly context: ArcContext = { fields: 0, active: 0, arcs: 0 };
    private readonly point: BorderPoint = makeBorderPoint();
    private view: Graphics | undefined;

    constructor(options: ArcOptions = {}) {
        super();
        this.reach = clamp(options.reach ?? Arc.REACH, 0, 400);
        this.rate = clamp(options.rate ?? Arc.RATE, 0, 20);
        this.coils = new FieldSet<Coil>('arc', () => ({
            border: new Border(),
            width: -1,
            height: -1,
            radius: -1,
            from: new Float32Array(ARCS),
            span: new Float32Array(ARCS),
            bulge: new Float32Array(ARCS),
            age: new Float32Array(ARCS).fill(Infinity),
            life: new Float32Array(ARCS).fill(1),
            seed: new Float32Array(ARCS),
            owed: 0,
            burst: Infinity,
            burstSeed: 0,
            pull: 0,
            pullAt: 0,
            time: 0,
        }));
    }

    public initialize(): void {
        this.view = new Graphics();
        this.host.pixi.addChild(this.view);
    }

    public onTick(tick: TickContext): EffectContext<ArcContext> {
        this.coils.update(tick);
        const dt = Math.min(tick.timeDelta, 100);
        const struck = tick.events('lightning:strike').length > 0;
        let active = 0;
        let inAir = 0;
        for (const field of this.coils.fields) {
            const coil = field.data;
            this.fit(coil, field);
            coil.time = tick.time;
            if (field.active) {
                active++;
            }
            for (let i = 0; i < ARCS; i++) {
                coil.age[i] += dt;
                if (coil.age[i] < coil.life[i]) {
                    inAir++;
                }
            }
            coil.burst += dt;
            if (field.pressed || (struck && field.active) || field.turnedOn) {
                coil.burst = 0;
                coil.burstSeed = Math.random() * 1000;
            }

            const live = field.presence > 0.5 && coil.border.length > 0;
            if (live) {
                coil.owed += (this.rate * (0.35 + 0.65 * field.level) * (field.hover ? 1.8 : 1) * dt) / 1000;
                while (coil.owed >= 1) {
                    coil.owed -= 1;
                    this.strike(coil);
                }
            }

            // The pointer draws a bolt when it is near, but not while it is on the element itself.
            let near = false;
            if (live && field.pointerKnown && !field.hover) {
                const dx = field.pointerX < 0 ? -field.pointerX : field.pointerX > field.width ? field.pointerX - field.width : 0;
                const dy = field.pointerY < 0 ? -field.pointerY : field.pointerY > field.height ? field.pointerY - field.height : 0;
                near = dx * dx + dy * dy < this.reach * this.reach;
                if (near) {
                    coil.pullAt = coil.border.nearest(field.pointerX, field.pointerY, 4, this.point);
                }
            }
            coil.pull = approach(coil.pull, near ? 1 : 0, 9, dt);
        }
        this.context.fields = this.coils.fields.length;
        this.context.active = active;
        this.context.arcs = inAir;
        return this.publish(this.context);
    }

    public onRender(timed: TimedContext): void {
        const g = this.view;
        if (!g) {
            return;
        }
        g.clear();
        const theme = timed.theme;
        const hot = mixColor(theme.accent, theme.ink, 0.6);
        const point = this.point;
        for (const field of this.coils.fields) {
            const coil = field.data;
            const flicker = Math.floor(coil.time / FLICKER_MS);
            const shown = field.presence;

            // Small arcs: off the edge, up, and back onto it a little further along.
            for (let i = 0; i < ARCS; i++) {
                const t = coil.age[i] / coil.life[i];
                if (!(t < 1) || shown < 0.02) {
                    continue;
                }
                const steps = 7;
                for (let j = 0; j <= steps; j++) {
                    const along = j / steps;
                    const arch = Math.sin(Math.PI * along);
                    coil.border.pointAt(coil.from[i] + coil.span[i] * along, point);
                    const out = arch * (coil.bulge[i] + 3.5 * jag(coil.seed[i], flicker, j));
                    const x = field.x + point.x + point.nx * out + point.tx * arch * 3 * jag(coil.seed[i] + 7, flicker, j);
                    const y = field.y + point.y + point.ny * out + point.ty * arch * 3 * jag(coil.seed[i] + 7, flicker, j);
                    if (j === 0) {
                        g.moveTo(x, y);
                    } else {
                        g.lineTo(x, y);
                    }
                }
                g.stroke({ width: 1.5, color: i % 2 === 0 ? hot : theme.accentAlt, alpha: clamp(shown * (1 - t * t), 0, 1) });
            }

            // The bolt to the pointer.
            if (coil.pull > 0.03) {
                coil.border.pointAt(coil.pullAt, point);
                const ax = field.x + point.x;
                const ay = field.y + point.y;
                const bx = field.x + field.pointerX;
                const by = field.y + field.pointerY;
                const length = Math.hypot(bx - ax, by - ay) || 1;
                const px = -(by - ay) / length;
                const py = (bx - ax) / length;
                const steps = Math.max(4, Math.min(14, Math.round(length / 10)));
                g.moveTo(ax, ay);
                for (let j = 1; j <= steps; j++) {
                    const along = j / steps;
                    const side = Math.sin(Math.PI * along) * Math.min(9, length * 0.12) * jag(coil.pullAt, flicker, j);
                    g.lineTo(ax + (bx - ax) * along + px * side, ay + (by - ay) * along + py * side);
                }
                g.stroke({ width: 1.4, color: hot, alpha: clamp(coil.pull * shown * (0.65 + 0.35 * jag(3, flicker, 0)), 0, 1) });
            }

            // The discharge: bolts straight out of the edge, all the way round.
            const b = coil.burst / BURST_MS;
            if (b < 1 && coil.border.length > 0) {
                const bolts = clamp(Math.round(coil.border.length / 34), 5, 14);
                for (let k = 0; k < bolts; k++) {
                    const at = ((k + 0.5 * (1 + jag(coil.burstSeed, 0, k))) / bolts) * coil.border.length;
                    coil.border.pointAt(at, point);
                    const reach = (20 + 16 * (0.5 + 0.5 * jag(coil.burstSeed + 3, 0, k))) * Math.min(1, b * 4 + 0.3);
                    g.moveTo(field.x + point.x, field.y + point.y);
                    for (let j = 1; j <= 4; j++) {
                        const out = (reach * j) / 4;
                        const side = j < 4 ? 4 * jag(coil.burstSeed + k, flicker, j) : 0;
                        g.lineTo(field.x + point.x + point.nx * out + point.tx * side, field.y + point.y + point.ny * out + point.ty * side);
                    }
                    g.stroke({ width: 1.3, color: k % 3 === 0 ? theme.accentAlt : hot, alpha: clamp((1 - b) * (1 - b), 0, 1) });
                }
            }
        }
    }

    public cleanup(): void {
        this.view?.destroy();
        this.view = undefined;
        this.coils.clear();
        this.context.fields = this.context.active = this.context.arcs = 0;
    }

    private fit(coil: Coil, field: Field<Coil>): void {
        if (coil.width !== field.width || coil.height !== field.height || coil.radius !== field.radius) {
            coil.width = field.width;
            coil.height = field.height;
            coil.radius = field.radius;
            // Just outside the edge, so nothing is drawn on the element's own border.
            coil.border.set(field.width, field.height, field.radius, -1.5);
        }
    }

    /** One small arc, in the slot that has been free the longest. */
    private strike(coil: Coil): void {
        let slot = 0;
        for (let i = 1; i < ARCS; i++) {
            if (coil.age[i] - coil.life[i] > coil.age[slot] - coil.life[slot]) {
                slot = i;
            }
        }
        coil.from[slot] = Math.random() * coil.border.length;
        coil.span[slot] = (Math.random() < 0.5 ? -1 : 1) * (16 + Math.random() * 44);
        coil.bulge[slot] = 6 + Math.random() * 12;
        coil.age[slot] = 0;
        coil.life[slot] = 170 + Math.random() * 230;
        coil.seed[slot] = Math.random() * 1000;
    }
}
