import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

// The pages in this repository are the lab, served at /lab/, and its solo page (/lab/solo.html)
// for running chosen effects alone.
export default defineConfig({
    root,
    publicDir: `${root}public`,
    build: {
        outDir: `${root}dist`,
        emptyOutDir: true,
        sourcemap: false,
        rollupOptions: { input: { lab: `${root}lab/index.html`, solo: `${root}lab/solo.html` } },
    },
});
