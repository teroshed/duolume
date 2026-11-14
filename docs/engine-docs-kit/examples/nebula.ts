import { VisualsManager } from 'duolume';
import { LightningStorm, Nebula, Rain, Wind } from 'duolume/effects';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const manager = await VisualsManager.create(canvas);

// The cloud is dark until something lights it. Rain thickens it, wind carries it, and lightning lights it.
manager
    .addEffect(new Wind())
    .addEffect(new Rain({ dropCount: 300 })) // fewer drops than the default 500: the demo stage is small
    .addEffect(new LightningStorm())
    .addEffect(
        new Nebula({
            coverage: 0.6, // share of the stage height, from the top, that cloud may fill; 0.1 to 1
            density: 0.5, // how much cloud there is before the rain adds to it, 0 to 1
            drift: 1, // multiplier on how fast the cloud moves and changes shape; 0 is still
            pointerLight: true, // the pointer carries a faint light through the cloud
            rainThickens: true, // the cloud gathers while Rain has droplets in the air
        }),
    );

manager.run();
