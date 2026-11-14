import { describe, expect, test } from 'bun:test';
import { SnowCap } from '../effects/Snow/SnowCap';

describe('SnowCap', () => {
    test('deposit raises the column and keeps the volume', () => {
        const cap = new SnowCap(400, 30, true);
        const kept = cap.deposit(200, 100);
        expect(kept).toBeCloseTo(100);
        expect(cap.total).toBeCloseTo(100);
        expect(cap.heightAt(200)).toBeGreaterThan(cap.heightAt(100));
        expect(cap.heightAt(200)).toBeGreaterThan(0);
    });

    test('deposit at the ends and outside the surface lands on the edge columns', () => {
        const cap = new SnowCap(100, 30, true);
        expect(cap.deposit(-50, 20)).toBeCloseTo(20);
        expect(cap.deposit(500, 20)).toBeCloseTo(20);
        expect(cap.total).toBeCloseTo(40);
    });

    test('relax flattens a spike and conserves volume on a closed surface', () => {
        const cap = new SnowCap(400, 80, false);
        cap.heights[50] = 40;
        const before = cap.total;
        for (let i = 0; i < 400; i++) {
            cap.relax(3);
        }
        expect(cap.total).toBeCloseTo(before, 3);
        expect(cap.deepest).toBeLessThan(14);
        for (let i = 0; i < cap.cols - 1; i++) {
            expect(Math.abs(cap.heights[i] - cap.heights[i + 1])).toBeLessThan(SnowCap.REPOSE * cap.colWidth + 0.05);
        }
    });

    test('relax on an open surface reports exactly what fell off the ends', () => {
        const cap = new SnowCap(60, 80, true);
        cap.heights.fill(20);
        const before = cap.total;
        let fell = 0;
        for (let i = 0; i < 300; i++) {
            cap.relax(2);
            fell += cap.fellLeft + cap.fellRight;
        }
        expect(fell).toBeGreaterThan(0);
        expect(cap.total + fell).toBeCloseTo(before, 2);
    });

    test('carve removes snow and returns what it removed', () => {
        const cap = new SnowCap(400, 30, true);
        cap.heights.fill(10);
        const before = cap.total;
        const removed = cap.carve(200, 20, 6);
        expect(removed).toBeGreaterThan(0);
        expect(cap.total).toBeCloseTo(before - removed);
        expect(cap.heightAt(200)).toBeCloseTo(4, 0);
        expect(cap.heightAt(300)).toBeCloseTo(10);
        // Cannot take more than is there.
        const rest = cap.carve(200, 20, 1000);
        expect(cap.heightAt(200)).toBe(0);
        expect(rest).toBeGreaterThan(0);
        expect(cap.carve(200, 20, 1000)).toBe(0);
    });

    test('heights never exceed the cap or go below zero', () => {
        const cap = new SnowCap(200, 12, true);
        for (let i = 0; i < 200; i++) {
            cap.deposit(100 + Math.sin(i) * 20, 30);
            cap.relax(2);
        }
        expect(cap.deepest).toBeLessThanOrEqual(12 + 1e-4);
        cap.carve(100, 500, 100);
        cap.melt(100);
        cap.shave(100);
        for (let i = 0; i < cap.cols; i++) {
            expect(cap.heights[i]).toBeGreaterThanOrEqual(0);
            expect(cap.heights[i]).toBeLessThanOrEqual(12 + 1e-4);
        }
    });

    test('deposit reports less than offered when the pile is full', () => {
        const cap = new SnowCap(40, 5, false);
        cap.heights.fill(5);
        expect(cap.deposit(20, 50)).toBe(0);
    });

    test('melt lowers every column evenly, never below zero', () => {
        const cap = new SnowCap(100, 30, true);
        cap.heights.fill(1);
        cap.heights[3] = 5;
        const removed = cap.melt(2);
        expect(cap.heights[3]).toBeCloseTo(3);
        expect(cap.heights[0]).toBe(0);
        expect(removed).toBeCloseTo((cap.cols - 1 + 2) * 0.0 + (cap.cols - 1) * 1 * cap.colWidth + 2 * cap.colWidth);
    });

    test('resize keeps the shape', () => {
        const cap = new SnowCap(200, 30, true);
        cap.heights.fill(0);
        cap.heights[10] = 9;
        cap.resize(400);
        expect(cap.cols).toBe(100);
        expect(cap.deepest).toBeCloseTo(9);
        expect(cap.crest()).toBeGreaterThan(40);
    });

    test('shave takes most from the tallest columns', () => {
        const cap = new SnowCap(100, 30, true);
        cap.heights.fill(2);
        cap.heights[10] = 20;
        const removed = cap.shave(1);
        expect(removed).toBeGreaterThan(0);
        expect(cap.heights[10]).toBeCloseTo(19);
        expect(cap.heights[0]).toBeCloseTo(2);
    });
});
