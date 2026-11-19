import { PerspectiveCamera, Vector3 as ThreeVector3 } from 'three';
import { cornerRadius } from './dom/place';
import type { Vector3 } from './types';

export interface AnchorRect {
    name: string;
    /** Stage pixels, origin top-left. */
    x: number;
    y: number;
    width: number;
    height: number;
    /** Intersects the viewport. */
    visible: boolean;
    /** Its corner radius in pixels, from its CSS `border-radius`, kept to half its size plus one. Read again when its size changes. */
    radius: number;
    /** Free-form tags from `data-fx-tags`, e.g. "ledge" so rain lands on it. A numbered tag like `ledge-30` is listed twice, as `ledge-30` and as `ledge`. */
    tags: readonly string[];
    /** The number a tag ends in, by the tag's plain name: `ledge-30` gives `numbers.ledge === 30`. For a ledge it is the percent of falling things that fall through it. */
    numbers: Readonly<Record<string, number | undefined>>;
}

/** A tag that ends in a dash and a number, like `ledge-30` or `glow-2.5`. */
const NUMBERED_TAG = /^(.+)-(\d+(?:\.\d+)?)$/;

/**
 * Read a `data-fx-tags` value. Tags are separated by spaces. A tag that ends in a number, like
 * `ledge-30`, is also listed under its plain name (`ledge`), so code that looks for `ledge` finds
 * it, and its number goes into `numbers` (the last one wins if a name is numbered twice).
 */
export function readTags(text: string): { tags: string[]; numbers: Record<string, number | undefined> } {
    const tags: string[] = [];
    const numbers: Record<string, number | undefined> = {};
    for (const tag of text.split(/\s+/)) {
        if (tag === '') {
            continue;
        }
        if (!tags.includes(tag)) {
            tags.push(tag);
        }
        const numbered = NUMBERED_TAG.exec(tag);
        if (numbered) {
            numbers[numbered[1]] = Number(numbered[2]);
            if (!tags.includes(numbered[1])) {
                tags.push(numbered[1]);
            }
        }
    }
    return { tags, numbers };
}

interface AnchorEntry {
    element: Element;
    rect: AnchorRect;
    /** Found by `watchAll` (and dropped again when it leaves the page), not added with `observe`. */
    auto: boolean;
    /** The tags the page gave it, before `focus()` adds its word. */
    own: readonly string[];
    /** The size its radius was read at, so it is read again only when that changes. */
    sizedWidth: number;
    sizedHeight: number;
}

const FOV_DEGREES = 35;

/**
 * The one coordinate space both renderers agree on.
 *
 * Stage space is CSS pixels with the origin at the top-left of the canvas, exactly what Pixi
 * draws in. The Three.js camera is framed so the plane z = 0 maps onto it pixel for pixel:
 * a mesh placed with `toWorld(x, y)` sits over the Pixi pixel (x, y), and anything pushed
 * along z gets real perspective. That shared mapping is what lets a 3D object and a 2D
 * particle collide, orbit or refract each other.
 *
 * It also tracks named DOM elements, so effects can react to the page itself.
 */
export class Stage {
    public width = 1;
    public height = 1;
    public scrollY = 0;
    public readonly camera: PerspectiveCamera;
    private readonly anchors = new Map<string, AnchorEntry>();
    private anchorList: AnchorRect[] = [];
    private readonly taggedCache = new Map<string, AnchorRect[]>();
    private readonly scratch = new ThreeVector3();
    private watched: ParentNode | null = null;
    private mutations: MutationObserver | null = null;
    private rescan = false;
    /** Anchor names that show `focus` because code asked (`focus(name)`), whether or not they exist yet. */
    private readonly focused = new Set<string>();
    /** Called when watched page elements change, so a still picture can be redrawn. */
    public onAnchorsChanged?: () => void;

    public constructor() {
        this.camera = new PerspectiveCamera(FOV_DEGREES, 1, 1, 10000);
        this.resize(1, 1);
    }

