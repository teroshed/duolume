/** Points along one tendril; each is an x and a y in `out`. */
export const TENDRIL_POINTS = 12;

/**
 * Lay out one tendril: a path that leaves an element's edge at (`x`, `y`) heading along the
 * outward normal (`nx`, `ny`), in `TENDRIL_POINTS` steps that add up to `reach` pixels, curling
 * as it goes. It never turns back into the element (a box `width` by `height` with its corner at
 * 0, 0): a step that would land inside is turned to head straight out again.
 *
 * Writes `TENDRIL_POINTS` points (x, y pairs, element pixels) into `out` at `offset`. No
 * renderer; the dice come from `random`.
 */
export function layTendril(
    out: Float32Array,
    offset: number,
    x: number,
    y: number,
    nx: number,
    ny: number,
    reach: number,
    width: number,
    height: number,
    random: () => number = Math.random,
): void {
    const step = reach / (TENDRIL_POINTS - 1);
    const outward = Math.atan2(ny, nx);
    let heading = outward;
    // A tendril curls one way, more loosely as it goes, and wavers.
    let curl = (random() - 0.5) * 0.9;
    let px = x;
    let py = y;
    out[offset] = px;
    out[offset + 1] = py;
    for (let k = 1; k < TENDRIL_POINTS; k++) {
        heading += curl + (random() - 0.5) * 0.4;
        curl *= 0.9;
        let qx = px + Math.cos(heading) * step;
        let qy = py + Math.sin(heading) * step;
        if (qx > 0 && qx < width && qy > 0 && qy < height) {
            heading = outward;
            curl = -curl;
            qx = px + Math.cos(heading) * step;
            qy = py + Math.sin(heading) * step;
        }
        px = qx;
        py = qy;
        out[offset + k * 2] = px;
        out[offset + k * 2 + 1] = py;
    }
}
