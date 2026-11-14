import { Graphics } from 'pixi.js';
import { Effect } from '../../src/Effect';
import { clamp, lerp, mixColor, randomNumber } from '../../src/math';
import type { EffectContext, TickContext, TimedContext, Vector3 } from '../../src/types';
// Type-only imports bring the shared context/event shapes into the registries.
import type { MeteorsContext } from '../contracts';

export interface MeteorsOptions {
    /** Shortest quiet time between meteors, in milliseconds of simulation time. Default 2500 (`Meteors.INTERVAL_MIN_MS`). */
    intervalMin?: number;
    /** Longest quiet time between meteors, in milliseconds. A random time between the two is used. Default 7000 (`Meteors.INTERVAL_MAX_MS`). */
    intervalMax?: number;
    /** Multiplier on flight speed (1 is about 0.7 to 1.2 pixels per millisecond). Default 1 (`Meteors.SPEED`). */
    speed?: number;
    /** True: a meteor can land on the top edge of an element tagged `ledge`. Default true (`Meteors.PAGE_INTERACTION`). */
    pageInteraction?: boolean;
    /** True: a big impact (power above 0.6) sends one shock ring through the force field. Default true (`Meteors.SHOCK`). */
    shock?: boolean;
}

interface Meteor {
    x: number;
    y: number;
    vx: number;
    vy: number;
    power: number;
    /** Length of the visible tail in pixels. */
    tailLength: number;
    /** Recent head positions, a ring buffer: `trailHead` is the newest. */
    trailX: Float32Array;
    trailY: Float32Array;
    trailHead: number;
    /** 1 while flying; after an impact it falls to 0 and the tail fades with it. */
    fade: number;
    landed: boolean;
}

interface Scar {
    x: number;
    y: number;
    power: number;
    age: number;
}

/**
 * A meteor now and then streaks down the sky and lands: on the ground, on the top edge of a page
 * element, or on the rain eater or a singularity if it passes through one. It leaves debris and a
 * glowing scar that cools over a couple of seconds. Meteors are heavy, so the force field bends
 * them only a little, but a strong attractor visibly curves one, and can swallow it.
 *
 * What it listens to:
 * - the force field (acceleration at the head, scaled down: heavy things turn slowly)
 * - the `wind` context (meteors lean with it when it blows)
 * - the `rainEater` and `singularity` contexts (a meteor that enters their body lands there)
 * - elements tagged `ledge` (a meteor crossing the top edge from above lands on it)
 *
 * What it tells the others: the `meteors` context (in flight, impacts so far), a `meteor:impact`
 * event for every landing, `page:hit` when one lands on an element, a short flash and one shock
 * ring for big impacts only.
 *
 * Keys: `m` sends a meteor to the pointer (or a random spot when it is not on the stage).
 */
export class Meteors extends Effect<MeteorsContext> {
    public effectName: string = 'meteors';

    public static readonly INTERVAL_MIN_MS = 2500;
    public static readonly INTERVAL_MAX_MS = 7000;
    public static readonly SPEED = 1;
    public static readonly PAGE_INTERACTION = true;
    public static readonly SHOCK = true;

    private static readonly MAX_IN_FLIGHT = 4;
    private static readonly SPEED_MIN = 0.7;
    private static readonly SPEED_MAX = 1.2;
    /** Meteors are heavy: the force field accelerates them by this share of what a light thing feels. */
    private static readonly FORCE_SCALE = 0.35;
    private static readonly TRAIL_POINTS = 40;
    private static readonly GROUND_MARGIN = 8;
    private static readonly MAX_SPARKS = 500;
    private static readonly SPARK_GRAVITY = 0.0003;
    private static readonly DEBRIS_GRAVITY = 0.0016;
    private static readonly SCAR_MS = 2500;
    private static readonly MAX_SCARS = 10;
    private static readonly FADE_MS = 280;
    private static readonly FLASH_MS = 200;
    private static readonly FLASH_PEAK = 0.25;
    private static readonly BIG_POWER = 0.6;

