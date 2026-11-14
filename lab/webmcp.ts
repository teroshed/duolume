import { GradientType } from '../src';
import type { LabActions } from './actions';
import { EFFECT_NAMES, INTENSITY_LEVELS, INTENSITY_PRESETS, SCENE_NAMES, SCENE_PRESETS } from './intensity';

interface ToolResult {
    content: { type: 'text'; text: string }[];
}

interface ModelContextTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute(input: Record<string, unknown>): ToolResult | Promise<ToolResult>;
}

interface ModelContext {
    registerTool(tool: ModelContextTool): unknown;
}

/**
 * Programmatic access to every lab action.
 *
 * `window.teroshedLab` is the same object the page's own controls use. Where the browser
 * offers WebMCP (`navigator.modelContext`), each action is also registered as a tool.
 * Both go through `LabActions`, so validation and saved state are identical to a click.
 */
export function exposeLabActions(actions: LabActions): { webmcp: boolean } {
    Object.assign(window, { teroshedLab: actions });

    const modelContext = (navigator as Navigator & { modelContext?: ModelContext }).modelContext;
    if (!modelContext || typeof modelContext.registerTool !== 'function') {
        return { webmcp: false };
    }

    const reply = (): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(actions.getState()) }] });
    const object = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
        type: 'object',
        properties,
        required,
        additionalProperties: false,
    });

    const tools: ModelContextTool[] = [
        {
            name: 'lab_get_state',
            description: 'Read the engine lab state: scene, intensity level, which effects are on, speed, rain, gradient, paused.',
            inputSchema: object({}, []),
            execute: reply,
        },
        {
            name: 'lab_set_intensity',
            description: `Apply an intensity level. Outside the storm scene it sets only rain, shells and brightness, not which effects run. ${INTENSITY_LEVELS.map((level) => `${level}: ${INTENSITY_PRESETS[level].summary}`).join(' ')}`,
            inputSchema: object({ level: { type: 'string', enum: [...INTENSITY_LEVELS] } }, ['level']),
            execute: (input) => {
                actions.setLevel(input.level as never);
                return reply();
            },
        },
        {
            name: 'lab_set_scene',
            description: `Switch to a scene, a set of effects that belong together. ${SCENE_NAMES.map((scene) => `${scene}: ${SCENE_PRESETS[scene].summary}`).join(' ')}`,
            inputSchema: object({ scene: { type: 'string', enum: [...SCENE_NAMES] } }, ['scene']),
            execute: (input) => {
                actions.setScene(input.scene as never);
                return reply();
            },
        },
        {
            name: 'lab_set_effect',
            description: 'Switch one effect on or off.',
            inputSchema: object(
                { effect: { type: 'string', enum: [...EFFECT_NAMES] }, enabled: { type: 'boolean' } },
                ['effect', 'enabled'],
            ),
            execute: (input) => {
                actions.setEffectEnabled(input.effect as never, input.enabled as never);
                return reply();
            },
        },
        {
            name: 'lab_set_speed',
            description: 'Set simulation speed. Values outside 0.2–3 are clamped; the applied value is returned in the state.',
            inputSchema: object({ speed: { type: 'number', minimum: 0.2, maximum: 3 } }, ['speed']),
            execute: (input) => {
                actions.setSpeed(input.speed as never);
                return reply();
            },
        },
        {
            name: 'lab_set_drops',
            description: 'Set how many rain droplets to aim for (0–1600).',
            inputSchema: object({ drops: { type: 'integer', minimum: 0, maximum: 1600 } }, ['drops']),
            execute: (input) => {
                actions.setDrops(input.drops as never);
                return reply();
            },
        },
        {
            name: 'lab_set_gradient',
            description: 'Set the rain colour gradient.',
            inputSchema: object({ gradient: { type: 'string', enum: Object.values(GradientType) } }, ['gradient']),
            execute: (input) => {
                actions.setGradient(input.gradient as never);
                return reply();
            },
        },
        {
            name: 'lab_set_paused',
            description: 'Pause or resume the simulation.',
            inputSchema: object({ paused: { type: 'boolean' } }, ['paused']),
            execute: (input) => {
                actions.setPaused(input.paused as never);
                return reply();
            },
        },
        {
            name: 'lab_explode_eater',
            description: 'Break the rain eater crystal apart. It reassembles after about two seconds.',
            inputSchema: object({}, []),
            execute: () => {
                actions.explodeEater();
                return reply();
            },
        },
    ];

    try {
        for (const tool of tools) {
            modelContext.registerTool(tool);
        }
        return { webmcp: true };
    } catch {
        // The API is still experimental; a mismatch must not take the lab down with it.
        return { webmcp: false };
    }
}
