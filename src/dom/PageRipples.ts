import type { VisualsManager } from '../VisualsManager';

export interface PageRipplesOptions {
    /** Ripples alive at once. More hits than this are simply not shown. Default 16. */
    max?: number;
    /** Colour of the ring, any CSS colour. Default: a pale teal. */
    color?: string;
    /** Show one in this many rain hits (rain lands far more often than shards). Default 6. */
    rainEvery?: number;
}

/**
 * The page's answer to `page:hit`: a ring that spreads on top of the element something
 * stopped against. Works for a full-page canvas and for one placed anywhere in the page.
 *
 * The engine's canvas sits behind the page, so it cannot draw on an element's face. This
 * puts one small layer above the page (it never takes clicks or focus) and plays the ripple
 * there, clipped to the element it belongs to. Nothing is shown under reduced motion.
 *
 * Returns a function that removes the layer and stops listening.
 */
export function attachPageRipples(manager: VisualsManager, options: PageRipplesOptions = {}): () => void {
    const max = options.max ?? 16;
    const color = options.color ?? 'rgba(160, 240, 232, 0.9)';
    const rainEvery = Math.max(1, options.rainEvery ?? 6);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    const layer = document.createElement('div');
    layer.setAttribute('aria-hidden', 'true');
    Object.assign(layer.style, {
        position: 'fixed',
        inset: '0',
        pointerEvents: 'none',
        overflow: 'hidden',
        zIndex: '30',
        contain: 'strict',
    });
    document.body.append(layer);

    let alive = 0;
    let rainCount = 0;

    const stop = manager.on('page:hit', (event) => {
        if (reducedMotion.matches || alive >= max || !manager.getMotionEnabled()) {
            return;
        }
        const { x, y, anchor, edge, kind } = event.payload;
        if (kind === 'rain' && rainCount++ % rainEvery !== 0) {
            return;
        }
        const rect = manager.stage.anchor(anchor);
        if (!rect) {
            return;
        }

        // Stage pixels are measured from the canvas; the layer covers the viewport.
        const origin = manager.canvas.getBoundingClientRect();
        // A window the size of the element keeps the ring from spilling past its edges.
        const frame = document.createElement('div');
        Object.assign(frame.style, {
            position: 'absolute',
            left: `${origin.left + rect.x}px`,
            top: `${origin.top + rect.y}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            overflow: 'hidden',
            borderRadius: 'inherit',
        });
        const ring = document.createElement('div');
        // Rain is constant, so its ripple is small and faint; a shard is an event, so its ripple shows.
        const rain = kind === 'rain';
        const size = rain ? 34 : 84;
        Object.assign(ring.style, {
            position: 'absolute',
            left: `${x - rect.x - size / 2}px`,
            top: `${y - rect.y - size / 2}px`,
            width: `${size}px`,
            height: `${size}px`,
            borderRadius: '50%',
            border: `1.5px solid ${color}`,
            boxShadow: rain ? 'none' : `0 0 12px ${color}`,
            opacity: '0',
        });
        frame.append(ring);
        layer.append(frame);
        alive++;

        const animation = ring.animate(
            [
                { transform: 'scale(0.12)', opacity: rain ? 0.26 : edge ? 0.75 : 0.6 },
                { transform: 'scale(1)', opacity: 0 },
            ],
            { duration: rain ? 520 : 720, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' },
        );
        const done = (): void => {
            frame.remove();
            alive = Math.max(0, alive - 1);
        };
        animation.addEventListener('finish', done);
        animation.addEventListener('cancel', done);
    });

    return () => {
        stop();
        layer.remove();
    };
}
