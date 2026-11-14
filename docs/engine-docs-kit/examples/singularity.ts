import { VisualsManager } from 'duolume';
import { Rain, Singularity } from 'duolume/effects';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const manager = await VisualsManager.create(canvas);

// The hole feeds on what falls into it, so give it rain. When it is full it collapses, and forms again.
manager
    .addEffect(new Rain({ dropCount: 300 })) // fewer drops than the default 500: the demo stage is small
    .addEffect(
        new Singularity({
            home: { x: 0.68, y: 0.36 }, // where it lives, as fractions of the stage width and height
            radius: 26, // radius of the dark disc at zero mass, in pixels, 6 to 90
            pull: 0.0016, // attraction in px/ms², 0 to 0.01; 0 bends light but moves nothing
            spin: 0.0011, // swirl in px/ms², -0.01 to 0.01; negative turns the other way
            feed: true, // grow by feeding and collapse when full
            wander: true, // drift round its home on a slow loop
        }),
    );

manager.run();
