/**
 * The lights inside the nebula: a small fixed pool of fading point lights. No renderer in here,
 * so it can be tested on its own.
 */

export interface CloudLight {
    /** Stage pixels. */
    x: number;
    y: number;
    /** 0xRRGGBB. */
    color: number;
    /** Brightness right now. Halves every `halfLife` milliseconds; 0 is a free slot. */
    intensity: number;
    /** Reach in pixels: at this distance the light is all but gone. */
    radius: number;
    /** Milliseconds for the intensity to halve. */
    halfLife: number;
    /** Milliseconds until the one re-brightening of a flickering light; 0 when there is none to come. */
    flickerIn: number;
    /** What the intensity jumps back up to at that moment. */
    flickerTo: number;
}

/** Below this a light counts as out: it is not reported and its slot is cleared. */
export const LIGHT_THRESHOLD = 0.02;

/** While a flicker is still to come the light dims this many times faster, so the dip can be seen. */
const FLICKER_DIP = 4;

export class CloudLights {
    public readonly slots: CloudLight[] = [];

    constructor(size: number) {
        for (let i = 0; i < size; i++) {
            this.slots.push({ x: 0, y: 0, color: 0xffffff, intensity: 0, radius: 1, halfLife: 1, flickerIn: 0, flickerTo: 0 });
        }
    }

    /**
     * Light one slot. No slot is ever added: the new light takes the place of the weakest one.
     * `flickerIn` above 0 makes it dim quickly and come back once, after that many milliseconds,
     * at `flickerTo` (lightning does this).
     */
    public add(x: number, y: number, color: number, intensity: number, radius: number, halfLife: number, flickerIn = 0, flickerTo = 0): CloudLight {
        const slots = this.slots;
        let weakest = slots[0];
        for (let i = 1; i < slots.length; i++) {
            if (slots[i].intensity < weakest.intensity) {
                weakest = slots[i];
            }
        }
        weakest.x = x;
        weakest.y = y;
        weakest.color = color;
        weakest.intensity = Math.max(0, intensity);
        weakest.radius = Math.max(1, radius);
        weakest.halfLife = Math.max(1, halfLife);
        weakest.flickerIn = Math.max(0, flickerIn);
        weakest.flickerTo = flickerTo;
        return weakest;
    }

    /** Fade every light by `dt` milliseconds. Returns how many are still glowing. */
    public step(dt: number): number {
        let glowing = 0;
        for (const light of this.slots) {
            if (light.intensity <= 0) {
                continue;
            }
            if (light.flickerIn > 0) {
                light.intensity *= Math.pow(0.5, (dt * FLICKER_DIP) / light.halfLife);
                light.flickerIn -= dt;
                if (light.flickerIn <= 0) {
                    light.flickerIn = 0;
                    light.intensity = Math.max(light.intensity, light.flickerTo);
                }
            } else {
                light.intensity *= Math.pow(0.5, dt / light.halfLife);
            }
            if (light.intensity < LIGHT_THRESHOLD) {
                light.intensity = 0;
            } else {
                glowing++;
            }
        }
        return glowing;
    }

    public clear(): void {
        for (const light of this.slots) {
            light.intensity = 0;
            light.flickerIn = 0;
        }
    }
}
