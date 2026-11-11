import { Particle as PixiParticle, ParticleContainer, Rectangle, Texture } from 'pixi.js';
import { Effect } from '../../src/Effect';
import { gradientAtPosition, GradientType } from '../../src/Gradients';
import { ParticleSet } from '../../src/Governor';
import { distanceV2, mixColor, randomNumber } from '../../src/math';
import type { AnchorRect } from '../../src/Stage';
import type { EffectContext, TickContext, TimedContext, Vector3 } from '../../src/types';
import type { RainContext } from '../contracts';
import { Droplet, type DropletGradientType } from './Droplet';
import { FallParticle } from './FallParticle';
import { PageWalls, type PageStop } from './PageWalls';
import { PageWater } from './PageWater';

export interface RainOptions {
    /** Droplets at full budget. The original used 500. */
    dropCount?: number;
    gradient?: GradientType;
    /** Height of the landing band at the bottom of the stage. 0 lets rain fall off-screen. */
    groundBand?: number;
    /** Overall strength of the layer, 0..1. Lower it when text sits on top. */
    opacity?: number;
    /** Let rain meet elements tagged "ledge": stop on them, pool, drip. False ignores the page. Default true. */
    pageInteraction?: boolean;
}

const DROP_TEX_W = 16;
const DROP_TEX_H = 64;
const DOT_TEX = 16;

/**
 * The original Rain, drawn with Pixi.
 *
 * What it listens to:
 *   - `rainEater` (a Three.js effect): droplets within its eat distance are eaten, exactly
 *     as before; the rain reports them with a `rain:eaten` event so the eater can react.
 *   - the force field: attraction, wind and shock rings from any effect bend the rain.
 *   - the page: DOM anchors tagged "ledge" are walls for half the droplets (see PageWalls).
 *     Stopped water pools on the element (see PageWater), hangs from its underside and
 *     runs down its sides, then falls again.
 */
export class Rain extends Effect<RainContext> {
    public effectName: string = 'rain';

    public static readonly NEW_DROPS_PER_TICK = 10;
    public static readonly MIN_Y_POSITION = -100;
    public static readonly MAX_Y_POSITION = -50;

    public static readonly MIN_DROP_WIDTH = 1;
    public static readonly MAX_DROP_WIDTH = 3;
    public static readonly MIN_DROP_HEIGHT = 3;
    public static readonly MAX_DROP_HEIGHT = 36;
    public static readonly MIN_DROP_VELOCITY_X = -0.02;
    public static readonly MAX_DROP_VELOCITY_X = 0.02;
    public static readonly MIN_DROP_VELOCITY_Y = 0.1;
    public static readonly MAX_DROP_VELOCITY_Y = 0.5;
    public static readonly MIN_DROP_ACCELERATION = 0;
    public static readonly MAX_DROP_ACCELERATION = 0.001;
    public static readonly DROP_COUNT = 500;
    public static readonly PARTICLES_PER_FALLING_DROP = 5;
    /** Share of droplets that meet page elements; the rest pass behind them. */
    public static readonly INTERACTIVE_SHARE = 0.5;
    /** Size of a droplet that lets go of an element: bigger than most rain. */
    public static readonly DETACHED_SIZE: Vector3 = { x: 3.6, y: 8 };

    private readonly drops: ParticleSet<Droplet>;
    public readonly fallParticles: ParticleSet<FallParticle>;
    private currentDropletGradientType: DropletGradientType;

    private container!: ParticleContainer;
    private atlas!: Texture;
    private dropTexture!: Texture;
    private dotTexture!: Texture;
    private readonly viewPool: PixiParticle[] = [];
    private readonly scratch: Vector3 = { x: 0, y: 0 };
    private readonly ledges: AnchorRect[] = [];
    private readonly walls = new PageWalls();
    private readonly water: PageWater;
    private readonly pageInteraction: boolean;
    private readonly context: RainContext;
    private readonly opacity: number;

