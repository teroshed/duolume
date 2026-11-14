/**
 * How a bubble meets a page element: a circle that may not overlap a rectangle.
 * Renderer-free, so the rules can be tested on their own: see tests/bubbles.test.ts.
 */

/** A page element's rectangle in stage pixels. `AnchorRect` fits. */
export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface Contact {
    /** Unit normal pointing from the element to the bubble. Stage axes: `ny` = 1 means the bubble is underneath. */
    nx: number;
    ny: number;
    /** How far the bubble reaches into the element along that normal, in pixels. */
    depth: number;
    /** The point of the element the bubble touches. */
    x: number;
    y: number;
}

/** How much flatter (y) and wider (x) a bubble is drawn when fully pressed against an underside. */
export const SQUASH_FLAT = 0.16;
export const SQUASH_WIDE = 0.1;

/**
 * Does a bubble at (`cx`, `cy`) overlap `box`? If so, `out` says which way to push it and how far.
 *
 * Outside the rectangle the push is away from the nearest point of it, so a corner turns a
 * bubble smoothly from the underside to the side. With its centre inside (the element moved
 * over it, or it was born there) it leaves by the nearest side, the underside first on a tie.
 */
export function touch(cx: number, cy: number, radius: number, box: Box, out: Contact): boolean {
    // Nothing to push: no size, or a position that is not a number.
    if (!(radius > 0) || !Number.isFinite(cx) || !Number.isFinite(cy)) {
        return false;
    }
    const left = box.x;
    const right = box.x + box.width;
    const top = box.y;
    const bottom = box.y + box.height;
    const nearX = cx < left ? left : cx > right ? right : cx;
    const nearY = cy < top ? top : cy > bottom ? bottom : cy;
    const dx = cx - nearX;
    const dy = cy - nearY;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared >= radius * radius) {
        return false;
    }
    if (distanceSquared > 1e-9) {
        const distance = Math.sqrt(distanceSquared);
        out.nx = dx / distance;
        out.ny = dy / distance;
        out.depth = radius - distance;
        out.x = nearX;
        out.y = nearY;
        return true;
    }

    const toBottom = bottom - cy;
    const toTop = cy - top;
    const toLeft = cx - left;
    const toRight = right - cx;
    const least = Math.min(toBottom, toTop, toLeft, toRight);
    out.nx = 0;
    out.ny = 0;
    out.x = cx;
    out.y = cy;
    if (least === toBottom) {
        out.ny = 1;
        out.y = bottom;
    } else if (least === toTop) {
        out.ny = -1;
        out.y = top;
    } else if (least === toLeft) {
        out.nx = -1;
        out.x = left;
    } else {
        out.nx = 1;
        out.x = right;
    }
    out.depth = least + radius;
    return true;
}

/**
 * Which way a bubble held under an element drifts, -1 (left) or 1 (right): downwind when the
 * sideways force is clearly there, otherwise the way it was already going, otherwise toward
 * the nearer end of the element.
 */
export function slideDirection(cx: number, box: Box, forceX: number, clearForce: number, previous: number): number {
    if (Math.abs(forceX) > clearForce) {
        return forceX > 0 ? 1 : -1;
    }
    if (previous !== 0) {
        return previous;
    }
    return cx < box.x + box.width / 2 ? -1 : 1;
}

/**
 * Milliseconds before a bubble at `distance` from a blast of reach `range` pops: the nearest
 * go first, so a chain of pops runs outward. `roll` is a random 0..1. Never more than 250.
 */
export function fuseDelay(distance: number, range: number, roll: number): number {
    const share = range > 0 ? Math.min(1, Math.max(0, distance / range)) : 0;
    return share * 180 + roll * 70;
}
