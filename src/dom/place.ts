/**
 * Where the page layer puts things, worked out with no page in sight. `PageLayer` does the DOM;
 * everything it draws is decided here, from the element's box, the picture or frame, how far it
 * has appeared and the clock. So `bun test` can check it, and drawing twice gives the same picture.
 */

/** A page element as the page layer sees it. An anchor from the stage and a `Field` both fit. */
export interface PageBox {
    /** The element's `data-fx-anchor` name. */
    name: string;
    /** Left edge, in stage pixels. */
    x: number;
    /** Top edge, in stage pixels. */
    y: number;
    /** Width in pixels. */
    width: number;
    /** Height in pixels. */
    height: number;
    /** Its own corner radius in pixels. Left out: square corners. */
    radius?: number;
    /** False when it is off screen: then nothing is drawn on it. Left out: on screen. */
    visible?: boolean;
}

/** One image file placed on a page element. Any SVG or PNG: its shape is used and the theme colours it. */
export interface Picture {
    /** Address of the file, as in `<img src>`. A `data:` address works too. */
    image: string;
    /** Width and height in pixels; one number for a square. Default 24. */
    size?: number | [number, number];
    /** Where on the element: across 0..1, down 0..1. [1, 0] is the top-right corner. Default [0.5, 0.5]. */
    at?: [number, number];
    /** Which point of the image lands there, as a fraction of the image. Default [0.5, 0.5]. */
    origin?: [number, number];
    /** Pixels between the element's edge and the rectangle `at` is measured on. Default 0. On a frame, measured from the line. */
    gap?: number;
    /** -1 mirrors that axis: [-1, 1] flips it left to right. Default [1, 1]. */
    flip?: [number, number];
    /** Also place its mirror image opposite: 'x' on the other side, 'y' above or below, 'both' in all four corners. */
    mirror?: 'x' | 'y' | 'both';
    /** Repeat the image sideways across this fraction of the element's width, in whole copies. */
    span?: number;
    /** What paints it: a theme colour by name ('accent', 'ink'), any CSS colour, or 'own' for the file's own colours. Default 'accent'. */
    color?: string;
    /** CSS z-index among the page's own elements. Left out, it sits right above the canvas. */
    zIndex?: number;
    /** Unrolls from its base as it appears. */
    grows?: boolean;
    /** Rocks by this many degrees. */
    sway?: number;
    /** Pulses; the number (0..1) says when in the cycle, so neighbours are out of step. */
    twinkle?: number;
    /** Milliseconds it takes to appear or go when `shown` is true or false. Default 260. On a frame, the frame's `fade` is used. */
    fade?: number;
}

/** A border line round a page element, with pictures on it. */
export interface Frame {
    /** Pixels between the element and the line. Default 6. */
    gap?: number;
    /** Corner radius of the line. Left out: the element's own radius plus the gap. */
    radius?: number;
    /** Thickness in pixels; 0 for no line, only pictures. Default 1. */
    line?: number;
    /** [dash, space] in pixels. Left out, the line is solid and draws itself round the element as it appears. */
    dash?: [number, number];
    /** A bright dash that keeps running round the line. */
    bead?: boolean;
    /** Colour of the line: a theme colour by name ('accent', 'ink'), or any CSS colour. Default 'accent'. */
    color?: string;
    /** CSS z-index of the line, and of its pictures unless they give their own. */
    zIndex?: number;
    /** Images placed on the line. */
    pictures?: Picture[];
    /** Milliseconds it takes to appear or go when `shown` is true or false. Default 260. */
    fade?: number;
}

/** Milliseconds a piece takes to appear or go when `shown` is true or false, unless it says otherwise. */
export const FADE = 260;
/** Pixels between an element and its frame's line, unless the frame says otherwise. */
export const FRAME_GAP = 6;
/** Size of a picture in pixels, unless it says otherwise. */
export const PICTURE_SIZE = 24;
/** Pixels a picture travels in from outside while it appears. */
export const SPREAD = 10;
/** Milliseconds for the bead to go once round the line. */
export const BEAD_LAP = 3200;
/** Pixels per millisecond a dashed line marches. */
export const MARCH = 0.008;
/** Milliseconds of one twinkle or sway. */
export const CYCLE = 1500;

