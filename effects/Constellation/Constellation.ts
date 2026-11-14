import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { Effect } from '../../src/Effect';
import { approach, clamp, mixColor } from '../../src/math';
import type { EffectContext, TickContext, TimedContext, Vector3 } from '../../src/types';
import type { ConstellationContext } from '../contracts';

export interface ConstellationOptions {
    /** Points at full budget, 0..150. Default `COUNT` (90). */
    count?: number;
    /** Two points closer than this (pixels) are joined by a line that fades out towards it, 30..600. Default `LINK_DISTANCE` (165). */
    linkDistance?: number;
    /** Let events and presses run through the net as sparks. False draws the net only. Default true. */
    signals?: boolean;
    /** Treat the pointer as one more point: points within 1.2 times `linkDistance` join it and drift gently towards it (never closer than 40 px). Default true. */
    pointerLinks?: boolean;
}

const MAX_NODES = 150;
const POINTER = MAX_NODES; // index of the pointer's node in the arrays
const MAX_LINKS = 3000;
const MAX_PULSES = 240;
const BUCKETS = 5;
const LINK_ALPHA = 0.22;
const SPEED_MIN = 0.004;
const SPEED_MAX = 0.02;
const WRAP_MARGIN = 40;
const PULSE_SPEED = 0.45; // px/ms
const PULSE_KEEP = 0.7; // energy kept per hop
const MIN_ENERGY = 0.08;
const REFRACTORY = 500; // ms a point ignores new energy for firing purposes
const NODE_RATE = 3; // per second: node glow decay (about 700 ms to fade)
const SOURCE_REACH = 300; // an event further than this from every point starts nothing
const POINTER_HOLD = 40; // pointer repels points closer than this
const TAU = Math.PI * 2;

/**
 * Drifting points joined by thin lines, wired as a nervous system for the rest of the scene.
 * Whenever something happens anywhere, the nearest point lights up and the news travels from
 * point to point along the lines as sparks, hop by hop, fading as it spreads.
 *
 * What it listens to:
 *   - `lightning:strike`, `rainEater:exploded`, `singularity:collapsed`, `crystal:exploded`,
 *     `meteor:impact`, `firework:exploded`, `bubble:popped`, `flock:startled` and
 *     `fireflies:synced` events: each starts a signal at the point nearest to where it happened.
 *     An event more than 300 px from every point starts nothing.
 *   - a press (not on a button or link): starts a signal at the point nearest to the pointer.
 *   - the pointer: it counts as one more point, and the points around it drift towards it.
 *   - the force field: wind and shock rings carry the points a little.
 * What it tells the others: its context only (`nodes`, `links`, `signals`). No events, no forces.
 * Keys: none.
 */
export class Constellation extends Effect<ConstellationContext> {
    public effectName = 'constellation';

    public static readonly COUNT = 90;
    public static readonly LINK_DISTANCE = 165;

    private readonly context: ConstellationContext = { nodes: 0, links: 0, signals: 0 };
    private readonly count: number;
    private readonly linkDistance: number;
    private readonly useSignals: boolean;
    private readonly pointerLinks: boolean;

    // Points (structure of arrays). Index POINTER is the pointer.
    private readonly px = new Float32Array(MAX_NODES + 1);
    private readonly py = new Float32Array(MAX_NODES + 1);
    private readonly vx = new Float32Array(MAX_NODES + 1); // total velocity this tick, for render lead
    private readonly vy = new Float32Array(MAX_NODES + 1);
    private readonly kx = new Float32Array(MAX_NODES + 1); // velocity added by forces
    private readonly ky = new Float32Array(MAX_NODES + 1);
    private readonly heading = new Float32Array(MAX_NODES + 1);
    private readonly turn = new Float32Array(MAX_NODES + 1);
    private readonly speed = new Float32Array(MAX_NODES + 1);
    private readonly phase = new Float32Array(MAX_NODES + 1);
    private readonly presence = new Float32Array(MAX_NODES + 1);
    private readonly glow = new Float32Array(MAX_NODES + 1);
    private readonly firedAt = new Float64Array(MAX_NODES + 1).fill(-1e9);

    // Links, rebuilt every tick.
    private readonly linkA = new Uint16Array(MAX_LINKS);
    private readonly linkB = new Uint16Array(MAX_LINKS);
    private readonly linkAlpha = new Float32Array(MAX_LINKS);
    private linkCount = 0;

