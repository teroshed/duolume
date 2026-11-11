import { Graphics } from 'pixi.js';
import { Effect } from '../../src/Effect';
import { clamp, distanceV2, mixColor, randomNumber } from '../../src/math';
import type { EffectContext, TickContext, TimedContext, Vector3 } from '../../src/types';
// Type-only imports bring the shared context/event shapes into the registries.
import type { ChargePoint, LightningStormContext } from '../contracts';

interface LightningBolt {
    start: Vector3;
    end: Vector3;
    /** Milliseconds of simulation time since the bolt was spawned. */
    age: number;
    maxAge: number;
    segments: Vector3[];
    branches: Vector3[][];
}

/**
 * The original LightningStorm, drawn with Pixi Graphics.
 *
 * Charge builds wherever rain lands (`rain:landed`). A fully charged point discharges: into the
 * rain eater if it is close enough, else into another charged point, else up into the sky.
 * Every bolt is announced with a `lightning:strike` event and a shock ring.
 */
export class LightningStorm extends Effect<LightningStormContext> {
    public effectName: string = 'lightningStorm';

    private static readonly CHARGE_RADIUS = 50; // How close landings need to be to add to charge
    // The original added 5 per drop. Landings are reported far more densely now, so each counts for less.
    private static readonly CHARGE_PER_DROP = 2;
    private static readonly CHARGE_PER_KEY = 12;
    private static readonly CHARGE_THRESHOLD = 100; // When to spawn lightning
    private static readonly CHARGE_DECAY_RATE = 0.999; // Per CHARGE_DECAY_STEP_MS
    private static readonly CHARGE_DECAY_STEP_MS = 16.667;
    private static readonly LIGHTNING_DURATION_MS = 170;
    private static readonly MAX_CHARGE_POINTS = 20;
    private static readonly MAX_ACTIVE_BOLTS = 6;
    private static readonly LIGHTNING_BRANCH_CHANCE = 0.3;
    private static readonly EATER_STRIKE_RANGE = 420;
    private static readonly FLASH_DURATION_MS = 220;
    private static readonly FLASH_STRENGTH = 0.6;
    /** Quiet time between bolts that fire on their own, so a storm reads as strikes rather than a strobe. */
    private static readonly STRIKE_INTERVAL_MIN_MS = 1200;
    private static readonly STRIKE_INTERVAL_MAX_MS = 3800;
    /** How often a bolt that could reach the rain eater goes for it. */
    private static readonly EATER_STRIKE_CHANCE = 0.6;

    private readonly chargePoints: ChargePoint[] = [];
    private readonly activeLightning: LightningBolt[] = [];
    /** Scratch list of points at threshold, rebuilt on each spawn attempt. */
    private readonly ready: ChargePoint[] = [];
    private readonly context: LightningStormContext;
    /** 1 at a strike, decays to 0. Simulation state: advanced in onTick, only read in onRender. */
    private flash = 0;
    private spawnedThisTick = false;
    private cooldown = 0;

    private boltGraphics!: Graphics;
    private chargeGraphics!: Graphics;

    constructor() {
        super();
        this.context = { chargePoints: this.chargePoints, activeLightning: 0 };
    }

    public initialize(): void {
        this.boltGraphics = new Graphics();
        this.boltGraphics.blendMode = 'add';
        this.chargeGraphics = new Graphics();
        this.chargeGraphics.blendMode = 'add';
        this.host.pixi.addChild(this.chargeGraphics);
        this.host.pixi.addChild(this.boltGraphics);
    }

    private addChargeAtPosition(position: Vector3, amount: number = LightningStorm.CHARGE_PER_DROP): void {
        for (const chargePoint of this.chargePoints) {
            if (distanceV2(chargePoint.position, position) < LightningStorm.CHARGE_RADIUS) {
                chargePoint.charge = Math.min(chargePoint.maxCharge, chargePoint.charge + amount);
                return;
            }
        }

        if (this.chargePoints.length < LightningStorm.MAX_CHARGE_POINTS) {
            this.chargePoints.push({
                position: { x: position.x, y: position.y },
                charge: amount,
                maxCharge: LightningStorm.CHARGE_THRESHOLD,
            });
        }
    }

