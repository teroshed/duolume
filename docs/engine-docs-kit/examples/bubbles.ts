import { VisualsManager } from 'duolume';
import { Bubbles, Rain, Wind } from 'duolume/effects';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const manager = await VisualsManager.create(canvas);

// Wind carries the bubbles sideways; a light rain pops some of them.
manager
    .addEffect(new Wind())
    .addEffect(new Rain({ dropCount: 120 })) // fewer drops than the default 500: the demo stage is small
    .addEffect(
        new Bubbles({
            count: 14, // bubbles kept alive at full budget, 0 to 60
            minRadius: 14, // radius of the smallest bubble, in pixels
            maxRadius: 46, // radius of the largest, in pixels; most are nearer the smallest
            rainPops: true, // raindrops can pop them (needs Rain on the page)
            pageInteraction: true, // stop under elements tagged "ledge", flatten, slide round them
        }),
    );

manager.run();
