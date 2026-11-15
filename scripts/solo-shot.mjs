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
//                A step may also act on the page before its ticks, with "dom": a list of
//                { "check": ["#id", true] }, { "click": "#id" }, { "focus": "#id" }, { "blur": true },
//                { "value": ["#id", 30] } (a range input), { "type": ["#id", "text"] }.
//   extra-query  appended to the address: "seed=3&ledges=0&budget=0.4&options=<url-encoded JSON>",
//                and for effects that draw inside inputs "fields=liquid,mini+rain" (sample inputs
//                carrying those tags; their names and places are printed) and "samples=switch,off".
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
// "$OUT/rain" with OUT unset is "/rain": pictures in the filesystem root. Two agents did this.
if (/^[\\/][^\\/]*$/.test(prefix)) {
    console.error(`solo-shot: "${prefix}" would write into the filesystem root. Is a shell variable in the path empty?`);
    process.exit(2);
}
const steps = stepsJson ? JSON.parse(stepsJson) : [{ ticks: 600, shot: 'a' }];
const port = process.env.SOLO_PORT || '3031';

// Software WebGL, so it runs on a machine with no GPU.
const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
// SOLO_SCALE=2 photographs at two device pixels per pixel: for looking closely at small things.
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: Number(process.env.SOLO_SCALE || 1) });
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

const fieldList = await page.evaluate(() => window.solo.fields());
if (fieldList.length > 0) {
    console.log('fields (name x y width height | tags):');
    for (const field of fieldList) {
        // The picture is 1280x800: a sample below that is simply missing from it, so say so.
        const outside = field.x + field.width > 1280 || field.y + field.height > 800 ? '   <- OUTSIDE THE PICTURE: ask for fewer tags or samples' : '';
        console.log(`  ${field.name} ${field.x} ${field.y} ${field.width} ${field.height} | ${field.tags}${outside}`);
    }
}

/** Act on the page's real controls, the way a visitor would. */
async function act(action) {
    if (action.check) {
        await page.locator(action.check[0]).setChecked(action.check[1], { force: true });
    } else if (action.click) {
        await page.locator(action.click).click({ force: true });
    } else if (action.focus) {
        await page.locator(action.focus).focus();
    } else if (action.blur) {
        await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    } else if (action.value) {
        await page.locator(action.value[0]).evaluate((element, value) => {
            element.value = String(value);
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
        }, action.value[1]);
    } else if (action.type) {
        await page.locator(action.type[0]).fill(action.type[1]);
    }
}

for (const step of steps) {
    const started = Date.now();
    for (const action of step.dom ?? []) {
        await act(action);
    }
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
