export interface FieldTagsOptions {
    /** Where to look for `[data-fx-anchor]` elements. Default: `document`. */
    root?: ParentNode;
}

export interface FieldTags {
    /** Read every control again. For after a script changed `.checked`, `.value` or `disabled`. */
    refresh(): void;
    /** Stop listening and remove the words this wrote. */
    stop(): void;
}

/** The words this keeps up to date. Any other word in `data-fx-tags` is left as the page wrote it. */
const MANAGED = /^(on|off|focus|disabled|invalid|knob|value:.*|r:.*)$/;
const CONTROL = 'input, select, textarea, button, progress, meter';

/**
 * Keeps the state of the page's form controls in their `data-fx-tags`, so an effect that draws
 * inside an input knows what the input is doing without the page writing a line of script.
 *
 * For every `[data-fx-anchor]` element that is a form control, contains one, or sits in the
 * same `<label>` as one, these words are kept current:
 *
 *   on / off      a checkbox or radio button is checked or not
 *   focus         the control has the keyboard focus
 *   disabled      the control is disabled
 *   invalid       the control has been changed and its value is not accepted
 *   knob          the element is the track of a checkbox or radio (it is not the control itself)
 *   value:0.62    a range, progress or meter: how far along it is, 0 to 1
 *   r:10          the element's corner radius in pixels
 *
 *     <label class="switch">
 *         <input type="checkbox" checked />
 *         <span class="track" data-fx-anchor="rain-switch" data-fx-tags="mini rain"></span>
 *         Rain
 *     </label>
 *
 * The stage already follows changes to `data-fx-tags`, so nothing else is needed. One case needs
 * a word from the page: setting `.checked` or `.value` from script fires no event, so call
 * `refresh()` after doing that. `stop()` ends it and takes the words out again.
 */
export function attachFieldTags(options: FieldTagsOptions = {}): FieldTags {
    const root = options.root ?? document;
    const touched = new WeakSet<Element>();
    const abort = new AbortController();

    const controlOf = (anchor: Element): Element | null => {
        if (anchor.matches(CONTROL)) {
            return anchor;
        }
        return anchor.querySelector(CONTROL) ?? anchor.closest('label')?.querySelector(CONTROL) ?? null;
    };

    const sync = (anchor: Element): void => {
        const control = controlOf(anchor);
        if (!control) {
            return;
        }
        const words = (anchor.getAttribute('data-fx-tags') ?? '').split(/\s+/).filter((word) => word !== '' && !MANAGED.test(word));

        if (control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio')) {
            words.push(control.checked ? 'on' : 'off');
            if (control !== anchor) {
                words.push('knob');
            }
        } else if (control instanceof HTMLInputElement && control.type === 'range') {
            const min = Number(control.min || 0);
            const max = Number(control.max || 100);
            words.push(`value:${max > min ? round((Number(control.value) - min) / (max - min)) : 0}`);
        } else if (control instanceof HTMLProgressElement) {
            words.push(`value:${control.max > 0 ? round(control.value / control.max) : 0}`);
        } else if (control instanceof HTMLMeterElement) {
            words.push(`value:${control.max > control.min ? round((control.value - control.min) / (control.max - control.min)) : 0}`);
        }
        if (control.matches(':focus')) {
            words.push('focus');
        }
        if (control.matches(':disabled')) {
            words.push('disabled');
        }
        // Not before the visitor has touched it: an empty required field is not a mistake yet.
        if (touched.has(control) && control.matches(':invalid')) {
            words.push('invalid');
        }
        const radius = parseFloat(getComputedStyle(anchor).borderTopLeftRadius);
        if (Number.isFinite(radius)) {
            words.push(`r:${Math.round(Math.min(radius, anchor.clientHeight / 2 + 1, anchor.clientWidth / 2 + 1))}`);
        }

        const next = words.join(' ');
        if (anchor.getAttribute('data-fx-tags') !== next) {
            anchor.setAttribute('data-fx-tags', next);
        }
    };

    const syncAll = (): void => {
        for (const anchor of root.querySelectorAll('[data-fx-anchor]')) {
            sync(anchor);
        }
    };

    /** The anchors a control's state belongs to: itself, the ones around it, the ones in its label. */
    const syncFor = (target: EventTarget | null): void => {
        if (!(target instanceof Element)) {
            return;
        }
        const control = target.closest(CONTROL);
        if (!control) {
            return;
        }
        // A radio button that was switched off gets no event of its own, so do its whole group.
        if (control instanceof HTMLInputElement && control.type === 'radio') {
            syncAll();
            return;
        }
        const scope = control.closest('label') ?? control.parentElement ?? control;
        for (const anchor of scope.querySelectorAll('[data-fx-anchor]')) {
            sync(anchor);
        }
        const around = control.closest('[data-fx-anchor]');
        if (around) {
            sync(around);
        }
    };

    const listen = { signal: abort.signal, capture: true } as const;
    const onChange = (event: Event): void => {
        if (event.target instanceof Element) {
            const control = event.target.closest(CONTROL);
            if (control) {
                touched.add(control);
            }
        }
        syncFor(event.target);
    };
    const host = root as unknown as EventTarget;
    host.addEventListener('change', onChange, listen);
    host.addEventListener('input', onChange, listen);
    host.addEventListener('focusin', (event) => syncFor(event.target), listen);
    host.addEventListener('focusout', (event) => syncFor(event.target), listen);

    // Elements added later, and controls disabled or resized by script.
    const mutations = new MutationObserver(syncAll);
    mutations.observe(root as unknown as Node, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'data-fx-anchor'] });
    window.addEventListener('resize', syncAll, { signal: abort.signal });
    syncAll();

    return {
        refresh: syncAll,
        stop: () => {
            abort.abort();
            mutations.disconnect();
            for (const anchor of root.querySelectorAll('[data-fx-anchor]')) {
                if (!controlOf(anchor)) {
                    continue;
                }
                const words = (anchor.getAttribute('data-fx-tags') ?? '').split(/\s+/).filter((word) => word !== '' && !MANAGED.test(word));
                anchor.setAttribute('data-fx-tags', words.join(' '));
            }
        },
    };
}

function round(value: number): number {
    return Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
}