    public resize(width: number, height: number): void {
        this.width = Math.max(1, width);
        this.height = Math.max(1, height);
        const distance = this.height / 2 / Math.tan((FOV_DEGREES * Math.PI) / 360);
        this.camera.aspect = this.width / this.height;
        this.camera.near = distance * 0.05;
        this.camera.far = distance * 4;
        this.camera.position.set(0, 0, distance);
        this.camera.lookAt(0, 0, 0);
        this.camera.updateProjectionMatrix();
        this.camera.updateMatrixWorld(true);
    }

    /** Stage pixel (plus optional depth toward the viewer) → Three.js world position. */
    public toWorld(x: number, y: number, z = 0, out: ThreeVector3 = new ThreeVector3()): ThreeVector3 {
        return out.set(x - this.width / 2, this.height / 2 - y, z);
    }

    /** Three.js world position → stage pixel. `z` in the result is the world depth. */
    public project(world: ThreeVector3, out: Vector3 = { x: 0, y: 0 }): Vector3 {
        const v = this.scratch.copy(world).project(this.camera);
        out.x = (v.x * 0.5 + 0.5) * this.width;
        out.y = (0.5 - v.y * 0.5) * this.height;
        out.z = world.z;
        return out;
    }

    /** How many stage pixels one world unit covers at depth `z` (1 at z = 0, more when closer). */
    public scaleAtDepth(z: number): number {
        const distance = this.camera.position.z;
        return distance / Math.max(1, distance - z);
    }

    /** Track a DOM element under a name. Its rectangle is refreshed once per frame. Tags are read as `readTags` reads them. */
    public observe(name: string, element: Element, tags: readonly string[] = []): void {
        this.anchors.set(name, this.entry(name, element, readTags(tags.join(' ')), false));
        this.anchorList = Array.from(this.anchors.values(), (entry) => entry.rect);
        this.onAnchorsChanged?.();
    }

    public unobserve(name: string): void {
        if (this.anchors.delete(name)) {
            this.anchorList = Array.from(this.anchors.values(), (entry) => entry.rect);
            this.onAnchorsChanged?.();
        }
    }

    /**
     * Play the focus look on the element named `name`: its tags show the word `focus` until
     * `unfocus(name)`, as if it had the keyboard focus. The page's own `data-fx-tags` is not
     * touched. A name with no element yet is remembered for when it arrives.
     */
    public focus(name: string): void {
        if (!this.focused.has(name)) {
            this.focused.add(name);
            this.retag(name);
        }
    }

    /** Stop playing the focus look on `name`. Real keyboard focus, written into its tags by `attachFieldTags()`, still shows. */
    public unfocus(name: string): void {
        if (this.focused.delete(name)) {
            this.retag(name);
        }
    }

    private retag(name: string): void {
        const entry = this.anchors.get(name);
        if (entry) {
            entry.rect.tags = this.withFocus(name, entry.own);
            this.taggedCache.clear();
        }
        this.onAnchorsChanged?.();
    }

    /** The tags an anchor shows: its own, plus `focus` while code asks for it (a new list then, so a change shows in the list itself). */
    private withFocus(name: string, own: readonly string[]): readonly string[] {
        return this.focused.has(name) && !own.includes('focus') ? [...own, 'focus'] : own;
    }

    private entry(name: string, element: Element, read: { tags: string[]; numbers: Record<string, number | undefined> }, auto: boolean): AnchorEntry {
        return {
            element,
            rect: { name, x: 0, y: 0, width: 0, height: 0, visible: false, radius: 0, tags: this.withFocus(name, read.tags), numbers: read.numbers },
            auto,
            own: read.tags,
            sizedWidth: -1,
            sizedHeight: -1,
        };
    }

