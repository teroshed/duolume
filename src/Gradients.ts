import { mixColor, rgbToHex } from './math';
import type { Theme, Vector3 } from './types';

export enum GradientType {
    RAINBOW = 'rainbow',
    AURORA = 'aurora',
    SPIRAL = 'spiral',
    HEATMAP = 'heatmap',
    /** Follows the manager's theme: accent to alternate accent across the stage. */
    THEME = 'theme',
}

/**
 * The original position-and-time gradients. They now return a 0xRRGGBB number (a tint)
 * and take the simulation clock instead of reading performance.now(), so pausing,
 * slow motion and still frames behave.
 */
export function gradientAtPosition(
    gradientType: GradientType,
    position: Vector3,
    timeMs: number,
    theme?: Theme,
): number {
    if (gradientType === GradientType.RAINBOW) {
        return rainbowGradient(position, timeMs);
    }
    if (gradientType === GradientType.AURORA) {
        return auroraGradient(position, timeMs);
    }
    if (gradientType === GradientType.SPIRAL) {
        return spiralGradient(position, timeMs);
    }
    if (gradientType === GradientType.HEATMAP) {
        return heatmapGradient(position, timeMs);
    }
    if (gradientType === GradientType.THEME && theme) {
        return themeGradient(position, timeMs, theme);
    }
    return 0xff0000;
}

export function rainbowGradient(position: Vector3, timeMs: number): number {
    const time = timeMs * 0.001;
    const r = Math.sin(time + position.x * 0.01) * 127 + 128;
    const g = Math.sin(time + position.y * 0.01 + 2) * 127 + 128;
    const b = Math.sin(time + (position.x + position.y) * 0.005 + 4) * 127 + 128;
    return rgbToHex(r, g, b);
}

export function auroraGradient(position: Vector3, timeMs: number): number {
    const time = timeMs * 0.0005; // Slower
    const r = Math.sin(time * 0.3 + position.x * 0.003) * 100 + 155;
    const g = Math.sin(time * 0.5 + position.y * 0.002 + 1.5) * 120 + 135;
    const b = Math.cos(time * 0.4 + position.x * 0.004 + 3) * 80 + 175;
    return rgbToHex(r, g, b);
}

export function spiralGradient(position: Vector3, timeMs: number): number {
    const time = timeMs * 0.002;
    const angle = Math.atan2(position.y - 400, position.x - 400); // Spiral from center
    const distance = Math.sqrt(position.x ** 2 + position.y ** 2) * 0.01;
    const r = Math.sin(angle * 3 + time + distance) * 127 + 128;
    const g = Math.sin(angle * 5 + time * 1.5 + distance * 2) * 127 + 128;
    const b = Math.cos(angle * 2 + time * 0.8 - distance) * 127 + 128;
    return rgbToHex(r, g, b);
}

export function heatmapGradient(position: Vector3, timeMs: number): number {
    const time = timeMs * 0.001;
    const heat = (Math.sin(time + position.y * 0.005) + 1) * 0.5; // 0 to 1
    const r = heat * 100;
    const g = heat * 150 * (1 - heat); // Peaks in middle
    const b = (1 - heat) * 255;
    return rgbToHex(r, g, b);
}

export function themeGradient(position: Vector3, timeMs: number, theme: Theme): number {
    const wave = Math.sin(timeMs * 0.0004 + position.x * 0.0035 + position.y * 0.0012) * 0.5 + 0.5;
    return mixColor(mixColor(theme.accent, theme.accentAlt, wave), theme.ink, 0.25);
}
