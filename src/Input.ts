import type { Vector3 } from './types';

// A press inside a dialog (or on its backdrop, which targets the dialog) is for the dialog, not the scene.
const INTERACTIVE =
    'a, button, input, select, textarea, summary, label, dialog, [role="button"], [role="dialog"], [contenteditable="true"]';
// Controls that take text. A focused checkbox or slider does not swallow the scene's keys,
// but anything inside an open dialog does: its keys belong to the dialog.
const TYPING =
    'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]), select, textarea, dialog, [role="dialog"], [contenteditable="true"]';

/**
 * Pointer, keyboard, wheel and scroll state, with the original "just pressed / just released"
 * edges. Edges accumulate between frames and are handed to exactly one tick, however many
 * catch-up ticks a frame runs.
 *
 * By default it listens to the whole window: the engine's usual job is a background behind a
 * page, and a press anywhere on the page is a press on the scene. Given a `stage` element
 * (`input: 'stage'` on the manager) it listens to that element only: the pointer counts while it
 * is over the element, keys while the element has focus, and Space and the arrow keys stop
 * scrolling the page while it does.
 *
 * Every listener is registered against one AbortController and removed in `dispose`.
 */
export class InputState {
    public mousePosition?: Vector3;
    public mouseDown = false;
    public mouseOnInteractive = false;
    public keysPressed: string[] = [];
    public scrollY = 0;

    private justPressedKeys: string[] = [];
    private justReleasedKeys: string[] = [];
    private mouseJustPressed = false;
    private mouseJustReleased = false;
    private wheelDelta = 0;
    private readonly abort = new AbortController();
    private originX = 0;
    private originY = 0;
    private readonly stage: HTMLElement | null;

    public constructor(target: Window = window, stage: HTMLElement | null = null) {
        this.stage = stage;
        const options = { signal: this.abort.signal, passive: true } as const;

        target.addEventListener(
            'pointermove',
            (event) => {
                this.mousePosition = this.over(event)
                    ? { x: event.clientX - this.originX, y: event.clientY - this.originY }
                    : undefined;
            },
            options,
        );
        target.addEventListener(
            'pointerdown',
            (event) => {
                if (event.button !== 0 || !this.over(event)) {
                    return;
                }
                this.mousePosition = { x: event.clientX - this.originX, y: event.clientY - this.originY };
                const element = event.target instanceof Element ? event.target : null;
                this.mouseOnInteractive = element?.closest(INTERACTIVE) != null;
                if (!this.mouseDown) {
                    this.mouseJustPressed = true;
                }
                this.mouseDown = true;
            },
            options,
        );
        const release = (): void => {
            if (this.mouseDown) {
                this.mouseJustReleased = true;
            }
            this.mouseDown = false;
        };
        target.addEventListener('pointerup', release, options);
        target.addEventListener('pointercancel', release, options);
        target.addEventListener('blur', () => {
            release();
            for (const key of this.keysPressed) {
                this.justReleasedKeys.push(key);
            }
            this.keysPressed = [];
        }, options);
        target.addEventListener(
            'pointerleave',
            () => {
                this.mousePosition = undefined;
            },
            options,
        );
        target.document.addEventListener(
            'pointerleave',
            () => {
                this.mousePosition = undefined;
            },
            options,
        );
        target.addEventListener(
            'wheel',
            (event) => {
                this.wheelDelta += event.deltaY;
            },
            options,
        );
        target.addEventListener(
            'scroll',
            () => {
                this.scrollY = target.scrollY;
            },
            options,
        );
        target.addEventListener(
            'keydown',
            (event) => {
                if (event.target instanceof Element && event.target.closest(TYPING)) {
                    return;
                }
                if (stage && target.document.activeElement !== stage) {
                    return;
                }
                const key = normalizeKey(event.key);
                if (!this.keysPressed.includes(key)) {
                    this.keysPressed.push(key);
                    this.justPressedKeys.push(key);
                }
            },
            options,
        );
        target.addEventListener(
            'keyup',
            (event) => {
                const key = normalizeKey(event.key);
                if (this.keysPressed.includes(key)) {
                    this.keysPressed = this.keysPressed.filter((pressed) => pressed !== key);
                    this.justReleasedKeys.push(key);
                }
            },
            options,
        );
        this.scrollY = target.scrollY;

        if (stage) {
            // While the stage has focus, its keys are the scene's, not the page's scroll keys.
            stage.addEventListener(
                'keydown',
                (event) => {
                    if (event.key === ' ' || event.key.startsWith('Arrow')) {
                        event.preventDefault();
                    }
                },
                { signal: this.abort.signal },
            );
            stage.addEventListener(
                'blur',
                () => {
                    for (const key of this.keysPressed) {
                        this.justReleasedKeys.push(key);
                    }
                    this.keysPressed = [];
                },
                { signal: this.abort.signal },
            );
        }
    }

    /** Over the stage element, or anywhere when listening to the whole window. */
    private over(event: PointerEvent): boolean {
        if (!this.stage) {
            return true;
        }
        const box = this.stage.getBoundingClientRect();
        return (
            event.clientX >= box.left &&
            event.clientX <= box.right &&
            event.clientY >= box.top &&
            event.clientY <= box.bottom
        );
    }

    /** Viewport offset of the canvas, so pointer positions land in stage space. */
    public setOrigin(x: number, y: number): void {
        this.originX = x;
        this.originY = y;
    }

    /** Hand over the accumulated edges and reset them. Call once per frame, for the first tick only. */
    public takeEdges(): {
        justPressedKeys: string[];
        justReleasedKeys: string[];
        mouseJustPressed: boolean;
        mouseJustReleased: boolean;
        wheelDelta: number;
    } {
        const edges = {
            justPressedKeys: this.justPressedKeys,
            justReleasedKeys: this.justReleasedKeys,
            mouseJustPressed: this.mouseJustPressed,
            mouseJustReleased: this.mouseJustReleased,
            wheelDelta: this.wheelDelta,
        };
        this.justPressedKeys = [];
        this.justReleasedKeys = [];
        this.mouseJustPressed = false;
        this.mouseJustReleased = false;
        this.wheelDelta = 0;
        return edges;
    }

    public dispose(): void {
        this.abort.abort();
    }
}

export function normalizeKey(key: string): string {
    if (key === ' ') {
        return 'space';
    }
    return key.toLowerCase();
}
