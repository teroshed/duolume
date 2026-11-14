import { Color, Mesh, PlaneGeometry, ShaderMaterial, Vector2, Vector3 as ThreeVector3, type IUniform } from 'three';
import { Effect } from '../../src/Effect';
import { approach, clamp, randomNumber } from '../../src/math';
import type { EffectContext, TickContext, TimedContext, Vector3 } from '../../src/types';
// Type-only imports bring the shared context/event shapes into the registries.
import type { SingularityContext } from '../contracts';
import { bodyFragment, lensFragment, QUAD_VERTEX } from './shaders';

export interface SingularityOptions {
    /** Where it lives, as fractions of the stage width and height (0..1 each). Default `HOME` ({ x: 0.68, y: 0.36 }). */
    home?: { x: number; y: number };
    /** Radius of the dark disc at zero mass, in pixels, 6..90 (it grows to 2.4 times that when full). Default `RADIUS` (26). */
    radius?: number;
    /** Attraction strength, in px/ms², 0..0.01. 0 = it bends light but moves nothing. Default `PULL` (0.0016). */
    pull?: number;
    /** Swirl strength, in px/ms², -0.01..0.01; negative turns the other way. Default `SPIN` (0.0011). */
    spin?: number;
    /** Grow by feeding and collapse when full. False: nothing feeds it, it stays at its starting size and never collapses. Default true. */
    feed?: boolean;
    /** Drift around its home on a slow loop (once round in 90 seconds). False keeps it there. Default true. */
    wander?: boolean;
}

/** forming: growing in. whole: itself. imploding: full, shrinking to a point. gone: collapsed, waiting to form again. */
type Phase = 'forming' | 'whole' | 'imploding' | 'gone';

/**
 * A small black hole drifting through the scene, drawn with Three.js as two quads that face the
 * camera: a lens that looks through at the backdrop and the Pixi layer and bends them round a
 * dark disc, and on top the disc itself with its ring of light and a tilted band of gas.
 *
 * It pulls and swirls whatever samples the force field and feeds on what happens near it. It
 * grows as it feeds and shrinks back when nothing does. When it has eaten too much it collapses
 * in a flash and a shock ring, and after four to six seconds forms again, small, at another
 * point of its loop.
 *
 * What it listens to:
 *   - the `rain` context: droplets close to the disc fall in and feed it.
 *   - `rainEater:exploded`, `crystal:exploded`, `meteor:impact`, `firework:exploded`,
 *     `lightning:strike`, `bubble:popped` events within 1.5 times its pull range (570 to 870 px):
 *     each feeds it, the rain eater's burst and a big meteor most.
 *   - a press on its disc feeds it by hand (not a press on a button or link).
 *   - the force field: shock rings and wind from the other effects nudge it off its path a little.
 *   - pixels: the lens shows the Pixi layer behind it, bent.
 * What it tells the others: its position, disc radius and mass, and whether it has collapsed
 * (its context); an attraction and a vortex force while it exists; and when it collapses,
 * `singularity:collapsed`, a shock ring and a flash.
 * Keys: `g` moves its home to the pointer.
 */
export class Singularity extends Effect<SingularityContext> {
    public effectName: string = 'singularity';

    public static readonly HOME: Readonly<{ x: number; y: number }> = { x: 0.68, y: 0.36 };
    public static readonly RADIUS = 26;
    public static readonly PULL = 0.0016;
    public static readonly SPIN = 0.0011;

    /** Mass it starts with and leaks back to. */
    public static readonly START_MASS = 0.12;
    /** The disc at full mass is 1 + this times as wide as at none. */
    public static readonly GROWTH = 1.4;
    /** The lens and the quads reach this many disc radii from the centre. */
    public static readonly REACH = 5.2;
    /** Radius of the wander loop, as a share of the smaller stage side, and the time once round it. */
    public static readonly WANDER_RADIUS = 0.18;
    public static readonly WANDER_LOOP_MS = 90000;
    /** How much of the force field's push it feels (it is heavy), and the spring that takes it back to its path. */
    public static readonly NUDGE_WEIGHT = 0.3;
    public static readonly NUDGE_SPRING = 0.000004;

    /** Mass per droplet found near the disc, per tick (a third of the rain is looked at each tick). */
    public static readonly RAIN_FEED = 0.00006;
    public static readonly HAND_FEED = 0.12;
    /** Mass lost per millisecond once nothing has fed it for `LEAK_AFTER_MS`. */
    public static readonly LEAK = 0.000004;
    public static readonly LEAK_AFTER_MS = 1500;