    private createLightningBolt(start: Vector3, end: Vector3): LightningBolt {
        const segments: Vector3[] = [];
        const branches: Vector3[][] = [];

        const length = distanceV2(start, end);
        // Long bolts get more segments and more wobble, otherwise they read as straight lines.
        const numSegments = length > 400 ? 12 : 8;
        const jitter = clamp(length * 0.045, 8, 34);

        for (let i = 0; i <= numSegments; i++) {
            const t = i / numSegments;
            // The ends stay exactly on their targets so a bolt visibly meets what it hits.
            const edge = i === 0 || i === numSegments;
            const x = start.x + (end.x - start.x) * t + (edge ? 0 : randomNumber(-jitter, jitter));
            const y = start.y + (end.y - start.y) * t + (edge ? 0 : randomNumber(-jitter, jitter));
            segments.push({ x, y });

            if (!edge && Math.random() < LightningStorm.LIGHTNING_BRANCH_CHANCE) {
                const branch: Vector3[] = [{ x, y }];
                const branchLength = Math.round(randomNumber(3, 6));
                for (let j = 1; j < branchLength; j++) {
                    branch.push({ x: x + randomNumber(-30, 30), y: y + randomNumber(-30, 30) });
                }
                branches.push(branch);
            }
        }

        return { start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y }, age: 0, maxAge: LightningStorm.LIGHTNING_DURATION_MS, segments, branches };
    }

    private spawnLightningBetweenChargedPoints(tickContext: TickContext): void {
        if (this.spawnedThisTick || this.activeLightning.length >= LightningStorm.MAX_ACTIVE_BOLTS) {
            return;
        }

        const ready = this.ready;
        ready.length = 0;
        for (const cp of this.chargePoints) {
            if (cp.charge >= LightningStorm.CHARGE_THRESHOLD) {
                ready.push(cp);
            }
        }
        if (ready.length === 0) {
            return;
        }

        // The eater is preferred whenever any ready point can reach it; the nearest point fires.
        const eater = tickContext.read('rainEater');
        if (eater && !eater.exploded && Math.random() < LightningStorm.EATER_STRIKE_CHANCE) {
            let nearest: ChargePoint | undefined;
            let nearestDistance = LightningStorm.EATER_STRIKE_RANGE;
            for (const cp of ready) {
                const d = distanceV2(cp.position, eater.headPosition);
                if (d <= nearestDistance) {
                    nearest = cp;
                    nearestDistance = d;
                }
            }
            if (nearest) {
                this.fire(tickContext, nearest.position, eater.headPosition, true, false);
                nearest.charge = 0;
                return;
            }
        }

        if (ready.length >= 2) {
            const point1 = ready[Math.floor(Math.random() * ready.length)];
            const point2 = ready[Math.floor(Math.random() * ready.length)];
            if (point1 !== point2) {
                this.fire(tickContext, point1.position, point2.position, false, false);
                point1.charge = 0;
                point2.charge = 0;
            }
        } else {
            const point = ready[0];
            const sky = { x: point.position.x + randomNumber(-100, 100), y: 0 };
            this.fire(tickContext, point.position, sky, false, true);
            point.charge = 0;
        }
    }

    /** Creates the bolt and tells the rest of the engine about it. */
    private fire(tickContext: TickContext, start: Vector3, end: Vector3, hitEater: boolean, toSky: boolean): void {
        this.activeLightning.push(this.createLightningBolt(start, end));
        this.spawnedThisTick = true;
        this.flash = 1;

        tickContext.emit('lightning:strike', { x: end.x, y: end.y, fromX: start.x, fromY: start.y, hitEater });
        // A ring centred on the sky point would sit off-screen, so it starts where the bolt does.
        const ring = toSky ? start : end;
        tickContext.forces.shock(this.effectName, { x: ring.x, y: ring.y, strength: 0.0035, maxRadius: 300, width: 60 });
    }

    public onTick(tickContext: TickContext): EffectContext<LightningStormContext> {
        const dt = tickContext.timeDelta;
        const keys = tickContext.keysPressed;
        const dims = tickContext.canvasDimensions;
        this.spawnedThisTick = false;

        this.flash = Math.max(0, this.flash - dt / LightningStorm.FLASH_DURATION_MS);

        this.cooldown = Math.max(0, this.cooldown - dt);

        if (keys.includes('e') && dims) {
            for (let i = 0; i < 3; i++) {
                this.addChargeAtPosition({ x: randomNumber(0, dims.x), y: dims.y - 20 }, LightningStorm.CHARGE_PER_KEY);
            }
            this.spawnLightningBetweenChargedPoints(tickContext);
        }

        for (const event of tickContext.events('rain:landed')) {
            for (const point of event.payload.points) {
                this.addChargeAtPosition(point);
            }
        }

        // Space discharges the two most charged points now, ready or not.
        if (tickContext.justPressedKeys?.includes('space') && this.chargePoints.length >= 2) {
            let first: ChargePoint | undefined;
            let second: ChargePoint | undefined;
            for (const cp of this.chargePoints) {
                if (!first || cp.charge > first.charge) {
                    second = first;
                    first = cp;
                } else if (!second || cp.charge > second.charge) {
                    second = cp;
                }
            }
            if (first && second) {
                first.charge = first.maxCharge;
                second.charge = second.maxCharge;
                this.spawnLightningBetweenChargedPoints(tickContext);
            }
        }

        // Checked before the decay below. The original decayed first, which took a point that had
        // just reached the threshold back under it, so only the `e` key ever fired a bolt.
        if (this.cooldown <= 0) {
            this.spawnLightningBetweenChargedPoints(tickContext);
            if (this.spawnedThisTick) {
                this.cooldown = randomNumber(
                    LightningStorm.STRIKE_INTERVAL_MIN_MS,
                    LightningStorm.STRIKE_INTERVAL_MAX_MS,
                );
            }
        }

        const decay = Math.pow(LightningStorm.CHARGE_DECAY_RATE, dt / LightningStorm.CHARGE_DECAY_STEP_MS);
        for (let i = this.chargePoints.length - 1; i >= 0; i--) {
            this.chargePoints[i].charge *= decay;
            if (this.chargePoints[i].charge < 1) {
                this.chargePoints.splice(i, 1);
            }
        }

        for (let i = this.activeLightning.length - 1; i >= 0; i--) {
            const bolt = this.activeLightning[i];
            bolt.age += dt;
            if (bolt.age >= bolt.maxAge) {
                this.activeLightning.splice(i, 1);
            }
        }

        this.context.activeLightning = this.activeLightning.length;
        return this.publish(this.context);
    }

    public onRender(timedContext: TimedContext): void {
        const theme = timedContext.theme;

        const charges = this.chargeGraphics;
        charges.clear();
        for (const cp of this.chargePoints) {
            const ratio = cp.charge / cp.maxCharge;
            if (ratio < 0.08) {
                continue;
            }
            // The original drew a flat disc. Layered faint rings read as a glow instead, and stay quiet
            // until the point is nearly ready.
            const x = cp.position.x;
            const y = cp.position.y;
            charges.circle(x, y, 18 * ratio).fill({ color: theme.accentAlt, alpha: 0.05 * ratio });
            charges.circle(x, y, 10 * ratio).fill({ color: theme.accentAlt, alpha: 0.1 * ratio });
            charges
                .circle(x, y, 1.5 + 2.5 * ratio)
                .fill({ color: ratio > 0.8 ? theme.ink : theme.accent, alpha: 0.35 + 0.5 * ratio });
        }

        const g = this.boltGraphics;
        g.clear();
        const glow = mixColor(theme.accentAlt, theme.ink, 0.5);
        const tint = mixColor(theme.accentAlt, theme.ink, 0.25);
        for (const bolt of this.activeLightning) {
            const age = bolt.age / bolt.maxAge;
            const dip = (age - 0.4) / 0.08;
            // Brief dim near 40% of the life; depends on age only, so a paused frame is stable.
            const fade = (1 - age) * (1 - 0.45 * Math.exp(-dip * dip));

            tracePath(g, bolt.segments);
            g.stroke({ width: 8, color: glow, alpha: 0.3 * fade, cap: 'round', join: 'round' });
            tracePath(g, bolt.segments);
            g.stroke({ width: 3, color: theme.ink, alpha: 0.9 * fade, cap: 'round', join: 'round' });
            tracePath(g, bolt.segments);
            g.stroke({ width: 1, color: tint, alpha: fade, cap: 'round', join: 'round' });

            if (bolt.branches.length === 0) {
                continue;
            }
            for (const branch of bolt.branches) {
                tracePath(g, branch);
            }
            g.stroke({ width: 2, color: glow, alpha: 0.6 * fade, cap: 'round', join: 'round' });
        }

        if (this.flash > 0) {
            this.host.surfaces.flash.value += this.flash * LightningStorm.FLASH_STRENGTH;
        }
    }

    public cleanup(): void {
        this.boltGraphics?.destroy();
        this.chargeGraphics?.destroy();
        this.chargePoints.length = 0;
        this.activeLightning.length = 0;
        this.ready.length = 0;
        this.flash = 0;
        this.cooldown = 0;
        this.context.activeLightning = 0;
    }
}

function tracePath(g: Graphics, points: readonly Vector3[]): void {
    g.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
        g.lineTo(points[i].x, points[i].y);
    }
}
