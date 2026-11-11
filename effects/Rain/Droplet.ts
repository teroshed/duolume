import type { Particle as PixiParticle } from 'pixi.js';
import { GradientType } from '../../src/Gradients';
import { randomNumber } from '../../src/math';
import { Particle, type ParticleProps } from '../../src/Particle';
import type { EffectContext, TickContext, Vector3 } from '../../src/types';

export type DropletGradientType = GradientType;

export interface DropletContext {
    position: Vector3;
    fallen: boolean;
}

export class Droplet extends Particle {
    public static readonly DEFAULT_GRADIENT_TYPE = GradientType.THEME;
    public gradientType: GradientType = Droplet.DEFAULT_GRADIENT_TYPE;

    /** 0 = far, 1 = near. Sets size, speed and brightness together. */
    public depth = 0.5;
    /** Where the bottom of the drop was before this tick's motion, for landing checks. */
    public previousBottom = 0;
    /** Random 0..1, fixed at birth: how deep into the ground band this drop falls. */
    public groundJitter = Math.random();

    /** Where the left side was before this tick's motion, for wall crossings. */
    public previousX = 0;
    /** Only interactive drops meet page elements; the rest pass behind them. Rolled at birth. */
    public interactive = false;
    /** Chance of being stopped when first crossing into an element. Personal, fixed at birth. */
    public edgeChance = 0;
    /** Name of the element the head is currently over, so a crossing is rolled once. */
    public over?: string;
    /** Water this drop carries into a reservoir, about 1 for an average rain drop. */
    public water = 1;

    /** The drop's sprite. Owned by Rain, which pools and releases it. */
    public view?: PixiParticle;

    // One context object per droplet, reused every tick: same contract, no garbage.
    private readonly context: EffectContext<DropletContext>;

    constructor(props: ParticleProps) {
        super(props);
        this.context = { effectType: 'droplet', effectContext: { position: this.position, fallen: false } };
    }

    public static readonly MIN_EDGE_CHANCE = 0.2;
    public static readonly MAX_EDGE_CHANCE = 0.5;
    /** size.x * size.y of an average rain drop: one unit of water. */
    public static readonly AVERAGE_AREA = 40;

    /** Decide at birth whether this drop meets page elements, and how readily it stops. */
    public rollInteraction(probability: number): void {
        this.interactive = Math.random() < probability;
        this.edgeChance = randomNumber(Droplet.MIN_EDGE_CHANCE, Droplet.MAX_EDGE_CHANCE);
    }

    public setGradientType(gradientType: GradientType): void {
        this.gradientType = gradientType;
    }

    public onTick(tickContext: TickContext): EffectContext<DropletContext> {
        this.previousBottom = this.position.y + this.size.y;
        this.previousX = this.position.x;
        this.updateMotion(tickContext);
        this.context.effectContext.fallen = this.checkFallen(tickContext);
        return this.context;
    }

    private checkFallen(tickContext: TickContext): boolean {
        if (!tickContext.canvasDimensions) {
            return false;
        }
        // The original landed drops somewhere in the bottom 100 px, re-rolled every tick.
        // The roll is now fixed per drop, so a drop lands at one depth instead of flickering.
        return this.position.y + this.size.y > tickContext.canvasDimensions.y - this.groundJitter * Droplet.groundBand;
    }

    /** Height of the band above the bottom edge in which drops land. 0 lets them fall off-screen. */
    public static groundBand = 100;
}