/** How far a piece has appeared, eased so it arrives quickly and settles slowly. */
export function eased(shown: number): number {
    return 1 - (1 - shown) ** 3;
}

/** `shown` as drawn: kept to 0..1, and under reduced motion simply there (from 0.5) or gone. */
export function settle(shown: number, still: boolean): number {
    const value = Number.isFinite(shown) ? Math.min(1, Math.max(0, shown)) : 0;
    return still ? (value >= 0.5 ? 1 : 0) : value;
}

/** One step of a fade on the real clock: `elapsed` milliseconds toward `target` (0 or 1) over `fade`. */
export function fadeToward(current: number, target: number, elapsed: number, fade: number): number {
    const step = fade > 0 ? elapsed / fade : 1;
    return target > current ? Math.min(target, current + step) : Math.max(target, current - step);
}

/** Where a frame's line runs: the middle of the stroke, and its corner radius. */
export interface LineBox {
    x: number;
    y: number;
    width: number;
    height: number;
    radius: number;
}

/**
 * The frame's line round a box. The outside of the stroke lands on whole pixels, so a 1 px line
 * covers one row of pixels instead of straddling two (its middle is on a half pixel).
 */
export function frameLine(box: PageBox, frame: Frame = {}): LineBox {
    const gap = frame.gap ?? FRAME_GAP;
    const line = Math.max(0, frame.line ?? 1);
    const left = Math.round(box.x - gap);
    const top = Math.round(box.y - gap);
    const outerWidth = Math.round(box.width + gap * 2);
    const outerHeight = Math.round(box.height + gap * 2);
    const width = Math.max(0, outerWidth - line);
    const height = Math.max(0, outerHeight - line);
    const radius = frame.radius ?? (box.radius ?? 0) + gap;
    return {
        x: left + line / 2,
        y: top + line / 2,
        width,
        height,
        radius: Math.max(0, Math.min(radius, width / 2, height / 2)),
    };
}

/** How the line is dashed and where the dashes are this frame. `pathLength` 100 means "100 is once round". */
export interface LineDraw {
    /** SVG `stroke-dasharray`. */
    dashArray: string;
    /** SVG `stroke-dashoffset`. */
    dashOffset: number;
    /** SVG `pathLength`, or undefined for real pixels. */
    pathLength: number | undefined;
    /** Opacity of the whole frame. */
    opacity: number;
    /** Where the bead is (a `stroke-dashoffset` on a path of length 100), or undefined when there is none. */
    bead: number | undefined;
}

/** The line's dashes for a frame `shown` this far (already settled), at `time` ms of the scene. */
export function lineDraw(frame: Frame, shown: number, time: number, still: boolean): LineDraw {
    const dash = frame.dash;
    return {
        dashArray: dash ? `${dash[0]} ${dash[1]}` : '100',
        // A dashed line marches slowly; a plain one draws itself round the element as it appears.
        dashOffset: dash ? (still ? 0 : -time * MARCH) : 100 * (1 - eased(shown)),
        pathLength: dash ? undefined : 100,
        opacity: Math.min(1, shown * 2),
        bead: frame.bead && !still ? -((time / BEAD_LAP) % 1) * 100 : undefined,
    };
}

/** One copy of a picture, placed: everything `PageLayer` writes on its node. */
export interface Placement {
    /** Left and top of the image, in stage pixels, before flipping and rocking. */
    x: number;
    y: number;
    /** Size of the node: wider than the image when it repeats across a span. */
    width: number;
    height: number;
    /** Size of one copy of the image. */
    imageWidth: number;
    imageHeight: number;
    /** True when the image repeats sideways. */
    repeat: boolean;
    /** -1 or 1 times the twinkle's size. */
    scaleX: number;
    scaleY: number;
    /** Degrees it rocks by, now. */
    turn: number;
    /** The point it flips and rocks about, as a fraction of the node (the centre for a twinkle). */
    pivotX: number;
    pivotY: number;
    /** Fraction cut off its top while it unrolls, 0 when whole. */
    clipTop: number;
    opacity: number;
}

