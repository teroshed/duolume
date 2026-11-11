import type { Particle as PixiParticle } from 'pixi.js';
import { mixColor } from '../../src/math';
import { Particle, type ParticleProps } from '../../src/Particle';
import type { Theme, TickContext } from '../../src/types';
import type { Firework } from './Firework';
import { FireworksEffect } from './FireworksEffect';

const TICK_MS = 1000 / 60;
/** Below this the dot is under a pixel and not worth a view. */
const MIN_SIZE = 0.5;

/** A glowing mark the stem leaves behind. It fades and shrinks, then asks to be removed. */
export class FireworkTrail extends Particle {
    public view?: PixiParticle;
    /** The shell that left it, so the shell knows when its trails are gone. */
    public readonly owner: Firework;

    constructor(props: ParticleProps, owner: Firework) {
        super({ ...props, velocity: { x: 0, y: 0 }, acceleration: { x: 0, y: 0 }, priority: props.priority ?? 2 });
        this.owner = owner;
    }

    public onTick(tickContext: TickContext): void {
        // The original decayed per tick; this keeps its look at 60 Hz whatever the step.
        const ticks = tickContext.timeDelta / TICK_MS;
        this.alpha -= FireworksEffect.FIREWORK_TRAIL_ALPHA_DECAY * ticks;
        const shrink = Math.pow(0.95, ticks);
        this.size.x *= shrink;
        this.size.y *= shrink;
        if (this.alpha <= 0.1 || this.size.x < MIN_SIZE) {
            this.alpha = 0;
            this.removeRequested = true;
        }
    }

    /** Starts at the theme's ink and drifts toward its accent as it ages. */
    public tint(theme: Theme): number {
        return mixColor(theme.ink, theme.accent, 1 - Math.max(0, Math.min(1, this.alpha)));
    }
}