    private readonly intervalMin: number;
    private readonly intervalMax: number;
    private readonly speed: number;
    private readonly pageInteraction: boolean;
    private readonly shock: boolean;

    private readonly meteors: Meteor[] = [];
    private readonly scars: Scar[] = [];
    private readonly context: MeteorsContext = { meteors: 0, impacts: 0 };
    private impacts = 0;
    private countdown = 0;
    private seeded = false;
    /** 0..1, decays over FLASH_MS; simulation state, read by onRender. */
    private flash = 0;
    private flashPeak = 0;

    // Sparks and debris, structure-of-arrays.
    private sparkCount = 0;
    private readonly sx = new Float32Array(Meteors.MAX_SPARKS);
    private readonly sy = new Float32Array(Meteors.MAX_SPARKS);
    private readonly svx = new Float32Array(Meteors.MAX_SPARKS);
    private readonly svy = new Float32Array(Meteors.MAX_SPARKS);
    private readonly slife = new Float32Array(Meteors.MAX_SPARKS);
    private readonly smax = new Float32Array(Meteors.MAX_SPARKS);
    private readonly ssize = new Float32Array(Meteors.MAX_SPARKS);
    /** Where a debris spark bounces; unused by trail sparks. */
    private readonly sfloor = new Float32Array(Meteors.MAX_SPARKS);
    /** 0 trail spark, 1 debris, 2 debris that has bounced. */
    private readonly skind = new Uint8Array(Meteors.MAX_SPARKS);

    private readonly force: Vector3 = { x: 0, y: 0 };
    private tailGraphics!: Graphics;
    private sparkGraphics!: Graphics;
    private scarGraphics!: Graphics;
    // Scratch for drawing a tail.
    private readonly px = new Float32Array(Meteors.TRAIL_POINTS + 2);
    private readonly py = new Float32Array(Meteors.TRAIL_POINTS + 2);
    private readonly pl = new Float32Array(Meteors.TRAIL_POINTS + 2);
    private readonly lx = new Float32Array(Meteors.TRAIL_POINTS + 2);
    private readonly ly = new Float32Array(Meteors.TRAIL_POINTS + 2);

    constructor(options: MeteorsOptions = {}) {
        super();
        this.intervalMin = Math.max(50, options.intervalMin ?? Meteors.INTERVAL_MIN_MS);
        this.intervalMax = Math.max(this.intervalMin, options.intervalMax ?? Meteors.INTERVAL_MAX_MS);
        this.speed = clamp(options.speed ?? Meteors.SPEED, 0.1, 4);
        this.pageInteraction = options.pageInteraction ?? Meteors.PAGE_INTERACTION;
        this.shock = options.shock ?? Meteors.SHOCK;
    }

    public initialize(): void {
        this.scarGraphics = new Graphics();
        this.tailGraphics = new Graphics();
        this.sparkGraphics = new Graphics();
        for (const g of [this.scarGraphics, this.tailGraphics, this.sparkGraphics]) {
            g.blendMode = 'add';
            this.host.pixi.addChild(g);
        }
    }