    public static readonly FORM_MS = 1500;
    public static readonly IMPLODE_MS = 300;
    /** How long the ring of light of a collapse stays visible. */
    public static readonly BURST_MS = 700;
    public static readonly GONE_MIN_MS = 4000;
    public static readonly GONE_MAX_MS = 6000;
    public static readonly FLASH_MS = 350;
    public static readonly FLASH_STRENGTH = 0.8;
    public static readonly GULP_MS = 420;

    private readonly baseRadius: number;
    private readonly pull: number;
    private readonly spin: number;
    private readonly feed: boolean;
    private readonly wander: boolean;

    /** Home as fractions of the stage, gliding toward `homeTarget`. */
    private readonly home: Vector3;
    private readonly homeTarget: Vector3;
    private readonly position: Vector3 = { x: 0, y: 0 };
    /** px/ms, measured from the last move: only for leading the picture between ticks. */
    private readonly velocity: Vector3 = { x: 0, y: 0 };
    /** How far the force field has pushed it off its path, and how fast that is changing. */
    private readonly nudge: Vector3 = { x: 0, y: 0 };
    private readonly nudgeVelocity: Vector3 = { x: 0, y: 0 };
    private readonly force: Vector3 = { x: 0, y: 0 };
    private readonly context: SingularityContext;

    private phase: Phase = 'forming';
    private phaseFor = 0;
    private goneFor = 0;
    private pathTime = 0;
    private mass = Singularity.START_MASS;
    /** `mass`, eased: what the size and the pull follow, so a big meal swells it instead of popping it. */
    private shownMass = Singularity.START_MASS;
    private sinceFed = 0;
    /** 1 when it swallows something, decays to 0: the disc pulses. */
    private gulp = 0;
    /** 1 at the collapse, decays to 0. Simulation state: advanced in onTick, only read in onRender. */
    private flash = 0;
    private rainCursor = 0;
    private seeded = false;

    private geometry: PlaneGeometry | undefined;
    private lens: Mesh<PlaneGeometry, ShaderMaterial> | undefined;
    private body: Mesh<PlaneGeometry, ShaderMaterial> | undefined;
    private uniforms: Record<string, IUniform> | undefined;

    constructor(options: SingularityOptions = {}) {
        super();
        this.baseRadius = clamp(options.radius ?? Singularity.RADIUS, 6, 90);
        this.pull = clamp(options.pull ?? Singularity.PULL, 0, 0.01);
        this.spin = clamp(options.spin ?? Singularity.SPIN, -0.01, 0.01);
        this.feed = options.feed ?? true;
        this.wander = options.wander ?? true;
        const home = options.home ?? Singularity.HOME;
        this.home = { x: clamp(Number(home.x) || 0, 0, 1), y: clamp(Number(home.y) || 0, 0, 1) };
        this.homeTarget = { x: this.home.x, y: this.home.y };
        this.context = { position: this.position, radius: 0, mass: this.mass, collapsed: false };
    }

    public initialize(): void {
        const surfaces = this.host.surfaces;
        // One set of uniform holders for both quads: `behind` is what lets the lens see the other layers.
        const uniforms: Record<string, IUniform> = {
            ...surfaces.behind,
            uStage: { value: new Vector2(1, 1) },
            uCentre: { value: new Vector2() },
            uRadius: { value: 0 },
            uReach: { value: 1 },
            uMass: { value: 0 },
            uTimeS: { value: 0 },
            uTurn: { value: 1 },
            uAxis: { value: new Vector2(1, 0) },
            uGlow: { value: 0 },
            uBurst: { value: new ThreeVector3() },
            uAccent: { value: new Color() },
            uAccentAlt: { value: new Color() },
            uInk: { value: new Color() },
        };
        this.uniforms = uniforms;
        this.geometry = new PlaneGeometry(2, 2);

        const quad = (fragmentShader: string, renderOrder: number): Mesh<PlaneGeometry, ShaderMaterial> => {
            const material = new ShaderMaterial({
                uniforms: { ...uniforms },
                vertexShader: QUAD_VERTEX,
                fragmentShader,
                transparent: true,
                premultipliedAlpha: true,
                depthTest: false,
                depthWrite: false,
            });
            const mesh = new Mesh(this.geometry, material);
            mesh.frustumCulled = false;
            mesh.renderOrder = renderOrder;
            mesh.visible = false;
            this.host.three.add(mesh);
            return mesh;
        };
        // The lens replaces the picture behind it, so it is drawn before every other 3D thing
        // (they stay visible on top of it); the disc and its light are drawn after them all.
        this.lens = quad(lensFragment(surfaces.glsl.background, surfaces.glsl.pixiSample), -50);
        this.body = quad(bodyFragment(surfaces.glsl.background), 50);
    }

