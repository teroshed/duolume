import { Effect } from '../../src/Effect';
import { approach, distanceV2, randomNumber } from '../../src/math';
import type { EffectContext, TickContext, TimedContext, Vector3 } from '../../src/types';
import type { CrystalsContext, CrystalState } from '../contracts';
import { CrystalBody, type CrystalShape } from '../Crystal/CrystalBody';
import { Head } from '../RainEater/Head';

export interface CrystalsOptions {
    /**
     * DOM anchor names. One crystal settles beside each and follows it as the page scrolls.
     * Without any, `count` crystals roam the stage freely.
     */
    homes?: readonly string[];
    /** How many free-roaming crystals to make when there are no homes. Default 4. */
    count?: number;
    /** Smallest and largest radius in stage pixels. Each crystal picks its own in between. */
    minRadius?: number;
    maxRadius?: number;
    /** False: nothing breaks these crystals, not a click, the rain eater or lightning. Default true. */
    breakable?: boolean;
    /** Free-roaming crystals drift slowly and smoothly: a low top speed, no sudden turns. */
    calm?: boolean;
}

interface Crystal {
    head: Head;
    body: CrystalBody;
    /** Anchor this crystal lives beside, if any. */
    homeName?: string;
    home: Vector3;
    spin: number;
    spinRate: number;
    /** Flares up when it is broken or struck, then fades. Drives the glow. */
    pulse: number;
    active: boolean;
    state: CrystalState;
}

const SHAPES: readonly CrystalShape[] = ['icosahedron', 'octahedron', 'dodecahedron', 'gem'];

/**
 * A handful of glass crystals of different shapes and sizes, each slowly changing its
 * proportions, each breakable with a click or tap.
 *
 * A broken crystal's shards fly, some catch on page elements (see CrystalBody), and they all
 * come home in the end. What sets a crystal off besides a click:
 *   - the rain eater exploding nearby (a chain reaction),
 *   - lightning landing close to it,
 *   - a meteor coming down close to it,
 *   - a singularity collapsing nearby.
 * Every break sends a small shock ring into the force field, so rain and sparks feel it.
 */
export class Crystals extends Effect<CrystalsContext> {
    public effectName: string = 'crystals';

    public static readonly DEFAULT_COUNT = 4;
    /** A rain eater exploding within this distance sets a crystal off. */
    public static readonly CHAIN_RANGE = 320;
    /** Lightning landing within this distance sets a crystal off. */
    public static readonly STRIKE_RANGE = 110;
    /** A meteor landing within this distance sets a crystal off. */
    public static readonly IMPACT_RANGE = 150;
    /** How much of the force field a crystal feels. */
    public static readonly FORCE_SHARE = 0.1;
    /** Top speed of a calm free-roaming crystal, in px/ms. */
    public static readonly CALM_MAX_VELOCITY = 0.03;

    private readonly options: CrystalsOptions;
    private readonly crystals: Crystal[] = [];
    private readonly force: Vector3 = { x: 0, y: 0 };
    private readonly context: CrystalsContext;
    private placed = false;

    constructor(options: CrystalsOptions = {}) {
        super();
        this.options = options;
        this.context = { crystals: [] };
    }

    public initialize(): void {
        const homes = this.options.homes ?? [];
        const count = homes.length > 0 ? homes.length : (this.options.count ?? Crystals.DEFAULT_COUNT);
        const minRadius = this.options.minRadius ?? 16;
        const maxRadius = this.options.maxRadius ?? 38;
        const states: CrystalState[] = [];

        for (let i = 0; i < count; i++) {
            const radius = randomNumber(minRadius, maxRadius);
            const homed = homes.length > 0;
            const calm = this.options.calm === true;
            const roaming = calm ? Crystals.CALM_MAX_VELOCITY : 0.1;
            const head = new Head({
                position: { x: 0, y: 0 },
                size: { x: radius * 2, y: radius * 2 },
                // A homed crystal must keep up with a scrolling page; a free one just drifts.
                maxAbsoluteVelocity: homed ? { x: 1.6, y: 1.6 } : { x: roaming, y: roaming },
                priority: 8,
            });
            head.margin = homed ? radius * 8 : 0;
            head.nudge = homed ? 0.02 : calm ? Crystals.CALM_MAX_VELOCITY * 0.2 : 0.05;
            head.turns = !calm;
            const state: CrystalState = { x: 0, y: 0, radius, exploded: false };
            states.push(state);
            this.crystals.push({
                head,
                body: new CrystalBody(this.host, { radius, shape: SHAPES[i % SHAPES.length], morph: 0.2 }),
                homeName: homes[i],
                home: { x: 0, y: 0 },
                spin: Math.random() * 6.28,
                spinRate: randomNumber(0.00018, 0.00042) * (i % 2 === 0 ? 1 : -1),
                pulse: 0,
                active: true,
                state,
            });
        }
        this.context.crystals = states;
    }

