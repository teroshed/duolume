// Pixi builds its uniform-sync code with `new Function` unless this polyfill is loaded.
// Loading it here keeps the engine usable under a `script-src 'self'` content security policy.
import 'pixi.js/unsafe-eval';
import { autoDetectRenderer, Container, type Renderer as PixiRenderer } from 'pixi.js';
import {
    BufferGeometry,
    Camera,
    CanvasTexture,
    Color,
    Float32BufferAttribute,
    HalfFloatType,
    LinearFilter,
    Mesh,
    NoColorSpace,
    Scene,
    ShaderMaterial,
    UnsignedByteType,
    Vector2,
    Vector3 as ThreeVector3,
    Vector4,
    WebGLRenderer,
    WebGLRenderTarget,
    type IUniform,
    type Texture,
    type TextureDataType,
} from 'three';
import type { Shock } from './ForceField';
import {
    BACKGROUND_GLSL,
    BLOOM_DOWN_FRAGMENT,
    BLOOM_UP_FRAGMENT,
    COMBINE_FRAGMENT,
    FINAL_FRAGMENT,
    FULLSCREEN_VERTEX,
    PIXI_SAMPLE_GLSL,
} from './shaders';
import type { Stage } from './Stage';
import type { Theme } from './types';

export interface CompositorOptions {
    /** Upper bound on devicePixelRatio. Default 2. */
    maxPixelRatio?: number;
    /** Glow pass. Default true. */
    bloom?: boolean;
    /** Multisample the Three.js scene. Default true. */
    antialias?: boolean;
    bloomStrength?: number;
}

/**
 * The other renderer's pixels, made available to effects.
 *
 * `behind` is a set of uniform holders — spread it into a ShaderMaterial's uniforms and
 * include `glsl.background` + `glsl.pixiSample` to read "what is behind this fragment":
 * the backdrop and the Pixi layer, at any screen position. Holders are shared by
 * reference, so the compositor keeps every material current without touching it.
 */
export interface Surfaces {
    readonly behind: Readonly<Record<string, IUniform>>;
    readonly glsl: { readonly background: string; readonly pixiSample: string };
    /** Where the backdrop pools its light, in stage pixels. Any effect may steer it. */
    readonly focus: { x: number; y: number; strength: number };
    /**
     * Brief ambient light over the whole backdrop. Effects add to `value` in `onRender`;
     * it is cleared after every frame, so a flash lasts exactly as long as something keeps adding it.
     */
    readonly flash: { value: number };
}

/**
 * Runs Pixi and Three.js as one picture.
 *
 * Each library keeps its own WebGL context — the supported, version-proof arrangement —
 * and they meet in two places:
 *
 *   Pixi → Three   The Pixi canvas is uploaded as a texture every frame. Three.js
 *                  materials can sample it (glass refracts the 2D layer behind it), and
 *                  the final composite draws it under and over the 3D scene.
 *   Three → Pixi   Through the simulation (contexts, forces, events) and through the
 *                  composite, which bends the 2D layer wherever a shock ring passes.
 *
 * Frame order: Pixi back layer → upload → [Pixi front layer → upload] → Three.js scene
 * into an HDR target → combine → bloom → tone, dither, encode to the visible canvas.
 */
export class Compositor {
    public readonly pixi: PixiRenderer;
    public readonly pixiBack = new Container();
    public readonly pixiFront = new Container();
    public readonly three: WebGLRenderer;
    public readonly scene = new Scene();
    public readonly surfaces: Surfaces;
    public lost = false;
    public onLostChange?: (lost: boolean) => void;
    /**
     * Viewer comfort, applied on top of whatever the effects ask for. Each is a multiplier:
     * `flash` on ambient flashes, `ripple` on how far shock rings bend the picture, `bloom` on glow.
     * The simulation is untouched; only how hard it hits the eye changes.
     */
    public readonly comfort = { flash: 1, ripple: 1, bloom: 1 };
    private readonly bloomStrength: number;

    private readonly stage: Stage;
    private readonly bloomEnabled: boolean;
    private readonly maxPixelRatio: number;
    private pixelRatio = 1;

    private readonly texBack: CanvasTexture;
    private readonly texFront: CanvasTexture;
    private readonly sceneTarget: WebGLRenderTarget;
    private readonly combineTarget: WebGLRenderTarget;
    private readonly bloomDown: WebGLRenderTarget[] = [];
    private readonly bloomUp: WebGLRenderTarget[] = [];

