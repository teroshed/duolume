import { Effect } from '../../src/Effect';
import { clamp, mixColor } from '../../src/math';
import type { EffectContext, TickContext, TimedContext } from '../../src/types';
import type { CircuitContext } from '../contracts';
import { FieldLayer } from '../Field/FieldLayer';
import { FieldSet, type Field } from '../Field/FieldSet';
import { hashSeed, makeRandom, nearestOnBoard, pointAt, routeBoard, segmentAt, type Board, type Trace } from './route';
import type { Graphics } from 'pixi.js';

export interface CircuitOptions {
    /** The tag that marks an element as a circuit board. Default `TAG` ('circuit'). */
    tag?: string;
    /** Multiplier on how many traces a board has, 0.3 to 3. Default `DENSITY` (1). */
    density?: number;
    /** How fast a pulse travels, in px/ms. Default `SPEED` (0.1). */
    speed?: number;
    /** Multiplier on how often pulses enter a trace, 0 to 5. Default `RATE` (1). */
    rate?: number;
}

/** Pulses a board can carry at once, per trace it has (at least `MIN_POOL`). */
const POOL_PER_TRACE = 6;
const MIN_POOL = 16;
const MAX_POOL = 64;

/** The state of one board: its traces, the pulses on them, the glow left on its pads. */
interface Rig {
    width: number;
    height: number;
    board: Board;
    /** Per root trace: ms (scaled by rate) until the next pulse enters it. */
    cool: Float32Array;
    /** Per trace, per node: how lit the pad is, decaying. */
    flash: Float32Array[];
    /** The pulse pool, struct-of-arrays. */
    live: Uint8Array;
    pTrace: Int16Array;
    pPos: Float32Array;
    pDir: Int8Array;
    pSpeed: Float32Array;
    pPower: Float32Array;
    pulses: number;
    /** The trace the pointer is nearest, and how much it is lit. */
    hoverTrace: number;
    hoverAmt: number;
    /** Whether the traces keep to the edges (text fields, buttons). */
    quiet: boolean;
}

interface Hit {
    trace: number;
    dist: number;
    x: number;
    y: number;
    d2: number;
}

/**
 * A small circuit board inside a page element: fine one-pixel traces run across it with 45 and 90
 * degree jogs, pads at the start and vias at the end. Switched off the board is dark and you can
 * just see the traces. Switched on, current flows: short bright pulses travel from the left end
 * to the right, the pads they pass light up and fade, a pulse splits where a trace branches.
 * A bar is busier the fuller it is. A switch turning on sends a pulse down every trace at once;
 * turning off lets the pulses in flight finish. A press sends a strong pulse both ways from the
 * nearest point of the nearest trace; the hovered trace is lit a little and its pulses run faster.
 *
 * Any element tagged `circuit` is a board. The routing is deterministic from the element's name
 * and size. A switch's traces run on under the knob; in a text field or a button the traces keep
 * to the top and bottom edges, so the text between them stays easy to read.
 *
 * What it listens to:
 *   - elements tagged `circuit`: their state (`on`, `off`, `focus`, `knob`, `value:`), the pointer
 *     over them and presses on them.
 *   - `lightning:strike`: every board that is showing surges (a pulse on every trace, every pad lit).
 *   - `meteor:impact` and `crystal:exploded`: the same, smaller.
 * It tells the others how many boards it is drawing in, how many are showing, and how many
 * pulses are travelling (`signals`). No forces, no events.
 * It has no keys.
 */
export class Circuit extends Effect<CircuitContext> {
    public effectName = 'circuit';

    public static readonly TAG = 'circuit';
    public static readonly DENSITY = 1;
    public static readonly SPEED = 0.1;
    public static readonly RATE = 1;

    private readonly density: number;
    private readonly speed: number;
    private readonly rate: number;
    private readonly boards: FieldSet<Rig>;
    private readonly context: CircuitContext = { fields: 0, active: 0, signals: 0 };
    private readonly hit: Hit = { trace: -1, dist: 0, x: 0, y: 0, d2: 0 };
    private readonly point = { x: 0, y: 0 };
    private layer: FieldLayer | undefined;

