import type { TickContext } from '../../src/types';

/** Something alarming that happened this tick. */
export interface Alarm {
    x: number;
    y: number;
    /** Birds closer than this take fright, px. */
    range: number;
    /** For a hit on a page element: its anchor name, and only birds sitting on it take fright. Otherwise ''. */
    anchor: string;
}

const MAX_ALARMS = 16;
const MAX_THREATS = 4;

/**
 * Everything that frightens the flock, read from the tick in one place. Alarms are one-shot
 * (a press, an explosion, a strike): they startle. Threats are there as long as their owner is
 * (a predator's head, a pressed or fast pointer): flying birds keep clear of them.
 */
export class Fears {
    public readonly alarms: Alarm[] = [];
    public alarmCount = 0;
    /** x, y, range for each threat. */
    public readonly threats = new Float32Array(MAX_THREATS * 3);
    public threatCount = 0;
    private mouseX = NaN;
    private mouseY = NaN;

    constructor() {
        for (let i = 0; i < MAX_ALARMS; i++) {
            this.alarms.push({ x: 0, y: 0, range: 0, anchor: '' });
        }
    }

    public gather(tick: TickContext): void {
        this.alarmCount = 0;
        this.threatCount = 0;
        this.gatherAlarms(tick);
        this.gatherThreats(tick, tick.timeDelta);
    }

    public reset(): void {
        this.alarmCount = 0;
        this.threatCount = 0;
        this.mouseX = NaN;
        this.mouseY = NaN;
    }

    private addAlarm(x: number, y: number, range: number, anchor = ''): void {
        if (this.alarmCount >= this.alarms.length) {
            return;
        }
        const alarm = this.alarms[this.alarmCount++];
        alarm.x = x;
        alarm.y = y;
        alarm.range = range;
        alarm.anchor = anchor;
    }

    private gatherAlarms(tick: TickContext): void {
        const mouse = tick.mousePosition;
        if (tick.mouseJustPressed && mouse && !tick.mouseOnInteractive) {
            this.addAlarm(mouse.x, mouse.y, 170);
        }
        for (const e of tick.events('crystal:exploded')) this.addAlarm(e.payload.x, e.payload.y, 320);
        for (const e of tick.events('rainEater:exploded')) this.addAlarm(e.payload.x, e.payload.y, 450);
        for (const e of tick.events('lightning:strike')) this.addAlarm(e.payload.x, e.payload.y, 320);
        for (const e of tick.events('firework:exploded')) this.addAlarm(e.payload.x, e.payload.y, 200 + 150 * e.payload.power);
        for (const e of tick.events('meteor:impact')) this.addAlarm(e.payload.x, e.payload.y, 200 + 200 * e.payload.power);
        for (const e of tick.events('singularity:collapsed')) this.addAlarm(e.payload.x, e.payload.y, Infinity);
        for (const e of tick.events('bubble:popped')) this.addAlarm(e.payload.x, e.payload.y, 70);
        for (const e of tick.events('page:hit')) {
            if (e.payload.kind !== 'rain') {
                this.addAlarm(e.payload.x, e.payload.y, 0, e.payload.anchor);
            }
        }
    }

    /** Things to keep clear of while they are there: x, y, range for each. */
    private gatherThreats(tick: TickContext, dt: number): void {
        const mouse = tick.mousePosition;
        if (mouse) {
            const moved = Number.isNaN(this.mouseX) ? 0 : Math.hypot(mouse.x - this.mouseX, mouse.y - this.mouseY) / Math.max(dt, 1);
            this.mouseX = mouse.x;
            this.mouseY = mouse.y;
            if (tick.mouseDown || moved > 0.9) {
                this.addThreat(mouse.x, mouse.y, 150);
            }
        }
        const eater = tick.read('rainEater');
        if (eater?.headPosition && !eater.exploded) {
            this.addThreat(eater.headPosition.x, eater.headPosition.y, 200);
        }
        const serpent = tick.read('serpent');
        if (serpent?.headPosition) {
            this.addThreat(serpent.headPosition.x, serpent.headPosition.y, 220);
        }
        const hole = tick.read('singularity');
        if (hole?.position && !hole.collapsed) {
            this.addThreat(hole.position.x, hole.position.y, (hole.radius ?? 0) * 6 + 120);
        }
    }

    private addThreat(x: number, y: number, range: number): void {
        if (this.threatCount < MAX_THREATS && Number.isFinite(x) && Number.isFinite(y)) {
            const k = this.threatCount++ * 3;
            this.threats[k] = x;
            this.threats[k + 1] = y;
            this.threats[k + 2] = range;
        }
    }
}
