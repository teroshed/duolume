import { describe, expect, test } from 'bun:test';
import { Droplet } from '../effects/Rain/Droplet';
import { PageWalls } from '../effects/Rain/PageWalls';
import { readTags, Stage, type AnchorRect } from '../src/Stage';

describe('readTags', () => {
    test('a numbered tag is also listed under its plain name, and its number is kept', () => {
        const read = readTags('ledge-30 mini rain');
        expect(read.tags).toEqual(['ledge-30', 'ledge', 'mini', 'rain']);
        expect(read.numbers.ledge).toBe(30);
        expect(read.numbers.mini).toBeUndefined();
    });

    test('plain tags are left as they were, with no numbers', () => {
        const read = readTags('  ledge   petals on value:0.62 r:10 ');
        expect(read.tags).toEqual(['ledge', 'petals', 'on', 'value:0.62', 'r:10']);
        expect(read.numbers).toEqual({});
        expect(readTags('').tags).toEqual([]);
    });

    test('0, 100, decimals, and a name with a dash in it; the last number for a name wins', () => {
        expect(readTags('ledge-0').numbers.ledge).toBe(0);
        expect(readTags('ledge-100').numbers.ledge).toBe(100);
        expect(readTags('glow-2.5').numbers.glow).toBe(2.5);
        expect(readTags('top-shelf-40').numbers['top-shelf']).toBe(40);
        const twice = readTags('ledge ledge-20 ledge-70');
        expect(twice.numbers.ledge).toBe(70);
        expect(twice.tags).toEqual(['ledge', 'ledge-20', 'ledge-70']);
    });

    test('words that only look numbered are not: no number, no name, not a number', () => {
        expect(readTags('ledge-').numbers).toEqual({});
        expect(readTags('-5').numbers).toEqual({});
        expect(readTags('ledge-x').numbers).toEqual({});
    });
});

/** A stand-in for a page element: just what the stage reads from one. */
function fakeElement(name: string, tags: () => string): Element {
    return {
        getAttribute: (attribute: string) => (attribute === 'data-fx-anchor' ? name : attribute === 'data-fx-tags' ? tags() : null),
        getBoundingClientRect: () => ({ left: 10, top: 100, width: 200, height: 30 }),
    } as unknown as Element;
}

describe('the stage and numbered tags', () => {
    test("stage.tagged('ledge') finds an element tagged ledge-30, with its number", () => {
        const stage = new Stage();
        stage.resize(800, 600);
        stage.observe('shelf', fakeElement('shelf', () => ''), ['ledge-30']);
        stage.measure();
        const found = stage.tagged('ledge');
        expect(found.length).toBe(1);
        expect(found[0].tags.includes('ledge')).toBe(true);
        expect(found[0].numbers.ledge).toBe(30);
        expect(stage.tagged('ledge-30').length).toBe(1);
    });

    test('retagging ledge-0 to ledge-80 at runtime is picked up before the next frame', () => {
        let notify = (): void => {};
        const saved = globalThis.MutationObserver;
        globalThis.MutationObserver = class {
            constructor(callback: () => void) {
                notify = callback;
            }
            observe(): void {}
            disconnect(): void {}
        } as unknown as typeof MutationObserver;
        try {
            let tags = 'ledge-0';
            const element = fakeElement('shelf', () => tags);
            const root = { querySelectorAll: () => [element] } as unknown as ParentNode;
            const stage = new Stage();
            stage.resize(800, 600);
            stage.watchAll(root);
            stage.measure();
            expect(stage.tagged('ledge')[0].numbers.ledge).toBe(0);
            tags = 'ledge-80';
            notify();
            stage.measure();
            expect(stage.tagged('ledge')[0].numbers.ledge).toBe(80);
            tags = 'ledge';
            notify();
            stage.measure();
            expect(stage.tagged('ledge')[0].numbers.ledge).toBeUndefined();
        } finally {
            globalThis.MutationObserver = saved;
        }
    });
});

/** A ledge from x 0 to 100 and y 10 to 30. */
function ledge(tags: string): AnchorRect {
    return { name: 'shelf', x: 0, y: 10, width: 100, height: 20, visible: true, ...readTags(tags) };
}

/** A drop whose bottom has just crossed the ledge's top edge from above. */
function dropCrossingTop(roll: number, interactive: boolean): Droplet {
    const droplet = new Droplet({ position: { x: 49, y: 2 }, size: { x: 2, y: 10 }, velocity: { x: 0, y: 0.3 } });
    droplet.previousX = 49;
    droplet.previousBottom = 8;
    droplet.interactive = interactive;
    droplet.edgeChance = 0.3;
    droplet.roll = roll;
    return droplet;
}

describe('PageWalls and ledge-N', () => {
    const walls = new PageWalls();

    test('ledge-0 stops every drop at the edge it crosses, interactive or not', () => {
        for (const roll of [0, 0.5, 0.999]) {
            for (const interactive of [true, false]) {
                const droplet = dropCrossingTop(roll, interactive);
                const stop = walls.meet(droplet, [ledge('ledge-0')], 16);
                expect(stop?.edge).toBe('top');
                expect(droplet.position.y + droplet.size.y).toBe(10);
            }
        }
    });

    test('ledge-100 stops none, and never stops one later while it is inside', () => {
        const rects = [ledge('ledge-100')];
        for (const roll of [0, 0.5, 0.999]) {
            const droplet = dropCrossingTop(roll, true);
            expect(walls.meet(droplet, rects, 16)).toBeUndefined();
            for (let i = 0; i < 200; i++) {
                expect(walls.meet(droplet, rects, 1000)).toBeUndefined();
            }
        }
    });

    test('ledge-30 lets a drop through exactly when roll * 100 is below 30, the same way every time', () => {
        const rects = [ledge('ledge-30')];
        for (let k = 0; k < 20; k++) {
            expect(walls.meet(dropCrossingTop(0.29, true), rects, 16)).toBeUndefined();
            expect(walls.meet(dropCrossingTop(0.3, true), rects, 16)?.edge).toBe('top');
        }
        let through = 0;
        const n = 1000;
        for (let i = 0; i < n; i++) {
            if (!walls.meet(dropCrossingTop(i / n, false), rects, 16)) {
                through++;
            }
        }
        expect(through).toBe(300);
    });

    test('a plain ledge keeps the old rule: drops that are not interactive pass behind it', () => {
        const rects = [ledge('ledge')];
        for (let i = 0; i < 50; i++) {
            const droplet = dropCrossingTop(0.999, false);
            expect(walls.meet(droplet, rects, 16)).toBeUndefined();
            expect(walls.meet(droplet, rects, 1000)).toBeUndefined();
        }
        // An interactive one can still stop, at the edge or later inside.
        let stopped = 0;
        for (let i = 0; i < 200; i++) {
            const droplet = dropCrossingTop(0, true);
            if (walls.meet(droplet, rects, 16) || walls.meet(droplet, rects, 1000)) {
                stopped++;
            }
        }
        expect(stopped).toBeGreaterThan(0);
    });
});
