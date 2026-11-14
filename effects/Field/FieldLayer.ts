import { Container, Graphics } from 'pixi.js';

interface View {
    box: Container;
    clip: Graphics;
    graphics: Graphics;
    width: number;
    height: number;
    radius: number;
    inset: number;
    drawn: boolean;
}

/** What `draw` needs to know about an element: a `Field` has all of it. */
export interface FieldBox {
    readonly name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    radius: number;
}

/**
 * Not an effect: the drawing half of the input effects' building block.
 *
 * It gives each page element its own Pixi `Graphics`, placed at the element's top-left corner
 * and clipped to its rounded rectangle, so an effect draws in the element's own pixels
 * (0..width, 0..height) and nothing spills over the edge.
 *
 * In `onRender`: `const g = layer.draw(field)` for every field, draw into `g`, then
 * `layer.sweep()` once. `destroy()` in `cleanup`.
 */
export class FieldLayer {
    private readonly root = new Container();
    private readonly views = new Map<string, View>();

    /** `additive` makes everything drawn here add light instead of covering what is behind. */
    public constructor(parent: Container, additive = false) {
        this.root.label = 'fields';
        if (additive) {
            this.root.blendMode = 'add';
        }
        parent.addChild(this.root);
    }

    /**
     * The element's `Graphics`, cleared and ready: origin at its top-left corner, clipped to its
     * rounded rectangle shrunk by `inset` pixels (1 keeps clear of a one-pixel border).
     */
    public draw(field: FieldBox, inset = 1): Graphics {
        let view = this.views.get(field.name);
        if (!view) {
            const box = new Container();
            const clip = new Graphics();
            const graphics = new Graphics();
            box.addChild(clip, graphics);
            box.mask = clip;
            this.root.addChild(box);
            view = { box, clip, graphics, width: -1, height: -1, radius: -1, inset: -1, drawn: false };
            this.views.set(field.name, view);
        }
        if (view.width !== field.width || view.height !== field.height || view.radius !== field.radius || view.inset !== inset) {
            view.width = field.width;
            view.height = field.height;
            view.radius = field.radius;
            view.inset = inset;
            const width = Math.max(0, field.width - inset * 2);
            const height = Math.max(0, field.height - inset * 2);
            view.clip.clear();
            if (width > 0 && height > 0) {
                view.clip.roundRect(inset, inset, width, height, Math.max(0, field.radius - inset)).fill(0xffffff);
            }
        }
        view.box.position.set(field.x, field.y);
        view.box.visible = field.width > inset * 2 && field.height > inset * 2;
        view.drawn = true;
        view.graphics.clear();
        return view.graphics;
    }

    /** End of the frame: let go of the elements that were not drawn this time. */
    public sweep(): void {
        for (const [name, view] of this.views) {
            if (!view.drawn) {
                view.box.destroy({ children: true });
                this.views.delete(name);
            } else {
                view.drawn = false;
            }
        }
    }

    public destroy(): void {
        this.root.destroy({ children: true });
        this.views.clear();
    }
}
