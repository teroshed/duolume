import { Effect } from '../../src/Effect';
import type { EffectContext, TickContext, TimedContext } from '../../src/types';

/**
 * The starting point for a new effect. Copy this folder, rename the class and `effectName`,
 * fill in the four methods, then `manager.addEffect(new YourEffect())`.
 *
 * That is all an effect is. It never calls another effect: it returns what it wants the
 * others to know, and reads what they returned.
 *
 * This file is compiled with the rest of the library, so it cannot drift out of date.
 */
export class BlankEffect extends Effect {
    public effectName: string = 'blank';

    public initialize(): void {
        // Create what you draw.
        //   this.host.pixi   your Pixi container (behind the 3D scene)
        //   this.host.three  your Three.js group
        //   this.host.stage  stage pixels ↔ 3D positions, and the page's anchors
    }

    public onTick(tickContext: TickContext): EffectContext {
        // Simulate. tickContext.timeDelta is milliseconds; positions are stage pixels.
        //
        //   Read another effect:      const eater = tickContext.read('rainEater');
        //   Push the others around:   tickContext.forces.add({ kind: 'repel', owner: this.effectName, x, y, radius, strength });
        //   Feel what they push:      tickContext.forces.sample(x, y, out, this.effectName);
        //   Say something happened:   tickContext.emit('blank:happened', { x, y });
        //   Hear what happened:       for (const event of tickContext.events('rain:eaten')) { … }
        //   Land on the page:         for (const ledge of tickContext.stage.tagged('ledge')) { … }

        // Whatever you return here is what other effects get from tickContext.read('blank').
        return this.publish({});
    }

    public onRender(timedContext: TimedContext): void {
        // Move what you drew. Do not change simulation state here.
        // Between ticks, lead positions by velocity × timedContext.alpha × timedContext.tickDelta.
    }

    public cleanup(): void {
        // Release what you created in initialize.
    }
}