    public onTick(tickContext: TickContext): EffectContext<CrystalsContext> {
        const dt = tickContext.timeDelta;
        const stage = tickContext.stage;
        const ledges = stage.tagged('ledge');

        if (!this.placed) {
            this.placed = true;
            for (const crystal of this.crystals) {
                crystal.head.position.x = randomNumber(stage.width * 0.1, stage.width * 0.9);
                crystal.head.position.y = randomNumber(stage.height * 0.12, stage.height * 0.8);
            }
        }

        // One click breaks the nearest crystal under the pointer, not every one in reach.
        let clicked: Crystal | undefined;
        const pointer = tickContext.mousePosition;
        if (this.options.breakable !== false && tickContext.mouseJustPressed && !tickContext.mouseOnInteractive && pointer) {
            let nearest = Infinity;
            for (const crystal of this.crystals) {
                const distance = distanceV2(pointer, crystal.head.position);
                if (crystal.active && distance < crystal.body.radius * 1.4 && distance < nearest) {
                    nearest = distance;
                    clicked = crystal;
                }
            }
        }

        for (const crystal of this.crystals) {
            const { head, body } = crystal;
            this.followHome(crystal, tickContext);
            if (!crystal.active && !body.scattered && body.missing === 0) {
                continue;
            }

            const exploded = body.scattered;
            if (!exploded) {
                tickContext.forces.sample(head.position.x, head.position.y, this.force, this.effectName);
                // Heavy: a shock ring nudges a crystal, but the rain eater's pull does not capture it.
                head.velocity.x += this.force.x * dt * Crystals.FORCE_SHARE;
                head.velocity.y += this.force.y * dt * Crystals.FORCE_SHARE;
                head.onTick(tickContext);

                if (crystal === clicked || this.setOff(crystal, tickContext)) {
                    this.break(crystal, tickContext);
                }
            } else if (head.home) {
                head.position.x = approach(head.position.x, head.home.x, 1.2, dt);
                head.position.y = approach(head.position.y, head.home.y, 1.2, dt);
                head.velocity.x = 0;
                head.velocity.y = 0;
            }

            body.tick(tickContext, head.position, crystal.spin, 1, ledges, this.effectName);
            crystal.pulse = approach(crystal.pulse, 0, 2.2, dt);
            crystal.spin += crystal.spinRate * (1 + crystal.pulse * 3) * dt;

            crystal.state.x = head.position.x;
            crystal.state.y = head.position.y;
            crystal.state.exploded = body.scattered;
        }

        return this.publish(this.context);
    }

    /** True when something that happened last tick should break this crystal. */
    private setOff(crystal: Crystal, tickContext: TickContext): boolean {
        if (this.options.breakable === false) {
            return false;
        }
        const position = crystal.head.position;
        for (const event of tickContext.events('rainEater:exploded')) {
            if (distanceV2(position, event.payload) < Crystals.CHAIN_RANGE) {
                return true;
            }
        }
        for (const event of tickContext.events('lightning:strike')) {
            if (distanceV2(position, event.payload) < Crystals.STRIKE_RANGE) {
                return true;
            }
        }
        for (const event of tickContext.events('meteor:impact')) {
            if (distanceV2(position, event.payload) < Crystals.IMPACT_RANGE) {
                return true;
            }
        }
        for (const event of tickContext.events('singularity:collapsed')) {
            if (distanceV2(position, event.payload) < Crystals.CHAIN_RANGE) {
                return true;
            }
        }
        return false;
    }

    private break(crystal: Crystal, tickContext: TickContext): void {
        const { head, body } = crystal;
        body.explode(head.position, head.velocity, crystal.spin, 1, tickContext.time);
        crystal.pulse = 1;
        const { x, y } = head.position;
        // Small crystals make small rings.
        const power = body.radius / 40;
        tickContext.forces.shock(this.effectName, {
            x,
            y,
            strength: 0.0022 + power * 0.0016,
            maxRadius: 160 + power * 160,
            width: 46,
        });
        tickContext.emit('crystal:exploded', { x, y, radius: body.radius });
    }

    /** Keep a homed crystal beside its page element; a homeless one is left to roam. */
    private followHome(crystal: Crystal, tickContext: TickContext): void {
        if (crystal.homeName === undefined) {
            return;
        }
        const anchor = tickContext.stage.anchor(crystal.homeName);
        const present = anchor !== undefined && anchor.width > 0;
        if (present) {
            crystal.home.x = anchor.x + anchor.width / 2;
            crystal.home.y = anchor.y + anchor.height / 2;
            if (!crystal.head.home) {
                // First sighting: start at home rather than flying in from a corner.
                crystal.head.position.x = crystal.home.x;
                crystal.head.position.y = crystal.home.y;
            }
            crystal.head.home = crystal.home;
        }
        // An element that is hidden (for example on a narrow screen) parks its crystal.
        crystal.active = present;
    }

    public onRender(timedContext: TimedContext): void {
        const lead = timedContext.alpha * timedContext.tickDelta;
        const stage = timedContext.stage;
        for (const crystal of this.crystals) {
            const { head, body } = crystal;
            const loose = body.scattered || body.missing > 0;
            // Far off-screen and whole: nothing to draw.
            const margin = body.radius * 3;
            const onStage =
                head.position.x > -margin &&
                head.position.x < stage.width + margin &&
                head.position.y > -margin &&
                head.position.y < stage.height + margin;
            const visible = (crystal.active && onStage) || loose;
            body.setVisible(visible);
            if (!visible) {
                continue;
            }
            const moving = !body.scattered;
            body.render(
                timedContext,
                head.position.x + (moving ? head.velocity.x * lead : 0),
                head.position.y + (moving ? head.velocity.y * lead : 0),
                crystal.spin,
                1,
                0.08 + crystal.pulse * 0.6,
            );
        }
    }

    public cleanup(): void {
        for (const crystal of this.crystals) {
            crystal.body.dispose();
        }
        this.crystals.length = 0;
        this.placed = false;
    }
}