    constructor(options: RainOptions = {}) {
        super();
        this.opacity = options.opacity ?? 1;
        this.pageInteraction = options.pageInteraction ?? true;
        this.currentDropletGradientType = options.gradient ?? Droplet.DEFAULT_GRADIENT_TYPE;
        if (options.groundBand !== undefined) {
            Droplet.groundBand = options.groundBand;
        }
        const release = (particle: Droplet | FallParticle): void => this.releaseView(particle);
        this.drops = new ParticleSet<Droplet>({
            capacity: options.dropCount ?? Rain.DROP_COUNT,
            exitDuration: 380,
            maxBirthsPerTick: Rain.NEW_DROPS_PER_TICK,
            maxExitsPerTick: 14,
            onRemove: release,
        });
        this.fallParticles = new ParticleSet<FallParticle>({
            capacity: (options.dropCount ?? Rain.DROP_COUNT) * 2,
            exitDuration: 160,
            maxBirthsPerTick: 400,
            maxExitsPerTick: 40,
            onRemove: release,
        });
        this.water = new PageWater({
            acquireBead: () => this.acquireView(this.dotTexture),
            acquireTail: () => this.acquireView(this.dropTexture),
            release: (view) => this.releasePixiView(view),
            spawnDroplet: (x, headY, water, velocityY) => this.spawnDetached(x, headY, water, velocityY),
        });
        this.context = { drops: this.drops.items, dropCount: 0, eaten: 0, landed: 0, pooled: 0, dripping: 0 };
    }

    public initialize(): void {
        this.atlas = Texture.from(drawAtlas());
        this.dropTexture = new Texture({ source: this.atlas.source, frame: new Rectangle(0, 0, DROP_TEX_W, DROP_TEX_H) });
        this.dotTexture = new Texture({
            source: this.atlas.source,
            frame: new Rectangle(DROP_TEX_W, 0, DOT_TEX, DOT_TEX),
        });
        this.container = new ParticleContainer({
            texture: this.dropTexture,
            dynamicProperties: { position: true, rotation: true, vertex: true, color: true, uvs: true },
        });
        this.container.blendMode = 'add';
        this.container.alpha = this.opacity;
        this.host.pixi.addChild(this.container);
    }

    public setDropletGradientType(gradientType: DropletGradientType): void {
        this.currentDropletGradientType = gradientType;
        for (const d of this.drops.items) {
            d.setGradientType(gradientType);
        }
    }

    /** How many droplets to aim for at full budget. */
    public setDropTarget(targetDropCount: number): void {
        this.drops.capacity = Math.max(0, Math.floor(targetDropCount));
        this.fallParticles.capacity = this.drops.capacity * 2;
    }

    private createNewDrops(tickContext: TickContext): void {
        const width = tickContext.canvasDimensions?.x ?? 0;
        for (let i = 0; i < Rain.NEW_DROPS_PER_TICK && this.drops.canSpawn(); i++) {
            // Near drops are bigger, faster and brighter; far ones are the first the governor lets go.
            const depth = Math.random();
            const scale = 0.55 + depth * 0.85;
            const x = randomNumber(0, width);
            const y = randomNumber(Rain.MIN_Y_POSITION, Rain.MAX_Y_POSITION);
            const sizeX = randomNumber(Rain.MIN_DROP_WIDTH, Rain.MAX_DROP_WIDTH) * scale;
            const sizeY = randomNumber(Rain.MIN_DROP_HEIGHT, Rain.MAX_DROP_HEIGHT) * scale;
            const velocityX = randomNumber(Rain.MIN_DROP_VELOCITY_X, Rain.MAX_DROP_VELOCITY_X);
            const velocityY = randomNumber(Rain.MIN_DROP_VELOCITY_Y, Rain.MAX_DROP_VELOCITY_Y) * (0.65 + depth * 0.6);
            const droplet = new Droplet({
                position: { x, y },
                velocity: { x: velocityX, y: velocityY },
                size: { x: sizeX, y: sizeY },
                acceleration: { x: 0, y: randomNumber(Rain.MIN_DROP_ACCELERATION, Rain.MAX_DROP_ACCELERATION) },
                maxAbsoluteVelocity: { x: 0.7, y: 1.1 },
                priority: 3 + Math.round(depth * 4),
            });
            droplet.depth = depth;
            droplet.water = (sizeX * sizeY) / Droplet.AVERAGE_AREA;
            if (this.pageInteraction) {
                droplet.rollInteraction(Rain.INTERACTIVE_SHARE);
            }
            droplet.alpha = 0.3 + depth * 0.65;
            droplet.setGradientType(this.currentDropletGradientType);
            droplet.view = this.acquireView(this.dropTexture);
            this.drops.add(droplet);
        }
    }

