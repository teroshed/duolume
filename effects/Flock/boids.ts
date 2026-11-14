/**
 * The steering rules of a flock, with no renderer attached: separation, alignment and
 * cohesion (Craig Reynolds' boids), soft walls, and a velocity step that keeps speed in a band
 * and limits how fast a bird can turn. Positions are stage pixels, velocities px/ms,
 * accelerations px/ms². Birds live in structure-of-arrays: index `i` of each array is one bird.
 */

export interface BoidRules {
    /** Birds closer than this are neighbours, in px. */
    neighbourRadius: number;
    /** Inside this distance a neighbour pushes away, in px. */
    separationRadius: number;
    /** Peak push of one very close neighbour, px/ms². */
    separation: number;
    /** How quickly a bird matches its neighbours' velocity, 1/ms. */
    alignment: number;
    /** Pull toward the middle of the neighbours, per px of distance, 1/ms². */
    cohesion: number;
    /** Speed band, px/ms. */
    minSpeed: number;
    maxSpeed: number;
    /** Largest change of heading, radians per ms. */
    maxTurn: number;
    /** Pull of a bird with no neighbours toward the nearest other bird, px/ms². */
    lonely: number;
}

export const DEFAULT_RULES: BoidRules = {
    neighbourRadius: 70,
    separationRadius: 22,
    separation: 0.0022,
    alignment: 0.0022,
    cohesion: 0.000002,
    minSpeed: 0.07,
    maxSpeed: 0.17,
    maxTurn: 0.0042,
    lonely: 0.00012,
};

export interface Vec {
    x: number;
    y: number;
}

/**
 * The flocking acceleration on bird `i` from the others, written into `out`.
 * `skip[j]` non-zero leaves bird `j` out (perched birds are not part of the flock in the air).
 * A bird with no neighbours heads for the nearest other bird instead. Returns the number of neighbours.
 */
export function steer(
    i: number,
    px: ArrayLike<number>,
    py: ArrayLike<number>,
    vx: ArrayLike<number>,
    vy: ArrayLike<number>,
    count: number,
    rules: BoidRules,
    out: Vec,
    skip?: ArrayLike<number>,
): number {
    const x = px[i];
    const y = py[i];
    const r2 = rules.neighbourRadius * rules.neighbourRadius;
    const sepR = rules.separationRadius;
    let sepX = 0;
    let sepY = 0;
    let sumVx = 0;
    let sumVy = 0;
    let sumX = 0;
    let sumY = 0;
    let neighbours = 0;
    let nearest = -1;
    let nearestD2 = Infinity;
    for (let j = 0; j < count; j++) {
        if (j === i || (skip !== undefined && skip[j] !== 0)) {
            continue;
        }
        const dx = px[j] - x;
        const dy = py[j] - y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= r2) {
            if (d2 < nearestD2) {
                nearestD2 = d2;
                nearest = j;
            }
            continue;
        }
        neighbours++;
        sumVx += vx[j];
        sumVy += vy[j];
        sumX += px[j];
        sumY += py[j];
        if (d2 < sepR * sepR) {
            const d = Math.sqrt(d2);
            if (d < 0.001) {
                // Exactly on top of each other: part them along an arbitrary but stable axis.
                sepX -= i < j ? 1 : -1;
                continue;
            }
            const t = 1 - d / sepR;
            sepX -= (dx / d) * t * t;
            sepY -= (dy / d) * t * t;
        }
    }
    if (neighbours === 0) {
        if (nearest < 0) {
            out.x = 0;
            out.y = 0;
        } else {
            const d = Math.sqrt(nearestD2);
            out.x = ((px[nearest] - x) / d) * rules.lonely;
            out.y = ((py[nearest] - y) / d) * rules.lonely;
        }
        return 0;
    }
    const inv = 1 / neighbours;
    out.x =
        sepX * rules.separation +
        (sumVx * inv - vx[i]) * rules.alignment +
        (sumX * inv - x) * rules.cohesion;
    out.y =
        sepY * rules.separation +
        (sumVy * inv - vy[i]) * rules.alignment +
        (sumY * inv - y) * rules.cohesion;
    return neighbours;
}

/**
 * A push back from the stage edges, starting `margin` px inside them and growing past them,
 * added to `out`. `strength` is the push at the edge itself, px/ms².
 */
export function edgeSteer(x: number, y: number, width: number, height: number, margin: number, strength: number, out: Vec): Vec {
    const k = strength / margin;
    if (x < margin) {
        out.x += (margin - x) * k;
    } else if (x > width - margin) {
        out.x -= (x - (width - margin)) * k;
    }
    if (y < margin) {
        out.y += (margin - y) * k;
    } else if (y > height - margin) {
        out.y -= (y - (height - margin)) * k;
    }
    return out;
}

/**
 * Apply an acceleration for `dt` ms to the velocity (vx, vy): the heading turns by at most
 * `maxTurn × dt`, and the speed is kept between `minSpeed` and `maxSpeed × boost`.
 * The new velocity is written into `out`.
 */
export function integrate(vx: number, vy: number, ax: number, ay: number, dt: number, rules: BoidRules, boost: number, out: Vec): Vec {
    const speed0 = Math.hypot(vx, vy);
    let nx = vx + ax * dt;
    let ny = vy + ay * dt;
    let speed = Math.hypot(nx, ny);
    if (speed0 > 1e-6 && speed > 1e-6) {
        const a0 = Math.atan2(vy, vx);
        let turn = Math.atan2(ny, nx) - a0;
        if (turn > Math.PI) {
            turn -= Math.PI * 2;
        } else if (turn < -Math.PI) {
            turn += Math.PI * 2;
        }
        const limit = rules.maxTurn * boost * dt;
        if (turn > limit || turn < -limit) {
            const a = a0 + (turn > 0 ? limit : -limit);
            nx = Math.cos(a) * speed;
            ny = Math.sin(a) * speed;
        }
    }
    if (speed < 1e-6) {
        // No heading left: keep the old one, or pick one.
        nx = speed0 > 1e-6 ? vx : 1;
        ny = speed0 > 1e-6 ? vy : 0;
        speed = Math.hypot(nx, ny);
    }
    const lo = rules.minSpeed;
    const hi = Math.max(lo, rules.maxSpeed * boost);
    const target = speed < lo ? lo : speed > hi ? hi : speed;
    out.x = (nx / speed) * target;
    out.y = (ny / speed) * target;
    return out;
}
