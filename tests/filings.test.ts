import { describe, expect, test } from 'bun:test';
import { Needles, makeDrive } from '../effects/Filings/Needles';

function settle(n: Needles, drive: ReturnType<typeof makeDrive>, ms: number): void {
    for (let t = 0; t < ms; t += 16) {
        drive.time += 16;
        n.step(16, drive);
    }
}

function setup(): { n: Needles; d: ReturnType<typeof makeDrive> } {
    const n = new Needles();
    n.seed(0, 60, 28, 5.5, 400);
    const d = makeDrive();
    d.width = 60;
    d.height = 28;
    d.mode = 1;
    return { n, d };
}

describe('Needles', () => {
    test('seed stays inside and under the cap', () => {
        const n = new Needles();
        n.seed(0, 222, 98, 5.5, 400);
        expect(n.count).toBeLessThanOrEqual(400);
        expect(n.count).toBeGreaterThan(100);
        for (let i = 0; i < n.count; i++) {
            expect(n.x[i]).toBeGreaterThanOrEqual(0);
            expect(n.x[i]).toBeLessThanOrEqual(222);
            expect(n.y[i]).toBeLessThanOrEqual(98);
        }
        const tiny = new Needles();
        tiny.seed(0, 0, 0, 5.5, 400);
        expect(tiny.count).toBe(0);
    });

    test('a switch settles to its own tilt, and flips as a wave', () => {
        const { n, d } = setup();
        d.toD = d.fromD = 1;
        settle(n, d, 600);
        for (let i = 0; i < n.count; i++) expect(n.angle[i]).toBeCloseTo(-Math.atan(0.8), 1);
        d.fromD = 1;
        d.toD = -1;
        d.flipAt = d.time;
        d.originX = 0;
        settle(n, d, 80);
        let near = 0;
        let far = 0;
        for (let i = 0; i < n.count; i++) {
            if (n.x[i] < 10 && n.angle[i] > 0) near++;
            if (n.x[i] > 50 && n.angle[i] > 0) far++;
        }
        expect(near).toBeGreaterThan(far);
        settle(n, d, 800);
        for (let i = 0; i < n.count; i++) expect(n.angle[i]).toBeCloseTo(Math.atan(0.8), 1);
    });

    test('the pointer over the element makes circles round it', () => {
        const { n, d } = setup();
        d.pointerOn = true;
        d.pointerFade = 1;
        d.pointerDist = 0;
        d.pointerX = 30;
        d.pointerY = 14;
        settle(n, d, 800);
        for (let i = 0; i < n.count; i++) {
            const dx = 30 - n.x[i];
            const dy = 14 - n.y[i];
            if (Math.hypot(dx, dy) < 12) {
                const radial = Math.abs(Math.cos(n.angle[i]) * dx + Math.sin(n.angle[i]) * dy) / Math.hypot(dx, dy);
                expect(radial).toBeLessThan(0.5);
            }
        }
    });

    test('stays finite under a huge scene force', () => {
        const { n, d } = setup();
        d.sceneX.fill(1e6);
        d.sceneY.fill(-1e6);
        settle(n, d, 500);
        for (let i = 0; i < n.count; i++) expect(Number.isFinite(n.angle[i])).toBe(true);
    });
});