    /** Pick up every `[data-fx-anchor]` element under `root`, once. Tags come from `data-fx-tags`. */
    public observeAll(root: ParentNode): void {
        for (const element of root.querySelectorAll('[data-fx-anchor]')) {
            const name = element.getAttribute('data-fx-anchor');
            if (!name) {
                continue;
            }
            this.observe(name, element, [element.getAttribute('data-fx-tags') ?? '']);
        }
    }

    /**
     * Like `observeAll`, and keep following the page: elements added, removed or retagged later are
     * picked up before the next frame. The manager does this for its `anchors` root. A name given
     * to `observe` by hand is left alone.
     */
    public watchAll(root: ParentNode): void {
        this.mutations?.disconnect();
        this.watched = root;
        this.scan(root);
        this.mutations = new MutationObserver(() => {
            this.rescan = true;
            this.onAnchorsChanged?.();
        });
        this.mutations.observe(root as unknown as Node, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['data-fx-anchor', 'data-fx-tags'],
        });
    }

    private scan(root: ParentNode): void {
        const found = new Set<string>();
        for (const element of root.querySelectorAll('[data-fx-anchor]')) {
            const name = element.getAttribute('data-fx-anchor');
            if (!name || found.has(name)) {
                continue;
            }
            found.add(name);
            const read = readTags(element.getAttribute('data-fx-tags') ?? '');
            const existing = this.anchors.get(name);
            if (existing && !existing.auto) {
                continue;
            }
            if (existing && existing.element === element && existing.own.join(' ') === read.tags.join(' ')) {
                continue;
            }
            this.anchors.set(name, this.entry(name, element, read, true));
        }
        for (const [name, entry] of this.anchors) {
            if (entry.auto && !found.has(name)) {
                this.anchors.delete(name);
            }
        }
        this.anchorList = Array.from(this.anchors.values(), (entry) => entry.rect);
    }

    public anchor(name: string): AnchorRect | undefined {
        return this.anchors.get(name)?.rect;
    }

    /** The page element that carries `data-fx-anchor="name"`, if it is on the page. */
    public element(name: string): Element | undefined {
        return this.anchors.get(name)?.element;
    }

    public get allAnchors(): readonly AnchorRect[] {
        return this.anchorList;
    }

    /**
     * The anchors that carry a tag and are on screen right now, e.g. `stage.tagged('ledge')`
     * for the page elements things can land on (it finds `ledge-30` too). The list is rebuilt
     * once per frame, not per call.
     */
    public tagged(tag: string): readonly AnchorRect[] {
        let list = this.taggedCache.get(tag);
        if (!list) {
            list = this.anchorList.filter((anchor) => anchor.visible && anchor.tags.includes(tag));
            this.taggedCache.set(tag, list);
        }
        return list;
    }

    /** Refresh anchor rectangles. `originX/originY` is the canvas's own viewport offset. */
    public measure(originX = 0, originY = 0): void {
        if (this.rescan && this.watched) {
            this.rescan = false;
            this.scan(this.watched);
        }
        this.taggedCache.clear();
        for (const entry of this.anchors.values()) {
            const box = entry.element.getBoundingClientRect();
            const rect = entry.rect;
            rect.x = box.left - originX;
            rect.y = box.top - originY;
            rect.width = box.width;
            rect.height = box.height;
            if (box.width !== entry.sizedWidth || box.height !== entry.sizedHeight) {
                // Reading the style costs more than reading the box, so only when the size changed.
                entry.sizedWidth = box.width;
                entry.sizedHeight = box.height;
                rect.radius = typeof getComputedStyle === 'function' ? cornerRadius(getComputedStyle(entry.element).borderTopLeftRadius, box.width, box.height) : 0;
            }
            rect.visible =
                box.width > 0 &&
                box.height > 0 &&
                rect.x < this.width &&
                rect.x + rect.width > 0 &&
                rect.y < this.height &&
                rect.y + rect.height > 0;
        }
    }

    public clearAnchors(): void {
        this.mutations?.disconnect();
        this.mutations = null;
        this.watched = null;
        this.anchors.clear();
        this.anchorList = [];
    }
}
