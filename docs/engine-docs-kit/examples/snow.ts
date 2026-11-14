import { VisualsManager } from 'duolume';
import { Snow, Wind } from 'duolume/effects';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const manager = await VisualsManager.create(canvas);

// Wind slants the flakes, and a strong push shaves the piles. Hold an arrow key to blow.
manager.addEffect(new Wind()).addEffect(
    new Snow({
        flakeCount: 200, // flakes in the air at full budget, 0 to 1500 (400 by default; fewer for a small stage)
        pageInteraction: true, // piles settle on elements tagged "ledge"
        ledgeDepth: 26, // deepest a drift gets on an element, in pixels, 0 to 200
        groundDepth: 40, // deepest a drift gets on the floor, in pixels, 0 to 300; 0 lets the snow fall off the bottom
        melt: 0.15, // depth every pile loses, in pixels per second, 0 to 20
    }),
);

manager.run();
