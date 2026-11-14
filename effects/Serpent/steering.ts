/**
 * The serpent's body and steering rules, free of any renderer so they can be tested on their
 * own. Lengths are stage pixels. Angles are radians in stage space (x right, y down), so a
 * growing angle turns clockwise on screen.
 */

const TAU = Math.PI * 2;

/** The shortest signed turn from heading `from` to heading `to`, in -π..π. */
export function angleDelta(from: number, to: number): number {
    let delta = (to - from) % TAU;
    if (delta > Math.PI) {
        delta -= TAU;
    } else if (delta < -Math.PI) {
        delta += TAU;
    }
    return delta;
}

/**
 * How fast to turn, in rad/ms, to bring `heading` round to `want`: proportional to how far off
 * it is (`gain` per ms), and never faster than `maxRate`. This is what makes arcs instead of snaps.
 */
export function turnRate(heading: number, want: number, gain: number, maxRate: number): number {
    const rate = angleDelta(heading, want) * gain;
    return rate > maxRate ? maxRate : rate < -maxRate ? -maxRate : rate;
}

/**
 * Follow the leader: segment 0 has already moved; every other segment is moved straight toward
 * the one in front of it until it is exactly `spacing[i]` behind it.
 */
export function followChain(x: Float32Array, y: Float32Array, z: Float32Array, count: number, spacing: Float32Array): void {
    for (let i = 1; i < count; i++) {
        const dx = x[i - 1] - x[i];
        const dy = y[i - 1] - y[i];
        const dz = z[i - 1] - z[i];
        const distance = Math.hypot(dx, dy, dz);
        if (distance < 0.0001) {
            continue;
        }
        const k = (distance - spacing[i]) / distance;
        x[i] += dx * k;
        y[i] += dy * k;
        z[i] += dz * k;
    }
}

/**
 * Width across the body in pixels at `t` (0 just behind the head, 1 at the tip of the tail):
 * a slim neck, a full body about a fifth of the way along, then a long thin tail.
 */
export function bodyWidth(t: number): number {
    const along = t < 0 ? 0 : t > 1 ? 1 : t;
    return 4 + 15 * Math.sin(Math.PI * Math.pow(along, 0.45));
}

/** Distance from one segment to the next at `t`, in pixels. It shrinks toward the tail with the width. */
export function segmentSpacing(t: number): number {
    const along = t < 0 ? 0 : t > 1 ? 1 : t;
    return 11.5 - 6 * along;
}

/**
 * The point to steer for in order to circle (`cx`, `cy`) at `radius`: the point on that circle
 * `lead` radians ahead of where (`x`, `y`) is now, going round in `direction` (+1 clockwise on
 * screen, -1 the other way). From far away it leads in; from inside the circle it leads out.
 */
export function orbitPoint(
    x: number,
    y: number,
    cx: number,
    cy: number,
    radius: number,
    direction: number,
    lead: number,
    out: { x: number; y: number },
): { x: number; y: number } {
    const bearing = Math.atan2(y - cy, x - cx) + direction * lead;
    out.x = cx + Math.cos(bearing) * radius;
    out.y = cy + Math.sin(bearing) * radius;
    return out;
}

/** Distance from the point (`px`, `py`) to the line segment a–b. */
export function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const abx = bx - ax;
    const aby = by - ay;
    const lengthSquared = abx * abx + aby * aby;
    let t = lengthSquared > 0 ? ((px - ax) * abx + (py - ay) * aby) / lengthSquared : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}
