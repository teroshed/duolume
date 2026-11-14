import type { Graphics } from 'pixi.js';
import type { Theme } from '../../src/types';

/** The space a miniature has, in the element's own pixels (origin at its top-left corner). */
export interface MiniBox {
    /** The whole element. */
    width: number;
    height: number;
    /**
     * The part no knob covers: `x` is its left edge, `w` its width. Put the subject here.
     * A switch's knob sits at the right end while it is on, so this is the left part; for an
     * element with no knob it is the whole width.
     */
    x: number;
    w: number;
}

/** What is happening to the element, and in the scene, during this tick. One object per element, reused. */
export interface MiniSignal {
    /** Milliseconds this tick advances. */
    dt: number;
    /** Simulation clock in milliseconds. */
    time: number;
    /** 0..1, eased: how much the miniature should be showing (1 while on). Its drawing is already faded by this. */
    presence: number;
    /** 0..1, eased: the element's level (a slider's value; 1 while a switch is on). */
    level: number;
    /** The pointer is over the element. */
    hover: boolean;
    /** Where the pointer is, in the element's pixels. Only meaningful while `hover`. */
    pointerX: number;
    pointerY: number;
    /** True for the one tick in which the element was pressed, or switched on. */
    kick: boolean;
    /**
     * Above 0 on a tick in which the real effect did the thing it is known for: lightning
     * struck, a shell burst, the eater ate, a crystal broke. 0 on every other tick, and always 0
     * when that effect is not on the page.
     */
    pulse: number;
    /** -1..1: the scene's wind, left to right. 0 when there is no wind effect on the page. */
    wind: number;
}

/**
 * One miniature: a small moving picture of a library effect, sized for the inside of a switch.
 * `S` is whatever it keeps per element. Nothing here is shared between elements.
 *
 * `tick` advances it; `draw` only draws from the state (it may be called twice for one tick, or
 * not at all). Colours come from the theme. There is no bloom to lean on at this size: draw crisp
 * shapes a few pixels across, not glows.
 */
export interface Mini<S> {
    create(box: MiniBox): S;
    tick(state: S, box: MiniBox, signal: MiniSignal): void;
    draw(g: Graphics, state: S, box: MiniBox, theme: Theme, signal: MiniSignal): void;
}
