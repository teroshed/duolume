import { describe, expect, test } from 'bun:test';
import { diffText, placeLetters } from '../src/dom/letters';

const chars = (text: string): string[] => Array.from(text);

describe('placeLetters', () => {
    // "abc" measured as 10, 8 and 12 wide.
    const edges = [0, 10, 18, 30];

    test('letters follow each other from the left of the box', () => {
        const letters = placeLetters(chars('abc'), edges, { left: 100, width: 200, align: 'start', scroll: 0 });
        expect(letters).toEqual([
            { char: 'a', start: 100, end: 110 },
            { char: 'b', start: 110, end: 118 },
            { char: 'c', start: 118, end: 130 },
        ]);
    });

    test('a short line is centred or pushed to the end; a long one is not', () => {
        expect(placeLetters(chars('abc'), edges, { left: 100, width: 200, align: 'center', scroll: 0 })[0].start).toBe(185);
        expect(placeLetters(chars('abc'), edges, { left: 100, width: 200, align: 'end', scroll: 0 })[2].end).toBe(300);
        expect(placeLetters(chars('abc'), edges, { left: 100, width: 20, align: 'center', scroll: 0 })[0].start).toBe(100);
    });

    test('scrolled text moves left with the scroll', () => {
        expect(placeLetters(chars('abc'), edges, { left: 100, width: 20, align: 'start', scroll: 12 })[2].start).toBe(106);
    });

    test('an emoji is one letter, the list is reused, and no text is no letters', () => {
        const out = placeLetters(chars('a😀'), [0, 10, 30], { left: 0, width: 100, align: 'start', scroll: 0 });
        expect(out.map((letter) => letter.char)).toEqual(['a', '😀']);
        expect(placeLetters([], [0], { left: 0, width: 100, align: 'center', scroll: 0 }, out)).toBe(out);
        expect(out.length).toBe(0);
    });
});

describe('diffText', () => {
    test('a letter typed, at the end and in the middle', () => {
        expect(diffText(chars('hel'), chars('hell'))).toEqual({ at: 3, added: 'l', removed: '' });
        expect(diffText(chars('helo'), chars('hello'))).toEqual({ at: 3, added: 'l', removed: '' });
    });

    test('a backspace, and a word deleted', () => {
        expect(diffText(chars('hello'), chars('hell'))).toEqual({ at: 4, added: '', removed: 'o' });
        // "two " and "wo t" are the same deletion here; what matches at the start is kept first.
        expect(diffText(chars('one two three'), chars('one three'))).toEqual({ at: 5, added: '', removed: 'wo t' });
        expect(diffText(chars('one two four'), chars('one four'))).toEqual({ at: 4, added: '', removed: 'two ' });
    });

    test('a paste over a selection removes and adds', () => {
        expect(diffText(chars('one two three'), chars('one 2 three'))).toEqual({ at: 4, added: '2', removed: 'two' });
    });

    test('nothing changed, everything new, everything gone', () => {
        expect(diffText(chars('same'), chars('same'))).toEqual({ at: 4, added: '', removed: '' });
        expect(diffText([], chars('abc'))).toEqual({ at: 0, added: 'abc', removed: '' });
        expect(diffText(chars('abc'), [])).toEqual({ at: 0, added: '', removed: 'abc' });
    });

    test('a repeated letter is one edit, not two', () => {
        expect(diffText(chars('aa'), chars('aaa'))).toEqual({ at: 2, added: 'a', removed: '' });
    });
});
