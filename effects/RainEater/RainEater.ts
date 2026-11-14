import { Effect } from '../../src/Effect';
import { approach, clamp, distanceV2, randomNumber } from '../../src/math';
import type { EffectContext, TickContext, TimedContext, Vector3 } from '../../src/types';
import type { RainEaterContext } from '../contracts';
import { CrystalBody } from '../Crystal/CrystalBody';
import { Head } from './Head';

export interface RainEaterOptions {
    /** Radius of the crystal in stage pixels. */
    radius?: number;
    /**
     * DOM anchor names the head may live beside. It settles next to whichever is most in
     * view and follows the page as it scrolls. Without any, it roams freely as in the original.
     */
    homes?: readonly string[];
    /** Where on the home anchor to sit, 0..1 across and down. Default: centre. */
    homeAlign?: Vector3;
    /** Energy gained per droplet eaten. */
    energyPerDrop?: number;
    /** Drift slowly and smoothly instead of darting about: a low top speed, gentle pushes, no sudden turns. */
    calm?: boolean;
}

/**
 * The original RainEater, with its head rebuilt as a Three.js crystal.
 *
 * It is the other half of the rain: a wandering head that eats droplets that come close.
 * The two effects never call each other and are drawn by different renderers; they meet
 * through the engine:
 *
 *   rain eater → rain   publishes `headPosition` and `eatDistance` (the rain does the eating,
 *                       as before), and adds an attraction force that bends nearby droplets in.
 *   rain → rain eater   `rain:eaten` events charge it. Fully charged it explodes: a shock ring
 *                       goes into the force field (throwing the rain outward), a
 *                       `rainEater:exploded` event goes out (the click-explosion effect answers
 *                       with sparks), and the crystal breaks into shards that fly, catch on
 *                       page elements, and come home.
 *   strikes, impacts    a `lightning:strike` that ends on the head, or a `meteor:impact` within a
 *                       radius and 24 px of it, is a big meal: it charges the head by a quarter
 *                       (a meteor by a quarter times 0.5 plus its power).
 *   pixels              the crystal is glass: its shader samples the Pixi layer behind it,
 *                       so droplets are seen refracted through its facets.
 */
export class RainEater extends Effect<RainEaterContext> {
    public effectName: string = 'rainEater';

    public headParticle!: Head;
    public exploded = false;

    public static readonly EAT_DISTANCE = 100;
    public static readonly MAX_ABSOLUTE_VELOCITY_X = 0.3;
    public static readonly MAX_ABSOLUTE_VELOCITY_Y = 0.3;
    public static readonly RANDOM_MAX_ACCELERATION = 0.0001;
    public static readonly RANDOM_MIN_ACCELERATION = -0.0001;
    public static readonly ACCELERATION_CHANGE_INTERVAL = 500;
    /** A calm head: top speed in px/ms, and the largest push it gives itself in px/ms². */
    public static readonly CALM_MAX_VELOCITY = 0.045;
    public static readonly CALM_MAX_ACCELERATION = 0.000012;
    /** Energy lost per millisecond when nothing is being eaten. */
    public static readonly ENERGY_LEAK = 0.000006;
    /** Energy gained when lightning lands on the head. */
    public static readonly ENERGY_PER_STRIKE = 0.25;

    private readonly radius: number;
    private readonly homes: readonly string[];
    private readonly homeAlign: Vector3;
    private readonly energyPerDrop: number;
    private readonly calm: boolean;

    private energy = 0;
    private pulse = 0;
    private spin = 0;
    private spinRate = 0;
    private readonly force: Vector3 = { x: 0, y: 0 };
    private readonly home: Vector3 = { x: 0, y: 0 };
    private readonly context: RainEaterContext;

    private body!: CrystalBody;

    constructor(options: RainEaterOptions = {}) {
        super();
        this.radius = options.radius ?? 46;
        this.homes = options.homes ?? [];
        this.homeAlign = options.homeAlign ?? { x: 0.5, y: 0.5 };
        this.energyPerDrop = options.energyPerDrop ?? 0.0012;
        this.calm = options.calm ?? false;
        this.initializeHead();
        this.context = {
            headPosition: this.headParticle.position,
            velocity: this.headParticle.velocity,
            exploded: false,
            isExploded: false,
            eatDistance: Math.max(this.radius * 1.3, 40),
            radius: this.radius,
            energy: 0,
        };
    }

