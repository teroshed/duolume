import type { AnchorRect } from '../../src/Stage';
import type { Droplet } from './Droplet';

export type PageEdge = 'top' | 'left' | 'right' | 'bottom' | 'inside';

/** Where a droplet was stopped. One object is reused, so read it before the next `meet`. */
export interface PageStop {
    rect: AnchorRect;
    edge: PageEdge;
}

/**
 * Page elements as walls for raindrops: the same rule crystal shards follow in `meetPage`.
 * A plain `ledge` stops only interactive drops: crossing into it rolls the drop's `edgeChance`
 * once, and staying inside gives it a small chance per millisecond of stopping where it is.
 * A numbered ledge, `ledge-N`, decides alone: N percent of drops fall through it (those whose
 * `roll * 100` is below N) and every other drop stops on the edge it crosses.
 */
export class PageWalls {
    /** On a plain ledge: the chance per millisecond that a drop inside the element stops where it is. */
    public static readonly INSIDE_CHANCE_PER_MS = 0.0015;

    private readonly stop: PageStop = { rect: { name: '', x: 0, y: 0, width: 0, height: 0, visible: false, radius: 0, tags: [], numbers: {} }, edge: 'top' };

    /** Returns where the droplet stopped, or undefined if it carries on. */
    public meet(droplet: Droplet, elements: readonly AnchorRect[], timeDelta: number): PageStop | undefined {
        const x = droplet.position.x + droplet.size.x / 2;
        const y = droplet.position.y + droplet.size.y;
        let over: AnchorRect | undefined;
        for (let i = 0; i < elements.length; i++) {
            const rect = elements[i];
            if (x > rect.x && x < rect.x + rect.width && y > rect.y && y < rect.y + rect.height) {
                over = rect;
                break;
            }
        }
        if (!over) {
            droplet.over = undefined;
            return undefined;
        }
        const through = over.numbers.ledge;
        if (through === undefined && !droplet.interactive) {
            return undefined;
        }

        const stop = this.stop;
        stop.rect = over;
        if (droplet.over !== over.name) {
            // Just crossed in: the element is a wall for some drops.
            droplet.over = over.name;
            const stops = through === undefined ? Math.random() < droplet.edgeChance : droplet.roll * 100 >= through;
            if (stops) {
                stop.edge = this.crossedEdge(droplet, over);
                snapToEdge(droplet, over, stop.edge);
                return stop;
            }
            return undefined;
        }

        if (through === undefined && Math.random() < PageWalls.INSIDE_CHANCE_PER_MS * timeDelta) {
            stop.edge = 'inside';
            return stop;
        }
        return undefined;
    }

    private crossedEdge(droplet: Droplet, rect: AnchorRect): PageEdge {
        const fromX = droplet.previousX + droplet.size.x / 2;
        const fromY = droplet.previousBottom;
        const right = rect.x + rect.width;
        if (fromY <= rect.y && fromX >= rect.x && fromX <= right) {
            return 'top';
        }
        if (fromX <= rect.x) {
            return 'left';
        }
        if (fromX >= right) {
            return 'right';
        }
        return fromY <= rect.y ? 'top' : 'bottom';
    }
}

/** Put the head back on the boundary it came through. */
function snapToEdge(droplet: Droplet, rect: AnchorRect, edge: PageEdge): void {
    switch (edge) {
        case 'top':
            droplet.position.y = rect.y - droplet.size.y;
            break;
        case 'bottom':
            droplet.position.y = rect.y + rect.height - droplet.size.y;
            break;
        case 'left':
            droplet.position.x = rect.x - droplet.size.x / 2;
            break;
        case 'right':
            droplet.position.x = rect.x + rect.width - droplet.size.x / 2;
            break;
        case 'inside':
            break;
    }
}
