import { describe, expect, test } from 'bun:test';
import { PageWater } from '../effects/Rain/PageWater';

// One rule sizes the drop hanging under an element, the runner down its side, and the droplet
// that lets go. These pin the rule, so the three cannot drift apart.
describe('PageWater.dropSize', () => {
    test('a drop holding DROP_WATER has DROP_SIZE', () => {
        const size = PageWater.dropSize(PageWater.DROP_WATER, { x: 0, y: 0 });
        expect(size.x).toBeCloseTo(PageWater.DROP_SIZE.x);
        expect(size.y).toBeCloseTo(PageWater.DROP_SIZE.y);
    });

    test('more water makes a bigger drop, in the same proportions', () => {
        const small = PageWater.dropSize(1, { x: 0, y: 0 });
        const large = PageWater.dropSize(4, { x: 0, y: 0 });
        expect(large.x).toBeGreaterThan(small.x);
        expect(large.y / large.x).toBeCloseTo(small.y / small.x);
        // Area follows the water: four times the water, twice the width.
        expect(large.x / small.x).toBeCloseTo(2);
    });

    test('the size is bounded however little or much water there is', () => {
        const least = PageWater.dropSize(0, { x: 0, y: 0 });
        const most = PageWater.dropSize(1000, { x: 0, y: 0 });
        expect(least.x).toBeGreaterThan(0);
        expect(most.x).toBeCloseTo(PageWater.dropSize(6, { x: 0, y: 0 }).x);
    });

    test('it writes into the vector it is given and returns it', () => {
        const out = { x: 0, y: 0 };
        expect(PageWater.dropSize(2, out)).toBe(out);
    });
});