/** The copies a picture asks for: itself, and its mirror images. */
export function mirrored(picture: Picture): { at: [number, number]; flip: [number, number] }[] {
    const [across, down] = picture.at ?? [0.5, 0.5];
    const [flipX, flipY] = picture.flip ?? [1, 1];
    const copies: { at: [number, number]; flip: [number, number] }[] = [{ at: [across, down], flip: [flipX, flipY] }];
    if (picture.mirror === 'x' || picture.mirror === 'both') {
        copies.push({ at: [1 - across, down], flip: [-flipX, flipY] });
    }
    if (picture.mirror === 'both') {
        copies.push({ at: [1 - across, 1 - down], flip: [-flipX, -flipY] });
    }
    if (picture.mirror === 'y' || picture.mirror === 'both') {
        copies.push({ at: [across, 1 - down], flip: [flipX, -flipY] });
    }
    return copies;
}

/**
 * Every copy of a picture on a rectangle (the element, or a frame's line), for a piece `shown`
 * this far (already settled), at `time` ms of the scene. `index` is its place among its
 * neighbours: a picture without `twinkle` takes its rhythm from it, so neighbours rock out of step.
 */
export function placePicture(
    rect: { x: number; y: number; width: number; height: number },
    picture: Picture,
    shown: number,
    time: number,
    still: boolean,
    index = 0,
): Placement[] {
    const size = picture.size ?? PICTURE_SIZE;
    const [imageWidth, imageHeight] = typeof size === 'number' ? [size, size] : size;
    const [originX, originY] = picture.origin ?? [0.5, 0.5];
    const gap = picture.gap ?? 0;
    const x = rect.x - gap;
    const y = rect.y - gap;
    const width = rect.width + gap * 2;
    const height = rect.height + gap * 2;
    const arrive = eased(shown);
    const spread = (1 - arrive) * SPREAD; // pictures arrive from outside
    const span = picture.span;
    const nodeWidth = span ? Math.max(1, Math.round((width * span) / imageWidth)) * imageWidth : imageWidth;

    return mirrored(picture).map(({ at, flip }, copy) => {
        const phase = picture.twinkle ?? (index + copy) * 0.25;
        const cycle = Math.sin((time / CYCLE + phase) * Math.PI * 2);
        const pulse = picture.twinkle === undefined ? 1 : still ? 0.85 : 0.7 + 0.3 * cycle;
        return {
            x: x + at[0] * width + Math.sign(at[0] - 0.5) * spread - originX * nodeWidth,
            y: y + at[1] * height + Math.sign(at[1] - 0.5) * spread - originY * imageHeight,
            width: nodeWidth,
            height: imageHeight,
            imageWidth,
            imageHeight,
            repeat: span !== undefined,
            scaleX: flip[0] * pulse,
            scaleY: flip[1] * pulse,
            turn: picture.sway && !still ? picture.sway * cycle : 0,
            // Mirroring and rocking pivot on the point that sits on the element; pulsing on the centre.
            pivotX: picture.twinkle === undefined ? originX : 0.5,
            pivotY: picture.twinkle === undefined ? originY : 0.5,
            clipTop: picture.grows ? 1 - arrive : 0,
            opacity: Math.min(1, shown * 2),
        };
    });
}

/**
 * An element's corner radius from its computed `border-top-left-radius` (`"10px"`, `"50%"`),
 * kept to what fits, as `attachFieldTags()` keeps its `r:` word.
 */
export function cornerRadius(text: string, width: number, height: number): number {
    const value = parseFloat(text);
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }
    const pixels = text.trim().endsWith('%') ? (value / 100) * width : value;
    return Math.round(Math.min(pixels, height / 2 + 1, width / 2 + 1));
}