    public onTick(tick: TickContext): EffectContext<SingularityContext> {
        const dt = tick.timeDelta;
        const mouse = tick.mousePosition;
        const width = tick.stage.width;
        const height = tick.stage.height;

        this.flash = Math.max(0, this.flash - dt / Singularity.FLASH_MS);
        this.gulp = Math.max(0, this.gulp - dt / Singularity.GULP_MS);
        this.phaseFor += dt;
        this.pathTime += dt;

        if (mouse && tick.justPressedKeys.includes('g')) {
            this.homeTarget.x = clamp(mouse.x / width, 0, 1);
            this.homeTarget.y = clamp(mouse.y / height, 0, 1);
        }
        this.home.x = approach(this.home.x, this.homeTarget.x, 2.2, dt);
        this.home.y = approach(this.home.y, this.homeTarget.y, 2.2, dt);

        if (!this.seeded) {
            // The first tick is the first time the stage size is real.
            this.seeded = true;
            this.place(width, height);
        }

        if (this.phase === 'gone') {
            if (this.phaseFor >= this.goneFor) {
                this.formAgain(width, height);
            }
        } else {
            this.move(tick, width, height);
            if (this.phase === 'forming' && this.phaseFor >= Singularity.FORM_MS) {
                this.phase = 'whole';
                this.phaseFor = 0;
            }
            if (this.phase === 'imploding') {
                if (this.phaseFor >= Singularity.IMPLODE_MS) {
                    this.collapse(tick);
                }
            } else if (this.feed) {
                this.eat(tick);
            }
        }

        this.shownMass = approach(this.shownMass, this.mass, 3.5, dt);

        if (this.phase !== 'gone') {
            // Re-added every tick, as every force is. While it forms the pull grows with it.
            const x = this.position.x;
            const y = this.position.y;
            const grown = this.shownMass;
            const strength = (0.6 + 0.9 * grown) * (this.phase === 'forming' ? this.phaseFor / Singularity.FORM_MS : 1);
            if (this.pull > 0) {
                tick.forces.add({ kind: 'attract', owner: this.effectName, x, y, radius: this.pullRange(), strength: this.pull * strength });
            }
            if (this.spin !== 0) {
                tick.forces.add({ kind: 'vortex', owner: this.effectName, x, y, radius: 460 + 220 * grown, strength: this.spin * strength });
            }
        }

        this.context.radius = this.discRadius(0);
        this.context.mass = this.mass;
        this.context.collapsed = this.phase === 'gone';
        return this.publish(this.context);
    }

    public onRender(timed: TimedContext): void {
        if (this.flash > 0) {
            this.host.surfaces.flash.value += this.flash * Singularity.FLASH_STRENGTH;
        }
        const lens = this.lens;
        const body = this.body;
        const uniforms = this.uniforms;
        if (!lens || !body || !uniforms) {
            return;
        }
        const bursting = this.phase === 'gone' && this.phaseFor < Singularity.BURST_MS;
        const visible = this.seeded && (this.phase !== 'gone' || bursting);
        lens.visible = visible && !bursting;
        body.visible = visible;
        if (!visible) {
            return;
        }

        const stage = timed.stage;
        const lead = timed.alpha * timed.tickDelta;
        const x = this.position.x + this.velocity.x * lead;
        const y = this.position.y + this.velocity.y * lead;
        // The quads keep the size of the whole hole while the disc inside them forms or implodes.
        const reach = this.fullRadius() * Singularity.REACH;
        stage.toWorld(x, y, 0, lens.position);
        body.position.copy(lens.position);
        lens.scale.setScalar(reach);
        body.scale.setScalar(reach);

        const timeS = timed.time / 1000;
        const tilt = -0.3 + 0.1 * Math.sin(timeS * 0.07);
        const swallow = Math.sin(Math.PI * this.gulp);
        (uniforms.uStage.value as Vector2).set(stage.width, stage.height);
        (uniforms.uCentre.value as Vector2).set(x, y);
        uniforms.uRadius.value = this.discRadius(lead) * (1 + 0.16 * swallow);
        uniforms.uReach.value = reach;
        uniforms.uMass.value = this.shownMass;
        uniforms.uTimeS.value = timeS;
        uniforms.uTurn.value = this.spin < 0 ? -1 : 1;
        (uniforms.uAxis.value as Vector2).set(Math.cos(tilt), Math.sin(tilt));
        (uniforms.uAccent.value as Color).setHex(timed.theme.accent);
        (uniforms.uAccentAlt.value as Color).setHex(timed.theme.accentAlt);
        (uniforms.uInk.value as Color).setHex(timed.theme.ink);

        // Light: fades in as it forms, flares as it implodes, and a collapse leaves a point and a ring.
        const age = this.phaseFor + lead;
        const burst = uniforms.uBurst.value as ThreeVector3;
        burst.set(0, 0, 0);
        let glow = 1 + 0.5 * swallow;
        if (this.phase === 'forming') {
            glow *= clamp(age / Singularity.FORM_MS, 0, 1);
        } else if (this.phase === 'imploding') {
            const t = clamp(age / Singularity.IMPLODE_MS, 0, 1);
            glow *= 1 + 2.5 * t;
            burst.z = t * t;
        } else if (bursting) {
            const t = clamp(age / Singularity.BURST_MS, 0, 1);
            burst.set(reach * 0.84 * (1 - (1 - t) * (1 - t)), (1 - t) * (1 - t), Math.max(0, 1 - t * 3));
        }
        uniforms.uGlow.value = glow;
    }