    public onTick(tick: TickContext): EffectContext<MeteorsContext> {
        const dt = tick.timeDelta;
        const width = tick.stage.width;
        const height = tick.stage.height;

        if (!this.seeded) {
            this.seeded = true;
            this.countdown = randomNumber(0.3, 1) * this.intervalMin;
        }

        // Arrivals.
        this.countdown -= dt;
        if (this.countdown <= 0) {
            this.countdown = randomNumber(this.intervalMin, this.intervalMax);
            this.launch(tick, width, height, undefined, undefined, undefined);
        }
        if (tick.justPressedKeys?.includes('m')) {
            const mouse = tick.mousePosition;
            if (mouse && mouse.x >= 0 && mouse.x <= width && mouse.y >= 0 && mouse.y <= height) {
                this.launch(tick, width, height, mouse.x, mouse.y, 0.8);
            } else {
                this.launch(tick, width, height, randomNumber(0.1, 0.9) * width, randomNumber(0.5, 1) * height, 0.8);
            }
        }

        // Flight.
        for (let i = this.meteors.length - 1; i >= 0; i--) {
            const m = this.meteors[i];
            if (m.landed) {
                m.fade -= dt / Meteors.FADE_MS;
                if (m.fade <= 0) {
                    this.meteors.splice(i, 1);
                }
                continue;
            }
            if (!this.fly(m, tick, dt, width, height)) {
                // Left the stage sideways or far below: gone, no impact.
                this.meteors.splice(i, 1);
            }
        }

        this.stepSparks(dt, tick.budget.budget);

        for (let i = this.scars.length - 1; i >= 0; i--) {
            this.scars[i].age += dt;
            if (this.scars[i].age >= Meteors.SCAR_MS) {
                this.scars.splice(i, 1);
            }
        }
        this.flash = Math.max(0, this.flash - dt / Meteors.FLASH_MS);

        let inFlight = 0;
        for (const m of this.meteors) {
            if (!m.landed) {
                inFlight++;
            }
        }
        this.context.meteors = inFlight;
        this.context.impacts = this.impacts;
        return this.publish(this.context);
    }

    /** Starts a meteor. With a target it is aimed to arrive there; without, it comes from a random top position. */
    private launch(tick: TickContext, width: number, height: number, targetX: number | undefined, targetY: number | undefined, power: number | undefined): void {
        let inFlight = 0;
        for (const m of this.meteors) {
            if (!m.landed) {
                inFlight++;
            }
        }
        if (inFlight >= Meteors.MAX_IN_FLIGHT) {
            return;
        }

        // Lean with the wind when there is one: 0.5 is an even chance of either side.
        const wind = tick.read('wind');
        const lean = wind && typeof wind.x === 'number' ? clamp(wind.x * 300, -0.35, 0.35) : 0;
        const side = Math.random() < 0.5 + lean ? 1 : -1;
        const angle = (randomNumber(20, 45) * Math.PI) / 180;
        const dirX = Math.sin(angle) * side;
        const dirY = Math.cos(angle);
        const speed = randomNumber(Meteors.SPEED_MIN, Meteors.SPEED_MAX) * this.speed;

        const p = power ?? (Math.random() < 0.12 ? randomNumber(0.8, 1) : randomNumber(0.2, 0.5));
        const startY = -randomNumber(10, 40);
        let startX: number;
        if (targetX !== undefined && targetY !== undefined) {
            startX = targetX - (dirX / dirY) * (targetY - startY);
        } else {
            const landX = randomNumber(0.08, 0.92) * width;
            startX = clamp(landX - (dirX / dirY) * (height - startY), -40, width + 40);
        }

        const points = Meteors.TRAIL_POINTS;
        const m: Meteor = {
            x: startX,
            y: startY,
            vx: dirX * speed,
            vy: dirY * speed,
            power: p,
            tailLength: 120 + 260 * p,
            trailX: new Float32Array(points),
            trailY: new Float32Array(points),
            trailHead: points - 1,
            fade: 1,
            landed: false,
        };
        // The tail already trails behind it when it appears, as if it had been falling for a while.
        const step = 1000 / 60;
        for (let i = 0; i < points; i++) {
            const back = points - 1 - i;
            m.trailX[i] = startX - m.vx * step * back;
            m.trailY[i] = startY - m.vy * step * back;
        }
        this.meteors.push(m);
    }