    constructor(options: CircuitOptions = {}) {
        super();
        this.density = clamp(options.density ?? Circuit.DENSITY, 0.3, 3);
        this.speed = clamp(options.speed ?? Circuit.SPEED, 0.01, 1);
        this.rate = clamp(options.rate ?? Circuit.RATE, 0, 5);
        this.boards = new FieldSet<Rig>(options.tag ?? Circuit.TAG, (field) => this.lay(field));
    }

    public initialize(): void {
        this.layer = new FieldLayer(this.host.pixi);
    }

    public onTick(tick: TickContext): EffectContext<CircuitContext> {
        this.boards.update(tick);
        const dt = Math.min(tick.timeDelta, 50);
        const budget = clamp(tick.budget.budget, 0.25, 1);

        let surge = 0;
        if (tick.events('lightning:strike').length > 0) {
            surge = 1;
        } else if (tick.events('meteor:impact').length > 0 || tick.events('crystal:exploded').length > 0) {
            surge = 0.5;
        }

        let active = 0;
        let signals = 0;
        for (const field of this.boards.fields) {
            let rig = field.data;
            if (Math.abs(field.width - rig.width) > 0.5 || Math.abs(field.height - rig.height) > 0.5) {
                rig = field.data = this.lay(field);
            }
            if (field.active) {
                active++;
            }
            const traces = rig.board.traces;
            if (traces.length === 0) {
                continue;
            }

            // The pointer: the trace it is nearest lights up; a press sends a strong pulse out.
            let hoverTarget = -1;
            if (field.hover && field.pointerKnown && !field.words.disabled && nearestOnBoard(rig.board, field.pointerX, field.pointerY, this.hit)) {
                if (this.hit.d2 < 24 * 24) {
                    hoverTarget = this.hit.trace;
                }
                if (field.pressed) {
                    this.press(rig, field.pointerX, field.pointerY, this.hit);
                }
            }
            if (hoverTarget >= 0) {
                rig.hoverTrace = hoverTarget;
            }
            rig.hoverAmt += ((hoverTarget >= 0 ? 1 : 0) - rig.hoverAmt) * Math.min(1, dt / 120);
            if (rig.hoverAmt < 0.01 && hoverTarget < 0) {
                rig.hoverAmt = 0;
                rig.hoverTrace = -1;
            }

            if (field.turnedOn) {
                // Power-up: a pulse down every trace at once.
                for (let t = 0; t < rig.board.roots; t++) {
                    this.spawn(rig, t, 0, 1, 1.4, 1.1);
                    rig.cool[t] = 600 + Math.random() * 400;
                }
            }
            if (surge > 0 && field.active) {
                this.surge(rig, surge);
            }

            // Pulses enter while it is showing: busier the fuller it is.
            if (field.active) {
                const pace = this.rate * (0.3 + field.level) * (0.5 + 0.5 * budget);
                for (let t = 0; t < rig.board.roots; t++) {
                    rig.cool[t] -= dt * pace;
                    if (rig.cool[t] <= 0) {
                        this.spawn(rig, t, 0, 1, 1, 0.85 + Math.random() * 0.3);
                        rig.cool[t] = 500 + Math.random() * 400;
                    }
                }
            }

            this.advance(rig, dt);
            signals += rig.pulses;
        }

        this.context.fields = this.boards.fields.length;
        this.context.active = active;
        this.context.signals = signals;
        return this.publish(this.context);
    }

    public onRender(timed: TimedContext): void {
        const layer = this.layer;
        if (!layer) {
            return;
        }
        const theme = timed.theme;
        for (const field of this.boards.fields) {
            const g = layer.draw(field);
            const rig = field.data;
            if (rig.board.traces.length > 0) {
                this.drawBoard(g, field, rig, theme);
            }
        }
        layer.sweep();
    }

    public cleanup(): void {
        this.boards.clear();
        this.layer?.destroy();
        this.layer = undefined;
        this.context.fields = 0;
        this.context.active = 0;
        this.context.signals = 0;
    }

