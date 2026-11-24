import { describe, expect, test } from 'bun:test';
import { InputState } from '../src/Input';

type Listener = (event: Record<string, unknown>) => void;

// The tests run without a DOM; InputState only asks whether a press landed on an Element.
(globalThis as { Element?: unknown }).Element ??= class {};

/** Enough of a window for InputState: listeners that can be fired by hand, and a media query. */
function fakeWindow(coarse = false): { target: Window; fire: (type: string, event?: Record<string, unknown>) => void } {
    const listeners = new Map<string, Listener[]>();
    const add = (type: string, listener: Listener): void => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    };
    const target = {
        addEventListener: add,
        document: { addEventListener: add },
        matchMedia: (query: string) => ({ matches: coarse && query === '(pointer: coarse)' }),
        scrollY: 0,
    } as unknown as Window;
    return {
        target,
        fire: (type, event = {}) => {
            for (const listener of listeners.get(type) ?? []) {
                listener({ button: 0, clientX: 0, clientY: 0, pointerType: 'mouse', target: null, ...event });
            }
        },
    };
}

describe('how the visitor is pointing', () => {
    test('before any input it is a guess from the device', () => {
        expect(new InputState(fakeWindow(false).target).pointer).toEqual({ kind: 'mouse', coarse: false, last: undefined });
        expect(new InputState(fakeWindow(true).target).pointer).toEqual({ kind: 'touch', coarse: true, last: undefined });
    });

    test('the kind follows the latest input, and the device stays what it is', () => {
        const { target, fire } = fakeWindow(true);
        const input = new InputState(target);
        fire('pointermove', { pointerType: 'mouse', clientX: 10, clientY: 20 });
        expect(input.pointer.kind).toBe('mouse');
        expect(input.pointer.coarse).toBe(true);
        fire('pointerdown', { pointerType: 'pen', clientX: 30, clientY: 40 });
        expect(input.pointer.kind).toBe('pen');
        fire('pointerdown', { pointerType: 'touch', clientX: 50, clientY: 60 });
        expect(input.pointer.kind).toBe('touch');
        expect(input.pointer.last).toEqual({ x: 50, y: 60 });
    });

    test('a finger is a pointer only while it is down: one frame with the tap, then none', () => {
        const { target, fire } = fakeWindow(true);
        const input = new InputState(target);
        // A tap that begins and ends between two frames.
        fire('pointerdown', { pointerType: 'touch', clientX: 100, clientY: 200 });
        fire('pointerup', { pointerType: 'touch', clientX: 100, clientY: 200 });
        // The frame that hears of it: the press, the release, and where.
        expect(input.mousePosition).toEqual({ x: 100, y: 200 });
        const edges = input.takeEdges();
        expect(edges.mouseJustPressed).toBe(true);
        expect(edges.mouseJustReleased).toBe(true);
        // From then on there is no pointer, but the last place is remembered.
        expect(input.mousePosition).toBeUndefined();
        expect(input.pointer.last).toEqual({ x: 100, y: 200 });
        input.takeEdges();
        expect(input.mousePosition).toBeUndefined();
    });

    test('a finger held down keeps its position, and a second touch before the frame keeps it too', () => {
        const { target, fire } = fakeWindow(true);
        const input = new InputState(target);
        fire('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 });
        input.takeEdges();
        fire('pointermove', { pointerType: 'touch', clientX: 40, clientY: 10 });
        input.takeEdges();
        expect(input.mousePosition).toEqual({ x: 40, y: 10 });
        // Lift and touch again before the next frame: the pointer is there.
        fire('pointerup', { pointerType: 'touch' });
        fire('pointerdown', { pointerType: 'touch', clientX: 70, clientY: 10 });
        input.takeEdges();
        expect(input.mousePosition).toEqual({ x: 70, y: 10 });
        expect(input.mouseDown).toBe(true);
    });

    test('a mouse that lets go of its button is still there', () => {
        const { target, fire } = fakeWindow();
        const input = new InputState(target);
        fire('pointerdown', { pointerType: 'mouse', clientX: 5, clientY: 6 });
        fire('pointerup', { pointerType: 'mouse', clientX: 5, clientY: 6 });
        input.takeEdges();
        input.takeEdges();
        expect(input.mousePosition).toEqual({ x: 5, y: 6 });
    });
});
