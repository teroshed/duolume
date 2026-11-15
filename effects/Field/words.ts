/**
 * What the tags of a page element say about its state.
 *
 * An input effect draws inside the page elements that carry its tag (`data-fx-tags="liquid"`).
 * The other words in the same attribute describe the element, and this is the whole vocabulary:
 *
 *   on / off      a switch or checkbox is checked or not
 *   focus         it has the keyboard focus
 *   disabled      it cannot be used
 *   invalid       what was entered is not accepted
 *   busy          it is waiting for something
 *   knob          a knob covers one end (a switch track): the left end when off, the right when on
 *   value:0.62    how full it is, 0 to 1 (a slider, a progress bar)
 *   r:10          corner radius in pixels (without it the element is taken to be a pill)
 *
 * The page may write these itself, or call `attachFieldTags()` once, which keeps them up to
 * date from the real form controls. Words that are not listed are ignored.
 */
export interface FieldWords {
    on: boolean;
    off: boolean;
    focus: boolean;
    disabled: boolean;
    invalid: boolean;
    busy: boolean;
    knob: boolean;
    /** 0..1, or undefined when the tags give no value. */
    value: number | undefined;
    /** Corner radius in pixels, or undefined when the tags give none. */
    radius: number | undefined;
}

export function emptyFieldWords(): FieldWords {
    return { on: false, off: false, focus: false, disabled: false, invalid: false, busy: false, knob: false, value: undefined, radius: undefined };
}

/** Read the vocabulary above out of an element's tags, into `out`. */
export function readFieldWords(tags: readonly string[], out: FieldWords = emptyFieldWords()): FieldWords {
    out.on = out.off = out.focus = out.disabled = out.invalid = out.busy = out.knob = false;
    out.value = undefined;
    out.radius = undefined;
    for (const tag of tags) {
        if (tag === 'on' || tag === 'off' || tag === 'focus' || tag === 'disabled' || tag === 'invalid' || tag === 'busy' || tag === 'knob') {
            out[tag] = true;
        } else if (tag.startsWith('value:')) {
            const value = Number(tag.slice(6));
            if (Number.isFinite(value)) {
                out.value = value < 0 ? 0 : value > 1 ? 1 : value;
            }
        } else if (tag.startsWith('r:')) {
            const radius = Number(tag.slice(2));
            if (Number.isFinite(radius) && radius >= 0) {
                out.radius = radius;
            }
        }
    }
    return out;
}