    // ---- simulation --------------------------------------------------------------------------

    /** Route a board for an element: deterministic from its name and size. */
    private lay(field: Field<Rig>): Rig {
        const w = field.width;
        const h = field.height;
        const area = w * h;
        const pad = area >= 6000 && h >= 60;
        const small = field.words.knob || field.words.value !== undefined || h <= 26;
        const quiet = !pad && !small;
        const base = pad ? clamp(area / 2700, 3, 10) : small ? 2.4 : 2;
        const board = routeBoard({
            width: w,
            height: h,
            radius: field.radius,
            random: makeRandom(hashSeed(field.name, w, h)),
            count: Math.round(base * this.density),
            mode: quiet ? 'edges' : 'open',
        });
        const traces = board.traces;
        const slots = clamp(traces.length * POOL_PER_TRACE, MIN_POOL, MAX_POOL);
        const cool = new Float32Array(board.roots);
        for (let t = 0; t < cool.length; t++) {
            cool[t] = Math.random() * 700;
        }
        return {
            width: w,
            height: h,
            board,
            cool,
            flash: traces.map((trace) => new Float32Array(trace.nodes.length)),
            live: new Uint8Array(slots),
            pTrace: new Int16Array(slots),
            pPos: new Float32Array(slots),
            pDir: new Int8Array(slots),
            pSpeed: new Float32Array(slots),
            pPower: new Float32Array(slots),
            pulses: 0,
            hoverTrace: -1,
            hoverAmt: 0,
            quiet,
        };
    }

    /** Put a pulse on a trace. Returns false when the pool is full. */
    private spawn(rig: Rig, trace: number, pos: number, dir: number, power: number, speed: number): boolean {
        const live = rig.live;
        for (let i = 0; i < live.length; i++) {
            if (live[i] === 0) {
                live[i] = 1;
                rig.pTrace[i] = trace;
                rig.pPos[i] = pos;
                rig.pDir[i] = dir;
                rig.pPower[i] = power;
                rig.pSpeed[i] = speed;
                rig.pulses++;
                this.lightNodes(rig, trace, pos, pos, power);
                return true;
            }
        }
        return false;
    }

    /** Light the pads between two distances along a trace. */
    private lightNodes(rig: Rig, trace: number, a: number, b: number, power: number): void {
        const nodes = rig.board.traces[trace].nodes;
        const flash = rig.flash[trace];
        const lo = Math.min(a, b) - 0.01;
        const hi = Math.max(a, b) + 0.01;
        for (let i = 0; i < nodes.length; i++) {
            const d = nodes[i].dist;
            if (d >= lo && d <= hi && flash[i] < power) {
                flash[i] = power;
            }
        }
    }

    private advance(rig: Rig, dt: number): void {
        const traces = rig.board.traces;
        const decay = Math.exp(-dt / 280);
        for (let t = 0; t < traces.length; t++) {
            const flash = rig.flash[t];
            for (let i = 0; i < flash.length; i++) {
                flash[i] = flash[i] < 0.01 ? 0 : flash[i] * decay;
            }
        }
        if (rig.pulses === 0) {
            return;
        }
        for (let i = 0; i < rig.live.length; i++) {
            if (rig.live[i] === 0) {
                continue;
            }
            const t = rig.pTrace[i];
            const trace = traces[t];
            const pace = this.speed * rig.pSpeed[i] * (t === rig.hoverTrace ? 1 + 0.5 * rig.hoverAmt : 1);
            const from = rig.pPos[i];
            const to = from + rig.pDir[i] * pace * dt;
            const a = clamp(Math.min(from, to), 0, trace.length);
            const b = clamp(Math.max(from, to), 0, trace.length);
            this.lightNodes(rig, t, a, b, rig.pPower[i]);
            // A branch: the pulse carries on and a smaller one sets off down it.
            for (let k = 0; k < trace.splitAt.length; k++) {
                const at = trace.splitAt[k];
                if (at >= a - 0.01 && at <= b + 0.01 && rig.pPower[i] < 1.7) {
                    this.spawn(rig, trace.splitTo[k], 0, 1, rig.pPower[i] * 0.85, rig.pSpeed[i]);
                }
            }
            rig.pPos[i] = to;
            if (to > trace.length + 1 || to < -1) {
                rig.live[i] = 0;
                rig.pulses--;
            }
        }
    }

