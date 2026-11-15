/** A point on the path, with its outward normal and its direction of travel (both unit length). */
export interface BorderPoint {
    x: number;
    y: number;
    /** Unit normal, pointing out of the rounded rectangle. */
    nx: number;
    ny: number;
    /** Unit tangent, in the direction of increasing distance (clockwise on screen). */
    tx: number;
    ty: number;
}

export function makeBorderPoint(): BorderPoint {
    return { x: 0, y: 0, nx: 0, ny: -1, tx: 1, ty: 0 };
}

const HALF_PI = Math.PI / 2;

/**
 * The closed path of a fuse: an element's rounded rectangle, drawn inward by `inset` pixels.
 * Pure geometry (no Pixi): a length, and the point, outward normal and direction at any
 * distance along it.
 *
 * Distance 0 is the middle of the left side; it runs up the left side, along the top, down the
 * right side and back along the bottom: clockwise on the screen. Distances wrap, so any number
 * is valid. Straight runs and quarter arcs are exact. The path's corner radius is the element's
 * radius less the inset, so the path follows the element's border; a pill stays a pill.
 */
export class Border {
    /** Perimeter of the path in pixels. */
    public length = 0;
    /** Half the path's width and height: where it sits is centred on the element. */
    private left = 0;
    private top = 0;
    private right = 0;
    private bottom = 0;
    private r = 0;
    /** Distance at which each of the nine pieces ends. */
    private readonly ends = new Float64Array(9);

    public constructor(width = 0, height = 0, radius = 0, inset = 2.5) {
        this.set(width, height, radius, inset);
    }

    /** Re-shape the path for an element of this size and corner radius. */
    public set(width: number, height: number, radius: number, inset = 2.5): void {
        const w = Math.max(0, (Number.isFinite(width) ? width : 0) - inset * 2);
        const h = Math.max(0, (Number.isFinite(height) ? height : 0) - inset * 2);
        const r = Math.max(0, Math.min(Number.isFinite(radius) ? radius - inset : 0, w / 2, h / 2));
        this.left = inset;
        this.top = inset;
        this.right = inset + w;
        this.bottom = inset + h;
        this.r = r;
        if (w === 0 && h === 0) {
            // Nothing to travel along: sit at the middle of the element.
            this.left = this.right = width / 2 || 0;
            this.top = this.bottom = height / 2 || 0;
        }
        const ends = this.ends;
        const arc = r * HALF_PI;
        const side = Math.max(0, h / 2 - r);
        const run = Math.max(0, w - 2 * r);
        const flank = Math.max(0, h - 2 * r);
        ends[0] = side; // left side, going up from the middle
        ends[1] = ends[0] + arc; // top-left corner
        ends[2] = ends[1] + run; // top
        ends[3] = ends[2] + arc; // top-right corner
        ends[4] = ends[3] + flank; // right side
        ends[5] = ends[4] + arc; // bottom-right corner
        ends[6] = ends[5] + run; // bottom
        ends[7] = ends[6] + arc; // bottom-left corner
        ends[8] = ends[7] + side; // left side, down to the middle
        this.length = ends[8];
    }

    /** The point `distance` pixels along the path (wrapping), written into `out`. */
    public pointAt(distance: number, out: BorderPoint): BorderPoint {
        const length = this.length;
        if (!(length > 0) || !Number.isFinite(distance)) {
            out.x = (this.left + this.right) / 2;
            out.y = (this.top + this.bottom) / 2;
            out.nx = 0;
            out.ny = -1;
            out.tx = 1;
            out.ty = 0;
            return out;
        }
        let d = distance % length;
        if (d < 0) {
            d += length;
        }
        const ends = this.ends;
        const { left, top, right, bottom, r } = this;
        const cy = (top + bottom) / 2;
        let piece = 0;
        while (piece < 8 && d > ends[piece]) {
            piece++;
        }
        const into = d - (piece === 0 ? 0 : ends[piece - 1]);
        switch (piece) {
            case 0:
                return this.line(out, left, cy - into, -1, 0, 0, -1);
            case 1:
                return this.arc(out, left + r, top + r, Math.PI + into / r);
            case 2:
                return this.line(out, left + r + into, top, 0, -1, 1, 0);
            case 3:
                return this.arc(out, right - r, top + r, 1.5 * Math.PI + into / r);
            case 4:
                return this.line(out, right, top + r + into, 1, 0, 0, 1);
            case 5:
                return this.arc(out, right - r, bottom - r, into / r);
            case 6:
                return this.line(out, right - r - into, bottom, 0, 1, -1, 0);
            case 7:
                return this.arc(out, left + r, bottom - r, HALF_PI + into / r);
            default:
                return this.line(out, left, bottom - r - into, -1, 0, 0, -1);
        }
    }

    /**
     * The distance of the path point nearest to (x, y), found by walking the path every `step`
     * pixels. For lighting a spark where the pointer is.
     */
    public nearest(x: number, y: number, step = 2, scratch: BorderPoint = makeBorderPoint()): number {
        let best = 0;
        let bestSq = Infinity;
        const length = this.length;
        for (let d = 0; d < length; d += step) {
            this.pointAt(d, scratch);
            const dx = scratch.x - x;
            const dy = scratch.y - y;
            const sq = dx * dx + dy * dy;
            if (sq < bestSq) {
                bestSq = sq;
                best = d;
            }
        }
        return best;
    }

    private line(out: BorderPoint, x: number, y: number, nx: number, ny: number, tx: number, ty: number): BorderPoint {
        out.x = x;
        out.y = y;
        out.nx = nx;
        out.ny = ny;
        out.tx = tx;
        out.ty = ty;
        return out;
    }

    private arc(out: BorderPoint, cx: number, cy: number, angle: number): BorderPoint {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        out.x = cx + this.r * cos;
        out.y = cy + this.r * sin;
        out.nx = cos;
        out.ny = sin;
        out.tx = -sin;
        out.ty = cos;
        return out;
    }
}
