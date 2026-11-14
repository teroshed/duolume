import { VisualsManager } from 'duolume';
import { Constellation, Meteors } from 'duolume/effects';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const manager = await VisualsManager.create(canvas);

// Constellation carries news, so give it some: each meteor that lands sends a spark through the net.
manager.addEffect(new Meteors()).addEffect(
    new Constellation({
        count: 50, // points at full budget, 0 to 150 (90 by default; fewer for a small stage)
        linkDistance: 165, // pixels: points closer than this are joined by a line, 30 to 600
        signals: true, // events and presses run through the net as sparks
        pointerLinks: true, // the pointer is one more point: nearby points join it and drift towards it
    }),
);

manager.run();
