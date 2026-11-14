import { Effect } from '../../src/Effect';
import { clamp } from '../../src/math';
import type { EffectContext, TickContext, TimedContext } from '../../src/types';
import type { MiniaturesContext } from '../contracts';
import { FieldLayer } from '../Field/FieldLayer';
import { FieldSet, type Field } from '../Field/FieldSet';
import type { Mini, MiniBox, MiniSignal } from './Mini';
import { MINIS } from './minis';

export interface MiniaturesOptions {
    /** The tag that marks an element as a window for a miniature. Default `TAG` ('mini'). */
    tag?: string;
    /** Multiplier on how fast the miniatures move. Default `SPEED` (1). */
    speed?: number;
}

/** What the effect keeps for one element. */
interface Window {
    name: string;
    mini: Mini<unknown>;
    state: unknown;
    box: MiniBox;
    signal: MiniSignal;
    tags: readonly string[] | undefined;
}

/**
 * The events that count as "the real effect just did its thing", by miniature. A miniature
 * whose effect is listed here gets a `pulse` on the tick after one of them is emitted, so the
 * small picture in a switch moves in step with the big one in the scene.
 */
const PULSES: Readonly<Record<string, readonly string[]>> = {
    lightningStorm: ['lightning:strike'],
    fireworks: ['firework:exploded'],
    rainEater: ['rain:eaten', 'rainEater:exploded'],
    crystals: ['crystal:exploded'],
    meteors: ['meteor:impact'],
    bubbles: ['bubble:popped'],
    singularity: ['singularity:collapsed'],
    flock: ['flock:startled'],
    fireflies: ['fireflies:synced'],
    confetti: ['firework:exploded', 'fireflies:synced'],
    nebula: ['lightning:strike', 'firework:exploded'],
    tide: ['meteor:impact', 'lightning:strike'],
    meadow: ['lightning:strike', 'meteor:impact'],
    serpent: ['lightning:strike'],
    constellation: ['lightning:strike', 'crystal:exploded', 'meteor:impact', 'firework:exploded'],
};

/**
 * A small moving picture of an effect, inside a page element: rain falling in the switch that
 * turns the rain on, a bolt in the lightning switch, a bubble or two in the bubbles switch.
 *
 * Any element tagged `mini` is a window. The other word in its tags that is an effect's name
 * (`rain`, `fireworks`, `lightningStorm`, …: all twenty library effects have one) chooses the
 * picture; a name it does not know gets a few drifting motes. The element's state comes from
 * its tags too (`on`, `off`, `focus`, `knob`, `value:0.6`, `r:10`; `attachFieldTags()` keeps them
 * current from the real form controls): switched off, the picture fades out.
 *
 *     <label class="switch">
 *         <input type="checkbox" checked />
 *         <span class="track" data-fx-anchor="rain-switch" data-fx-tags="mini rain"></span>
 *         Rain
 *     </label>
 *
 * What it listens to:
 *   - elements tagged `mini`, and the pointer over them (a miniature livens up under the pointer
 *     and answers a press).
 *   - the events of the effect each miniature pictures (`lightning:strike`, `firework:exploded`,
 *     `rain:eaten`, `crystal:exploded`, `meteor:impact`, `bubble:popped`, …): the small picture
 *     flashes, bursts or pops in step with the real one.
 *   - the `wind` context: small rain slants and small grass leans the way the real wind blows.
 *   - presses on the open stage, for the click-sparks miniature.
 * It tells the others how many windows it is drawing in, and nothing else: no forces, no events.
 * It has no keys.
 */
export class Miniatures extends Effect<MiniaturesContext> {
    public effectName = 'miniatures';

    public static readonly TAG = 'mini';
    public static readonly SPEED = 1;
    /** The wind effect's hand-push, in px/ms²: the wind a miniature treats as full strength. */
    private static readonly FULL_WIND = 0.0011;

    private readonly speed: number;
    private readonly windows: FieldSet<Window>;
    private readonly context: MiniaturesContext = { fields: 0, active: 0 };
    private layer: FieldLayer | undefined;

