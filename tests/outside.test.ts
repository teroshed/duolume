import { describe, expect, test } from 'bun:test';
import { jag } from '../effects/Arc/jag';
import { Border, makeBorderPoint } from '../effects/Field/border';
import { layTendril, TENDRIL_POINTS } from '../effects/Ivy/tendril';

function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('a path outside an element', () => {
    test('a negative inset puts the path that far outside, all the way round', () => {
        const border = new Border(100, 40, 10, -8);
        const point = makeBorderPoint();
        // Longer than the element's own edge.
        expect(border.length).toBeGreaterThan(new Border(100, 40, 10, 0).length);
        for (let d = 0; d < border.length; d += 3) {
            border.pointAt(d, point);
            const outside = point.x < 0 || point.x > 100 || point.y < 0 || point.y > 40;
            expect(outside).toBe(true);
            // Never further than the gap from the element's box.
            const dx = point.x < 0 ? -point.x : point.x > 100 ? point.x - 100 : 0;
            const dy = point.y < 0 ? -point.y : point.y > 40 ? point.y - 40 : 0;
            expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(8.001);
        }
    });
});

describe('layTendril', () => {
    test('starts on the edge, is as long as asked, and never goes back into the element', () => {
        const random = seeded(11);
        const out = new Float32Array(TENDRIL_POINTS * 2);
        for (let run = 0; run < 200; run++) {
            // From the middle of the top edge of a 120 by 40 box, heading up.
            layTendril(out, 0, 60, 0, 0, -1, 55, 120, 40, random);
            expect(out[0]).toBe(60);
            expect(out[1]).toBe(0);
            let length = 0;
            for (let k = 1; k < TENDRIL_POINTS; k++) {
                const x = out[k * 2];
                const y = out[k * 2 + 1];
                length += Math.hypot(x - out[(k - 1) * 2], y - out[(k - 1) * 2 + 1]);
                expect(x > 0 && x < 120 && y > 0 && y < 40).toBe(false);
            }
            expect(length).toBeCloseTo(55, 3);
        }
    });

    test('the same dice lay the same tendril', () => {
        const a = new Float32Array(TENDRIL_POINTS * 2);
        const b = new Float32Array(TENDRIL_POINTS * 2);
        layTendril(a, 0, 0, 20, -1, 0, 40, 100, 40, seeded(5));
        layTendril(b, 0, 0, 20, -1, 0, 40, 100, 40, seeded(5));
        expect(Array.from(a)).toEqual(Array.from(b));
    });
});

describe('jag', () => {
    test('stays between -1 and 1, repeats for the same numbers, and changes with the moment', () => {
        let differs = 0;
        let sum = 0;
        for (let i = 0; i < 500; i++) {
            const value = jag(i * 0.37, i, i % 9);
            expect(value).toBeGreaterThanOrEqual(-1);
            expect(value).toBeLessThan(1);
            expect(jag(i * 0.37, i, i % 9)).toBe(value);
            if (jag(i * 0.37, i + 1, i % 9) !== value) {
                differs++;
            }
            sum += value;
        }
        expect(differs).toBeGreaterThan(490);
        // Not lopsided.
        expect(Math.abs(sum / 500)).toBeLessThan(0.15);
    });
});