    // Pulses travelling along links.
    private readonly pFrom = new Uint16Array(MAX_PULSES);
    private readonly pTo = new Uint16Array(MAX_PULSES);
    private readonly pT = new Float32Array(MAX_PULSES);
    private readonly pEnergy = new Float32Array(MAX_PULSES);
    private pulseCount = 0;
    private readonly arrTo = new Uint16Array(MAX_PULSES);
    private readonly arrFrom = new Uint16Array(MAX_PULSES);
    private readonly arrEnergy = new Float32Array(MAX_PULSES);

    private readonly force: Vector3 = { x: 0, y: 0 };
    private seeded = false;
    private width = 0;
    private height = 0;
    private now = 0;

    private linkGfx: Graphics | undefined;
    private tailGfx: Graphics | undefined;
    private nodeLayer: Container | undefined;
    private pulseLayer: Container | undefined;
    private texture: Texture | undefined;
    private nodeSprites: Sprite[] = [];
    private pulseSprites: Sprite[] = [];

    constructor(options: ConstellationOptions = {}) {
        super();
        this.count = Math.round(clamp(options.count ?? Constellation.COUNT, 0, MAX_NODES));
        this.linkDistance = clamp(options.linkDistance ?? Constellation.LINK_DISTANCE, 30, 600);
        this.useSignals = options.signals ?? true;
        this.pointerLinks = options.pointerLinks ?? true;
    }

    public initialize(): void {
        this.texture = Texture.from(drawGlow());
        this.linkGfx = new Graphics();
        this.tailGfx = new Graphics();
        this.nodeLayer = new Container();
        this.pulseLayer = new Container();
        for (const layer of [this.linkGfx, this.tailGfx, this.nodeLayer, this.pulseLayer]) {
            layer.blendMode = 'add';
            this.host.pixi.addChild(layer);
        }
    }

    public cleanup(): void {
        for (const layer of [this.linkGfx, this.tailGfx, this.nodeLayer, this.pulseLayer]) {
            layer?.parent?.removeChild(layer);
            layer?.destroy({ children: true });
        }
        this.texture?.destroy(true);
        this.linkGfx = this.tailGfx = this.nodeLayer = this.pulseLayer = undefined;
        this.texture = undefined;
        this.nodeSprites = [];
        this.pulseSprites = [];
        this.seeded = false;
        this.linkCount = 0;
        this.pulseCount = 0;
        this.glow.fill(0);
        this.presence.fill(0);
        this.firedAt.fill(-1e9);
    }

