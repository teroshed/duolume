import { approach } from '../../src/math';
import type { TickContext } from '../../src/types';
import { emptyFieldWords, readFieldWords, type FieldWords } from './words';

/**
 * One page element an input effect draws in, as the effect sees it: where it is, what state it
 * is in, what the pointer is doing to it, and the effect's own data for it.
 * Positions are stage pixels; `pointerX/Y` are measured from the field's top-left corner.
 */
export interface Field<T> {
    /** The element's `data-fx-anchor` name. */
    readonly name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    /** Corner radius in pixels: `r:10` from the tags, else half the shorter side (a pill). */
    radius: number;
    /** What its tags say. See `words.ts`. */
    readonly words: FieldWords;
    /**
     * Whether the effect should be showing. True while it is `on` or has the `focus`; also true
     * when the tags say neither `on` nor `off` (a button, a text field: always showing).
     * Never true while `disabled`.
     */
    active: boolean;
    /** `active` eased, 0..1. Fade and grow things with it rather than switching them. */
    presence: number;
    /** How full it is, 0..1: `value:` from the tags, else 1 while `on` and 0 otherwise. */
    value: number;
    /** `value` eased, 0..1. */
    level: number;
    /** The pointer is over it. */
    hover: boolean;
    /** Where the pointer is, from the field's top-left corner. Only meaningful while `pointerKnown`. */
    pointerX: number;
    pointerY: number;
    /** False until the pointer has moved onto the stage. */
    pointerKnown: boolean;
    /** True for the one tick in which the pointer pressed on it. */
    pressed: boolean;
    /** True for the one tick in which `active` became true, and the one in which it became false. */
    turnedOn: boolean;
    turnedOff: boolean;
    /** How far the element itself moved since the last tick, in pixels (a dragged or scrolled element). */
    movedX: number;
    movedY: number;
    /** Milliseconds since the effect first saw it. */
    age: number;
    /** Left edge and width of the part no knob covers, from the field's top-left. The whole width when there is no knob. */
    freeX: number;
    freeWidth: number;
    /** Whatever the effect keeps for this element. */
    data: T;
}

/**
 * Not an effect: a building block shared by the input effects (Miniatures, Liquid, Sand, …),
 * the way CrystalBody is shared by RainEater and Crystals.
 *
 * It keeps one `Field` for every page element on screen that carries a tag, creates the
 * effect's data for it the first time it is seen and releases it when it is gone, and works
 * out the things every input effect needs: state from the tags, eased presence and level, the
 * pointer over it, presses, and how far it moved.
 *
 * Call `update(tick)` at the start of `onTick`, then loop over `fields`.
 */
export class FieldSet<T> {
    public readonly fields: Field<T>[] = [];
    /** Per second: how fast `presence` and `level` follow `active` and `value`. */
    public ease = 7;

    private readonly byName = new Map<string, Field<T>>();
    private readonly seen = new Set<string>();
    private readonly tagsOf = new Map<string, readonly string[]>();

    public constructor(
        /** The tag that marks an element as this effect's. */
        public readonly tag: string,
        private readonly create: (field: Field<T>) => T,
        private readonly release?: (field: Field<T>) => void,
    ) {}

    public update(tick: TickContext): void {
        const dt = tick.timeDelta;
        const mouse = tick.mousePosition;
        const seen = this.seen;
        seen.clear();

        for (const anchor of tick.stage.tagged(this.tag)) {
            seen.add(anchor.name);
            let field = this.byName.get(anchor.name);
            const fresh = field === undefined;
            if (!field) {
                field = {
                    name: anchor.name,
                    x: anchor.x,
                    y: anchor.y,
                    width: anchor.width,
                    height: anchor.height,
                    radius: 0,
                    words: emptyFieldWords(),
                    active: false,
                    presence: 0,
                    value: 0,
                    level: 0,
                    hover: false,
                    pointerX: 0,
                    pointerY: 0,
                    pointerKnown: false,
                    pressed: false,
                    turnedOn: false,
                    turnedOff: false,
                    movedX: 0,
                    movedY: 0,
                    age: 0,
                    freeX: 0,
                    freeWidth: anchor.width,
                    data: undefined as T,
                };
                this.byName.set(anchor.name, field);
                this.fields.push(field);
            }

            // Retagging replaces the tag list, so comparing the list itself is enough.
            if (this.tagsOf.get(anchor.name) !== anchor.tags) {
                this.tagsOf.set(anchor.name, anchor.tags);
                readFieldWords(anchor.tags, field.words);
            }
            const words = field.words;

            field.movedX = fresh ? 0 : anchor.x - field.x;
            field.movedY = fresh ? 0 : anchor.y - field.y;
            field.x = anchor.x;
            field.y = anchor.y;
            field.width = anchor.width;
            field.height = anchor.height;
            const half = Math.min(anchor.width, anchor.height) / 2;
            field.radius = Math.min(half, words.radius ?? half);

            const active = !words.disabled && (words.on || words.focus || !words.off);
            field.turnedOn = active && !field.active && !fresh;
            field.turnedOff = !active && field.active;
            field.active = active;
            field.value = words.value ?? (words.on || (!words.off && active) ? 1 : 0);
            if (fresh) {
                // A value is where it is from the start; presence fades in.
                field.level = field.value;
                field.data = this.create(field);
            } else {
                field.age += dt;
            }
            field.presence = approach(field.presence, active ? 1 : 0, this.ease, dt);
            field.level = approach(field.level, field.value, this.ease, dt);

            // A switch track: the knob sits on the left when off and on the right when on.
            if (words.knob) {
                const knob = Math.min(field.height, field.width / 2);
                field.freeWidth = field.width - knob;
                field.freeX = field.level > 0.5 ? 0 : knob;
            } else {
                field.freeX = 0;
                field.freeWidth = field.width;
            }

            field.pointerKnown = mouse !== undefined;
            if (mouse) {
                field.pointerX = mouse.x - field.x;
                field.pointerY = mouse.y - field.y;
                field.hover = field.pointerX >= 0 && field.pointerY >= 0 && field.pointerX <= field.width && field.pointerY <= field.height;
            } else {
                field.hover = false;
            }
            field.pressed = field.hover && tick.mouseJustPressed;
        }

        if (seen.size !== this.fields.length) {
            for (let i = this.fields.length - 1; i >= 0; i--) {
                const field = this.fields[i];
                if (!seen.has(field.name)) {
                    this.release?.(field);
                    this.byName.delete(field.name);
                    this.tagsOf.delete(field.name);
                    this.fields.splice(i, 1);
                }
            }
        }
    }

    /** Release everything. For effect cleanup. */
    public clear(): void {
        for (const field of this.fields) {
            this.release?.(field);
        }
        this.fields.length = 0;
        this.byName.clear();
        this.tagsOf.clear();
        this.seen.clear();
    }
}
