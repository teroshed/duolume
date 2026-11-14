import { VisualsManager } from 'duolume';
import { Confetti, Wind } from 'duolume/effects';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const manager = await VisualsManager.create(canvas);

// Wind carries the paper as it falls.
manager.addEffect(new Wind()).addEffect(
    new Confetti({
        burst: 90, // pieces per cannon shot at full budget, 0 to 300
        interval: 9000, // milliseconds between the shots it fires on its own; 0 fires only on events and the key
        gravity: 0.0007, // downward pull in px/ms², 0 to 0.01
        pageInteraction: true, // come to rest on elements tagged "ledge"
    }),
);

manager.run();