    public cleanup(): void {
        for (const mesh of [this.lens, this.body]) {
            if (mesh) {
                mesh.removeFromParent();
                mesh.material.dispose();
            }
        }
        this.geometry?.dispose();
        this.lens = undefined;
        this.body = undefined;
        this.geometry = undefined;
        this.uniforms = undefined;

        this.phase = 'forming';
        this.phaseFor = 0;
        this.goneFor = 0;
        this.pathTime = 0;
        this.mass = Singularity.START_MASS;
        this.shownMass = Singularity.START_MASS;
        this.sinceFed = 0;
        this.gulp = 0;
        this.flash = 0;
        this.rainCursor = 0;
        this.seeded = false;
        this.nudge.x = this.nudge.y = 0;
        this.nudgeVelocity.x = this.nudgeVelocity.y = 0;
        this.velocity.x = this.velocity.y = 0;
        this.context.radius = 0;
        this.context.mass = this.mass;
        this.context.collapsed = false;
    }

    /** Radius of the dark disc when whole, at the size it is showing. */
    private fullRadius(): number {
        return this.baseRadius * (1 + Singularity.GROWTH * this.shownMass);
    }

    /** Radius of the dark disc right now, `leadMs` after the last tick: it grows in as it forms and shrinks to nothing as it implodes. */
    private discRadius(leadMs: number): number {
        const age = this.phaseFor + leadMs;
        let scale = 1;
        if (this.phase === 'gone') {
            scale = 0;
        } else if (this.phase === 'forming') {
            const t = 1 - clamp(age / Singularity.FORM_MS, 0, 1);
            scale = 1 - t * t * t;
        } else if (this.phase === 'imploding') {
            const t = clamp(age / Singularity.IMPLODE_MS, 0, 1);
            scale = 1 - t * t;
        }
        return this.fullRadius() * scale;
    }

    private pullRange(): number {
        return 380 + 200 * this.shownMass;
    }

    /** Put it on its path: home plus where the wander loop is now, plus the nudge, kept on the stage. */
    private place(width: number, height: number): void {
        let x = this.home.x * width;
        let y = this.home.y * height;
        if (this.wander) {
            // A slow two-to-three Lissajous figure: a closed loop that never quite retraces a simple circle.
            const turn = (this.pathTime / Singularity.WANDER_LOOP_MS) * Math.PI * 2;
            const reach = Math.min(width, height) * Singularity.WANDER_RADIUS;
            x += Math.sin(turn * 2 + 0.6) * reach;
            y += Math.sin(turn * 3) * reach * 0.7;
        }
        const margin = Math.min(this.fullRadius() * 1.5, width / 2, height / 2);
        this.position.x = clamp(x + this.nudge.x, margin, width - margin);
        this.position.y = clamp(y + this.nudge.y, margin, height - margin);
    }

    /** One tick along the path, shoved a little by whatever else is in the force field. */
    private move(tick: TickContext, width: number, height: number): void {
        const dt = tick.timeDelta;
        const nudge = this.nudge;
        const speed = this.nudgeVelocity;
        const force = tick.forces.sample(this.position.x, this.position.y, this.force, this.effectName);
        const keep = Math.exp(-0.003 * dt);
        speed.x = (speed.x + (force.x * Singularity.NUDGE_WEIGHT - nudge.x * Singularity.NUDGE_SPRING) * dt) * keep;
        speed.y = (speed.y + (force.y * Singularity.NUDGE_WEIGHT - nudge.y * Singularity.NUDGE_SPRING) * dt) * keep;
        nudge.x = clamp(nudge.x + speed.x * dt, -140, 140);
        nudge.y = clamp(nudge.y + speed.y * dt, -140, 140);

        const fromX = this.position.x;
        const fromY = this.position.y;
        this.place(width, height);
        this.velocity.x = dt > 0 ? (this.position.x - fromX) / dt : 0;
        this.velocity.y = dt > 0 ? (this.position.y - fromY) / dt : 0;
    }

