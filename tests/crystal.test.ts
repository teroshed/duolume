import { describe, expect, test } from 'bun:test';
import { Vector3 as ThreeVector3 } from 'three';
import { Shard } from '../effects/Crystal/CrystalBody';
import { Stage } from '../src/Stage';

// CrystalBody itself needs a renderer host. What can be checked without one: the stage's
// tag lookup that feeds it, and that a shard is an ordinary particle.

describe('stage tags', () => {
    const element = (left: number, top: number, width: number, height: number): Element =>
        ({ getBoundingClientRect: () => ({ left, top, width, height }) }) as unknown as Element;

    test('tagged() returns the on-screen anchors carrying a tag, refreshed by measure()', () => {
        const stage = new Stage();
        stage.resize(800, 600);
        stage.observe('card', element(100, 100, 200, 120), ['ledge']);
        stage.observe('far', element(100, 5000, 200, 120), ['ledge']);
        stage.observe('plain', element(400, 100, 200, 120), []);
        stage.measure();
        expect(stage.tagged('ledge').map((anchor) => anchor.name)).toEqual(['card']);
        expect(stage.tagged('nothing')).toEqual([]);

        // Scroll the far element into view: the list follows on the next measure.
        stage.observe('far', element(100, 300, 200, 120), ['ledge']);
        expect(stage.tagged('ledge').map((anchor) => anchor.name)).toEqual(['card']);
        stage.measure();
        expect(stage.tagged('ledge').map((anchor) => anchor.name)).toEqual(['card', 'far']);
    });

    test('stage pixels and world positions agree on the z = 0 plane', () => {
        const stage = new Stage();
        stage.resize(800, 600);
        const world = stage.toWorld(200, 150);
        expect(world.x).toBe(-200);
        expect(world.y).toBe(150);
        const back = stage.project(world);
        expect(back.x).toBeCloseTo(200);
        expect(back.y).toBeCloseTo(150);
    });
});

describe('shard', () => {
    test('starts attached and moves like any particle once loose', () => {
        const shard = new Shard(new ThreeVector3(0, 1, 0));
        expect(shard.state).toBe('attached');
        shard.state = 'flying';
        shard.velocity.x = 0.2;
        shard.velocity.y = -0.1;
        shard.updatePosition({ timeDelta: 10 } as never);
        expect(shard.position.x).toBeCloseTo(2);
        expect(shard.position.y).toBeCloseTo(-1);
    });
});