    /** Advances one meteor and resolves what it hits. Returns false when it has left for good. */
    private fly(m: Meteor, tick: TickContext, dt: number, width: number, height: number): boolean {
        const fromX = m.x;
        const fromY = m.y;

        tick.forces.sample(m.x, m.y, this.force, this.effectName);
        m.vx += this.force.x * Meteors.FORCE_SCALE * dt;
        m.vy += this.force.y * Meteors.FORCE_SCALE * dt;
        m.x += m.vx * dt;
        m.y += m.vy * dt;

        const segX = m.x - fromX;
        const segY = m.y - fromY;
        let bestT = 2;
        let kind = 0; // 1 body, 2 ledge, 3 ground
        let anchor = '';

        // 1. Another effect's body.
        const eater = tick.read('rainEater');
        if (eater && !eater.exploded && eater.headPosition) {
            const t = segmentHit(fromX, fromY, segX, segY, eater.headPosition.x, eater.headPosition.y, eater.radius);
            if (t < bestT) {
                bestT = t;
                kind = 1;
            }
        }
        const hole = tick.read('singularity');
        if (hole && !hole.collapsed && hole.position) {
            const t = segmentHit(fromX, fromY, segX, segY, hole.position.x, hole.position.y, hole.radius);
            if (t < bestT) {
                bestT = t;
                kind = 1;
            }
        }

        // 2. The top edge of a ledge, crossed from above.
        if (this.pageInteraction && segY > 0) {
            for (const rect of tick.stage.tagged('ledge')) {
                if (fromY < rect.y && m.y >= rect.y) {
                    const t = (rect.y - fromY) / segY;
                    const x = fromX + segX * t;
                    if (t < bestT && x >= rect.x && x <= rect.x + rect.width) {
                        bestT = t;
                        kind = 2;
                        anchor = rect.name;
                    }
                }
            }
        }

        // 3. The ground.
        const groundY = height - Meteors.GROUND_MARGIN;
        if (m.y >= groundY && segY > 0) {
            const t = clamp((groundY - fromY) / segY, 0, 1);
            if (t < bestT) {
                bestT = t;
                kind = 3;
            }
        }

        if (kind !== 0) {
            const hx = fromX + segX * bestT;
            const hy = fromY + segY * bestT;
            m.x = hx;
            m.y = hy;
            this.pushTrail(m);
            m.landed = true;
            this.impact(m, hx, hy, kind === 3 || kind === 1 ? groundY : hy, tick);
            if (kind === 2) {
                tick.emit('page:hit', { x: hx, y: hy, anchor, edge: true, kind: 'meteor' });
            }
            return true;
        }

        this.pushTrail(m);
        this.shed(m, dt, tick.budget.budget);

        // Gone sideways or far below: silent. (A meteor that has not yet entered is not "leaving".)
        if ((m.x < -150 && m.vx <= 0) || (m.x > width + 150 && m.vx >= 0) || m.y > height + 120) {
            return false;
        }
        return true;
    }

    private pushTrail(m: Meteor): void {
        const next = (m.trailHead + 1) % m.trailX.length;
        m.trailX[next] = m.x;
        m.trailY[next] = m.y;
        m.trailHead = next;
    }

    /** Sparks left behind on the path. */
    private shed(m: Meteor, dt: number, budget: number): void {
        const rate = (0.04 + 0.05 * m.power) * dt; // expected sparks this tick
        let count = Math.floor(rate);
        if (Math.random() < rate - count) {
            count++;
        }
        for (let i = 0; i < count; i++) {
            if (this.sparkCount >= Meteors.MAX_SPARKS * Math.max(0.15, budget)) {
                return;
            }
            const k = this.addSpark();
            if (k < 0) {
                return;
            }
            const along = Math.random();
            this.sx[k] = m.x - m.vx * dt * along + randomNumber(-2, 2);
            this.sy[k] = m.y - m.vy * dt * along + randomNumber(-2, 2);
            this.svx[k] = -m.vx * randomNumber(0.04, 0.14) + randomNumber(-0.03, 0.03);
            this.svy[k] = -m.vy * randomNumber(0.04, 0.14) + randomNumber(-0.03, 0.03);
            this.smax[k] = this.slife[k] = randomNumber(350, 800);
            this.ssize[k] = randomNumber(0.6, 1.1);
            this.skind[k] = 0;
        }
    }

