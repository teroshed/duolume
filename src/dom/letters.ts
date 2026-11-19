import type { FieldLetter } from '../types';

/** Where a line of text sits in its field, along the reading direction, in the units the edges are in. */
export interface LetterBox {
    /** Left edge of the space the text may use (inside the border and the padding). */
    left: number;
    /** Width of that space. */
    width: number;
    /** Where a line shorter than the space sits in it. */
    align: 'start' | 'center' | 'end';
    /** How far the text has been scrolled to the left (a line longer than its field). */
    scroll: number;
}

/**
 * Where each letter of a line of text is. Pure arithmetic: the browser measures the text and
 * hands in `edges`, where `edges[i]` is the width of the first `i` characters (`edges[0]` is 0),
 * so the result has the kerning and the letter spacing the browser used.
 *
 * `chars` is the text split into the characters that were measured (by code point, so an emoji
 * is one). The letters are written into `out`, which is reused, and returned.
 */
export function placeLetters(chars: readonly string[], edges: ArrayLike<number>, box: LetterBox, out: FieldLetter[] = []): FieldLetter[] {
    const count = Math.min(chars.length, edges.length - 1);
    const width = count > 0 ? edges[count] : 0;
    const spare = box.width - width;
    const shift = spare > 0 ? (box.align === 'center' ? spare / 2 : box.align === 'end' ? spare : 0) : 0;
    const origin = box.left + shift - box.scroll;
    out.length = Math.max(0, count);
    for (let i = 0; i < count; i++) {
        const letter = out[i] ?? { char: '', start: 0, end: 0 };
        letter.char = chars[i];
        letter.start = origin + edges[i];
        letter.end = origin + edges[i + 1];
        out[i] = letter;
    }
    return out;
}

/** What one edit did: the text it put in and the text it took out, and where. */
export interface TextEdit {
    /** Index of the first character that differs, counted in characters of the new text. */
    at: number;
    added: string;
    removed: string;
}

/**
 * The smallest single edit that turns `before` into `after`: what is the same at the start and
 * at the end is kept, the rest was replaced. Typing a letter adds it; a paste over a selection
 * removes the selection and adds the paste; a backspace only removes.
 *
 * Where letters repeat, the same edit can be told more than one way ("a|a" plus an "a"); the
 * start is matched first, so the edit is reported as late in the text as it can be.
 *
 * Both are lists of characters, so an edit never splits an emoji.
 */
export function diffText(before: readonly string[], after: readonly string[]): TextEdit {
    const shorter = Math.min(before.length, after.length);
    let head = 0;
    while (head < shorter && before[head] === after[head]) {
        head++;
    }
    let tail = 0;
    while (tail < shorter - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) {
        tail++;
    }
    return {
        at: head,
        added: after.slice(head, after.length - tail).join(''),
        removed: before.slice(head, before.length - tail).join(''),
    };
}
