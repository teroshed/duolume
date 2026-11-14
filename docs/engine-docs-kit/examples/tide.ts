import { VisualsManager } from 'duolume';
import { Rain, Tide, Wind } from 'duolume/effects';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const manager = await VisualsManager.create(canvas);

// The sea rises with the rain it is given and drains when it stops. Wind sets which way the swell runs.
manager
    .addEffect(new Wind())
    .addEffect(new Rain()) // the default rain; a thin rain drains the sea faster than it fills it
    .addEffect(
        new Tide({
            level: 70, // resting height of the water above the bottom of the stage, in pixels, 0 to 2000
            maxRise: 120, // most the rain can raise it above that, in pixels, 0 to 2000
            risePerDrop: 0.019, // pixels one landed raindrop adds; the default rain fills maxRise in about 50 seconds
            drain: 4, // pixels per second the raised water falls back
            splashes: true, // throw spray on big splashes
        }),
    );

manager.run();
