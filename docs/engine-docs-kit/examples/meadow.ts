import { VisualsManager } from 'duolume';
import { Meadow, Wind } from 'duolume/effects';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const manager = await VisualsManager.create(canvas);

// The meadow only moves when something pushes it. Wind rolls gusts through it; hold an arrow key to blow.
manager.addEffect(new Wind()).addEffect(
    new Meadow({
        density: 36, // blades per 100 px of ground, 0 to 90
        height: 46, // typical blade height on the floor, in pixels (on elements about 55% of it)
        ground: true, // grow along the bottom of the stage
        ledges: true, // grow along the top of elements tagged "ledge"
        regrow: 9000, // milliseconds for a cut or scorched blade to grow back
    }),
);

manager.run();
