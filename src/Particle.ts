import type { TickContext, TimedContext, Vector3 } from './types';

export type ParticleProps = {
    position: Vector3;
    size?: Vector3; // Defaults to 3x3
    color?: string;
    velocity?: Vector3;
    acceleration?: Vector3;
    maxAbsoluteVelocity?: Vector3;
    /** 1–10. Assigned at birth; the governor removes the lowest first. Defaults to 5. */
    priority?: number;
};

export type ParticleLife = 'alive' | 'exiting' | 'removed';

/**
 * The original motion object: position, velocity, acceleration, an optional speed limit
 * with a hook, all in pixels and milliseconds. Drawing is no longer part of it — the effect
 * that owns a particle also owns its view, in Pixi, in Three.js, or in both.
 *
 * Two things are added: a birth priority, and a life cycle (alive → exiting → removed)
 * so nothing has to vanish from one frame to the next.
 */
export abstract class Particle {
    public position: Vector3;
    public size: Vector3;
    public color: string;
    public velocity: Vector3;
    public acceleration?: Vector3;
    public removeRequested: boolean = false;

    public alpha: number = 1;

    public maxAbsoluteVelocity?: Vector3;

    public priority: number;
    public life: ParticleLife = 'alive';
    /** 0 while alive, rising to 1 across the exit animation. */
    public exitProgress: number = 0;

    public constructor(props: ParticleProps) {
        if (props.maxAbsoluteVelocity) {
            this.maxAbsoluteVelocity = props.maxAbsoluteVelocity;
        }

        this.position = props.position;
        this.size = props.size ?? { x: 3, y: 3 };
        this.color = props.color ?? 'rgb(240,240,240)';
        this.velocity = props.velocity ?? { x: 0, y: 0 };
        this.acceleration = props.acceleration ?? { x: 0, y: 0 };
        this.priority = props.priority ?? 5;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public onSpeedLimitExceeded(event: { axis: 'x' | 'y'; direction: 'negative' | 'positive' }): void {}

    /**
     * Updates the particle's position based on velocity and its velocity based on acceleration for one tick.
     * @param tickContext - The tick context containing timeDelta and simulation information.
     */
    public updateMotion(tickContext: TickContext): void {
        this.updateVelocity(tickContext);
        this.updatePosition(tickContext);
    }

    /**
     * Updates the particle's velocity based on its acceleration and the elapsed time.
     * @param tickContext - The tick context containing timeDelta and simulation information.
     */
    public updateVelocity(tickContext: TickContext): void {
        if (!this.acceleration || !this.velocity) {
            return;
        }

        this.velocity.x += this.acceleration.x * tickContext.timeDelta;
        this.velocity.y += this.acceleration.y * tickContext.timeDelta;

        this.checkForSpeedLimits();
    }

    protected checkForSpeedLimits(): void {
        if (!this.maxAbsoluteVelocity) {
            return;
        }
        const maxVelocityX = this.maxAbsoluteVelocity.x;
        if (maxVelocityX > 0) {
            if (this.velocity.x < -maxVelocityX) {
                this.onSpeedLimitExceeded({ axis: 'x', direction: 'negative' });
                this.velocity.x = -maxVelocityX;
            } else if (this.velocity.x > maxVelocityX) {
                this.onSpeedLimitExceeded({ axis: 'x', direction: 'positive' });
                this.velocity.x = maxVelocityX;
            }
        }
        const maxVelocityY = this.maxAbsoluteVelocity.y;
        if (maxVelocityY > 0) {
            if (this.velocity.y < -maxVelocityY) {
                this.onSpeedLimitExceeded({ axis: 'y', direction: 'negative' });
                this.velocity.y = -maxVelocityY;
            } else if (this.velocity.y > maxVelocityY) {
                this.onSpeedLimitExceeded({ axis: 'y', direction: 'positive' });
                this.velocity.y = maxVelocityY;
            }
        }
    }

    /**
     * Updates the particle's position based on its velocity and the elapsed time.
     * @param tickContext - The tick context containing timeDelta and simulation information.
     */
    public updatePosition(tickContext: TickContext): void {
        if (!this.velocity) {
            return;
        }
        this.position.x += this.velocity.x * tickContext.timeDelta;
        this.position.y += this.velocity.y * tickContext.timeDelta;
    }

    /** Ask to leave. The particle plays its exit instead of disappearing. Safe to call twice. */
    public requestExit(): void {
        if (this.life === 'alive') {
            this.life = 'exiting';
            this.exitProgress = 0;
        }
    }

    /** Emergency path: gone on the next sweep, no animation. */
    public removeNow(): void {
        this.life = 'removed';
        this.exitProgress = 1;
        this.removeRequested = true;
    }

    /** Advance an exit in progress. Returns true once the particle is removed. */
    public advanceExit(timeDelta: number, exitDuration: number): boolean {
        if (this.life === 'alive') {
            return false;
        }
        if (this.life === 'exiting') {
            this.exitProgress = exitDuration > 0 ? Math.min(1, this.exitProgress + timeDelta / exitDuration) : 1;
            if (this.exitProgress >= 1) {
                this.life = 'removed';
                this.removeRequested = true;
            }
        }
        return this.life === 'removed';
    }

    public cleanup(): void {}

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public onRender(timedContext: TimedContext): void {}
}