    /** Index of a free spark slot (count is increased), or -1 when the arrays are full. */
    private addSpark(): number {
        if (this.sparkCount >= Meteors.MAX_SPARKS) {
            return -1;
        }
        return this.sparkCount++;
    }

    private impact(m: Meteor, x: number, y: number, floorY: number, tick: TickContext): void {
        const power = m.power;
        this.impacts++;
        tick.emit('meteor:impact', { x, y, power });

        // Debris in a fan opposite to the incoming direction.
        const speed = Math.hypot(m.vx, m.vy) || 1;
        const base = Math.atan2(-m.vy / speed, -m.vx / speed);
        const budget = Math.max(0.2, tick.budget.budget);
        const count = Math.round((10 + 30 * power) * budget);
        for (let i = 0; i < count; i++) {
            const k = this.addSpark();
            if (k < 0) {
                break;
            }
            const a = base + randomNumber(-1.05, 1.05);
            const s = randomNumber(0.1, 0.45 + 0.3 * power);
            this.sx[k] = x + randomNumber(-3, 3);
            this.sy[k] = y - 1;
            this.svx[k] = Math.cos(a) * s;
            this.svy[k] = Math.min(-0.05, Math.sin(a) * s);
            this.smax[k] = this.slife[k] = randomNumber(500, 1100);
            this.ssize[k] = randomNumber(0.7, 1.2);
            this.sfloor[k] = floorY;
            this.skind[k] = 1;
        }

        if (this.scars.length >= Meteors.MAX_SCARS) {
            this.scars.shift();
        }
        this.scars.push({ x, y, power, age: 0 });

        if (power > Meteors.BIG_POWER) {
            this.flashPeak = Meteors.FLASH_PEAK * power;
            this.flash = 1;
            if (this.shock) {
                tick.forces.shock(this.effectName, { x, y, strength: 0.003, maxRadius: 260, width: 50 });
            }
        }
    }

    private stepSparks(dt: number, budget: number): void {
        const limit = Math.max(40, Math.floor(Meteors.MAX_SPARKS * budget));
        for (let i = this.sparkCount - 1; i >= 0; i--) {
            this.slife[i] -= dt;
            let dead = this.slife[i] <= 0;
            if (!dead) {
                const kind = this.skind[i];
                this.svy[i] += (kind === 0 ? Meteors.SPARK_GRAVITY : Meteors.DEBRIS_GRAVITY) * dt;
                this.sx[i] += this.svx[i] * dt;
                this.sy[i] += this.svy[i] * dt;
                if (kind !== 0 && this.sy[i] >= this.sfloor[i] && this.svy[i] > 0) {
                    if (kind === 1) {
                        this.sy[i] = this.sfloor[i];
                        this.svy[i] *= -0.38;
                        this.svx[i] *= 0.7;
                        this.skind[i] = 2;
                    } else {
                        dead = true;
                    }
                }
                // Over the limit (the frame budget dropped): the oldest-looking ones go first.
                if (this.sparkCount > limit && this.slife[i] < this.smax[i] * 0.5) {
                    dead = true;
                }
            }
            if (dead) {
                this.removeSpark(i);
            }
        }
    }

    private removeSpark(i: number): void {
        const last = --this.sparkCount;
        if (i !== last) {
            this.sx[i] = this.sx[last];
            this.sy[i] = this.sy[last];
            this.svx[i] = this.svx[last];
            this.svy[i] = this.svy[last];
            this.slife[i] = this.slife[last];
            this.smax[i] = this.smax[last];
            this.ssize[i] = this.ssize[last];
            this.sfloor[i] = this.sfloor[last];
            this.skind[i] = this.skind[last];
        }
    }