    private readonly fsScene = new Scene();
    private readonly fsCamera = new Camera();
    private readonly fsMesh: Mesh<BufferGeometry, ShaderMaterial>;
    private readonly combineMaterial: ShaderMaterial;
    private readonly downMaterial: ShaderMaterial;
    private readonly upMaterial: ShaderMaterial;
    private readonly finalMaterial: ShaderMaterial;

    private readonly uniforms: {
        uPixiBack: IUniform<Texture>;
        uResolution: IUniform<Vector2>;
        uBgTop: IUniform<Color>;
        uBgBottom: IUniform<Color>;
        uGlowA: IUniform<Color>;
        uGlowB: IUniform<Color>;
        uFxTime: IUniform<number>;
        uFxAspect: IUniform<number>;
        uBgScroll: IUniform<number>;
        uBgFocus: IUniform<ThreeVector3>;
        uBgFlash: IUniform<number>;
    };
    private readonly abort = new AbortController();

    public static async create(
        canvas: HTMLCanvasElement,
        stage: Stage,
        options: CompositorOptions = {},
    ): Promise<Compositor> {
        const pixi = await autoDetectRenderer({
            preference: 'webgl',
            width: 2,
            height: 2,
            resolution: 1,
            backgroundAlpha: 0,
            antialias: false,
            autoDensity: false,
            hello: false,
            powerPreference: 'high-performance',
        });
        return new Compositor(canvas, stage, pixi, options);
    }

    private constructor(canvas: HTMLCanvasElement, stage: Stage, pixi: PixiRenderer, options: CompositorOptions) {
        this.stage = stage;
        this.pixi = pixi;
        this.bloomEnabled = options.bloom ?? true;
        this.maxPixelRatio = options.maxPixelRatio ?? 2;
        this.bloomStrength = this.bloomEnabled ? (options.bloomStrength ?? 0.55) : 0;

        this.three = new WebGLRenderer({
            canvas,
            alpha: false,
            antialias: false,
            depth: false,
            stencil: false,
            powerPreference: 'high-performance',
        });
        this.three.autoClear = false;
        this.three.setClearColor(0x000000, 0);

        const pixiCanvas = pixi.canvas as HTMLCanvasElement;
        this.texBack = makeLayerTexture(pixiCanvas);
        this.texFront = makeLayerTexture(pixiCanvas);

        // RGBA16F keeps highlights above 1.0 for the bloom; fall back to 8-bit where it can't be rendered to.
        const hdr = this.three.extensions.has('EXT_color_buffer_float') || this.three.extensions.has('EXT_color_buffer_half_float');
        const type: TextureDataType = hdr ? HalfFloatType : UnsignedByteType;
        const samples = (options.antialias ?? true) ? 4 : 0;

        this.sceneTarget = new WebGLRenderTarget(2, 2, { type, samples, depthBuffer: true });
        this.combineTarget = new WebGLRenderTarget(2, 2, { type, depthBuffer: false });
        for (let i = 0; i < 3; i++) {
            this.bloomDown.push(new WebGLRenderTarget(2, 2, { type, depthBuffer: false }));
        }
        for (let i = 0; i < 2; i++) {
            this.bloomUp.push(new WebGLRenderTarget(2, 2, { type, depthBuffer: false }));
        }

        this.uniforms = {
            uPixiBack: { value: this.texBack },
            uResolution: { value: new Vector2(2, 2) },
            uBgTop: { value: new Color() },
            uBgBottom: { value: new Color() },
            uGlowA: { value: new Color() },
            uGlowB: { value: new Color() },
            uFxTime: { value: 0 },
            uFxAspect: { value: 1 },
            uBgScroll: { value: 0 },
            uBgFocus: { value: new ThreeVector3(0.5, 0.5, 0) },
            uBgFlash: { value: 0 },
        };
        this.surfaces = {
            behind: this.uniforms,
            glsl: { background: BACKGROUND_GLSL, pixiSample: PIXI_SAMPLE_GLSL },
            focus: { x: 0, y: 0, strength: 0 },
            flash: { value: 0 },
        };

        this.combineMaterial = fullscreenMaterial(COMBINE_FRAGMENT, {
            ...this.uniforms,
            uScene: { value: this.sceneTarget.texture },
            uPixiFront: { value: this.texFront },
            uHasFront: { value: 0 },
            uStage: { value: new Vector2(1, 1) },
            uShock: { value: [new Vector4(), new Vector4(), new Vector4(), new Vector4()] },
            uShockWidth: { value: [1, 1, 1, 1] },
        });
        this.downMaterial = fullscreenMaterial(BLOOM_DOWN_FRAGMENT, {
            uSource: { value: null },
            uHalfPixel: { value: new Vector2() },
            uThreshold: { value: 0 },
        });
        this.upMaterial = fullscreenMaterial(BLOOM_UP_FRAGMENT, {
            uSource: { value: null },
            uAdd: { value: null },
            uHalfPixel: { value: new Vector2() },
        });
        this.finalMaterial = fullscreenMaterial(FINAL_FRAGMENT, {
            uCombined: { value: this.combineTarget.texture },
            uBloom: { value: this.bloomUp[1].texture },
            uBloomStrength: { value: this.bloomStrength },
            uVignette: { value: 0.55 },
            uFxTime: this.uniforms.uFxTime,
        });

        const triangle = new BufferGeometry();
        triangle.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
        this.fsMesh = new Mesh(triangle, this.combineMaterial);
        this.fsMesh.frustumCulled = false;
        this.fsScene.add(this.fsMesh);

        const signal = this.abort.signal;
        const setLost = (lost: boolean) => (event: Event) => {
            if (lost) {
                event.preventDefault();
            }
            this.lost = lost;
            if (!lost) {
                this.texBack.needsUpdate = true;
                this.texFront.needsUpdate = true;
            }
            this.onLostChange?.(lost);
        };
        canvas.addEventListener('webglcontextlost', setLost(true), { signal });
        canvas.addEventListener('webglcontextrestored', setLost(false), { signal });
        pixiCanvas.addEventListener('webglcontextlost', setLost(true), { signal });
        pixiCanvas.addEventListener('webglcontextrestored', setLost(false), { signal });
    }

