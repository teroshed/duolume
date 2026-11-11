import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

// The only page in this repository is the lab, served at /lab/.
export default defineConfig({
    root,
    publicDir: `${root}public`,
    build: {
        outDir: `${root}dist`,
        emptyOutDir: true,
        sourcemap: false,
        rollupOptions: { input: { lab: `${root}lab/index.html` } },
    },
});
