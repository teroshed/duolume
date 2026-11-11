import type { LabActions } from './actions';
import { INTENSITY_LEVELS, INTENSITY_PRESETS, type IntensityLevel } from './intensity';

const CLOSE_MS = 240;

/**
 * The dialog shown on entering the lab. It says what this page is, warns that it can be
 * hard on the eyes, and lets the visitor pick an intensity while the scene behind it —
 * dimmed — follows the slider live.
 *
 * It is a native modal `<dialog>`: focus starts on the slider, stays inside while open,
 * Escape accepts the current choice, and focus goes back to whatever opened it.
 */
export function initIntro(actions: LabActions, fallbackFocus: HTMLElement): { open(): void } {
    const dialog = query<HTMLDialogElement>('#intro');
    const slider = query<HTMLInputElement>('#intro-level');
    const name = query<HTMLElement>('#intro-level-name');
    const summary = query<HTMLElement>('#intro-level-summary');
    const steps = Array.from(dialog.querySelectorAll<HTMLElement>('[data-level]'));
    const skip = query<HTMLInputElement>('#intro-skip');
    const start = query<HTMLButtonElement>('#intro-start');
    let closeTimer = 0;
    let returnFocusTo: HTMLElement | null = null;

    const render = (): void => {
        const state = actions.getState();
        const index = INTENSITY_LEVELS.indexOf(state.level);
        const preset = INTENSITY_PRESETS[state.level];
        slider.value = String(index);
        slider.setAttribute('aria-valuetext', preset.label);
        slider.style.setProperty('--fill', `${(index / (INTENSITY_LEVELS.length - 1)) * 100}%`);
        name.textContent = preset.label;
        summary.textContent = preset.summary;
        skip.checked = state.skipIntro;
        dialog.dataset.level = state.level;
        for (const step of steps) {
            step.classList.toggle('is-current', step.dataset.level === state.level);
        }
    };

    slider.addEventListener('input', () => {
        actions.setLevel(INTENSITY_LEVELS[Number(slider.value)] as IntensityLevel);
    });
    for (const step of steps) {
        // A pointer shortcut for the slider. The slider itself is the keyboard path.
        step.addEventListener('click', () => {
            actions.setLevel(step.dataset.level as IntensityLevel);
            slider.focus();
        });
    }
    skip.addEventListener('change', () => actions.setSkipIntro(skip.checked));
    actions.subscribe(render);

    const finish = (): void => {
        window.clearTimeout(closeTimer);
        dialog.classList.remove('is-closing');
        if (dialog.open) {
            dialog.close();
        }
    };

    const close = (): void => {
        if (!dialog.open || dialog.classList.contains('is-closing')) {
            return;
        }
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            finish();
            return;
        }
        // Play the exit, then close. The timer is the fallback if the animation never reports back.
        dialog.classList.add('is-closing');
        closeTimer = window.setTimeout(finish, CLOSE_MS + 80);
    };

    dialog.addEventListener('animationend', (event) => {
        if (event.target === dialog && dialog.classList.contains('is-closing')) {
            finish();
        }
    });
    // Escape accepts the current level instead of snapping shut: the choice is already applied.
    dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        close();
    });
    dialog.addEventListener('close', () => {
        const target = returnFocusTo && returnFocusTo.isConnected ? returnFocusTo : fallbackFocus;
        target.focus();
        returnFocusTo = null;
    });
    start.addEventListener('click', close);

    const open = (): void => {
        if (dialog.open) {
            return;
        }
        returnFocusTo = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
            ? document.activeElement
            : null;
        render();
        dialog.showModal();
        slider.focus();
    };

    return { open };
}

function query<T extends Element>(selector: string): T {
    const found = document.querySelector<T>(selector);
    if (!found) {
        throw new Error(`Missing ${selector}`);
    }
    return found;
}
