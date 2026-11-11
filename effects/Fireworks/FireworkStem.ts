import type { Particle as PixiParticle } from 'pixi.js';
import { randomNumber } from '../../src/math';
import { Particle, type ParticleProps } from '../../src/Particle';
import type { TickContext, Vector3 } from '../../src/types';
import { FireworksEffect } from './FireworksEffect';

/** One tick at 60 Hz, in milliseconds. The original's tick limits were counted in these. */
const TICK_MS = 1000 / 60;

/** The rocket that climbs before a shell bursts. */
export class FireworkStem extends Particle {
    public view?: PixiParticle;
    public exploded = false;
    public shouldExplode = false;
    /** 0..1 position of this stem's size between the smallest and largest. */
    public readonly power: number;

    private elapsed = 0;
    private readonly timeLimit: number;
    private readonly minHeight: number;
    private readonly maxVelocityDown: number;
    private readonly force: Vector3 = { x: 0, y: 0 };

    constructor(props: ParticleProps) {
        const size = randomNumber(FireworksEffect.FIREWORK_STEM_MIN_SIZE, FireworksEffect.FIREWORK_STEM_MAX_SIZE);
        super({
            ...props,
            size: { x: size, y: size },
            velocity: {
                x: 0,
                y: randomNumber(FireworksEffect.FIREWORK_STEM_MIN_VELOCITY, FireworksEffect.FIREWORK_STEM_MAX_VELOCITY),
            },
            acceleration: { x: 0, y: FireworksEffect.FIREWORK_STEM_ACCELERATION },
            priority: props.priority ?? 8,
        });
        const range = FireworksEffect.FIREWORK_STEM_MAX_SIZE - FireworksEffect.FIREWORK_STEM_MIN_SIZE;
        this.power = range > 0 ? (size - FireworksEffect.FIREWORK_STEM_MIN_SIZE) / range : 1;
        this.timeLimit = randomNumber(200, 500) * TICK_MS;
        this.minHeight = randomNumber(
            FireworksEffect.FIREWORK_STEM_MIN_HEIGHT - 20,
            FireworksEffect.FIREWORK_STEM_MIN_HEIGHT + 20,
        );
        this.maxVelocityDown = randomNumber(-0.1, 0.8);
        this.color = 'orange';
    }

    public onTick(tickContext: TickContext): void {
        if (this.exploded) {
            return;
        }
        const dt = tickContext.timeDelta;
        this.elapsed += dt;

        // Wind, the rain eater's pull and shock rings all bend the climb.
        tickContext.forces.sample(this.position.x, this.position.y, this.force);
        this.velocity.x += this.force.x * dt;
        this.velocity.y += this.force.y * dt;

        this.updateMotion(tickContext);

        const stageHeight = tickContext.stage.height;
        // The slow-down test only counts once the stem is on the stage: a stem born slower than its
        // limit would otherwise burst below the screen.
        const slowed = this.position.y < stageHeight && this.velocity.y >= this.maxVelocityDown;
        const high = this.position.y <= Math.min(this.minHeight, stageHeight * 0.3);
        if (this.elapsed >= this.timeLimit || slowed || high) {
            this.shouldExplode = true;
        }
    }
}