    public initializeHead(): void {
        this.generateNewHead();
        this.switchAccelerationDirection();
    }

    public generateNewHead(): void {
        const homed = this.homes.length > 0;
        const roaming = this.calm ? RainEater.CALM_MAX_VELOCITY : RainEater.MAX_ABSOLUTE_VELOCITY_X;
        this.headParticle = new Head({
            position: { x: 100, y: 100 },
            size: { x: this.radius * 2, y: this.radius * 2 },
            // A homed head must be able to keep up with a scrolling page.
            maxAbsoluteVelocity: homed
                ? { x: 1.6, y: 1.6 }
                : { x: roaming, y: this.calm ? roaming : RainEater.MAX_ABSOLUTE_VELOCITY_Y },
            priority: 10,
        });
        this.headParticle.margin = homed ? this.radius * 6 : 0;
        this.headParticle.nudge = homed ? 0.035 : undefined;
        if (this.calm) {
            this.headParticle.turns = false;
            this.headParticle.nudge = RainEater.CALM_MAX_VELOCITY * 0.12;
        }
    }

    public switchAccelerationDirection(): void {
        const reach = this.calm ? RainEater.CALM_MAX_ACCELERATION : RainEater.RANDOM_MAX_ACCELERATION;
        this.headParticle.acceleration = { x: randomNumber(-reach, reach), y: randomNumber(-reach, reach) };
    }

    public initialize(): void {
        this.body = new CrystalBody(this.host, { radius: this.radius, shape: 'gem', morph: 0.06 });
    }

    /** How much bigger than its resting size the crystal is right now. */
    private get swell(): number {
        return 1 + this.energy * 0.14 + this.pulse * 0.07;
    }

    public onTick(tickContext: TickContext): EffectContext<RainEaterContext> {
        const head = this.headParticle;
        const dt = tickContext.timeDelta;
        const dims = tickContext.canvasDimensions;

        if (tickContext.totalTickCount === 0 && dims && this.homes.length === 0) {
            head.position.x = dims.x * 0.5;
            head.position.y = dims.y * 0.4;
        }
        this.updateHome(tickContext);

        // What the rain reported eating last tick charges the head.
        for (const event of tickContext.events('rain:eaten')) {
            this.energy += event.payload.count * this.energyPerDrop;
            this.pulse = Math.min(1, this.pulse + 0.25 + event.payload.count * 0.05);
        }
        // A bolt that lands on the head is a big meal.
        for (const event of tickContext.events('lightning:strike')) {
            if (event.payload.hitEater && !this.exploded) {
                this.energy += RainEater.ENERGY_PER_STRIKE;
                this.pulse = 1;
            }
        }
        // So is a meteor: one that comes down on the head reports its impact there.
        for (const event of tickContext.events('meteor:impact')) {
            if (!this.exploded && distanceV2(head.position, event.payload) < this.radius + 24) {
                this.energy += RainEater.ENERGY_PER_STRIKE * (0.5 + event.payload.power);
                this.pulse = 1;
            }
        }
        this.energy = clamp(this.energy - RainEater.ENERGY_LEAK * dt, 0, 1);
        this.pulse = approach(this.pulse, 0, 6, dt);

        if (!this.exploded) {
            // Anything else in the field pushes the head around too: a click's shock ring shoves it.
            tickContext.forces.sample(head.position.x, head.position.y, this.force, this.effectName);
            head.velocity.x += this.force.x * dt * 0.7;
            head.velocity.y += this.force.y * dt * 0.7;

            if ((tickContext.totalTickCount ?? 0) % Math.round(RainEater.ACCELERATION_CHANGE_INTERVAL / 16.7) === 0) {
                this.switchAccelerationDirection();
            }
            const headContext = head.onTick(tickContext);

            const clicked =
                tickContext.mouseJustPressed === true &&
                !tickContext.mouseOnInteractive &&
                tickContext.mousePosition !== undefined &&
                distanceV2(tickContext.mousePosition, head.position) < this.radius * 1.25;

            if (headContext.effectContext.isExploded || this.energy >= 1 || clicked) {
                this.explodeHead(tickContext);
            } else {
                // Hungry: pull nearby rain inward.
                tickContext.forces.add({
                    kind: 'attract',
                    owner: this.effectName,
                    x: head.position.x,
                    y: head.position.y,
                    radius: this.context.eatDistance * 3.2,
                    strength: 0.0011 + this.energy * 0.0009,
                });
            }
        } else if (head.home) {
            // Drift home while in pieces, so it comes back together where it belongs.
            head.position.x = approach(head.position.x, head.home.x, 1.2, dt);
            head.position.y = approach(head.position.y, head.home.y, 1.2, dt);
            head.velocity.x = 0;
            head.velocity.y = 0;
        }

        this.body.tick(tickContext, head.position, this.spin, this.swell, tickContext.stage.tagged('ledge'), this.effectName);
        if (this.exploded && !this.body.scattered) {
            // Every shard that is coming back has arrived: whole enough to eat again.
            this.exploded = false;
            head.reform();
        }

        this.spinRate = approach(this.spinRate, 0.00028 + this.energy * 0.0011 + this.pulse * 0.0006, 3, dt);
        this.spin += this.spinRate * dt;

        const context = this.context;
        context.velocity = head.velocity; // Head replaces its velocity object when it bounces
        context.exploded = this.exploded;
        context.isExploded = this.exploded;
        context.energy = this.energy;
        return this.publish(context);
    }