    public onTick(tickContext: TickContext): EffectContext<RainContext> {
        const drops = this.drops;
        const dims = tickContext.canvasDimensions;
        const width = dims?.x ?? 0;

        drops.govern(tickContext);
        this.fallParticles.govern(tickContext);

        const ledges = this.ledges;
        ledges.length = 0;
        for (const anchor of tickContext.stage.allAnchors) {
            if (this.pageInteraction && anchor.visible && anchor.tags.includes('ledge')) {
                ledges.push(anchor);
            }
        }

        // Water that lets go of an element is born first, so the birth budget cannot starve it.
        this.water.tick(tickContext, ledges);
        this.createNewDrops(tickContext);


        const rainEaterContext = tickContext.read('rainEater');
        const eaterHead = rainEaterContext?.headPosition;
        const eatDistance = rainEaterContext?.eatDistance ?? 0;
        const eaterHungry = eaterHead !== undefined && rainEaterContext?.exploded === false;

        let eaten = 0;
        let eatenX = 0;
        let eatenY = 0;
        let landed = 0;
        let landedPoints: Vector3[] | undefined;
        const force = this.scratch;
        const dt = tickContext.timeDelta;

        for (let i = 0; i < drops.items.length; i++) {
            const droplet = drops.items[i];
            if (droplet.life === 'removed') {
                continue;
            }

            if (eaterHungry && droplet.life === 'alive' && distanceV2(droplet.position, eaterHead) < eatDistance) {
                eaten++;
                eatenX += droplet.position.x;
                eatenY += droplet.position.y;
                this.onDropDestroy(droplet, tickContext, eaterHead);
                droplet.removeNow();
                continue;
            }

            // Whatever any effect put in the field bends the rain, whichever renderer that effect uses.
            tickContext.forces.sample(droplet.position.x, droplet.position.y + droplet.size.y, force);
            droplet.velocity.x += force.x * dt;
            droplet.velocity.y += force.y * dt;

            const dropletContext = droplet.onTick(tickContext);

            const stop = droplet.life === 'alive' && ledges.length > 0 ? this.walls.meet(droplet, ledges, dt) : undefined;
            if (stop) {
                if (stop.edge === 'top' || stop.edge === 'inside') {
                    landed++;
                    landedPoints = notePoint(landedPoints, droplet);
                }
                this.onStopped(droplet, stop, tickContext);
                droplet.removeNow();
                continue;
            }

            if (dropletContext.effectContext.fallen) {
                // With a ground band the drop splashes; without one it is already off-screen.
                if (Droplet.groundBand > 0) {
                    landedPoints = notePoint(landedPoints, droplet);
                    this.onDropDestroy(droplet, tickContext);
                }
                droplet.removeNow();
            } else if (droplet.position.x < -120 || droplet.position.x > width + 120) {
                droplet.removeNow();
            }
        }

        for (let i = 0; i < this.fallParticles.items.length; i++) {
            const fallParticle = this.fallParticles.items[i];
            const fallParticleContext = fallParticle.onTick(tickContext);
            if (fallParticleContext.effectContext.remove) {
                fallParticle.removeNow();
            }
        }

        drops.sweep(tickContext);
        this.fallParticles.sweep(tickContext);

        if (eaten > 0) {
            tickContext.emit('rain:eaten', { count: eaten, x: eatenX / eaten, y: eatenY / eaten });
        }

        if (landedPoints) {
            tickContext.emit('rain:landed', { points: landedPoints });
        }

        this.context.dropCount = drops.items.length;
        this.context.eaten = eaten;
        this.context.landed = landed;
        this.context.pooled = this.water.pooled;
        this.context.dripping = this.water.dripping;
        return this.publish(this.context);
    }

