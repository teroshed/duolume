import { Graphics } from 'pixi.js';
import { Effect } from '../../src/Effect';
import { approach, clamp, mixColor } from '../../src/math';
import type { EffectContext, FieldLetter, TickContext, TimedContext } from '../../src/types';
import type { GlyphsContext } from '../contracts';
import { FieldSet, type Field } from '../Field/FieldSet';

export interface GlyphsOptions {
    /** How far a typed letter's mark rises above the field, in px, 4..200. Default `RISE` (30). */
    rise?: number;
    /** How long a mark lives, in ms, 100..5000. Default `LIFE_MS` (950). */
    life?: number;
}

const MAX_MARKS = 96;

interface Line {
    /** Where the text starts and ends now, stage pixels, eased. NaN until there has been text. */
    from: number;
    to: number;
    wantFrom: number;
    wantTo: number;
    /** 0..1: there is text, eased. */
    shown: number;
    letters: number;
}

/**
 * A text field that answers what is typed, outside itself. Every letter typed into a field
 * tagged `glyphs` sends a mark exactly as wide as that letter up out of the top of the field;
 * every letter deleted drops one from under where it stood; and a line under the field runs
 * from the first letter to the last, growing and shrinking with the text. Drawn on the canvas
 * behind the page, so it shows where the page round the field is see-through.
 *
 * What it listens to: `field:text`, the event `attachFieldText(manager)` sends from the page,
 * with the text and where every letter is. Without that on the page it draws nothing.
 * It tells the others how many letters its fields hold and how many marks are in the air (its
 * context). No events, no forces, no keys.
 */
export class Glyphs extends Effect<GlyphsContext> {
    public effectName = 'glyphs';

    public static readonly RISE = 30;
    public static readonly LIFE_MS = 950;

    private readonly rise: number;
    private readonly life: number;
    private readonly lines: FieldSet<Line>;
    private readonly context: GlyphsContext = { fields: 0, active: 0, letters: 0, marks: 0 };
    private view: Graphics | undefined;

    // Marks, structure of arrays, stage pixels and milliseconds.
    private readonly x0 = new Float32Array(MAX_MARKS);
    private readonly x1 = new Float32Array(MAX_MARKS);
    private readonly y0 = new Float32Array(MAX_MARKS);
    /** +1 falls (a deleted letter), -1 rises (a typed one). */
    private readonly way = new Float32Array(MAX_MARKS);
    private readonly age = new Float32Array(MAX_MARKS);
    private readonly tone = new Uint8Array(MAX_MARKS);
    private count = 0;

    constructor(options: GlyphsOptions = {}) {
        super();
        this.rise = clamp(options.rise ?? Glyphs.RISE, 4, 200);
        this.life = clamp(options.life ?? Glyphs.LIFE_MS, 100, 5000);
        this.lines = new FieldSet<Line>('glyphs', () => ({ from: NaN, to: NaN, wantFrom: NaN, wantTo: NaN, shown: 0, letters: 0 }));
    }

    public initialize(): void {
        this.view = new Graphics();
        this.host.pixi.addChild(this.view);
    }

