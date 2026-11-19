import type { Stage } from '../Stage';
import type { Theme } from '../types';
import { FADE, fadeToward, frameLine, lineDraw, placePicture, settle, type Frame, type PageBox, type Picture, type Placement } from './place';

export type { Frame, PageBox, Picture } from './place';

const SVG = 'http://www.w3.org/2000/svg';
const NO_FRAME: Frame = {};
/** Longest real-clock step a fade takes in one frame, so a hidden tab coming back does not jump. */
const LONGEST_STEP = 100;

/** What the manager tells every page layer once per frame. @internal */
export interface PageClock {
    /** Counts drawn frames, so a layer can tell a new frame from the same one. */
    frame: number;
    /** Scene time in milliseconds: the bead, the march, twinkles and sway follow it, and stop when it stops. */
    time: number;
    theme: Theme;
}

/** One frame or picture on one element, kept from frame to frame while it is asked for. */
interface Piece {
    /** The frame's drawing, for a frame. */
    svg?: SVGSVGElement;
    line?: SVGRectElement;
    bead?: SVGRectElement;
    /** One node per copy of a picture. */
    pictures: HTMLElement[];
    /** How far it has appeared, 0..1. */
    shown: number;
    /** A fade on the real clock is under way, and when it last stepped. */
    fading: boolean;
    stepped: number;
    /** Asked for this frame. */
    used: boolean;
}

/** What was last written on a node, so a value that did not change is not written again. */
const written = new WeakMap<Element, Map<string, string>>();

function put(node: HTMLElement | SVGElement, property: string, value: string): void {
    let seen = written.get(node);
    if (!seen) {
        seen = new Map();
        written.set(node, seen);
    }
    if (seen.get(property) !== value) {
        seen.set(property, value);
        node.style.setProperty(property, value);
    }
}

function attribute(node: Element, name: string, value: string | undefined): void {
    let seen = written.get(node);
    if (!seen) {
        seen = new Map();
        written.set(node, seen);
    }
    const key = `@${name}`;
    if (seen.get(key) !== (value ?? '')) {
        seen.set(key, value ?? '');
        if (value === undefined) {
            node.removeAttribute(name);
        } else {
            node.setAttribute(name, value);
        }
    }
}

/**
 * An effect's place on the page itself: `this.host.page`. What is drawn here is page content,
 * drawn by the browser at the screen's full sharpness, not pixels in the canvas (which go
 * through the bloom at a capped resolution, so a 1 px line comes out soft there).
 *
 * Call `picture()` and `frame()` in `onRender`, every frame, like drawing into a cleared
 * `Graphics`. What was not asked for in a frame is taken away after it. Nothing to create and
 * nothing to clean up: the manager makes the layer the first time it is used, hides it while the
 * effect is off, and removes it with the effect.
 *
 * The layer is a `<div>` right after the canvas, covering it exactly and clipped to it, that
 * never takes the pointer. Its `left` and `top` are stage pixels.
 */
export class PageLayer {
    /** The `<div>` covering the canvas. Put page content of your own in it if you like: `left` and `top` in it are stage pixels. */
    public readonly element: HTMLElement;

    private readonly pieces = new Map<string, Piece>();
    private readonly counts = new Map<string, number>();
    private readonly calm: MediaQueryList | undefined;
    private frameSeen = -1;
    private still = false;
    private now = 0;
    private fading = false;
    private left = 0;
    private top = 0;
    /** The z-index pieces get when they give none: the canvas's own, so they sit right above it. */
    private underZ = 'auto';

    /** @internal Made by the manager on the effect's first use of `host.page`. */
    public constructor(
        private readonly canvas: HTMLCanvasElement,
        private readonly stage: Stage,
        private readonly clock: PageClock,
    ) {
        const element = document.createElement('div');
        element.setAttribute('aria-hidden', 'true');
        // No opacity, transform, filter or z-index here: then the layer is no stacking context,
        // and each piece's z-index places it among the page's own elements.
        element.style.cssText = 'position: absolute; left: 0; top: 0; width: 0; height: 0; margin: 0; padding: 0; border: 0; overflow: hidden; pointer-events: none;';
        this.element = element;
        this.calm = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
    }

    /**
     * Put an image on a page element, this frame. `on` is an anchor's name, an anchor, a `Field`,
     * or any `{ name, x, y, width, height }`; missing or off screen, nothing is drawn. `shown` is
     * how far it has appeared: a number 0..1 as given, `true` or `false` to fade in or out by
     * itself over the picture's `fade`, left out for simply there.
     */
    public picture(on: string | PageBox | undefined, picture: Picture, shown?: number | boolean): void {
        const box = this.find(on);
        if (!box) {
            return;
        }
        const piece = this.piece(box.name, picture.image);
        const amount = this.amount(piece, shown, picture.fade ?? FADE);
        if (amount <= 0) {
            this.conceal(piece);
            return;
        }
        const zIndex = picture.zIndex !== undefined ? String(picture.zIndex) : this.underZ;
        this.drawPictures(piece, [[picture, placePicture(box, picture, amount, this.clock.time, this.still), zIndex]]);
    }

