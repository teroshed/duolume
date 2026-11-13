import { Particle, type ParticleProps } from '../../src/Particle';
import type { EffectContext, TickContext, Vector3 } from '../../src/types';

export interface HeadContext {
    isExploded: boolean;
}

/**
 * The rain eater's head: the original wandering particle. It drifts under a small random
 * acceleration, is capped by a speed limit, bounces off or wraps around the edges, and
 * now and then reverses or gets nudged.
 *
 * With a `home` set it is also pulled back toward that point, so it can be parked beside
 * a piece of the page and still feel alive.
 */
export class Head extends Particle {
    public martkSpeedLimitExceeded: boolean = false;
    public isExploded: boolean = false;

    /** Where the head likes to be. Undefined: free roaming with edge wrap, as in the original. */
    public home?: Vector3;
    /** Pull toward home, in 1/ms². */
    public homeStiffness = 0.0000035;
    /** Velocity kept per millisecond while homing (1 = no damping). */
    public homeDamping = 0.9985;
    /** How far outside the stage the head may sit before the edges act. */
    public margin = 0;
    /** Size of a random nudge in px/ms. Defaults to the speed limit. */
    public nudge?: number;
    /** Now and then it turns on the spot, as in the original. False: it only drifts. */
    public turns = true;

    private readonly context: EffectContext<HeadContext> = { effectType: 'head', effectContext: { isExploded: false } };

    public constructor(props: ParticleProps) {
        super(props);
    }

    public onTick(tickContext: TickContext): EffectContext<HeadContext> {
        this.context.effectContext.isExploded = this.isExploded;

        if (this.isExploded) {
            return this.context;
        }

        if (this.home) {
            const dt = tickContext.timeDelta;
            this.velocity.x += (this.home.x - this.position.x) * this.homeStiffness * dt;
            this.velocity.y += (this.home.y - this.position.y) * this.homeStiffness * dt;
            const keep = Math.pow(this.homeDamping, dt);
            this.velocity.x *= keep;
            this.velocity.y *= keep;
        }

        super.updateMotion(tickContext);
        this.checkForWallCollisions(tickContext);
        this.randomEvents(tickContext);

        return this.context;
    }

    public checkForWallCollisions(tickContext: TickContext): void {
        if (!tickContext || !tickContext.canvasDimensions) {
            return;
        }
        const minX = -this.margin;
        const minY = -this.margin;
        const maxX = tickContext.canvasDimensions.x + this.margin;
        const maxY = tickContext.canvasDimensions.y + this.margin;
        // A homed head always bounces; a free one bounces or wraps, as before.
        const bounce = (): boolean => this.home !== undefined || Math.random() < 0.5;

        if (this.position.x > maxX) {
            if (bounce()) {
                this.position.x = maxX;
                this.velocity = { ...this.velocity, x: -Math.abs(this.velocity.x) };
            } else {
                this.position.x = minX;
            }
        } else if (this.position.x < minX) {
            if (bounce()) {
                this.position.x = minX;
                this.velocity = { ...this.velocity, x: Math.abs(this.velocity.x) };
            } else {
                this.position.x = maxX;
            }
        }
        if (this.position.y > maxY) {
            if (bounce()) {
                this.position.y = maxY;
                this.velocity = { ...this.velocity, y: -Math.abs(this.velocity.y) };
            } else {
                this.position.y = minY;
            }
        } else if (this.position.y < minY) {
            if (bounce()) {
                this.position.y = minY;
                this.velocity = { ...this.velocity, y: Math.abs(this.velocity.y) };
            } else {
                this.position.y = maxY;
            }
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public randomEvents(tickContext: TickContext): void {
        // Occasionally reverse one or both velocity components, as before
        const outerDice = Math.random();
        if (this.turns && outerDice < 1 / 100) {
            const innerDice = Math.random();
            if (innerDice < 0.5) {
                // Reverse y velocity
                this.velocity = { ...this.velocity, y: -this.velocity.y };
            } else if (innerDice < 0.8) {
                // Reverse x velocity
                this.velocity = { ...this.velocity, x: -this.velocity.x };
            } else {
                // Reverse both velocity
                this.velocity = { ...this.velocity, x: -this.velocity.x, y: -this.velocity.y };
            }
        }

        // Occasionally nudge velocity randomly. The original nudge was up to ±1 px/ms and
        // relied on the speed limit to tame it; it is now sized against that limit.
        const nudgeDice = Math.random();
        if (nudgeDice < 1 / 120) {
            const limit = this.maxAbsoluteVelocity ? Math.max(this.maxAbsoluteVelocity.x, this.maxAbsoluteVelocity.y) : 1;
            const reach = this.nudge ?? limit;
            const dx = (Math.random() - 0.5) * 2 * reach;
            const dy = (Math.random() - 0.5) * 2 * reach;
            this.velocity = {
                ...this.velocity,
                x: this.velocity.x + dx,
                y: this.velocity.y + dy,
            };
        }
    }

    public explode(): void {
        this.isExploded = true;
    }

    public reform(): void {
        this.isExploded = false;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public onSpeedLimitExceeded(event: { axis: 'x' | 'y'; direction: 'negative' | 'positive' }): void {
        this.martkSpeedLimitExceeded = true;
    }
}
