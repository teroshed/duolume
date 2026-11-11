import type { Vector3 } from './types';

export type ForceKind = 'attract' | 'repel' | 'vortex' | 'wind';

export interface Force {
    kind: ForceKind;
    /** `effectName` of whoever added it, so an effect can ignore its own forces. */
    owner: string;
    x: number;
    y: number;
    /** Reach in pixels. A wind with radius 0 blows everywhere. */
    radius: number;
    /** Peak acceleration in px/ms². */
    strength: number;
    /** Wind direction (need not be normalised). */
    dirX?: number;
    dirY?: number;
}

export interface Shock {
    owner: string;
    x: number;
    y: number;
    /** Current ring radius in pixels. */
    radius: number;
    /** Ring thickness in pixels. */
    width: number;
    /** Expansion speed in px/ms. */
    speed: number;
    maxRadius: number;
    /** Peak outward acceleration in px/ms². */
    strength: number;
    /** 1 at birth, 0 when the ring reaches `maxRadius`. */
    fade: number;
}

export interface ShockOptions {
    x: number;
    y: number;
    strength?: number;
    speed?: number;
    maxRadius?: number;
    width?: number;
}

const MAX_SHOCKS = 4;

/**
 * The common currency between effects that draw with different renderers.
 *
 * Forces are immediate-mode: an effect re-adds its forces every tick, and everyone samples
 * the complete set from the tick before. That keeps the result independent of run order.
 * Shock rings are the exception: add one once and the field expands and retires it.
 */
export class ForceField {
    private building: Force[] = [];
    private settled: Force[] = [];
    public readonly shocks: Shock[] = [];

    /** Add a force for this tick. It takes effect for every sampler on the next tick. */
    public add(force: Force): void {
        this.building.push(force);
    }

    /** Start an expanding ring. Both renderers react: particles are pushed, the picture ripples. */
    public shock(owner: string, options: ShockOptions): void {
        if (this.shocks.length >= MAX_SHOCKS) {
            this.shocks.shift();
        }
        this.shocks.push({
            owner,
            x: options.x,
            y: options.y,
            radius: 0,
            width: options.width ?? 70,
            speed: options.speed ?? 0.9,
            maxRadius: options.maxRadius ?? 520,
            strength: options.strength ?? 0.004,
            fade: 1,
        });
    }

    /** Forces settled last tick. Read-only for effects. */
    public get list(): readonly Force[] {
        return this.settled;
    }

    /**
     * Net acceleration at a point, in px/ms², written into `out`.
     * `ignoreOwner` skips forces added by that effect.
     */
    public sample(x: number, y: number, out: Vector3, ignoreOwner?: string): Vector3 {
        let ax = 0;
        let ay = 0;
        const forces = this.settled;
        for (let i = 0; i < forces.length; i++) {
            const f = forces[i];
            if (ignoreOwner !== undefined && f.owner === ignoreOwner) {
                continue;
            }
            if (f.kind === 'wind') {
                const dx = f.dirX ?? 1;
                const dy = f.dirY ?? 0;
                const len = Math.hypot(dx, dy) || 1;
                let k = f.strength;
                if (f.radius > 0) {
                    const d = Math.hypot(x - f.x, y - f.y);
                    if (d >= f.radius) {
                        continue;
                    }
                    const t = 1 - d / f.radius;
                    k *= t * t;
                }
                ax += (dx / len) * k;
                ay += (dy / len) * k;
                continue;
            }
            const dx = f.x - x;
            const dy = f.y - y;
            const d = Math.hypot(dx, dy);
            if (d >= f.radius || d < 0.0001) {
                continue;
            }
            const t = 1 - d / f.radius;
            const k = (f.strength * t * t) / d;
            if (f.kind === 'attract') {
                ax += dx * k;
                ay += dy * k;
            } else if (f.kind === 'repel') {
                ax -= dx * k;
                ay -= dy * k;
            } else {
                // vortex: perpendicular to the radius
                ax += -dy * k;
                ay += dx * k;
            }
        }
        const shocks = this.shocks;
        for (let i = 0; i < shocks.length; i++) {
            const s = shocks[i];
            if (ignoreOwner !== undefined && s.owner === ignoreOwner) {
                continue;
            }
            const dx = x - s.x;
            const dy = y - s.y;
            const d = Math.hypot(dx, dy);
            const off = Math.abs(d - s.radius);
            if (off >= s.width || d < 0.0001) {
                continue;
            }
            const k = (s.strength * s.fade * (1 - off / s.width)) / d;
            ax += dx * k;
            ay += dy * k;
        }
        out.x = ax;
        out.y = ay;
        return out;
    }

    /** Called by the simulation once per tick, after every effect has run. */
    public step(timeDelta: number): void {
        const settled = this.settled;
        this.settled = this.building;
        settled.length = 0;
        this.building = settled;

        for (let i = this.shocks.length - 1; i >= 0; i--) {
            const s = this.shocks[i];
            s.radius += s.speed * timeDelta;
            s.fade = Math.max(0, 1 - s.radius / s.maxRadius);
            if (s.fade <= 0) {
                this.shocks.splice(i, 1);
            }
        }
    }

    public clear(): void {
        this.building.length = 0;
        this.settled.length = 0;
        this.shocks.length = 0;
    }
}