    constructor(options: MiniaturesOptions = {}) {
        super();
        this.speed = clamp(options.speed ?? Miniatures.SPEED, 0, 10);
        this.windows = new FieldSet<Window>(options.tag ?? Miniatures.TAG, (field) => this.open(field));
    }

    public initialize(): void {
        this.layer = new FieldLayer(this.host.pixi);
    }

    public onTick(tick: TickContext): EffectContext<MiniaturesContext> {
        this.windows.update(tick);
        const wind = clamp((tick.read('wind')?.x ?? 0) / Miniatures.FULL_WIND, -1, 1);
        const stagePress = tick.mouseJustPressed && !tick.mouseOnInteractive;

        let active = 0;
        for (const field of this.windows.fields) {
            const window = field.data;
            const tags = tick.stage.anchor(field.name)?.tags;
            // A different picture was asked for (the tags changed), or the element changed size: start it afresh.
            if (tags !== window.tags || Math.abs(field.width - window.box.width) > 1 || Math.abs(field.height - window.box.height) > 1) {
                this.choose(window, field, tags);
            }
            const box = window.box;
            box.x = field.freeX;
            box.w = field.freeWidth;

            const signal = window.signal;
            signal.dt = tick.timeDelta * this.speed;
            signal.time = tick.time * this.speed;
            signal.presence = field.presence;
            signal.level = field.level;
            signal.hover = field.hover;
            signal.pointerX = field.pointerX;
            signal.pointerY = field.pointerY;
            signal.kick = field.pressed || field.turnedOn;
            signal.pulse = this.pulse(window.name, tick, stagePress);
            signal.wind = wind;

            if (field.active) {
                active++;
            }
            // Nothing to see and nothing fading: let it rest.
            if (field.presence > 0.002) {
                window.mini.tick(window.state, box, signal);
            }
        }

        this.context.fields = this.windows.fields.length;
        this.context.active = active;
        return this.publish(this.context);
    }

    public onRender(timed: TimedContext): void {
        const layer = this.layer;
        if (!layer) {
            return;
        }
        for (const field of this.windows.fields) {
            const g = layer.draw(field);
            g.alpha = field.presence;
            if (field.presence > 0.002) {
                const window = field.data;
                window.mini.draw(g, window.state, window.box, timed.theme, window.signal);
            }
        }
        layer.sweep();
    }

    public cleanup(): void {
        this.windows.clear();
        this.layer?.destroy();
        this.layer = undefined;
    }

    private open(field: Field<Window>): Window {
        const window: Window = {
            name: 'drift',
            mini: MINIS.drift,
            state: undefined,
            box: { width: field.width, height: field.height, x: 0, w: field.width },
            signal: { dt: 0, time: 0, presence: 0, level: 0, hover: false, pointerX: 0, pointerY: 0, kick: false, pulse: 0, wind: 0 },
            tags: undefined,
        };
        this.choose(window, field, undefined);
        return window;
    }

    /** Pick the miniature the tags name and give it a fresh state for this element. */
    private choose(window: Window, field: Field<Window>, tags: readonly string[] | undefined): void {
        let name = 'drift';
        for (const tag of tags ?? []) {
            if (tag !== 'drift' && Object.hasOwn(MINIS, tag)) {
                name = tag;
                break;
            }
        }
        const sized = Math.abs(field.width - window.box.width) > 1 || Math.abs(field.height - window.box.height) > 1;
        window.tags = tags;
        window.box.width = field.width;
        window.box.height = field.height;
        const knob = field.words.knob ? Math.min(field.height, field.width / 2) : 0;
        window.box.x = field.freeX;
        window.box.w = field.width - knob;
        // The same picture at the same size keeps its state: only the element's state words changed.
        if (name === window.name && !sized && window.state !== undefined) {
            return;
        }
        window.name = name;
        window.mini = MINIS[name];
        window.state = window.mini.create(window.box);
    }

    private pulse(name: string, tick: TickContext, stagePress: boolean): number {
        if (name === 'clickExplosion') {
            return stagePress ? 1 : 0;
        }
        const types = PULSES[name];
        if (!types) {
            return 0;
        }
        for (const type of types) {
            if (tick.events(type).length > 0) {
                return 1;
            }
        }
        return 0;
    }
}