    public onRender(timed: TimedContext): void {
        const theme = timed.theme;
        const lead = timed.alpha * timed.tickDelta;

        // Scars: a small hot glow that cools from ink to accentAlt to nothing.
        const scars = this.scarGraphics;
        scars.clear();
        for (const s of this.scars) {
            const cool = clamp(s.age / Meteors.SCAR_MS, 0, 1);
            const heat = 1 - cool;
            const colour = mixColor(theme.ink, theme.accentAlt, clamp(cool * 1.6, 0, 1));
            const r = (7 + 16 * s.power) * (0.45 + 0.55 * Math.sqrt(heat));
            scars.ellipse(s.x, s.y, r * 1.8, r * 0.7).fill({ color: theme.accentAlt, alpha: 0.12 * heat });
            scars.ellipse(s.x, s.y, r, r * 0.4).fill({ color: colour, alpha: 0.3 * heat });
            scars.ellipse(s.x, s.y, r * 0.4 * heat + 1, r * 0.16 * heat + 0.5).fill({ color: theme.ink, alpha: 0.75 * heat * heat });
        }

        // Tails and heads.
        const g = this.tailGraphics;
        g.clear();
        for (const m of this.meteors) {
            const flying = !m.landed;
            const fade = m.landed ? clamp(m.fade, 0, 1) : 1;
            const hx = flying ? m.x + m.vx * lead : m.x;
            const hy = flying ? m.y + m.vy * lead : m.y;
            const n = this.gatherTail(m, hx, hy);
            if (n >= 2 && fade > 0) {
                this.drawRibbon(g, n, m, theme, fade, 1);
                this.drawRibbon(g, n, m, theme, fade, 0);
            }
            if (flying) {
                const p = m.power;
                const halo = 10 + 16 * p;
                for (let layer = 0; layer < 4; layer++) {
                    const k = 1 - layer * 0.22;
                    g.circle(hx, hy, halo * k).fill({ color: mixColor(theme.accent, theme.ink, layer / 4), alpha: 0.03 + 0.015 * layer });
                }
                g.circle(hx, hy, 2 + 2.2 * p).fill({ color: theme.ink, alpha: 0.95 });
            }
        }

        // Sparks and debris.
        const sg = this.sparkGraphics;
        sg.clear();
        for (let i = 0; i < this.sparkCount; i++) {
            const t = clamp(this.slife[i] / this.smax[i], 0, 1);
            const age = this.smax[i] - this.slife[i];
            const twinkle = 0.6 + 0.4 * Math.sin(age * 0.045 + i * 1.7);
            const a = t * twinkle;
            if (a < 0.03) {
                continue;
            }
            const warm = this.skind[i] === 0 ? mixColor(theme.accent, theme.ink, t) : mixColor(theme.accentAlt, theme.ink, t * t);
            sg.circle(this.sx[i] + this.svx[i] * lead, this.sy[i] + this.svy[i] * lead, this.ssize[i]).fill({ color: warm, alpha: a * 0.9 });
        }

        if (this.flash > 0) {
            this.host.surfaces.flash.value += this.flash * this.flashPeak;
        }
    }

    /** Fills px/py/pl with the head and the recent path, newest first, stopping at the tail length. Returns the count. */
    private gatherTail(m: Meteor, hx: number, hy: number): number {
        const size = m.trailX.length;
        this.px[0] = hx;
        this.py[0] = hy;
        this.pl[0] = 0;
        let n = 1;
        for (let k = 1; k < size && n < this.px.length; k++) {
            const idx = (m.trailHead - k + size * 2) % size;
            const x = m.trailX[idx];
            const y = m.trailY[idx];
            const px = this.px[n - 1];
            const py = this.py[n - 1];
            const d = Math.hypot(px - x, py - y);
            if (d < 0.5) {
                continue;
            }
            const total = this.pl[n - 1] + d;
            if (total >= m.tailLength) {
                const f = (m.tailLength - this.pl[n - 1]) / d;
                this.px[n] = px + (x - px) * f;
                this.py[n] = py + (y - py) * f;
                this.pl[n] = m.tailLength;
                n++;
                break;
            }
            this.px[n] = x;
            this.py[n] = y;
            this.pl[n] = total;
            n++;
        }
        return n;
    }