    public onTick(tick: TickContext): EffectContext<ConstellationContext> {
        const dt = tick.timeDelta;
        const w = tick.stage.width;
        const h = tick.stage.height;
        const now = tick.time;
        this.now = now;
        const n = this.count;

        if (!this.seeded) {
            this.seeded = true;
            this.seed(w, h, tick.budget.budget);
        } else if (w > 0 && h > 0 && (w !== this.width || h !== this.height)) {
            const sx = w / this.width;
            const sy = h / this.height;
            for (let i = 0; i < n; i++) {
                this.px[i] *= sx;
                this.py[i] *= sy;
            }
        }
        this.width = w;
        this.height = h;

        // Pointer as a point.
        const mouse = tick.mousePosition;
        const pointerOn = this.pointerLinks && mouse !== undefined;
        if (mouse) {
            this.px[POINTER] = mouse.x;
            this.py[POINTER] = mouse.y;
        }
        this.presence[POINTER] = approach(this.presence[POINTER], pointerOn ? 1 : 0, 4, dt);
        const reach = this.linkDistance * 1.2;

        // Move the points.
        const active = Math.ceil(n * clamp(tick.budget.budget, 0, 1));
        const damp = Math.exp(-dt / 900);
        const decay = Math.exp((-NODE_RATE * dt) / 1000);
        for (let i = 0; i < n; i++) {
            this.presence[i] = approach(this.presence[i], i < active ? 1 : 0, 1.5, dt);
            this.glow[i] *= decay;

            if (Math.random() < dt / 7000) {
                this.turn[i] = (Math.random() - 0.5) * 0.0005;
            }
            this.heading[i] += this.turn[i] * dt;

            tick.forces.sample(this.px[i], this.py[i], this.force, this.effectName);
            let kx = (this.kx[i] + this.force.x * dt * 0.5) * damp;
            let ky = (this.ky[i] + this.force.y * dt * 0.5) * damp;

            let slow = 1;
            if (pointerOn) {
                const dx = mouse.x - this.px[i];
                const dy = mouse.y - this.py[i];
                const d = Math.hypot(dx, dy);
                if (d < reach && d > 0.01) {
                    const near = 1 - d / reach;
                    // Pull in gently, push out below POINTER_HOLD so nothing collapses onto it.
                    const a = d > POINTER_HOLD ? 0.00006 * near : -0.0004 * (1 - d / POINTER_HOLD);
                    kx += (dx / d) * a * dt;
                    ky += (dy / d) * a * dt;
                    slow = 1 - 0.8 * near;
                }
            }
            const kv = Math.hypot(kx, ky);
            if (kv > 0.3) {
                kx *= 0.3 / kv;
                ky *= 0.3 / kv;
            }
            this.kx[i] = kx;
            this.ky[i] = ky;

            const s = this.speed[i] * slow;
            const vx = Math.cos(this.heading[i]) * s + kx;
            const vy = Math.sin(this.heading[i]) * s + ky;
            this.vx[i] = vx;
            this.vy[i] = vy;
            let x = this.px[i] + vx * dt;
            let y = this.py[i] + vy * dt;
            if (x < -WRAP_MARGIN) x = w + WRAP_MARGIN;
            else if (x > w + WRAP_MARGIN) x = -WRAP_MARGIN;
            if (y < -WRAP_MARGIN) y = h + WRAP_MARGIN;
            else if (y > h + WRAP_MARGIN) y = -WRAP_MARGIN;
            this.px[i] = x;
            this.py[i] = y;
        }
        this.vx[POINTER] = 0;
        this.vy[POINTER] = 0;

        this.buildLinks(reach);

        if (this.useSignals) {
            this.collectEvents(tick);
            this.advancePulses(dt, now);
        } else {
            this.pulseCount = 0;
        }

        let visible = 0;
        for (let i = 0; i < n; i++) {
            if (this.presence[i] > 0.02) visible++;
        }
        this.context.nodes = visible;
        this.context.links = this.linkCount;
        this.context.signals = this.pulseCount;
        return this.publish(this.context);
    }