    /**
     * Draw a border line round a page element, with its pictures, this frame. `on` and `shown`
     * as for `picture()`; a boolean `shown` fades over the frame's `fade`. Left out, `frame` is a
     * plain 1 px line in the accent colour, 6 px out, following the element's own corners.
     */
    public frame(on: string | PageBox | undefined, frame: Frame = NO_FRAME, shown?: number | boolean): void {
        const box = this.find(on);
        if (!box) {
            return;
        }
        const piece = this.piece(box.name, '');
        const amount = this.amount(piece, shown, frame.fade ?? FADE);
        if (amount <= 0) {
            this.conceal(piece);
            return;
        }
        const zIndex = frame.zIndex !== undefined ? String(frame.zIndex) : this.underZ;
        const line = frameLine(box, frame);
        const draw = lineDraw(frame, amount, this.clock.time, this.still);
        const thickness = Math.max(0, frame.line ?? 1);
        const color = this.paint(frame.color);

        if (!piece.svg) {
            piece.svg = document.createElementNS(SVG, 'svg');
            piece.svg.style.cssText = 'position: absolute; left: 0; top: 0; width: 100%; height: 100%; overflow: visible;';
            piece.line = document.createElementNS(SVG, 'rect');
            piece.bead = document.createElementNS(SVG, 'rect');
            for (const shape of [piece.line, piece.bead]) {
                shape.setAttribute('fill', 'none');
                shape.setAttribute('stroke-linecap', 'round');
                piece.svg.append(shape);
            }
            piece.bead.setAttribute('pathLength', '100');
            piece.bead.setAttribute('stroke-dasharray', '5 95');
            this.element.append(piece.svg);
        }
        const svg = piece.svg;
        const lineNode = piece.line!;
        const bead = piece.bead!;
        put(svg, 'display', thickness > 0 ? 'block' : 'none');
        put(svg, 'z-index', zIndex);
        put(svg, 'opacity', String(draw.opacity));
        for (const shape of [lineNode, bead]) {
            attribute(shape, 'x', String(line.x));
            attribute(shape, 'y', String(line.y));
            attribute(shape, 'width', String(line.width));
            attribute(shape, 'height', String(line.height));
            attribute(shape, 'rx', String(line.radius));
        }
        put(lineNode, 'stroke', color);
        attribute(lineNode, 'stroke-width', String(thickness));
        attribute(lineNode, 'pathLength', draw.pathLength === undefined ? undefined : String(draw.pathLength));
        attribute(lineNode, 'stroke-dasharray', draw.dashArray);
        put(lineNode, 'stroke-dashoffset', String(draw.dashOffset));
        put(bead, 'display', draw.bead === undefined ? 'none' : 'block');
        put(bead, 'stroke', `color-mix(in srgb, ${color} 35%, white)`);
        attribute(bead, 'stroke-width', String(thickness + 1.5));
        put(bead, 'stroke-dashoffset', String(draw.bead ?? 0));

        // Pictures sit on the line. Each one's copies count on from the last, so neighbours rock out of step.
        const pictures: [Picture, Placement[], string][] = [];
        let index = 0;
        for (const picture of frame.pictures ?? []) {
            const placements = placePicture(line, picture, amount, this.clock.time, this.still, index);
            index += placements.length;
            pictures.push([picture, placements, picture.zIndex !== undefined ? String(picture.zIndex) : zIndex]);
        }
        this.drawPictures(piece, pictures);
    }

    /** @internal After the effect's `onRender`: take away what was not asked for. True while something is still fading. */
    public end(): boolean {
        if (this.frameSeen !== this.clock.frame) {
            // Nothing was asked for this frame.
            for (const piece of this.pieces.values()) {
                piece.used = false;
            }
            this.fading = false;
        }
        for (const [key, piece] of this.pieces) {
            if (!piece.used) {
                piece.svg?.remove();
                for (const node of piece.pictures) {
                    node.remove();
                }
                this.pieces.delete(key);
            }
        }
        return this.fading;
    }

    /** @internal While the effect is off or has failed. */
    public hide(): void {
        put(this.element, 'display', 'none');
    }

    /** @internal When the effect is removed. */
    public remove(): void {
        this.element.remove();
        this.pieces.clear();
    }

    /** The first call in a frame lays the layer over the canvas again and forgets what was asked last frame. */
    private ready(): void {
        if (this.frameSeen === this.clock.frame) {
            return;
        }
        this.frameSeen = this.clock.frame;
        this.counts.clear();
        this.fading = false;
        this.still = this.calm?.matches ?? false;
        this.now = performance.now();
        for (const piece of this.pieces.values()) {
            piece.used = false;
        }

        const element = this.element;
        put(element, 'display', 'block');
        // Wherever the page puts the layer's containing block, move it by what it is off the canvas.
        const canvas = this.canvas.getBoundingClientRect();
        const layer = element.getBoundingClientRect();
        this.left = Math.round((this.left + canvas.left - layer.left) * 100) / 100;
        this.top = Math.round((this.top + canvas.top - layer.top) * 100) / 100;
        put(element, 'left', `${this.left}px`);
        put(element, 'top', `${this.top}px`);
        put(element, 'width', `${this.canvas.clientWidth}px`);
        put(element, 'height', `${this.canvas.clientHeight}px`);
        const style = getComputedStyle(this.canvas);
        this.underZ = style.position !== 'static' && style.zIndex !== 'auto' ? style.zIndex : 'auto';

        // Theme colours by name, so `color: 'accent'` follows setTheme.
        const theme = this.clock.theme;
        for (const key of Object.keys(theme) as (keyof Theme)[]) {
            put(element, `--fx-${key}`, `#${theme[key].toString(16).padStart(6, '0')}`);
        }
    }