    /** A tapered strip along the gathered path, coloured ink to accent to accentAlt. `glow` selects the wide faint layer. */
    private drawRibbon(g: Graphics, n: number, m: Meteor, theme: TimedContext['theme'], fade: number, glow: number): void {
        const px = this.px;
        const py = this.py;
        const lx = this.lx;
        const ly = this.ly;
        const total = Math.max(1, this.pl[n - 1]);
        const p = m.power;
        // Offsets (unit normal) at each point, from the direction between its neighbours.
        let nx = 0;
        let ny = 0;
        for (let i = 0; i < n; i++) {
            const a = Math.max(0, i - 1);
            const b = Math.min(n - 1, i + 1);
            const dx = px[a] - px[b];
            const dy = py[a] - py[b];
            const len = Math.hypot(dx, dy);
            if (len > 0.0001) {
                nx = -dy / len;
                ny = dx / len;
            }
            lx[i] = nx;
            ly[i] = ny;
        }
        for (let i = 0; i < n - 1; i++) {
            const t0 = this.pl[i] / total;
            const t1 = this.pl[i + 1] / total;
            const w0 = this.halfWidth(t0, p, glow);
            const w1 = this.halfWidth(t1, p, glow);
            const mid = (t0 + t1) * 0.5;
            const colour = mid < 0.4 ? mixColor(theme.ink, theme.accent, mid / 0.4) : mixColor(theme.accent, theme.accentAlt, (mid - 0.4) / 0.6);
            const falloff = Math.pow(1 - mid, glow ? 1.7 : 1.3);
            const alpha = (glow ? 0.2 : 0.8) * falloff * fade;
            g.moveTo(px[i] + lx[i] * w0, py[i] + ly[i] * w0)
                .lineTo(px[i + 1] + lx[i + 1] * w1, py[i + 1] + ly[i + 1] * w1)
                .lineTo(px[i + 1] - lx[i + 1] * w1, py[i + 1] - ly[i + 1] * w1)
                .lineTo(px[i] - lx[i] * w0, py[i] - ly[i] * w0)
                .closePath()
                .fill({ color: colour, alpha });
        }
    }

    /** Half the ribbon width at fraction t of the tail: thin at the head, a little wider at the end. */
    private halfWidth(t: number, power: number, glow: number): number {
        return glow ? lerp(2.2 + 3 * power, 6 + 7 * power, t) : lerp(0.5 + 0.9 * power, 1.2 + 1.4 * power, t);
    }

    public cleanup(): void {
        this.scarGraphics?.destroy();
        this.tailGraphics?.destroy();
        this.sparkGraphics?.destroy();
        this.meteors.length = 0;
        this.scars.length = 0;
        this.sparkCount = 0;
        this.impacts = 0;
        this.countdown = 0;
        this.seeded = false;
        this.flash = 0;
        this.flashPeak = 0;
        this.context.meteors = 0;
        this.context.impacts = 0;
    }
}

/**
 * Where along the segment (from + t·seg, t in 0..1) it first comes within `radius` of a point, or 2 when it does not.
 * Testing the whole segment means a fast meteor cannot pass through a body between two ticks.
 */
function segmentHit(fx: number, fy: number, sx: number, sy: number, cx: number, cy: number, radius: number): number {
    const len2 = sx * sx + sy * sy;
    const dx = cx - fx;
    const dy = cy - fy;
    const closest = len2 > 0 ? clamp((dx * sx + dy * sy) / len2, 0, 1) : 0;
    const ex = fx + sx * closest - cx;
    const ey = fy + sy * closest - cy;
    if (ex * ex + ey * ey > radius * radius) {
        return 2;
    }
    // Already inside at the start: hit at once. Otherwise the entry point on the circle.
    if (dx * dx + dy * dy <= radius * radius) {
        return 0;
    }
    const along = dx * sx + dy * sy;
    const half = Math.sqrt(Math.max(0, radius * radius - (ex * ex + ey * ey))) * Math.sqrt(len2);
    return clamp((along - half) / Math.max(len2, 1e-9), 0, 1);
}
