import { describe, expect, test } from 'bun:test';
import { cornerRadius, fadeToward, frameLine, lineDraw, mirrored, placePicture, settle, SPREAD } from '../src/dom/place';
import { Stage } from '../src/Stage';

// The page layer's maths has no DOM in it: where a picture lands, where a frame's line runs,
// how far a piece has appeared. PageLayer only writes these numbers onto page nodes.

const box = { name: 'card', x: 100.3, y: 50.6, width: 200, height: 40 };

describe('placing pictures', () => {
    test('at [1, 0] lands the origin of the picture on the top-right corner', () => {
        const [place] = placePicture(box, { image: 'star.svg', size: 20, at: [1, 0], origin: [0.5, 0.5] }, 1, 0, false);
        expect(place.x + 0.5 * place.width).toBeCloseTo(box.x + box.width);
        expect(place.y + 0.5 * place.height).toBeCloseTo(box.y);
        expect(place.opacity).toBe(1);
    });

    test('nothing travels once it is fully shown, and it arrives from outside before that', () => {
        const picture = { image: 'star.svg', size: 20, at: [1, 0] as [number, number] };
        const [there] = placePicture(box, picture, 1, 0, false);
        const [arriving] = placePicture(box, picture, 0, 0, false);
        expect(there.x).toBeCloseTo(box.x + box.width - 10);
        expect(arriving.x - there.x).toBeCloseTo(SPREAD); // further right
        expect(arriving.y - there.y).toBeCloseTo(-SPREAD); // further up
        expect(arriving.opacity).toBe(0);
    });

    test("mirror: 'both' gives four copies, one per corner, each flipped toward its own corner", () => {
        const copies = mirrored({ image: 'corner.svg', at: [0, 0], mirror: 'both' });
        expect(copies).toEqual([
            { at: [0, 0], flip: [1, 1] },
            { at: [1, 0], flip: [-1, 1] },
            { at: [1, 1], flip: [-1, -1] },
            { at: [0, 1], flip: [1, -1] },
        ]);
        const places = placePicture(box, { image: 'corner.svg', size: 24, at: [0, 0], origin: [0.25, 0.25], mirror: 'both' }, 1, 0, false);
        expect(places.map((place) => [place.scaleX, place.scaleY])).toEqual([
            [1, 1],
            [-1, 1],
            [-1, -1],
            [1, -1],
        ]);
        // Each copy flips about the point that sits on its corner, so that point stays on the corner.
        expect(places[2].x + places[2].pivotX * places[2].width).toBeCloseTo(box.x + box.width);
        expect(places[2].y + places[2].pivotY * places[2].height).toBeCloseTo(box.y + box.height);
        expect(mirrored({ image: 'a', at: [0, 0.5], mirror: 'x' })).toEqual([
            { at: [0, 0.5], flip: [1, 1] },
            { at: [1, 0.5], flip: [-1, 1] },
        ]);
    });

    test('span repeats the image in whole copies across that share of the width', () => {
        const [place] = placePicture(box, { image: 'ticks.svg', size: [40, 6], at: [0.5, 1], span: 0.5 }, 1, 0, false);
        // Half of 200 is 100, which is 2.5 copies of 40: it rounds to whole ones.
        expect(place.width % 40).toBe(0);
        expect(place.width).toBe(120);
        expect(place.repeat).toBe(true);
        expect(place.x + 0.5 * place.width).toBeCloseTo(box.x + box.width / 2);
        const [narrow] = placePicture({ ...box, width: 10 }, { image: 'ticks.svg', size: [40, 6], span: 0.5 }, 1, 0, false);
        expect(narrow.width).toBe(40); // never less than one
    });

    test('reduced motion holds twinkle and sway still, whatever the time', () => {
        const spark = { image: 'spark.svg', twinkle: 0.3 };
        const leaf = { image: 'laurel.svg', sway: 2 };
        const times = [0, 377, 1200, 9001];
        expect(new Set(times.map((time) => placePicture(box, spark, 1, time, true)[0].scaleX))).toEqual(new Set([0.85]));
        expect(new Set(times.map((time) => placePicture(box, leaf, 1, time, true)[0].turn))).toEqual(new Set([0]));
        // With motion they do move.
        expect(new Set(times.map((time) => placePicture(box, spark, 1, time, false)[0].scaleX)).size).toBeGreaterThan(1);
        expect(new Set(times.map((time) => placePicture(box, leaf, 1, time, false)[0].turn)).size).toBeGreaterThan(1);
    });

    test('grows unrolls from the base as it appears', () => {
        const leaf = { image: 'laurel.svg', grows: true };
        expect(placePicture(box, leaf, 0, 0, false)[0].clipTop).toBe(1);
        expect(placePicture(box, leaf, 1, 0, false)[0].clipTop).toBe(0);
    });

    test('the same inputs give the same output twice', () => {
        const picture = { image: 'laurel.svg', size: [27, 60] as [number, number], at: [0, 0.5] as [number, number], origin: [0.62, 0.5] as [number, number], mirror: 'x' as const, grows: true, sway: 2 };
        expect(placePicture(box, picture, 0.4, 1234.5, false, 3)).toEqual(placePicture(box, picture, 0.4, 1234.5, false, 3));
        const frame = { dash: [0.1, 7] as [number, number], bead: true };
        expect(lineDraw(frame, 0.4, 1234.5, false)).toEqual(lineDraw(frame, 0.4, 1234.5, false));
    });
});

