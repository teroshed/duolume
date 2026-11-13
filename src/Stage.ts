import { PerspectiveCamera, Vector3 as ThreeVector3 } from 'three';
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
    /** Free-form tags from `data-fx-tags`, e.g. "ledge" so rain lands on it. */
    tags: readonly string[];
}

interface AnchorEntry {
    element: Element;
    rect: AnchorRect;
    /** Found by `watchAll` (and dropped again when it leaves the page), not added with `observe`. */
    auto: boolean;
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

    /** Track a DOM element under a name. Its rectangle is refreshed once per frame. */
    public observe(name: string, element: Element, tags: readonly string[] = []): void {
        this.anchors.set(name, {
            element,
            rect: { name, x: 0, y: 0, width: 0, height: 0, visible: false, tags },
            auto: false,
        });
        this.anchorList = Array.from(this.anchors.values(), (entry) => entry.rect);
    }

    public unobserve(name: string): void {
        if (this.anchors.delete(name)) {
            this.anchorList = Array.from(this.anchors.values(), (entry) => entry.rect);
        }
    }

    /** Pick up every `[data-fx-anchor]` element under `root`, once. Tags come from `data-fx-tags`. */
    public observeAll(root: ParentNode): void {
        for (const element of root.querySelectorAll('[data-fx-anchor]')) {
            const name = element.getAttribute('data-fx-anchor');
            if (!name) {
                continue;
            }
            const tags = (element.getAttribute('data-fx-tags') ?? '').split(/\s+/).filter(Boolean);
            this.observe(name, element, tags);
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
            const tags = (element.getAttribute('data-fx-tags') ?? '').split(/\s+/).filter(Boolean);
            const existing = this.anchors.get(name);
            if (existing && !existing.auto) {
                continue;
            }
            if (existing && existing.element === element && existing.rect.tags.join(' ') === tags.join(' ')) {
                continue;
            }
            this.anchors.set(name, {
                element,
                rect: { name, x: 0, y: 0, width: 0, height: 0, visible: false, tags },
                auto: true,
            });
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

    public get allAnchors(): readonly AnchorRect[] {
        return this.anchorList;
    }

    /**
     * The anchors that carry a tag and are on screen right now, e.g. `stage.tagged('ledge')`
     * for the page elements things can land on. The list is rebuilt once per frame, not per call.
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
