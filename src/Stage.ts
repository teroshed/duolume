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
        });
        this.anchorList = Array.from(this.anchors.values(), (entry) => entry.rect);
    }

    public unobserve(name: string): void {
        if (this.anchors.delete(name)) {
            this.anchorList = Array.from(this.anchors.values(), (entry) => entry.rect);
        }
    }

    /** Pick up every `[data-fx-anchor]` element under `root`. Tags come from `data-fx-tags`. */
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
        this.anchors.clear();
        this.anchorList = [];
    }
}