    public onRender(timed: TimedContext): void {
        const linkGfx = this.linkGfx;
        const tailGfx = this.tailGfx;
        const nodeLayer = this.nodeLayer;
        const pulseLayer = this.pulseLayer;
        const texture = this.texture;
        if (!linkGfx || !tailGfx || !nodeLayer || !pulseLayer || !texture) {
            return;
        }
        const theme = timed.theme;
        const lead = timed.alpha * timed.tickDelta;
        const time = timed.time;
        const n = this.count;
        const nodeColor = mixColor(theme.accent, theme.ink, 0.5);
        const linkColor = mixColor(theme.accent, theme.accentAlt, 0.5);
        const { px, py, vx, vy, glow } = this;

        // Links: one path and one stroke per alpha bucket.
        linkGfx.clear();
        const lc = this.linkCount;
        for (let b = 0; b < BUCKETS; b++) {
            let any = false;
            for (let l = 0; l < lc; l++) {
                const a = this.linkA[l];
                const c = this.linkB[l];
                const e = Math.max(glow[a], glow[c]);
                const alpha = this.linkAlpha[l] * (1 + 2.4 * Math.min(e, 1.2));
                const bucket = Math.min(BUCKETS - 1, Math.floor((alpha / 0.6) * BUCKETS));
                if (bucket !== b || alpha < 0.012) continue;
                linkGfx.moveTo(px[a] + vx[a] * lead, py[a] + vy[a] * lead);
                linkGfx.lineTo(px[c] + vx[c] * lead, py[c] + vy[c] * lead);
                any = true;
            }
            if (any) {
                const t = b / (BUCKETS - 1);
                linkGfx.stroke({ width: 1, color: mixColor(linkColor, theme.ink, t * 0.55), alpha: ((b + 0.5) / BUCKETS) * 0.6 });
            }
        }

        // Points.
        while (this.nodeSprites.length < n) {
            const s = new Sprite(texture);
            s.anchor.set(0.5);
            nodeLayer.addChild(s);
            this.nodeSprites.push(s);
        }
        for (let i = 0; i < n; i++) {
            const s = this.nodeSprites[i];
            const p = this.presence[i];
            if (p < 0.02) {
                s.visible = false;
                continue;
            }
            const e = Math.min(glow[i], 1.3);
            const twinkle = 0.78 + 0.22 * Math.sin(time * (0.0006 + this.phase[i] * 0.0003) + this.phase[i] * 40);
            s.visible = true;
            s.position.set(px[i] + vx[i] * lead, py[i] + vy[i] * lead);
            s.scale.set((13 + e * 26) / 64);
            s.tint = e > 0.3 ? mixColor(nodeColor, theme.ink, Math.min(1, e)) : nodeColor;
            s.alpha = p * Math.min(1, (0.62 + 0.5 * e) * twinkle);
        }

        // Sparks.
        tailGfx.clear();
        const pc = this.pulseCount;
        while (this.pulseSprites.length < pc) {
            const s = new Sprite(texture);
            s.anchor.set(0.5);
            pulseLayer.addChild(s);
            this.pulseSprites.push(s);
        }
        for (let q = 0; q < 3; q++) {
            let any = false;
            for (let i = 0; i < pc; i++) {
                const bucket = Math.min(2, Math.floor((this.pEnergy[i] / 1.1) * 3));
                if (bucket !== q) continue;
                const f = this.pFrom[i];
                const t = this.pT[i];
                const ax = px[f] + vx[f] * lead;
                const ay = py[f] + vy[f] * lead;
                const to = this.pTo[i];
                const bx = px[to] + vx[to] * lead;
                const by = py[to] + vy[to] * lead;
                const len = Math.hypot(bx - ax, by - ay) || 1;
                const tt = Math.min(1, t + (PULSE_SPEED * lead) / len);
                const tail = Math.max(0, tt - 22 / len);
                tailGfx.moveTo(ax + (bx - ax) * tail, ay + (by - ay) * tail);
                tailGfx.lineTo(ax + (bx - ax) * tt, ay + (by - ay) * tt);
                any = true;
            }
            if (any) {
                tailGfx.stroke({ width: 1.4, color: theme.ink, alpha: 0.25 + q * 0.2 });
            }
        }
        for (let i = 0; i < this.pulseSprites.length; i++) {
            const s = this.pulseSprites[i];
            if (i >= pc) {
                s.visible = false;
                continue;
            }
            const f = this.pFrom[i];
            const to = this.pTo[i];
            const ax = px[f] + vx[f] * lead;
            const ay = py[f] + vy[f] * lead;
            const bx = px[to] + vx[to] * lead;
            const by = py[to] + vy[to] * lead;
            const len = Math.hypot(bx - ax, by - ay) || 1;
            const tt = Math.min(1, this.pT[i] + (PULSE_SPEED * lead) / len);
            s.visible = true;
            s.position.set(ax + (bx - ax) * tt, ay + (by - ay) * tt);
            s.tint = theme.ink;
            s.scale.set((9 + this.pEnergy[i] * 8) / 64);
            s.alpha = clamp(0.5 + this.pEnergy[i] * 0.6, 0, 1);
        }
    }