    /** A droplet was stopped by an element: pool its water and show what happened where it stopped. */
    private onStopped(droplet: Droplet, stop: PageStop, tickContext: TickContext): void {
        const rect = stop.rect;
        this.water.add(rect, droplet.water);
        switch (stop.edge) {
            case 'top':
                this.onDropDestroy(droplet, tickContext);
                break;
            case 'left':
            case 'right': {
                const side = stop.edge === 'left' ? -1 : 1;
                this.onDropDestroy(droplet, tickContext, undefined, side);
                this.water.runOnSide(rect, side, droplet.position.y + droplet.size.y, droplet.water * 0.5);
                break;
            }
            case 'bottom':
                this.onDropDestroy(droplet, tickContext, undefined, 0);
                break;
            case 'inside':
                // Behind the element nothing would show, so the page answers instead.
                tickContext.emit('page:hit', {
                    x: droplet.position.x + droplet.size.x / 2,
                    y: droplet.position.y + droplet.size.y,
                    anchor: rect.name,
                    edge: false,
                    kind: 'rain',
                });
                break;
        }
    }

    /** A drop of pooled water lets go and falls. It can be caught by an element further down. */
    private spawnDetached(centerX: number, headY: number, water: number, velocityY: number): boolean {
        if (!this.drops.canSpawn()) {
            return false;
        }
        const size = Rain.DETACHED_SIZE;
        const droplet = new Droplet({
            position: { x: centerX - size.x / 2, y: headY - size.y },
            velocity: { x: 0, y: velocityY },
            size: { x: size.x, y: size.y },
            acceleration: { x: 0, y: 0.0012 },
            maxAbsoluteVelocity: { x: 0.7, y: 1.1 },
            priority: 8,
        });
        droplet.depth = 0.9;
        droplet.alpha = 1;
        droplet.water = water;
        droplet.rollInteraction(1);
        droplet.setGradientType(this.currentDropletGradientType);
        droplet.view = this.acquireView(this.dropTexture);
        this.drops.add(droplet);
        return true;
    }

    /**
     * Splash specks. A number for `away` makes it the small splash of a stop against an element's side or underside:
     * thrown out from the element (-1 left, 1 right, 0 either way) instead of up.
     */
    private onDropDestroy(droppedDroplet: Droplet, tickContext: TickContext, toward?: Vector3, away?: number): void {
        const tint = mixColor(
            gradientAtPosition(droppedDroplet.gradientType, droppedDroplet.position, tickContext.time, tickContext.theme),
            0xffffff,
            0.35,
        );
        const x = droppedDroplet.position.x;
        const y = droppedDroplet.position.y + droppedDroplet.size.y;
        // Fewer specks for far drops, and none at all once the governor says the stage is full.
        const full = Math.max(1, Math.round(Rain.PARTICLES_PER_FALLING_DROP * (0.4 + droppedDroplet.depth * 0.6)));
        const count = away === undefined ? full : Math.max(1, Math.ceil(full / 2));
        for (let i = 0; i < count && this.fallParticles.canSpawn(); i++) {
            const randomSize = 0.8 + Math.random() * 2.2 * (0.5 + droppedDroplet.depth * 0.6);
            const fallParticle = new FallParticle({
                position: { x, y },
                size: { x: randomSize, y: randomSize },
                // Eaten drops are drawn inward; landed drops splash up.
                velocity: away !== undefined
                    ? { x: (away === 0 ? randomNumber(-1, 1) : away) * randomNumber(0.03, 0.11), y: randomNumber(-0.14, -0.02) }
                    : toward
                    ? {
                          x: (toward.x - x) * 0.0012 + randomNumber(-0.04, 0.04),
                          y: (toward.y - y) * 0.0012 + randomNumber(-0.04, 0.04),
                      }
                    : undefined,
                acceleration: toward ? { x: 0, y: 0 } : undefined,
            });
            fallParticle.tint = tint;
            fallParticle.alpha = 0.5 + droppedDroplet.depth * 0.5;
            fallParticle.view = this.acquireView(this.dotTexture);
            this.fallParticles.add(fallParticle);
        }
    }