    /** A press: a strong pulse each way from the nearest point of the nearest trace, and its nearest pad flashes. */
    private press(rig: Rig, x: number, y: number, hit: Hit): void {
        const t = hit.trace;
        this.spawn(rig, t, hit.dist, 1, 2, 1.35);
        this.spawn(rig, t, hit.dist, -1, 2, 1.35);
        let best = Infinity;
        let bt = -1;
        let bi = -1;
        for (let k = 0; k < rig.board.traces.length; k++) {
            const nodes = rig.board.traces[k].nodes;
            for (let i = 0; i < nodes.length; i++) {
                const d2 = (nodes[i].x - x) * (nodes[i].x - x) + (nodes[i].y - y) * (nodes[i].y - y);
                if (d2 < best) {
                    best = d2;
                    bt = k;
                    bi = i;
                }
            }
        }
        if (bt >= 0) {
            rig.flash[bt][bi] = 1.5;
        }
    }

    /** Lightning and the like: a bright pulse down every trace (or every other, for a small one) and every pad lit. */
    private surge(rig: Rig, size: number): void {
        for (let t = 0; t < rig.board.roots; t++) {
            if (size >= 1 || (t & 1) === 0) {
                this.spawn(rig, t, 0, 1, 1.5 * size + 0.3, 1.3);
            }
        }
        for (let t = 0; t < rig.flash.length; t++) {
            const flash = rig.flash[t];
            for (let i = 0; i < flash.length; i++) {
                flash[i] = Math.max(flash[i], size);
            }
        }
    }

    // ---- drawing -----------------------------------------------------------------------------

    private drawBoard(g: Graphics, field: Field<Rig>, rig: Rig, theme: TimedContext['theme']): void {
        const traces = rig.board.traces;
        const live = field.presence;
        // Idle: barely there. Showing: clearer.
        const base = (0.12 + 0.23 * live) * (rig.quiet ? 0.85 : 1);
        const wire = mixColor(mixColor(theme.accent, theme.bgBottom, 0.5), theme.accent, live);

        for (let t = 0; t < traces.length; t++) {
            const xy = traces[t].xy;
            g.moveTo(xy[0] + 0.5, xy[1] + 0.5);
            for (let i = 2; i < xy.length; i += 2) {
                g.lineTo(xy[i] + 0.5, xy[i + 1] + 0.5);
            }
        }
        g.stroke({ width: 1, color: wire, alpha: base });

        if (rig.hoverAmt > 0.02 && rig.hoverTrace >= 0) {
            const xy = traces[rig.hoverTrace].xy;
            g.moveTo(xy[0] + 0.5, xy[1] + 0.5);
            for (let i = 2; i < xy.length; i += 2) {
                g.lineTo(xy[i] + 0.5, xy[i + 1] + 0.5);
            }
            g.stroke({ width: 1, color: theme.accent, alpha: 0.25 * rig.hoverAmt });
        }

        // Pads, vias and junctions: dim at rest.
        const padAlpha = (0.2 + 0.3 * live) * (rig.quiet ? 0.85 : 1);
        for (let t = 0; t < traces.length; t++) {
            for (const n of traces[t].nodes) {
                if (n.kind === 'pad') {
                    g.rect(n.x - 1, n.y - 1, 3, 3);
                } else if (n.kind === 'dot') {
                    g.rect(n.x, n.y, 2, 2);
                }
            }
        }
        g.fill({ color: wire, alpha: padAlpha });
        for (let t = 0; t < traces.length; t++) {
            for (const n of traces[t].nodes) {
                if (n.kind === 'via') {
                    g.circle(n.x + 0.5, n.y + 0.5, 1.5);
                }
            }
        }
        g.stroke({ width: 1, color: wire, alpha: padAlpha });

        // Pads that a pulse is passing or has just passed.
        let any = false;
        for (let t = 0; t < traces.length; t++) {
            const flash = rig.flash[t];
            const nodes = traces[t].nodes;
            for (let i = 0; i < flash.length; i++) {
                if (flash[i] > 0.04) {
                    const n = nodes[i];
                    if (n.kind === 'via') {
                        g.circle(n.x + 0.5, n.y + 0.5, 1.5);
                    } else {
                        g.rect(n.x - 1, n.y - 1, 3, 3);
                    }
                    any = true;
                }
            }
        }
        if (any) {
            // One tone for all of them: drawn per pad below so each keeps its own fade.
            for (let t = 0; t < traces.length; t++) {
                const flash = rig.flash[t];
                const nodes = traces[t].nodes;
                for (let i = 0; i < flash.length; i++) {
                    if (flash[i] > 0.04) {
                        const n = nodes[i];
                        const a = Math.min(1, flash[i]) * 0.85;
                        const color = mixColor(theme.accentAlt, theme.ink, Math.min(1, flash[i]));
                        if (n.kind === 'via') {
                            g.circle(n.x + 0.5, n.y + 0.5, 1.5).stroke({ width: 1, color, alpha: a });
                        } else {
                            g.rect(n.x - 1, n.y - 1, 3, 3).fill({ color, alpha: a });
                        }
                    }
                }
            }
        }

        if (rig.pulses > 0) {
            this.drawPulses(g, rig, theme);
        }
    }