describe("a frame's line", () => {
    test('sits the gap outside the element, its 1 px stroke on whole pixels (middle on a half pixel), as the prototype did', () => {
        const line = frameLine(box, { gap: 6 });
        // Prototype: x = round(x - gap) + 0.5, width = round(width + 2 gap) - 1.
        expect(line.x).toBe(Math.round(100.3 - 6) + 0.5);
        expect(line.y).toBe(Math.round(50.6 - 6) + 0.5);
        expect(line.width).toBe(Math.round(200 + 12) - 1);
        expect(line.height).toBe(Math.round(40 + 12) - 1);
        // A 2 px line has its middle on a whole pixel instead.
        const thick = frameLine(box, { gap: 6, line: 2 });
        expect(thick.x).toBe(Math.round(100.3 - 6) + 1);
        expect(thick.width).toBe(Math.round(200 + 12) - 2);
    });

    test("its radius is the element's own plus the gap unless given, and never more than half its height", () => {
        expect(frameLine({ ...box, radius: 8 }, { gap: 6 }).radius).toBe(14);
        expect(frameLine({ ...box, radius: 8 }, { gap: 6, radius: 3 }).radius).toBe(3);
        expect(frameLine(box, { radius: 999 }).radius).toBe(frameLine(box).height / 2);
        expect(frameLine(box).radius).toBe(6); // square element: just the gap
    });

    test('a plain line draws itself round as it appears; a dashed one marches, except under reduced motion', () => {
        expect(lineDraw({}, 0, 0, false).dashOffset).toBe(100);
        expect(lineDraw({}, 1, 0, false).dashOffset).toBe(0);
        expect(lineDraw({}, 1, 0, false).pathLength).toBe(100);
        expect(lineDraw({ dash: [0.1, 7] }, 1, 1000, false).dashOffset).not.toBe(0);
        expect(lineDraw({ dash: [0.1, 7] }, 1, 1000, true).dashOffset).toBe(0);
        expect(lineDraw({ bead: true }, 1, 1000, false).bead).toBeDefined();
        expect(lineDraw({ bead: true }, 1, 1000, true).bead).toBeUndefined();
    });
});

describe('how far a piece is shown', () => {
    test('a number is used as given; under reduced motion it is there from 0.5 and gone below', () => {
        expect(settle(0.3, false)).toBe(0.3);
        expect(settle(7, false)).toBe(1);
        expect(settle(0.5, true)).toBe(1);
        expect(settle(0.49, true)).toBe(0);
    });

    test('a fade steps toward its end over the fade time and stops there', () => {
        expect(fadeToward(0, 1, 130, 260)).toBe(0.5);
        expect(fadeToward(0.9, 1, 130, 260)).toBe(1);
        expect(fadeToward(0.2, 0, 130, 260)).toBe(0);
        expect(fadeToward(0.3, 1, 0, 260)).toBe(0.3);
    });
});