    private find(on: string | PageBox | undefined): PageBox | undefined {
        this.ready();
        const box = typeof on === 'string' ? this.stage.anchor(on) : on;
        if (!box || box.visible === false || !(box.width > 0) || !(box.height > 0)) {
            return undefined;
        }
        return box;
    }

    /** A piece is known by its element's name and what it is (its image, or a frame), counted in the order asked. */
    private piece(name: string, what: string): Piece {
        const base = `${name}\u0000${what}`;
        const count = this.counts.get(base) ?? 0;
        this.counts.set(base, count + 1);
        const key = `${base}\u0000${count}`;
        let piece = this.pieces.get(key);
        if (!piece) {
            piece = { pictures: [], shown: 0, fading: false, stepped: 0, used: false };
            this.pieces.set(key, piece);
        }
        piece.used = true;
        return piece;
    }

    /** How far a piece is shown this frame. `true` and `false` fade on the real clock, so they also work while the scene is paused. */
    private amount(piece: Piece, shown: number | boolean | undefined, fade: number): number {
        if (typeof shown !== 'boolean') {
            piece.fading = false;
            piece.shown = settle(shown ?? 1, this.still);
            return piece.shown;
        }
        const target = shown ? 1 : 0;
        if (this.still || piece.shown === target) {
            piece.fading = false;
            piece.shown = target;
            return target;
        }
        // A fade starts on this frame and steps from the next, so a long wait before it is not counted.
        const elapsed = piece.fading ? Math.min(LONGEST_STEP, this.now - piece.stepped) : 0;
        piece.shown = fadeToward(piece.shown, target, elapsed, fade);
        piece.stepped = this.now;
        piece.fading = piece.shown !== target;
        this.fading ||= piece.fading;
        return piece.shown;
    }

    private conceal(piece: Piece): void {
        if (piece.svg) {
            put(piece.svg, 'display', 'none');
        }
        for (const node of piece.pictures) {
            put(node, 'display', 'none');
        }
    }

    private drawPictures(piece: Piece, pictures: [Picture, Placement[], string][]): void {
        let used = 0;
        for (const [picture, placements, zIndex] of pictures) {
            for (const place of placements) {
                let node = piece.pictures[used];
                if (!node) {
                    node = document.createElement('div');
                    node.style.cssText = 'position: absolute; left: 0; top: 0;';
                    this.element.append(node);
                    piece.pictures.push(node);
                }
                used++;
                this.drawPicture(node, picture, place, zIndex);
            }
        }
        for (const node of piece.pictures.splice(used)) {
            node.remove();
        }
    }

    private drawPicture(node: HTMLElement, picture: Picture, place: Placement, zIndex: string): void {
        const image = `url("${picture.image.replace(/"/g, '%22')}")`;
        const size = `${place.imageWidth}px ${place.imageHeight}px`;
        const repeat = place.repeat ? 'repeat-x' : 'no-repeat';
        const own = picture.color === 'own';
        put(node, 'display', 'block');
        put(node, 'width', `${place.width}px`);
        put(node, 'height', `${place.height}px`);
        put(node, 'z-index', zIndex);
        put(node, 'opacity', String(place.opacity));
        put(node, 'transform', `translate(${place.x}px, ${place.y}px) scale(${place.scaleX}, ${place.scaleY}) rotate(${place.turn}deg)`);
        put(node, 'transform-origin', `${place.pivotX * 100}% ${place.pivotY * 100}%`);
        put(node, 'clip-path', place.clipTop > 0 ? `inset(${place.clipTop * 100}% 0 0 0)` : 'none');
        // The file is a mask, so the picture takes the colour; with 'own' it is shown as it is.
        put(node, 'background-color', own ? 'transparent' : this.paint(picture.color));
        put(node, 'background-image', own ? image : 'none');
        put(node, 'background-size', size);
        put(node, 'background-repeat', repeat);
        put(node, 'background-position', 'left center');
        for (const prefix of ['', '-webkit-']) {
            put(node, `${prefix}mask-image`, own ? 'none' : image);
            put(node, `${prefix}mask-size`, size);
            put(node, `${prefix}mask-repeat`, repeat);
            put(node, `${prefix}mask-position`, 'left center');
        }
    }

    /** A theme colour by name becomes its variable on the layer; anything else is taken as a CSS colour. */
    private paint(color = 'accent'): string {
        return Object.prototype.hasOwnProperty.call(this.clock.theme, color) ?`var(--fx-${color})` : color;
    }
}
