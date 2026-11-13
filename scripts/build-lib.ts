// Builds what npm ships: JavaScript in lib/ (bundled per entry point, shared code in chunks, the
// two renderers left as imports for the page's own copies) and type declarations beside it.
//
//   bun run build:lib
//
// The entry points are the package's exports: 'duolume', 'duolume/types', 'duolume/effects', and
// every file of the effect library ('duolume/effects/Rain/Rain').
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const out = resolve(root, 'lib');
rmSync(out, { recursive: true, force: true });

const effectFiles = Array.from(new Bun.Glob('effects/**/*.ts').scanSync({ cwd: root })).map((file) => file.replaceAll('\\', '/'));
const entrypoints = ['src/index.ts', 'src/types.ts', ...effectFiles].map((file) => resolve(root, file));

const result = await Bun.build({
    entrypoints,
    root,
    outdir: out,
    format: 'esm',
    target: 'browser',
    splitting: true, // one copy of the engine, shared by 'duolume' and 'duolume/effects'
    external: ['pixi.js', 'pixi.js/unsafe-eval', 'three'],
    naming: { chunk: 'chunks/[name]-[hash].[ext]' },
});
if (!result.success) {
    for (const log of result.logs) {
        console.error(log);
    }
    process.exit(1);
}

const types = Bun.spawnSync(['bunx', 'tsc', '-p', 'tsconfig.lib.json'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
if (types.exitCode !== 0) {
    process.exit(types.exitCode ?? 1);
}
console.log(`lib/: ${result.outputs.length} JavaScript files from ${entrypoints.length} entry points, with type declarations`);
