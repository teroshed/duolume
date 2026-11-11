import type { TickContext, Vector3 } from '../../src/types';
import { FireworkStem } from './FireworkStem';
import { FireworksEffect } from './FireworksEffect';

/** What a shell needs from the effect that owns it. */
export interface FireworkHost {
    spawnTrail(owner: Firework, x: number, y: number, size: number): void;
    /** The shell has burst: the host spawns the sparks, the shock, the event and the flash. */
    detonate(owner: Firework): void;
}

/**
 * One shell: a stem that climbs and leaves trails, then bursts.
 * Trails and sparks live in the effect's shared sets; the shell only counts its trails so it
 * knows when it is finished.
 */
export class Firework {
    public readonly stem: FireworkStem;
    public exploded = false;
    /** Trails of this shell still alive in the effect's trail set. */
    public liveTrails = 0;

    constructor(position: Vector3) {
        this.stem = new FireworkStem({ position });
    }

    /** Burst and gone, with nothing left to fade. */
    public get finished(): boolean {
        return this.exploded && this.liveTrails === 0;
    }

    public onTick(tickContext: TickContext, host: FireworkHost): void {
        if (this.exploded) {
            return;
        }
        this.stem.onTick(tickContext);
        if (tickContext.totalTickCount === undefined || tickContext.totalTickCount % FireworksEffect.FIREWORK_TRAIL_INTERVAL === 0) {
            host.spawnTrail(this, this.stem.position.x, this.stem.position.y, this.stem.size.x);
        }
        if (this.stem.shouldExplode) {
            this.explode(host);
        }
    }

    public explode(host: FireworkHost): void {
        if (this.exploded) {
            return;
        }
        this.exploded = true;
        this.stem.exploded = true;
        host.detonate(this);
    }
}
