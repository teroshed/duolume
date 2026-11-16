/**
 * The pictures `FieldFrame` puts on its frames, inlined so the library ships them in its code.
 * Each one is drawn in black: only its shape counts, and the theme colours it.
 */

/** An SVG drawing as an address that `Picture.image` takes. */
function asImage(svg: string): string {
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** A head-up-display corner: a bracket with a fainter one outside it. Drawn for the top-left corner; the frame's corner is at (12, 12) of 48. */
export const BRACKET = asImage(
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M12 38V20a8 8 0 0 1 8-8h18" stroke-width="4"/>' +
        '<path d="M4 26V15A11 11 0 0 1 15 4h11" stroke-width="2" opacity=".55"/>' +
        '<path d="M45 12h.01M12 45v.01" stroke-width="4"/>' +
        '</svg>',
);

/** A curled corner with a small diamond. Drawn for the top-left corner; the frame's corner is at (24, 24) of 64. */
export const FILIGREE = asImage(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" fill="none" stroke="#000" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M24 50V36a12 12 0 0 1 12-12h14"/>' +
        '<path d="M50 24c6 0 10-4 10-9s-4-8-8-7-4 6 0 7"/>' +
        '<path d="M24 50c0 6-4 10-9 10s-8-4-7-8 6-4 7 0"/>' +
        '<path d="M15 32v-5A12 12 0 0 1 27 15h5" stroke-width="2" opacity=".55"/>' +
        '<path d="M12 6l5 6-5 6-5-6z" fill="#000" stroke="none" transform="rotate(-45 12 12)"/>' +
        '</svg>',
);

const LEAF = 'M0 0C3-3.6 9-3.6 12 0 9 3.6 3 3.6 0 0z';
/** Where each pair of leaves sits on the stem: x, y, the two turns, and the size. */
const LEAVES: [number, number, number, number, number][] = [
    [25.8, 71.7, -171, -87, 0.76],
    [20.2, 62.5, -156, -72, 0.84],
    [16.9, 51.6, -143, -59, 0.92],
    [15.8, 40.0, -132, -48, 1.0],
    [16.9, 28.4, -121, -37, 0.92],
    [20.2, 17.5, -108, -24, 0.84],
    [24.9, 9.5, -95, -11, 0.78],
];

/** Half a laurel wreath, shaped like "(": leaves along one curve, 36 by 80. */
export const LAUREL = asImage(
    '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="80" viewBox="0 0 36 80">' +
        '<path d="M30 76C11 60 11 20 30 4" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round"/>' +
        LEAVES.map(([x, y, a, b, size]) =>
            [a, b].map((turn) => `<path d="${LEAF}" transform="translate(${x} ${y}) rotate(${turn}) scale(${size})"/>`).join(''),
        ).join('') +
        `<path d="${LEAF}" transform="translate(30.0 4.0) rotate(-40) scale(.8)"/>` +
        '</svg>',
);

/** A four-point star, 32 by 32. */
export const SPARK = asImage(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
        '<path d="M16 0c1 10 6 15 16 16-10 1-15 6-16 16-1-10-6-15-16-16 10-1 15-6 16-16z"/>' +
        '</svg>',
);

/** One step of a ruler, 40 by 6: a long tick, then four short ones. It repeats sideways. */
export const TICKS = asImage(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="6" viewBox="0 0 40 6" fill="none" stroke="#000" stroke-width="1">' +
        '<path d="M.5 0v6M8.5 0v3M16.5 0v3M24.5 0v3M32.5 0v3"/>' +
        '</svg>',
);
