import { Effect } from '../../src/Effect';
import type { Frame } from '../../src/dom/PageLayer';
import type { EffectContext } from '../../src/types';
import type { FieldFrameContext } from '../contracts';
import { BRACKET, FILIGREE, LAUREL, SPARK, TICKS } from './decor';

/** The looks a frame can have. An element names one in its tags: `data-fx-tags="frame laurel"`. */
export type FieldFrameLook = 'hud' | 'filigree' | 'laurel' | 'sparkle';

export interface FieldFrameOptions {
    /** The look of an element whose tags name none: 'hud', 'filigree', 'laurel' or 'sparkle'. Default 'hud'. */
    look?: FieldFrameLook;
}

/** Every look: the line round the element and the pictures on it. */
export const LOOKS: Record<FieldFrameLook, Frame> = {
    // A head-up display: brackets on the corners, a ruler under it, a bright dash running round.
    hud: {
        radius: 4,
        bead: true,
        pictures: [
            { image: BRACKET, size: 24, at: [0, 0], origin: [0.25, 0.25], mirror: 'both' },
            { image: TICKS, size: [40, 6], at: [0.5, 1], origin: [0.5, -0.6], span: 0.5 },
        ],
    },
    // Curled corners.
    filigree: {
        radius: 7,
        pictures: [{ image: FILIGREE, size: 36, at: [0, 0], origin: [0.375, 0.375], mirror: 'both' }],
    },
    // A pill between two halves of a laurel wreath that unroll and rock.
    laurel: {
        radius: 999,
        pictures: [{ image: LAUREL, size: [27, 60], at: [0, 0.5], origin: [0.62, 0.5], mirror: 'x', grows: true, sway: 2 }],
    },
    // A dotted line (round ends on very short dashes) and sparks that twinkle out of step.
    sparkle: {
        radius: 12,
        line: 2,
        dash: [0.1, 7],
        pictures: [
            { image: SPARK, size: 18, at: [1, 0], twinkle: 0 },
            { image: SPARK, size: 9, at: [1, 0], origin: [-0.9, 1.7], twinkle: 0.35 },
            { image: SPARK, size: 7, at: [0.74, 0], origin: [0.5, 1.5], twinkle: 0.7 },
            { image: SPARK, size: 18, at: [0, 1], twinkle: 0.5 },
            { image: SPARK, size: 9, at: [0, 1], origin: [1.9, -0.7], twinkle: 0.85 },
            { image: SPARK, size: 7, at: [0.26, 1], origin: [0.5, -0.5], twinkle: 0.2 },
        ],
    },
};

/**
 * A sharp frame, with pictures on it, round every page element tagged `frame` while it has the
 * keyboard focus:
 *
 *     <input data-fx-anchor="email" data-fx-tags="frame laurel" />
 *
 * The other word picks the look: `hud`, `filigree`, `laurel` or `sparkle` (see `LOOKS`). Each
 * element fades its own frame in and out, on the page's clock, so it shows while the scene is
 * paused too, and under reduced motion it is simply there or gone. Nothing is drawn on the
 * canvas: the frame is page content (`this.host.page`), sharp at any screen.
 *
 * What it listens to: the word `focus` in the element's tags, which `attachFieldTags()` writes
 * from the real control and `manager.focus(name)` plays from code.
 * It tells the others nothing but its default look.
 */
export class FieldFrame extends Effect<FieldFrameContext> {
    public effectName: string = 'fieldFrame';

    private readonly look: FieldFrameLook;
    private readonly context: FieldFrameContext;

    public constructor(options: FieldFrameOptions = {}) {
        super();
        this.look = options.look !== undefined && Object.keys(LOOKS).includes(options.look) ? options.look : 'hud';
        this.context = { look: this.look };
    }

    public initialize(): void {}

    public onTick(): EffectContext<FieldFrameContext> {
        return this.publish(this.context);
    }

    public onRender(): void {
        for (const element of this.host.stage.tagged('frame')) {
            const look = (Object.keys(LOOKS) as FieldFrameLook[]).find((name) => element.tags.includes(name)) ?? this.look;
            this.host.page.frame(element, LOOKS[look], element.tags.includes('focus'));
        }
    }

    public cleanup(): void {}
}
