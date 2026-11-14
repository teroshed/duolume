import { VisualsManager } from 'duolume';
import { Flock } from 'duolume/effects';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const manager = await VisualsManager.create(canvas);

// The birds land on the shelf in page.html when things are calm, and take off together when they are not.
manager.addEffect(
    new Flock({
        count: 30, // birds at full budget, 0 to 150 (60 by default; fewer for a small stage)
        perch: true, // land on elements tagged "ledge"; false keeps every bird in the air
        speed: 1, // multiplier on flying speed, 0.2 to 3
        fear: 1, // multiplier on how strongly they flee and how easily they startle; 0 is fearless
    }),
);

manager.run();