    /** Everything that feeds it this tick: rain that falls in, events nearby, a press on it. */
    private eat(tick: TickContext): void {
        const dt = tick.timeDelta;
        const x = this.position.x;
        const y = this.position.y;
        const before = this.mass;

        const drops = tick.read('rain')?.drops;
        if (drops && drops.length > 0) {
            // A rotating third of the list per tick keeps this cheap however hard it rains.
            const mouth = this.discRadius(0) * 1.6;
            const mouthSquared = mouth * mouth;
            let found = 0;
            for (let i = this.rainCursor; i < drops.length; i += 3) {
                const drop = drops[i];
                if (drop.life !== 'alive') {
                    continue;
                }
                const dx = drop.position.x - x;
                const dy = drop.position.y + drop.size.y - y;
                if (dx * dx + dy * dy < mouthSquared) {
                    found++;
                }
            }
            this.rainCursor = (this.rainCursor + 1) % 3;
            this.mass += found * Singularity.RAIN_FEED * (dt / 16.667);
        }

        for (const event of tick.events('rainEater:exploded')) {
            this.swallow(event.payload, 0.25);
        }
        for (const event of tick.events('crystal:exploded')) {
            this.swallow(event.payload, 0.12);
        }
        for (const event of tick.events('meteor:impact')) {
            this.swallow(event.payload, 0.1 + 0.15 * clamp(event.payload.power, 0, 1));
        }
        for (const event of tick.events('firework:exploded')) {
            this.swallow(event.payload, 0.05 * clamp(event.payload.power, 0, 1));
        }
        for (const event of tick.events('lightning:strike')) {
            this.swallow(event.payload, 0.06);
        }
        for (const event of tick.events('bubble:popped')) {
            this.swallow(event.payload, 0.01);
        }

        const mouse = tick.mousePosition;
        if (mouse && tick.mouseJustPressed && !tick.mouseOnInteractive) {
            if (Math.hypot(mouse.x - x, mouse.y - y) < this.discRadius(0) * 1.5) {
                this.mass += Singularity.HAND_FEED;
                this.gulp = 1;
            }
        }

        if (this.mass > before) {
            this.sinceFed = 0;
        } else {
            this.sinceFed += dt;
            if (this.sinceFed > Singularity.LEAK_AFTER_MS) {
                this.mass = Math.max(Singularity.START_MASS, this.mass - Singularity.LEAK * dt);
            }
        }

        if (this.mass >= 1) {
            this.mass = 1;
            this.phase = 'imploding';
            this.phaseFor = 0;
        }
    }

    /** Something happened at `at`: if it is close enough, it adds `amount` of mass. */
    private swallow(at: { x: number; y: number }, amount: number): void {
        if (Math.hypot(at.x - this.position.x, at.y - this.position.y) < this.pullRange() * 1.5) {
            this.mass += amount;
            this.gulp = Math.max(this.gulp, clamp(amount / Singularity.HAND_FEED, 0.3, 1));
        }
    }

    /** The implosion has reached a point: tell everyone, push everything away, light the sky. */
    private collapse(tick: TickContext): void {
        const x = this.position.x;
        const y = this.position.y;
        tick.emit('singularity:collapsed', { x, y, radius: this.fullRadius() });
        tick.forces.shock(this.effectName, { x, y, strength: 0.006, maxRadius: 700, width: 90 });
        this.flash = 1;
        this.phase = 'gone';
        this.phaseFor = 0;
        this.goneFor = randomNumber(Singularity.GONE_MIN_MS, Singularity.GONE_MAX_MS);
        this.velocity.x = this.velocity.y = 0;
    }

    /** Back again, small, at another point of its loop. */
    private formAgain(width: number, height: number): void {
        this.phase = 'forming';
        this.phaseFor = 0;
        this.mass = Singularity.START_MASS;
        this.shownMass = Singularity.START_MASS;
        this.sinceFed = 0;
        this.gulp = 0;
        this.pathTime += randomNumber(0.2, 0.8) * Singularity.WANDER_LOOP_MS;
        this.nudge.x = this.nudge.y = 0;
        this.nudgeVelocity.x = this.nudgeVelocity.y = 0;
        this.place(width, height);
    }
}
