// Screenshots of the solo page (lab/solo.html) in headless Chromium, with scripted input.
// For checking an effect from a terminal, by a person or by a coding agent.
//
//   node scripts/solo-shot.mjs <outPrefix> <effects> [steps-json] [extra-query]
//
//   outPrefix    pictures are written to <outPrefix>-<shot>.png (1280x800)
//   effects      effectNames in run order, e.g. "wind,rain"
//   steps-json   an array of { ticks, input?, shot?, print? }. One tick is 16.67 ms of
//                simulation; keep a step under about 2000 ticks. input is the solo page's
//                SoloInput: { mouse: {x, y}, press, hold, keys, tap, wheel,
//                emit: [{ type, payload }], enabled: { rain: false } }. Input edges (press, tap,
//                emit) reach the first tick of their step only, so to photograph "2 ticks after
//                a press" make the press its own 2-tick step. A step with "shot" is photographed; a step with
//                "print": true prints what each effect published at that moment.
//                Default: [{"ticks":600,"shot":"a"}]
//   extra-query  appended to the address: "seed=3&ledges=0&budget=0.4&options=<url-encoded JSON>"
//
// The dev server must be running (bunx vite --host 127.0.0.1 --port 3031 --strictPort);
// SOLO_PORT overrides the port. Needs Playwright with a Chromium it can launch; it is not a
// dependency of this package.
//
// It prints console errors and warnings, what each effect published, and a cleanup check:
// every effect is removed at the end, which must not throw or leave anything in the scene.

import { createRequire } from 'node:module';

// require() rather than import(): it also finds a globally installed Playwright (NODE_PATH).
let chromium;
try {
    ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
    console.error('solo-shot needs Playwright: npm install -g playwright && npx playwright install chromium');
    process.exit(2);
}

const [prefix, effects, stepsJson, extra = ''] = process.argv.slice(2);
if (!prefix || !effects) {
    console.error('usage: node scripts/solo-shot.mjs <outPrefix> <effects> [steps-json] [extra-query]');
    process.exit(2);
}
const steps = stepsJson ? JSON.parse(stepsJson) : [{ ticks: 600, shot: 'a' }];
const port = process.env.SOLO_PORT || '3031';

// Software WebGL, so it runs on a machine with no GPU.
const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
        logs.push(`[${message.type()}] ${message.text()}`);
    }
});
page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message}`));

// Without this, saving any file under effects/ while a run is in progress reloads the page
// (Vite's hot reload) and the run dies. The stub stands in for Vite's client module.
await page.route('**/@vite/client', (route) =>
    route.fulfill({
        contentType: 'text/javascript',
        body: `const hot = { accept() {}, dispose() {}, prune() {}, invalidate() {}, on() {}, off() {}, send() {}, data: {} };
export const createHotContext = () => hot;
export const updateStyle = () => {};
export const removeStyle = () => {};
export const injectQuery = (url) => url;`,
    }),
);

// Long arrays are summarised: a context may hold hundreds of particles.
const readContexts = () =>
    page.evaluate(() => {
        const brief = (key, value) => (Array.isArray(value) && value.length > 6 ? `[${value.length} items]` : value);
        const contexts = {};
        for (const name of window.solo.effects) {
            try {
                contexts[name] = JSON.parse(JSON.stringify(window.solo.manager.simulation.tickContext.read(name) ?? null, brief));
            } catch {
                contexts[name] = 'not serialisable';
            }
        }
        return contexts;
    });

const query = `effects=${encodeURIComponent(effects)}&still=0&seed=7${extra ? `&${extra}` : ''}`;
await page.goto(`http://127.0.0.1:${port}/lab/solo.html?${query}`, { waitUntil: 'load' });
try {
    await page.waitForFunction(() => document.documentElement.dataset.soloReady === 'true', null, { timeout: 60000 });
} catch {
    console.error('The solo page did not become ready.');
    console.error(logs.join('\n'));
    await browser.close();
    process.exit(1);
}

for (const step of steps) {
    const started = Date.now();
    await page.evaluate(({ ticks, input }) => window.solo.step(ticks, input || {}), {
        ticks: step.ticks ?? 0,
        input: step.input,
    });
    if (step.shot) {
        const file = `${prefix}-${step.shot}.png`;
        await page.screenshot({ path: file });
        console.log(`shot ${file} (${step.ticks ?? 0} ticks, ${Date.now() - started} ms)`);
    }
    if (step.print) {
        console.log(`at ${step.shot ?? 'step'}:`, JSON.stringify(await readContexts()));
    }
}
const contexts = await readContexts();

const report = await page.evaluate(() => {
    const manager = window.solo.manager;
    const problems = [];
    manager.onEffectError = (name, phase, error) => problems.push(`${name} failed during ${phase}: ${error?.message}`);

    const enabled = manager.getEffectEnabledState();

    const count = () => ({ pixi: manager.compositor.pixiBack.children.length, three: manager.compositor.scene.children.length });
    const before = count();
    for (const name of [...window.solo.effects].reverse()) {
        try {
            manager.removeEffect(name);
        } catch (error) {
            problems.push(`removeEffect(${name}) threw: ${error.message}`);
        }
    }
    try {
        manager.renderOnce();
    } catch (error) {
        problems.push(`render after removal threw: ${error.message}`);
    }
    return { enabled, problems, before, after: count() };
});

console.log(
    'cleanup',
    report.problems.length > 0 ? `PROBLEMS: ${report.problems.join(' | ')}` : 'ok',
    JSON.stringify({ before: report.before, after: report.after }),
);
console.log('state', JSON.stringify({ enabled: report.enabled, contexts }));
if (logs.length > 0) {
    console.log(`console:\n${logs.slice(0, 30).join('\n')}`);
}
await browser.close();