    public explodeHead(tickContext: TickContext): void {
        if (this.exploded) {
            return;
        }
        const head = this.headParticle;
        this.exploded = true;
        head.explode();
        this.body.explode(head.position, head.velocity, this.spin, this.swell, tickContext.time);
        this.energy = 0;
        const { x, y } = head.position;
        tickContext.forces.shock(this.effectName, { x, y, strength: 0.0065, maxRadius: 640, width: 80 });
        tickContext.emit('rainEater:exploded', { x, y, radius: this.radius });
    }

    private updateHome(tickContext: TickContext): void {
        const head = this.headParticle;
        if (this.homes.length === 0) {
            head.home = undefined;
            return;
        }
        const stage = tickContext.stage;
        const midY = stage.height / 2;
        let best: { x: number; y: number } | undefined;
        let bestScore = Infinity;
        for (const name of this.homes) {
            const anchor = stage.anchor(name);
            if (!anchor || anchor.width <= 0) {
                continue;
            }
            const x = anchor.x + anchor.width * this.homeAlign.x;
            const y = anchor.y + anchor.height * this.homeAlign.y;
            const score = Math.abs(y - midY);
            if (score < bestScore) {
                bestScore = score;
                best = { x, y };
            }
        }
        if (!best) {
            this.home.x = stage.width * 0.72;
            this.home.y = stage.height * 0.42;
        } else {
            this.home.x = best.x;
            this.home.y = best.y;
        }
        if (!head.home) {
            // First sighting: start at home rather than flying in from a corner.
            head.position.x = this.home.x;
            head.position.y = this.home.y;
        }
        head.home = this.home;
    }

    public onRender(timedContext: TimedContext): void {
        const head = this.headParticle;
        const lead = timedContext.alpha * timedContext.tickDelta;
        const x = head.position.x + (this.exploded ? 0 : head.velocity.x * lead);
        const y = head.position.y + (this.exploded ? 0 : head.velocity.y * lead);
        const stage = timedContext.stage;

        // Lean toward the pointer a little, like something that noticed it.
        const pointer = timedContext.mousePosition;
        const leanX = pointer ? clamp((pointer.y - y) / stage.height, -0.5, 0.5) * 0.7 : 0;
        const leanY = pointer ? clamp((pointer.x - x) / stage.width, -0.5, 0.5) * 0.9 : 0;

        this.body.render(
            timedContext,
            x,
            y,
            this.spin + this.spinRate * lead,
            this.swell,
            this.energy + this.pulse * 0.25,
            leanX,
            leanY,
        );

        // The backdrop pools its light around the head.
        const focus = this.host.surfaces.focus;
        focus.x = x;
        focus.y = y;
        focus.strength = (0.45 + this.energy * 0.9) * (1 - this.body.missing * 0.6);
    }

    public cleanup(): void {
        this.body?.dispose();
        this.host.surfaces.focus.strength = 0;
    }
}
