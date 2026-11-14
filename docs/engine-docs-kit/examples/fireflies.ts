import { VisualsManager } from 'duolume';
import { Fireflies } from 'duolume/effects';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const manager = await VisualsManager.create(canvas);

// Fireflies stand alone. Add Rain and, while it rains, most of them gather under the shelf in page.html.
manager.addEffect(
    new Fireflies({
        count: 50, // fireflies at full budget, 0 to 300 (90 by default; fewer for a small stage)
        period: 2200, // milliseconds between one firefly's own flashes (each gets this plus or minus 12%)
        coupling: 0.1, // how hard a seen flash pulls a firefly forward, 0 to 1; 0 never syncs
        reach: 170, // pixels within which one firefly sees another's flash
        shelter: true, // hide under elements tagged "ledge" while it rains
    }),
);

manager.run();