    /** Device pixels per CSS pixel in use. */
    public get resolution(): number {
        return this.pixelRatio;
    }

    public setTheme(theme: Theme): void {
        // Color.setHex converts the sRGB hex into the linear working space.
        this.uniforms.uBgTop.value.setHex(theme.bgTop);
        this.uniforms.uBgBottom.value.setHex(theme.bgBottom);
        this.uniforms.uGlowA.value.setHex(theme.glowA);
        this.uniforms.uGlowB.value.setHex(theme.glowB);
    }

    public resize(width: number, height: number): void {
        const ratio = Math.min(globalThis.devicePixelRatio || 1, this.maxPixelRatio);
        this.pixelRatio = ratio;
        const pw = Math.max(2, Math.round(width * ratio));
        const ph = Math.max(2, Math.round(height * ratio));

        this.pixi.resize(width, height, ratio);
        this.three.setPixelRatio(1);
        this.three.setSize(pw, ph, false);

        // The layer textures are sized to the Pixi canvas; drop the GPU copies so they are reallocated.
        this.texBack.dispose();
        this.texFront.dispose();

        this.sceneTarget.setSize(pw, ph);
        this.combineTarget.setSize(pw, ph);
        let bw = pw;
        let bh = ph;
        for (let i = 0; i < this.bloomDown.length; i++) {
            bw = Math.max(2, Math.ceil(bw / 2));
            bh = Math.max(2, Math.ceil(bh / 2));
            this.bloomDown[i].setSize(bw, bh);
            if (i < this.bloomUp.length) {
                this.bloomUp[this.bloomUp.length - 1 - i].setSize(bw, bh);
            }
        }

        this.uniforms.uResolution.value.set(pw, ph);
        this.uniforms.uFxAspect.value = width / height;
        (this.combineMaterial.uniforms.uStage.value as Vector2).set(width, height);
    }