    public onTick(tick: TickContext): EffectContext<GlyphsContext> {
        this.lines.update(tick);
        const dt = Math.min(tick.timeDelta, 100);

        for (const event of tick.events('field:text')) {
            const edit = event.payload;
            const field = this.lines.fields.find((candidate) => candidate.name === edit.anchor);
            if (!field) {
                continue;
            }
            const line = field.data;
            const letters = edit.letters;
            line.letters = Array.from(edit.text).length;
            if (letters.length > 0) {
                line.wantFrom = clamp(letters[0].start, field.x, field.x + field.width);
                line.wantTo = clamp(letters[letters.length - 1].end, field.x, field.x + field.width);
                if (Number.isNaN(line.from)) {
                    line.from = line.to = line.wantFrom;
                }
            } else if (line.letters === 0 && !Number.isNaN(line.from)) {
                line.wantTo = line.wantFrom = line.from;
            }
            const added = Array.from(edit.added).length;
            for (let i = 0; i < added && i < 40; i++) {
                this.mark(field, letters[edit.at + i], -1, i);
            }
            for (let i = 0; i < edit.removedLetters.length && i < 40; i++) {
                this.mark(field, edit.removedLetters[i], 1, i);
            }
        }

        let active = 0;
        let held = 0;
        for (const field of this.lines.fields) {
            const line = field.data;
            if (field.active) {
                active++;
            }
            held += line.letters;
            line.shown = approach(line.shown, line.letters > 0 ? field.presence : 0, 6, dt);
            if (!Number.isNaN(line.from)) {
                line.from = approach(line.from, line.wantFrom, 14, dt);
                line.to = approach(line.to, line.wantTo, 14, dt);
            }
        }

        // Age the marks; drop the dead by moving the last one into their place.
        for (let i = this.count - 1; i >= 0; i--) {
            this.age[i] += dt;
            if (this.age[i] >= this.life) {
                const last = --this.count;
                this.x0[i] = this.x0[last];
                this.x1[i] = this.x1[last];
                this.y0[i] = this.y0[last];
                this.way[i] = this.way[last];
                this.age[i] = this.age[last];
                this.tone[i] = this.tone[last];
            }
        }

        this.context.fields = this.lines.fields.length;
        this.context.active = active;
        this.context.letters = held;
        this.context.marks = this.count;
        return this.publish(this.context);
    }

    public onRender(timed: TimedContext): void {
        const g = this.view;
        if (!g) {
            return;
        }
        g.clear();
        const theme = timed.theme;
        const bright = mixColor(theme.accent, theme.ink, 0.5);

        // The line under each field: as long as its text.
        for (const field of this.lines.fields) {
            const line = field.data;
            if (line.shown < 0.02 || Number.isNaN(line.from)) {
                continue;
            }
            const y = field.y + field.height + 5;
            g.moveTo(line.from, y - 3).lineTo(line.from, y).lineTo(line.to, y).lineTo(line.to, y - 3);
            g.stroke({ width: 1.2, color: theme.accent, alpha: clamp(0.7 * line.shown, 0, 1) });
        }

        // The marks: a dash as wide as its letter, leaving the field.
        for (let i = 0; i < this.count; i++) {
            if (this.age[i] < 0) {
                // Waiting its turn: the letters of one paste leave one after another.
                continue;
            }
            const t = this.age[i] / this.life;
            // Quick off the edge, then drifting.
            const gone = (1 - (1 - t) * (1 - t)) * this.rise;
            const y = this.y0[i] + this.way[i] * gone;
            const alpha = clamp((1 - t) * (1 - t) * 1.1, 0, 1);
            const color = this.way[i] > 0 ? theme.accentAlt : this.tone[i] === 0 ? bright : theme.accent;
            g.moveTo(this.x0[i], y).lineTo(this.x1[i], y);
            g.stroke({ width: 2.2 - t * 1.2, color, alpha });
            if (this.way[i] < 0) {
                // A spark over the middle of a typed letter, ahead of its dash.
                const cx = (this.x0[i] + this.x1[i]) / 2;
                g.circle(cx, y - 4 - 6 * t, 1.2);
                g.fill({ color: bright, alpha: clamp(alpha * 0.9, 0, 1) });
            }
        }
    }

    public cleanup(): void {
        this.view?.destroy();
        this.view = undefined;
        this.lines.clear();
        this.count = 0;
        this.context.fields = this.context.active = this.context.letters = this.context.marks = 0;
    }

    /** One mark for one letter, if the letter is known and is in view inside its field. */
    private mark(field: Field<Line>, letter: FieldLetter | undefined, way: number, index: number): void {
        if (!letter || this.count >= MAX_MARKS || letter.end <= field.x || letter.start >= field.x + field.width) {
            return;
        }
        const i = this.count++;
        this.x0[i] = Math.max(field.x, letter.start + 0.5);
        this.x1[i] = Math.min(field.x + field.width, Math.max(letter.start + 2, letter.end - 0.5));
        this.y0[i] = way < 0 ? field.y - 3 : field.y + field.height + 9;
        this.way[i] = way;
        // Letters of one paste leave one after another rather than as one bar.
        this.age[i] = -Math.min(index, 20) * 22;
        this.tone[i] = index % 2;
    }
}