describe("an element's corner radius", () => {
    test('is read from the computed style and kept to what fits, as attachFieldTags keeps r:', () => {
        expect(cornerRadius('10px', 200, 40)).toBe(10);
        expect(cornerRadius('999px', 200, 40)).toBe(21);
        expect(cornerRadius('50%', 200, 40)).toBe(21);
        expect(cornerRadius('0px', 200, 40)).toBe(0);
        expect(cornerRadius('', 200, 40)).toBe(0);
    });

    test('the stage reads it into AnchorRect.radius only when the element changes size', () => {
        let reads = 0;
        let width = 200;
        const global = globalThis as unknown as { getComputedStyle: unknown };
        const saved = global.getComputedStyle;
        global.getComputedStyle = () => {
            reads++;
            return { borderTopLeftRadius: '12px' };
        };
        try {
            const stage = new Stage();
            stage.resize(800, 600);
            stage.observe('card', { getBoundingClientRect: () => ({ left: 10, top: 10, width, height: 40 }) } as unknown as Element);
            stage.measure();
            stage.measure();
            expect(stage.anchor('card')?.radius).toBe(12);
            expect(reads).toBe(1);
            width = 300;
            stage.measure();
            expect(reads).toBe(2);
        } finally {
            global.getComputedStyle = saved;
        }
    });
});

describe('playing the focus look from code', () => {
    const element = { getBoundingClientRect: () => ({ left: 10, top: 10, width: 200, height: 40 }) } as unknown as Element;

    test('focus adds the word to the tags, tagged() still finds the element, unfocus takes it away', () => {
        const stage = new Stage();
        stage.resize(800, 600);
        let changed = 0;
        stage.onAnchorsChanged = () => changed++;
        stage.observe('email', element, ['frame', 'laurel']);
        stage.measure();
        const before = stage.anchor('email')!.tags;

        stage.focus('email');
        expect(stage.anchor('email')!.tags).toEqual(['frame', 'laurel', 'focus']);
        expect(stage.anchor('email')!.tags).not.toBe(before); // a new list, so a FieldSet sees the change
        expect(stage.tagged('frame').map((anchor) => anchor.name)).toEqual(['email']);
        expect(stage.tagged('focus').map((anchor) => anchor.name)).toEqual(['email']);
        expect(changed).toBeGreaterThan(0); // asks for a redraw

        stage.unfocus('email');
        expect(stage.anchor('email')!.tags).toEqual(['frame', 'laurel']);
        expect(stage.tagged('focus')).toEqual([]);
    });

    test('real focus in the tags still shows after unfocus, and is not doubled by focus', () => {
        const stage = new Stage();
        stage.observe('email', element, ['frame', 'focus']);
        stage.focus('email');
        expect(stage.anchor('email')!.tags).toEqual(['frame', 'focus']);
        stage.unfocus('email');
        expect(stage.anchor('email')!.tags).toEqual(['frame', 'focus']);
    });

    test('a retag keeps a forced focus, and a name that arrives later gets it', () => {
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
            let tags = 'frame';
            const page: Element[] = [];
            const field = {
                getAttribute: (name: string) => (name === 'data-fx-anchor' ? 'email' : name === 'data-fx-tags' ? tags : null),
                getBoundingClientRect: () => ({ left: 10, top: 10, width: 200, height: 40 }),
            } as unknown as Element;
            const stage = new Stage();
            stage.resize(800, 600);
            stage.watchAll({ querySelectorAll: () => page } as unknown as ParentNode);

            stage.focus('email'); // not on the page yet: remembered, and no throw
            expect(stage.anchor('email')).toBeUndefined();
            page.push(field);
            notify();
            stage.measure();
            expect(stage.anchor('email')!.tags).toEqual(['frame', 'focus']);

            tags = 'frame sparkle';
            notify();
            stage.measure();
            expect(stage.anchor('email')!.tags).toEqual(['frame', 'sparkle', 'focus']);

            stage.unfocus('email');
            notify();
            stage.measure();
            expect(stage.anchor('email')!.tags).toEqual(['frame', 'sparkle']);
            expect(() => stage.unfocus('nobody')).not.toThrow();
        } finally {
            globalThis.MutationObserver = saved;
        }
    });
});