    /** Draw one frame. `timeSeconds` is the simulation clock. */
    public render(timeSeconds: number, shocks: readonly Shock[], scrollY: number): void {
        if (this.lost) {
            return;
        }
        const three = this.three;
        const stage = this.stage;

        // 1. Pixi, behind. Upload at once: the front layer reuses the same canvas next.
        this.pixi.render({ container: this.pixiBack });
        this.texBack.needsUpdate = true;
        three.initTexture(this.texBack);

        // 2. Pixi, in front — only when some effect actually put something there.
        const hasFront = hasVisibleContent(this.pixiFront);
        if (hasFront) {
            this.pixi.render({ container: this.pixiFront });
            this.texFront.needsUpdate = true;
            three.initTexture(this.texFront);
        }

        const u = this.uniforms;
        u.uFxTime.value = timeSeconds;
        u.uBgScroll.value = (scrollY / Math.max(1, stage.height)) * 0.12;
        const focus = this.surfaces.focus;
        u.uBgFocus.value.set(focus.x / stage.width, 1 - focus.y / stage.height, focus.strength);
        u.uBgFlash.value = Math.min(1.5, this.surfaces.flash.value) * this.comfort.flash;
        this.finalMaterial.uniforms.uBloomStrength.value = this.bloomStrength * this.comfort.bloom;
        this.surfaces.flash.value = 0;

        const cu = this.combineMaterial.uniforms;
        cu.uHasFront.value = hasFront ? 1 : 0;
        const shockUniforms = cu.uShock.value as Vector4[];
        const shockWidths = cu.uShockWidth.value as number[];
        for (let i = 0; i < 4; i++) {
            const s = shocks[i];
            if (s) {
                const amplitude = s.fade * 26 * Math.min(2, s.strength / 0.004) * this.comfort.ripple;
                shockUniforms[i].set(s.x, s.y, s.radius, amplitude);
                shockWidths[i] = s.width;
            } else {
                shockUniforms[i].set(0, 0, 0, 0);
            }
        }

        // 3. The Three.js scene, into an HDR target. Its materials may sample the Pixi layer.
        three.setRenderTarget(this.sceneTarget);
        three.clear(true, true, false);
        three.render(this.scene, stage.camera);

        // 4. Backdrop + Pixi + Three + Pixi.
        this.pass(this.combineMaterial, this.combineTarget);

        // 5. Glow.
        if (this.bloomEnabled) {
            const down = this.bloomDown;
            const up = this.bloomUp;
            const du = this.downMaterial.uniforms;
            let source: WebGLRenderTarget = this.combineTarget;
            for (let i = 0; i < down.length; i++) {
                du.uSource.value = source.texture;
                (du.uHalfPixel.value as Vector2).set(0.5 / source.width, 0.5 / source.height);
                du.uThreshold.value = i === 0 ? 0.62 : 0;
                this.pass(this.downMaterial, down[i]);
                source = down[i];
            }
            const uu = this.upMaterial.uniforms;
            // up[0] is quarter size: blur(down[2]) + down[1]. up[1] is half size: blur(up[0]) + down[0].
            uu.uSource.value = down[2].texture;
            uu.uAdd.value = down[1].texture;
            (uu.uHalfPixel.value as Vector2).set(0.5 / down[2].width, 0.5 / down[2].height);
            this.pass(this.upMaterial, up[0]);
            uu.uSource.value = up[0].texture;
            uu.uAdd.value = down[0].texture;
            (uu.uHalfPixel.value as Vector2).set(0.5 / up[0].width, 0.5 / up[0].height);
            this.pass(this.upMaterial, up[1]);
        }

        // 6. To the screen.
        this.pass(this.finalMaterial, null);
    }

    public dispose(): void {
        this.abort.abort();
        this.texBack.dispose();
        this.texFront.dispose();
        this.sceneTarget.dispose();
        this.combineTarget.dispose();
        for (const target of [...this.bloomDown, ...this.bloomUp]) {
            target.dispose();
        }
        this.fsMesh.geometry.dispose();
        this.combineMaterial.dispose();
        this.downMaterial.dispose();
        this.upMaterial.dispose();
        this.finalMaterial.dispose();
        this.three.dispose();
        // Hand the GPU context back now rather than whenever the canvas is collected.
        this.three.forceContextLoss();
        this.pixiBack.destroy({ children: true });
        this.pixiFront.destroy({ children: true });
        // Not destroy(true): in Pixi 8.20 that also clears pools shared with other Pixi canvases on the page.
        this.pixi.destroy();
    }

    private pass(material: ShaderMaterial, target: WebGLRenderTarget | null): void {
        this.fsMesh.material = material;
        this.three.setRenderTarget(target);
        this.three.render(this.fsScene, this.fsCamera);
    }
}

function makeLayerTexture(canvas: HTMLCanvasElement): CanvasTexture {
    const texture = new CanvasTexture(canvas);
    texture.generateMipmaps = false;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    // The Pixi canvas already holds premultiplied sRGB; shaders convert it (see fxPixi).
    texture.premultiplyAlpha = true;
    texture.colorSpace = NoColorSpace;
    return texture;
}

function fullscreenMaterial(fragmentShader: string, uniforms: Record<string, IUniform>): ShaderMaterial {
    return new ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader,
        uniforms,
        depthTest: false,
        depthWrite: false,
    });
}

function hasVisibleContent(root: Container): boolean {
    for (const layer of root.children) {
        if (layer.visible && layer.children.length > 0) {
            return true;
        }
    }
    return false;
}
