import { describe, expect, test } from 'bun:test';
import { FieldSet } from '../effects/Field/FieldSet';
import { readFieldWords } from '../effects/Field/words';
import type { AnchorRect } from '../src/Stage';
import type { TickContext } from '../src/types';

// FieldSet only asks the tick for the tagged anchors, the pointer and the time step.
function anchor(name: string, tags: string, x = 100, y = 50, width = 60, height = 28): AnchorRect {
    return { name, x, y, width, height, visible: true, tags: tags.split(' '), numbers: {} };
}

function tick(anchors: AnchorRect[], mouse?: { x: number; y: number }, pressed = false): TickContext {
    return {
        timeDelta: 1000 / 60,
        mousePosition: mouse,
        mouseJustPressed: pressed,
        stage: { tagged: (tag: string) => anchors.filter((a) => a.tags.includes(tag)) },
    } as unknown as TickContext;
}

describe('field words', () => {
    test('reads state, value and radius, and ignores everything else', () => {
        const words = readFieldWords('liquid on focus knob value:0.62 r:10 ledge whatever:3'.split(' '));
        expect(words).toEqual({ on: true, off: false, focus: true, disabled: false, invalid: false, busy: false, knob: true, value: 0.62, radius: 10 });
    });

    test('keeps a value between 0 and 1 and drops what is not a number', () => {
        expect(readFieldWords(['value:7']).value).toBe(1);
        expect(readFieldWords(['value:-2']).value).toBe(0);
        expect(readFieldWords(['value:lots']).value).toBeUndefined();
        expect(readFieldWords(['r:-4']).radius).toBeUndefined();
    });

    test('reading into the same object forgets what it held', () => {
        const words = readFieldWords(['on', 'value:0.5']);
        readFieldWords(['off'], words);
        expect(words.on).toBe(false);
        expect(words.off).toBe(true);
        expect(words.value).toBeUndefined();
    });
});

describe('field set', () => {
    test('makes the effect its data once per element, and lets go when the element is gone', () => {
        const made: string[] = [];
        const released: string[] = [];
        const set = new FieldSet<{ id: string }>(
            'liquid',
            (field) => {
                made.push(field.name);
                return { id: field.name };
            },
            (field) => released.push(field.name),
        );
        const a = anchor('a', 'liquid on');
        const b = anchor('b', 'liquid off');
        set.update(tick([a, b, anchor('other', 'sand on')]));
        set.update(tick([a, b]));
        expect(made).toEqual(['a', 'b']);
        expect(set.fields.map((field) => field.data.id)).toEqual(['a', 'b']);

        set.update(tick([b]));
        expect(released).toEqual(['a']);
        expect(set.fields.map((field) => field.name)).toEqual(['b']);
        set.clear();
        expect(released).toEqual(['a', 'b']);
        expect(set.fields.length).toBe(0);
    });

    test('on shows it, off and disabled hide it, and saying neither shows it', () => {
        const set = new FieldSet<null>('fuse', () => null);
        set.update(tick([anchor('on', 'fuse on'), anchor('off', 'fuse off'), anchor('plain', 'fuse'), anchor('dead', 'fuse on disabled')]));
        const active = Object.fromEntries(set.fields.map((field) => [field.name, field.active]));
        expect(active).toEqual({ on: true, off: false, plain: true, dead: false });
    });

    test('the focus does not light a switch that is off: one just clicked off still has it', () => {
        const set = new FieldSet<null>('fuse', () => null);
        set.update(tick([anchor('clicked', 'fuse on focus knob'), anchor('field', 'fuse focus')]));
        expect(set.fields.map((field) => field.active)).toEqual([true, true]);
        set.update(tick([anchor('clicked', 'fuse off focus knob'), anchor('field', 'fuse focus')]));
        expect(set.fields.map((field) => field.active)).toEqual([false, true]);
        expect(set.fields[0].turnedOff).toBe(true);
    });

    test('presence eases in and out, and the turn is reported for one tick', () => {
        const set = new FieldSet<null>('sand', () => null);
        let a = anchor('a', 'sand off');
        set.update(tick([a]));
        expect(set.fields[0].presence).toBe(0);

        a = anchor('a', 'sand on'); // retagging replaces the tag list, as the stage does
        set.update(tick([a]));
        expect(set.fields[0].turnedOn).toBe(true);
        expect(set.fields[0].presence).toBeGreaterThan(0);
        expect(set.fields[0].presence).toBeLessThan(0.5);
        set.update(tick([a]));
        expect(set.fields[0].turnedOn).toBe(false);
        for (let i = 0; i < 120; i++) {
            set.update(tick([a]));
        }
        expect(set.fields[0].presence).toBeGreaterThan(0.99);

        a = anchor('a', 'sand off');
        set.update(tick([a]));
        expect(set.fields[0].turnedOff).toBe(true);
    });

    test('the level follows value:, and without one it is full while on and empty while off', () => {
        const set = new FieldSet<null>('liquid', () => null);
        set.update(tick([anchor('bar', 'liquid value:0.3'), anchor('on', 'liquid on'), anchor('off', 'liquid off')]));
        const level = Object.fromEntries(set.fields.map((field) => [field.name, field.level]));
        expect(level).toEqual({ bar: 0.3, on: 1, off: 0 });
    });

    test('knows the pointer: over it, where, and the press', () => {
        const set = new FieldSet<null>('pulse', () => null);
        const a = anchor('a', 'pulse', 100, 50, 60, 28);
        set.update(tick([a], { x: 130, y: 60 }, true));
        const field = set.fields[0];
        expect(field.hover).toBe(true);
        expect(field.pressed).toBe(true);
        expect(field.pointerX).toBe(30);
        expect(field.pointerY).toBe(10);

        set.update(tick([a], { x: 300, y: 60 }, true));
        expect(field.hover).toBe(false);
        expect(field.pressed).toBe(false);
        set.update(tick([a]));
        expect(field.pointerKnown).toBe(false);
    });

    test('a pill by default, the radius the tags give otherwise, and the part a knob leaves free', () => {
        const set = new FieldSet<null>('mini', () => null);
        set.update(tick([anchor('pill', 'mini'), anchor('square', 'mini r:6'), anchor('switchOn', 'mini on knob'), anchor('switchOff', 'mini off knob')]));
        const by = Object.fromEntries(set.fields.map((field) => [field.name, field]));
        expect(by.pill.radius).toBe(14);
        expect(by.square.radius).toBe(6);
        expect(by.pill.freeWidth).toBe(60);
        expect([by.switchOn.freeX, by.switchOn.freeWidth]).toEqual([0, 32]);
        expect([by.switchOff.freeX, by.switchOff.freeWidth]).toEqual([28, 32]);
    });

    test('reports how far the element moved', () => {
        const set = new FieldSet<null>('liquid', () => null);
        set.update(tick([anchor('a', 'liquid', 100, 50)]));
        set.update(tick([anchor('a', 'liquid', 112, 47)]));
        expect([set.fields[0].movedX, set.fields[0].movedY]).toEqual([12, -3]);
    });
});