    public onRender(timedContext: TimedContext): void {
        const lead = timedContext.alpha * timedContext.tickDelta;
        const time = timedContext.time;
        const theme = timedContext.theme;

        const drops = this.drops.items;
        for (let i = 0; i < drops.length; i++) {
            const droplet = drops[i];
            const view = droplet.view;
            if (!view) {
                continue;
            }
            const vx = droplet.velocity.x;
            const vy = droplet.velocity.y;
            view.x = droplet.position.x + droplet.size.x / 2 + vx * lead;
            view.y = droplet.position.y + droplet.size.y + vy * lead;
            // The head leads: the texture's round end points along the velocity.
            view.rotation = Math.atan2(-vx, vy);
            view.scaleX = (droplet.size.x * 2.2) / DROP_TEX_W;
            view.scaleY = (droplet.size.y * 1.5) / DROP_TEX_H;
            view.tint = gradientAtPosition(droplet.gradientType, droplet.position, time, theme);
            view.alpha = droplet.alpha * (1 - droplet.exitProgress);
        }

        this.water.onRender(timedContext, this.currentDropletGradientType);

        const specks = this.fallParticles.items;
        for (let i = 0; i < specks.length; i++) {
            const speck = specks[i];
            const view = speck.view;
            if (!view) {
                continue;
            }
            view.x = speck.position.x + speck.velocity.x * lead;
            view.y = speck.position.y + speck.velocity.y * lead;
            const scale = (speck.size.x * 2.4) / DOT_TEX;
            view.scaleX = scale;
            view.scaleY = scale;
            view.tint = speck.tint;
            view.alpha = Math.max(0, speck.alpha) * (1 - speck.exitProgress);
        }
    }

    public cleanup(): void {
        this.drops.clear();
        this.fallParticles.clear();
        this.water.clear();
        this.viewPool.length = 0;
        this.container?.destroy();
        this.dropTexture?.destroy();
        this.dotTexture?.destroy();
        this.atlas?.destroy(true);
    }

    private acquireView(texture: Texture): PixiParticle {
        let view = this.viewPool.pop();
        if (view) {
            view.texture = texture;
        } else {
            view = new PixiParticle({ texture });
        }
        if (texture === this.dropTexture) {
            view.anchorX = 0.5;
            view.anchorY = 1;
        } else {
            view.anchorX = 0.5;
            view.anchorY = 0.5;
        }
        view.rotation = 0;
        view.alpha = 0;
        this.container.addParticle(view);
        return view;
    }

    private releaseView(particle: Droplet | FallParticle): void {
        const view = particle.view;
        if (!view) {
            return;
        }
        particle.view = undefined;
        this.releasePixiView(view);
    }

    private releasePixiView(view: PixiParticle): void {
        this.container.removeParticle(view);
        this.viewPool.push(view);
    }
}

function notePoint(points: Vector3[] | undefined, droplet: Droplet): Vector3[] | undefined {
    const list = points ?? [];
    if (list.length < 16) {
        list.push({ x: droplet.position.x, y: droplet.position.y + droplet.size.y });
    }
    return list;
}

/**
 * One small texture for everything the rain draws: a teardrop (the original triangle with
 * a round end, softened) and a soft dot for splashes.
 */
function drawAtlas(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = DROP_TEX_W + DOT_TEX;
    canvas.height = DROP_TEX_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return canvas;
    }

    const cx = DROP_TEX_W / 2;
    const r = 3.2;
    const headY = DROP_TEX_H - r - 2;
    const fade = ctx.createLinearGradient(0, 2, 0, DROP_TEX_H);
    fade.addColorStop(0, 'rgba(255,255,255,0)');
    fade.addColorStop(0.55, 'rgba(255,255,255,0.4)');
    fade.addColorStop(1, 'rgba(255,255,255,1)');
    ctx.fillStyle = fade;
    ctx.beginPath();
    ctx.moveTo(cx, 2);
    ctx.lineTo(cx + r, headY);
    ctx.arc(cx, headY, r, 0, Math.PI);
    ctx.lineTo(cx, 2);
    ctx.closePath();
    ctx.fill();

    const dot = ctx.createRadialGradient(
        DROP_TEX_W + DOT_TEX / 2,
        DOT_TEX / 2,
        0,
        DROP_TEX_W + DOT_TEX / 2,
        DOT_TEX / 2,
        DOT_TEX / 2,
    );
    dot.addColorStop(0, 'rgba(255,255,255,1)');
    dot.addColorStop(0.45, 'rgba(255,255,255,0.55)');
    dot.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = dot;
    ctx.fillRect(DROP_TEX_W, 0, DOT_TEX, DOT_TEX);
    return canvas;
}
