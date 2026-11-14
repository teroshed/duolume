import { VisualsManager } from 'duolume';
import { Meteors } from 'duolume/effects';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const manager = await VisualsManager.create(canvas);

// Meteors land on the ground and on the shelf in page.html. Press M with the pointer over the stage to send one.
manager.addEffect(
    new Meteors({
        intervalMin: 2500, // shortest quiet time between meteors, in milliseconds
        intervalMax: 7000, // longest quiet time
        speed: 1, // multiplier on flight speed, 0.1 to 4
        pageInteraction: true, // land on the top edge of elements tagged "ledge"
        shock: true, // a big impact sends one shock ring through the force field
    }),
);

manager.run();
