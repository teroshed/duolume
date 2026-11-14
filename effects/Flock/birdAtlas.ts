/** Side of one frame in the atlas, texture pixels. */
export const ATLAS_CELL = 32;

/**
 * Two frames side by side, drawn white and tinted per bird: a bird in flight pointing right
 * (swept wings, forked tail), and a bird sitting upright facing right, feet at the bottom edge.
 */
export function drawAtlas(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = ATLAS_CELL * 2;
    canvas.height = ATLAS_CELL;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return canvas;
    }
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';

    // In flight: nose at the right, wings swept back to two tips, a short forked tail.
    ctx.beginPath();
    ctx.moveTo(30, 16);
    ctx.quadraticCurveTo(24, 13.6, 18, 14);
    ctx.quadraticCurveTo(12, 8, 6, 2);
    ctx.quadraticCurveTo(10, 10, 11, 14.2);
    ctx.lineTo(3, 13);
    ctx.lineTo(7, 16);
    ctx.lineTo(3, 19);
    ctx.lineTo(11, 17.8);
    ctx.quadraticCurveTo(10, 22, 6, 30);
    ctx.quadraticCurveTo(12, 24, 18, 18);
    ctx.quadraticCurveTo(24, 18.4, 30, 16);
    ctx.closePath();
    ctx.fill();

    // Sitting: a round body, a head, a tiny beak and a tail tick, feet at the bottom.
    const ox = ATLAS_CELL;
    ctx.beginPath();
    ctx.ellipse(ox + 15, 20, 7.5, 9, -0.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ox + 19.5, 9.5, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(ox + 24, 8);
    ctx.lineTo(ox + 29, 10);
    ctx.lineTo(ox + 24, 12);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(ox + 10, 25);
    ctx.lineTo(ox + 4, 30);
    ctx.stroke();
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(ox + 14, 28);
    ctx.lineTo(ox + 14, 32);
    ctx.moveTo(ox + 18, 27);
    ctx.lineTo(ox + 18, 32);
    ctx.stroke();
    return canvas;
}
