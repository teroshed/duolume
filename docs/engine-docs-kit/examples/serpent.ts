import { VisualsManager } from 'duolume';
import { Rain, Serpent } from 'duolume/effects';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const manager = await VisualsManager.create(canvas);

// Rain swirls in the serpent's wake. Add Flock and it hunts the birds.
manager
    .addEffect(new Rain({ dropCount: 200 })) // fewer drops than the default 500: the demo stage is small
    .addEffect(
        new Serpent({
            segments: 36, // body segments, 8 to 120 (46 by default; shorter for a small stage)
            speed: 1, // multiplier on swimming speed, 0.1 to 4
            curiosity: 0.6, // 0 to 1: how strongly the pointer draws it; 0 ignores the pointer
            hunt: true, // chase the flock when there is one on the page
            depth: 160, // pixels it weaves toward and away from the viewer, each way; 0 to 600
        }),
    );

manager.run();