    private drawPulses(g: Graphics, rig: Rig, theme: TimedContext['theme']): void {
        const traces = rig.board.traces;
        // Three passes, tail then body then head, so each is one stroke.
        for (let pass = 0; pass < 4; pass++) {
            let drew = false;
            for (let i = 0; i < rig.live.length; i++) {
                if (rig.live[i] === 0) {
                    continue;
                }
                const strong = rig.pPower[i] > 1.3;
                if (pass === 3 && !strong) {
                    continue;
                }
                const trace = traces[rig.pTrace[i]];
                const pos = rig.pPos[i];
                const back = -rig.pDir[i];
                const headLen = strong ? 7 : 5;
                const bodyLen = headLen + 6;
                const tailLen = bodyLen + 14;
                if (pass === 0) {
                    this.range(g, trace, pos + back * bodyLen, pos + back * tailLen);
                } else if (pass === 1) {
                    this.range(g, trace, pos + back * headLen, pos + back * bodyLen);
                } else {
                    this.range(g, trace, pos, pos + back * headLen);
                }
                drew = true;
            }
            if (!drew) {
                continue;
            }
            if (pass === 0) {
                g.stroke({ width: 1, color: theme.accentAlt, alpha: 0.3 });
            } else if (pass === 1) {
                g.stroke({ width: 1, color: theme.accentAlt, alpha: 0.65 });
            } else if (pass === 2) {
                g.stroke({ width: 1, color: theme.ink, alpha: 0.95 });
            } else {
                g.stroke({ width: 2, color: theme.ink, alpha: 0.9 });
            }
        }
    }

    /** Add the stretch of a trace between two distances to the current path. */
    private range(g: Graphics, trace: Trace, d0: number, d1: number): void {
        const a = clamp(Math.min(d0, d1), 0, trace.length);
        const b = clamp(Math.max(d0, d1), 0, trace.length);
        if (b - a < 0.01) {
            return;
        }
        const p = this.point;
        pointAt(trace, a, p);
        g.moveTo(p.x + 0.5, p.y + 0.5);
        const xy = trace.xy;
        for (let i = segmentAt(trace, a) + 1; i < trace.cum.length && trace.cum[i] < b; i++) {
            if (trace.cum[i] > a) {
                g.lineTo(xy[i * 2] + 0.5, xy[i * 2 + 1] + 0.5);
            }
        }
        pointAt(trace, b, p);
        g.lineTo(p.x + 0.5, p.y + 0.5);
    }
}
