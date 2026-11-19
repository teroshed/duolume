import type { FieldLetter } from '../types';
import type { VisualsManager } from '../VisualsManager';
import { diffText, placeLetters, type LetterBox } from './letters';

export interface FieldTextOptions {
    /** Where to listen for typing. Default: `document`. */
    root?: ParentNode;
}

/** Input types whose value is text someone types. */
const TEXT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);
const BULLET = '•';

/**
 * Tells the scene what is typed. Every time the text of an `<input>` or a `<textarea>` changes,
 * this emits the engine event `field:text` (see `FieldTextEvent`): the field's anchor name, the
 * whole text, what the edit added and removed and where, the caret, and where every letter is
 * drawn, in stage pixels, so an effect can answer under the very letter that was typed.
 *
 *     const manager = await VisualsManager.create(canvas);
 *     attachFieldText(manager);
 *     // in an effect:  for (const e of tick.events('field:text')) { e.payload.letters[e.payload.at] … }
 *
 * The letters are measured with the field's own font, letter spacing and alignment, and follow
 * the text when it scrolls inside a field that is too short for it. They are left out (an empty
 * list) for a text area, whose lines wrap, and for right-to-left text. A password field is
 * reported as bullets only: its text never reaches the scene.
 *
 * Changing `.value` from script fires no event, so nothing is emitted for it. Returns a function
 * that stops listening.
 */
export function attachFieldText(manager: VisualsManager, options: FieldTextOptions = {}): () => void {
    const root = (options.root ?? document) as unknown as EventTarget;
    const abort = new AbortController();
    /** What each field held, and where its letters were, after the edit before. */
    const before = new WeakMap<Element, { chars: string[]; letters: FieldLetter[] }>();
    const pen = document.createElement('canvas').getContext('2d');
    let edges = new Float64Array(64);

    const textOf = (control: HTMLInputElement | HTMLTextAreaElement): string[] => {
        const chars = Array.from(control.value);
        return control instanceof HTMLInputElement && control.type === 'password' ? chars.map(() => BULLET) : chars;
    };

    const isTextField = (target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement =>
        target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && TEXT_TYPES.has(target.type));

    /** Where every letter is, in stage pixels. Empty when it cannot be told. */
    const measure = (control: HTMLInputElement | HTMLTextAreaElement, chars: string[], originX: number): FieldLetter[] => {
        if (!pen || control instanceof HTMLTextAreaElement) {
            return [];
        }
        const style = getComputedStyle(control);
        if (style.direction === 'rtl') {
            return [];
        }
        pen.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        // Canvas text has letter spacing in current browsers; where it has not, the letters are a little tight.
        (pen as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
        const shown = style.textTransform === 'uppercase' ? chars.map((c) => c.toUpperCase()) : style.textTransform === 'lowercase' ? chars.map((c) => c.toLowerCase()) : chars;
        if (edges.length < shown.length + 1) {
            edges = new Float64Array((shown.length + 1) * 2);
        }
        // Measuring each prefix keeps the kerning between neighbours.
        let prefix = '';
        edges[0] = 0;
        for (let i = 0; i < shown.length; i++) {
            prefix += shown[i];
            edges[i + 1] = pen.measureText(prefix).width;
        }
        const rect = control.getBoundingClientRect();
        const left = parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
        const right = parseFloat(style.borderRightWidth) + parseFloat(style.paddingRight);
        const align = style.textAlign;
        const box: LetterBox = {
            left: rect.left - originX + (Number.isFinite(left) ? left : 0),
            width: Math.max(0, rect.width - (Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0)),
            align: align === 'center' ? 'center' : align === 'right' || align === 'end' ? 'end' : 'start',
            scroll: control.scrollLeft,
        };
        return placeLetters(chars, edges, box);
    };

    const remember = (event: Event): void => {
        if (isTextField(event.target) && !before.has(event.target)) {
            before.set(event.target, { chars: textOf(event.target), letters: [] });
        }
    };

    const onInput = (event: Event): void => {
        const control = event.target;
        if (!isTextField(control)) {
            return;
        }
        const origin = manager.canvas.getBoundingClientRect();
        const chars = textOf(control);
        const was = before.get(control) ?? { chars: [], letters: [] };
        const edit = diffText(was.chars, chars);
        const letters = measure(control, chars, origin.left);
        const taken = Array.from(edit.removed).length;
        const rect = control.getBoundingClientRect();
        let caret = -1;
        try {
            // Counted in characters, like everything else here. Some input types refuse to say.
            caret = control.selectionStart === null ? -1 : Array.from(control.value.slice(0, control.selectionStart)).length;
        } catch {
            caret = -1;
        }
        manager.emit('field:text', {
            anchor: control.closest('[data-fx-anchor]')?.getAttribute('data-fx-anchor') ?? '',
            text: chars.join(''),
            added: edit.added,
            removed: edit.removed,
            at: edit.at,
            caret,
            letters,
            removedLetters: was.letters.length >= edit.at + taken ? was.letters.slice(edit.at, edit.at + taken).map((letter) => ({ ...letter })) : [],
            top: rect.top - origin.top,
            bottom: rect.bottom - origin.top,
        });
        before.set(control, { chars, letters: letters.map((letter) => ({ ...letter })) });
    };

    const listen = { signal: abort.signal, capture: true } as const;
    root.addEventListener('focusin', remember, listen);
    root.addEventListener('input', onInput, listen);
    return () => abort.abort();
}
