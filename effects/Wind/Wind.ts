import { Effect } from '../../src/Effect';
import { approach } from '../../src/math';
import type { EffectContext, TickContext, TimedContext } from '../../src/types';
import type { WindContext } from '../contracts';

export interface WindOptions {
    /** Peak acceleration of the natural gusts, in px/ms². */
    gust?: number;
    /** Acceleration added while an arrow key is held, in px/ms². */
    push?: number;
}

/**
 * The original Wind was an empty effect that looked at `keysPressed` and did nothing yet.
 * This is what it was reaching for: it draws nothing at all and exists only to act on the
 * others. It puts one stage-wide wind force into the field; the rain slants, sparks drift,
 * ribbons are carried along, firework stems lean.
 *
 * Gusts come and go on their own. Hold the left or right arrow key to blow by hand.
 */
export class Wind extends Effect<WindContext> {
    public effectName: string;

    public static readonly GUST = 0.00016;
    public static readonly PUSH = 0.0011;

    private readonly gust: number;
    private readonly push: number;
    private pushed = 0;
    private readonly context: WindContext = { x: 0, y: 0 };

    constructor(options: WindOptions = {}) {
        super();
        this.effectName = 'wind';
        this.gust = options.gust ?? Wind.GUST;
        this.push = options.push ?? Wind.PUSH;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public onRender(timedContext: TimedContext): void {}

    public onTick(tickContext: TickContext): EffectContext<WindContext> {
        const t = tickContext.time / 1000;
        // Three slow waves that drift in and out of step: long calms, the odd strong gust.
        const wave = Math.sin(t * 0.21) * 0.55 + Math.sin(t * 0.53 + 1.7) * 0.3 + Math.sin(t * 1.31 + 4.2) * 0.15;
        const natural = wave * Math.abs(wave) * this.gust;

        let target = 0;
        if (tickContext.keysPressed.includes('arrowleft')) {
            target -= this.push;
        }
        if (tickContext.keysPressed.includes('arrowright')) {
            target += this.push;
        }
        this.pushed = approach(this.pushed, target, 4, tickContext.timeDelta);

        const x = natural + this.pushed;
        if (x !== 0) {
            tickContext.forces.add({
                kind: 'wind',
                owner: this.effectName,
                x: 0,
                y: 0,
                radius: 0,
                strength: Math.abs(x),
                dirX: Math.sign(x),
                dirY: 0,
            });
        }

        this.context.x = x;
        this.context.y = 0;
        return this.publish(this.context);
    }

    public initialize(): void {}

    public cleanup(): void {}
}
