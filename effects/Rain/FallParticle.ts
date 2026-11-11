import type { Particle as PixiParticle } from 'pixi.js';
import { randomNumber } from '../../src/math';
import { Particle, type ParticleProps } from '../../src/Particle';
import type { EffectContext, TickContext } from '../../src/types';

export interface FallParticleContext {
    remove: boolean;
}

/** The splash a droplet leaves: a few specks thrown up and out, pulled back down, fading. */
export class FallParticle extends Particle {
    public static readonly GRAVITY = 0.0009;
    public static readonly ALPHA_DECAY = 0.0016; // per millisecond

    public tint = 0xffffff;
    public view?: PixiParticle;

    private readonly context: EffectContext<FallParticleContext> = {
        effectType: 'fallParticle',
        effectContext: { remove: false },
    };

    constructor(props: ParticleProps) {
        super({
            ...props,
            velocity: props.velocity ?? { x: randomNumber(-0.09, 0.09), y: randomNumber(-0.24, -0.05) },
            acceleration: props.acceleration ?? { x: 0, y: FallParticle.GRAVITY },
            priority: props.priority ?? 2,
        });
    }

    public onTick(tickContext: TickContext): EffectContext<FallParticleContext> {
        this.updateMotion(tickContext);
        this.alpha -= FallParticle.ALPHA_DECAY * tickContext.timeDelta;
        const below = tickContext.canvasDimensions ? this.position.y > tickContext.canvasDimensions.y + 20 : false;
        this.context.effectContext.remove = this.alpha <= 0 || below;
        return this.context;
    }
}