    private seed(w: number, h: number, budget: number): void {
        const active = Math.ceil(this.count * clamp(budget, 0, 1));
        for (let i = 0; i < MAX_NODES; i++) {
            this.px[i] = Math.random() * w;
            this.py[i] = Math.random() * h;
            this.heading[i] = Math.random() * TAU;
            this.turn[i] = (Math.random() - 0.5) * 0.0005;
            this.speed[i] = SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN);
            this.phase[i] = Math.random();
            this.presence[i] = i < active ? 1 : 0;
            this.glow[i] = 0;
        }
    }

    /** All pairs closer than `linkDistance` (the pointer: `reach`), with alpha falling smoothly to 0 at that distance. */
    private buildLinks(reach: number): void {
        const n = this.count;
        const { px, py, presence } = this;
        const L = this.linkDistance;
        let lc = 0;
        for (let i = 0; i <= n; i++) {
            const a = i === n ? POINTER : i;
            const pa = presence[a];
            if (pa < 0.02) continue;
            for (let j = i + 1; j <= n; j++) {
                const b = j === n ? POINTER : j;
                const pb = presence[b];
                if (pb < 0.02 || lc >= MAX_LINKS) continue;
                const range = b === POINTER ? reach : L;
                const dx = px[a] - px[b];
                if (dx > range || dx < -range) continue;
                const dy = py[a] - py[b];
                const d2 = dx * dx + dy * dy;
                if (d2 >= range * range) continue;
                const t = 1 - Math.sqrt(d2) / range;
                this.linkA[lc] = a;
                this.linkB[lc] = b;
                this.linkAlpha[lc] = LINK_ALPHA * t * t * (3 - 2 * t) * Math.min(pa, pb);
                lc++;
            }
        }
        this.linkCount = lc;
    }

    private collectEvents(tick: TickContext): void {
        for (const e of tick.events('lightning:strike')) this.startAt(e.payload.x, e.payload.y, 1);
        for (const e of tick.events('rainEater:exploded')) this.startAt(e.payload.x, e.payload.y, 1.2);
        for (const e of tick.events('singularity:collapsed')) this.startAt(e.payload.x, e.payload.y, 1.5);
        for (const e of tick.events('crystal:exploded')) this.startAt(e.payload.x, e.payload.y, 0.9);
        for (const e of tick.events('meteor:impact')) this.startAt(e.payload.x, e.payload.y, 0.5 + 0.5 * e.payload.power);
        for (const e of tick.events('firework:exploded')) this.startAt(e.payload.x, e.payload.y, 0.4 + 0.5 * e.payload.power);
        for (const e of tick.events('bubble:popped')) this.startAt(e.payload.x, e.payload.y, 0.3);
        for (const e of tick.events('flock:startled')) this.startAt(e.payload.x, e.payload.y, 0.4);
        for (const e of tick.events('fireflies:synced')) this.startAt(e.payload.x, e.payload.y, 0.6);
        const mouse = tick.mousePosition;
        if (mouse && tick.mouseJustPressed && !tick.mouseOnInteractive) {
            this.startAt(mouse.x, mouse.y, 0.8);
        }
    }

    /** Light the point nearest to (x, y), if there is one within reach, and let it fire. */
    private startAt(x: number, y: number, energy: number): void {
        let best = -1;
        let bestD = SOURCE_REACH * SOURCE_REACH;
        for (let i = 0; i < this.count; i++) {
            if (this.presence[i] < 0.5) continue;
            const dx = this.px[i] - x;
            const dy = this.py[i] - y;
            const d = dx * dx + dy * dy;
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        }
        if (best >= 0) {
            this.receive(best, -1, energy);
        }
    }

    /** A point gets energy: it glows, and unless it fired lately it sends a weaker pulse down each of its links. */
    private receive(node: number, from: number, energy: number): void {
        this.glow[node] = Math.min(1.6, Math.max(this.glow[node], energy));
        const out = energy * PULSE_KEEP;
        if (this.now - this.firedAt[node] < REFRACTORY || out < MIN_ENERGY) {
            return;
        }
        this.firedAt[node] = this.now;
        for (let l = 0; l < this.linkCount; l++) {
            if (this.pulseCount >= MAX_PULSES) return;
            const a = this.linkA[l];
            const b = this.linkB[l];
            const other = a === node ? b : b === node ? a : -1;
            if (other < 0 || other === from || other === POINTER || this.linkAlpha[l] < 0.01) continue;
            const k = this.pulseCount++;
            this.pFrom[k] = node;
            this.pTo[k] = other;
            this.pT[k] = 0;
            this.pEnergy[k] = out;
        }
    }

    private advancePulses(dt: number, now: number): void {
        this.now = now;
        const { px, py } = this;
        let write = 0;
        let arrivals = 0;
        const total = this.pulseCount;
        for (let i = 0; i < total; i++) {
            const f = this.pFrom[i];
            const t = this.pTo[i];
            const len = Math.hypot(px[t] - px[f], py[t] - py[f]) || 1;
            const progress = this.pT[i] + (PULSE_SPEED * dt) / len;
            if (progress >= 1) {
                this.arrTo[arrivals] = t;
                this.arrFrom[arrivals] = f;
                this.arrEnergy[arrivals] = this.pEnergy[i];
                arrivals++;
                continue;
            }
            this.pFrom[write] = f;
            this.pTo[write] = t;
            this.pT[write] = progress;
            this.pEnergy[write] = this.pEnergy[i];
            write++;
        }
        this.pulseCount = write;
        for (let i = 0; i < arrivals; i++) {
            this.receive(this.arrTo[i], this.arrFrom[i], this.arrEnergy[i]);
        }
    }
}

/** A white dot with a soft halo, 64 px, tinted per sprite. */
function drawGlow(): HTMLCanvasElement {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.28)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.07)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return canvas;
}
