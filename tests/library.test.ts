import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// An effect is listed by hand in several places (AGENTS.md has the checklist). Nothing in the
// engine ties them together, on purpose: there is no registry. These tests read the files as
// text and say which place was forgotten.

const root = resolve(import.meta.dir, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

interface LibraryEffect {
    className: string;
    effectName: string;
    file: string;
}

/** The effects exported from effects/index.ts, with the name each one runs under. */
function exportedEffects(): LibraryEffect[] {
    const effects: LibraryEffect[] = [];
    for (const match of read('effects/index.ts').matchAll(/export \{ (\w+)(?:, type \w+)? \} from '\.\/([\w/]+)';/g)) {
        const [, className, path] = match;
        const file = `effects/${path}.ts`;
        const name = read(file).match(/effectName(?:: string)? = '(\w+)'/);
        effects.push({ className, effectName: name ? name[1] : '', file });
    }
    return effects;
}

/** Every class under effects/ that extends Effect, whether or not it is exported. */
function effectClassesOnDisk(): string[] {
    const classes: string[] = [];
    for (const folder of readdirSync(resolve(root, 'effects'))) {
        const directory = resolve(root, 'effects', folder);
        if (!statSync(directory).isDirectory()) {
            continue;
        }
        for (const file of readdirSync(directory)) {
            for (const match of readFileSync(resolve(directory, file), 'utf8').matchAll(/export class (\w+) extends Effect\b/g)) {
                classes.push(match[1]);
            }
        }
    }
    return classes;
}

const effects = exportedEffects();
/** The template is a library export but not something a page or the lab lists. */
const listed = effects.filter((effect) => effect.className !== 'BlankEffect');

describe('the effect library is listed everywhere it should be', () => {
    test('effects/index.ts was readable and every effect declares its effectName', () => {
        expect(effects.length).toBeGreaterThan(0);
        expect(effects.filter((effect) => effect.effectName === '').map((effect) => effect.file)).toEqual([]);
    });

    test('effect names are unique', () => {
        const names = effects.map((effect) => effect.effectName);
        expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
    });

    test('every effect class under effects/ is exported from effects/index.ts', () => {
        const exported = new Set(effects.map((effect) => effect.className));
        expect(effectClassesOnDisk().filter((className) => !exported.has(className))).toEqual([]);
    });

    test('every effect has a row in the "effect library" table of README.md', () => {
        const readme = read('README.md');
        expect(effects.filter((effect) => !readme.includes(`| \`${effect.className}\` |`)).map((effect) => effect.className)).toEqual([]);
    });

    test('every effect has its context registered in effects/contracts.ts', () => {
        const contracts = read('effects/contracts.ts');
        const registry = contracts.slice(contracts.indexOf('interface EffectContextMap'), contracts.indexOf('interface EngineEventMap'));
        expect(listed.filter((effect) => !new RegExp(`^\\s+${effect.effectName}: \\w+;`, 'm').test(registry)).map((effect) => effect.effectName)).toEqual([]);
    });

    test('every effect is in the lab: EFFECT_NAMES, a checkbox, and the manager', () => {
        const intensity = read('lab/intensity.ts');
        const names = intensity.slice(intensity.indexOf('EFFECT_NAMES = ['), intensity.indexOf('] as const'));
        const page = read('lab/index.html');
        const main = read('lab/main.ts');
        const missing = listed
            .filter(
                (effect) =>
                    !names.includes(`'${effect.effectName}'`) ||
                    !page.includes(`data-effect="${effect.effectName}"`) ||
                    !new RegExp(`\\b${effect.className}\\b`).test(main),
            )
            .map((effect) => effect.effectName);
        expect(missing).toEqual([]);
    });
});
