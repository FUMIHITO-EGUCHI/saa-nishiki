import { resolveSliderValue } from '../../shared/sliderValue.js';

const CAT = '[mySlider]';
const OVER_CLASS = 'is-over';        // the typed value sits outside the range
const CLAMPED_CLASS = 'is-clamped';  // the value was just pulled back to a bound (short flash, CSS)
export const SLIDER_RANGE_EVENT = 'saa-slider-range';

export function setupSlider(containerId, spanText = 'mySlider', options = {},  callback = null, noTitle = false) {
    let {
        min = 0,
        max = 255,
        step = 1,
    } = options;
    const { defaultValue = 0 } = options;

    const container = document.querySelector(`.${containerId}`);
    if (!container) {
        console.error(CAT, `[setupSlider] Container with class "${containerId}" not found.`);
        return;
    }

    container.innerHTML = `
        <div class="mySlider-${containerId}-row" ${noTitle?'hidden':''}>
            <span class="mySlider-${containerId}-span" ${noTitle?'hidden':''}>${spanText}</span>
            <input class="mySlider-${containerId}-value" type="number" min="${min}" max="${max}" step="${step}" value="${defaultValue}" ${noTitle?'hidden':''}>
        </div>
        <input class="mySlider-${containerId}-bar" title=${spanText} type="range" min="${min}" max="${max}" step="${step}" value="${defaultValue}">
    `;

    const sliderBar = container.querySelector(`.mySlider-${containerId}-bar`);
    const sliderText = container.querySelector(`.mySlider-${containerId}-value`);
    const sliderSpan = container.querySelector(`.mySlider-${containerId}-span`);

    // Determine if the value should be treated as an integer based on step
    const isIntegerStep = Number.isInteger(step);

    const getTypedValue = (value) => {
        const parsed = Number.parseFloat(value);
        return isIntegerStep ? Number.parseInt(parsed, 10) : parsed;
    };

    const inRange = value => value >= min && value <= max;

    // Tells whoever laid the control out (the run bar's Size label) whether the box
    // currently holds an out-of-range value or was just clamped.
    const announce = (over, clamped = false) => {
        sliderText.classList.toggle(OVER_CLASS, over);
        if (clamped) {
            sliderText.classList.remove(CLAMPED_CLASS);
            void sliderText.offsetWidth; // restart the flash animation on a repeat clamp
            sliderText.classList.add(CLAMPED_CLASS);
        }
        container.dispatchEvent(new CustomEvent(SLIDER_RANGE_EVENT, { bubbles: true, detail: { over, clamped, min, max } }));
    };
    sliderText.addEventListener('animationend', () => sliderText.classList.remove(CLAMPED_CLASS));

    // Writes a resolved (in-range, on-step) value to both controls and fires the callback.
    const commit = (resolved, { clamped = false } = {}) => {
        sliderBar.value = resolved;
        sliderText.value = resolved;
        announce(false, clamped);
        if (callback) {
            callback(getTypedValue(resolved));
        }
    };

    sliderBar.addEventListener('input', () => {
        sliderText.value = sliderBar.value;
        announce(false);
        if (callback) {
            callback(getTypedValue(sliderBar.value));
        }
    });

    // Typing: in-range values apply live; an out-of-range one only marks the box
    // (red) and waits for the change event.
    sliderText.addEventListener('input', () => {
        const value = Number.parseFloat(sliderText.value);

        if (inRange(value)) {
            sliderBar.value = value;
            announce(false);
            if (callback) {
                callback(getTypedValue(value));
            }
        } else {
            announce(Number.isFinite(value));
        }
    });

    // Leaving the box (blur / Enter): what was typed is clamped to the range and
    // snapped to the step, then written to both controls. Where the bar is hidden
    // (the run bar's size / steps / CFG boxes) this is the only visible control, so a
    // "2048" typed into a 512–1536 box must become 1536 rather than stay on screen
    // while the generation silently keeps the previous value.
    sliderText.addEventListener('change', () => {
        const typed = Number.parseFloat(sliderText.value);
        const resolved = resolveSliderValue(sliderText.value, { min, max, step });
        if (resolved === null) {
            sliderText.value = sliderBar.value; // not a number: show what is in effect
            announce(false);
            return;
        }
        commit(resolved, { clamped: !inRange(typed) });
    });

    return {
        setValue: (value) => {
            const resolved = resolveSliderValue(value, { min, max, step });
            if (resolved === null) {
                console.warn(CAT, '[setValue] Not a number:', value);
                return;
            }
            const clamped = !inRange(Number(value));
            if (clamped) console.warn(CAT, '[setValue] Value out of range, clamped:', value, '->', resolved);
            commit(resolved, { clamped });
        },
        // Narrows or widens the accepted range (the Size boxes follow the model type).
        // A current value the new range no longer holds is pulled to the bound.
        setRange: (range = {}) => {
            const nextMin = Number.isFinite(range.min) ? range.min : min;
            const nextMax = Number.isFinite(range.max) ? range.max : max;
            const nextStep = Number.isFinite(range.step) && range.step > 0 ? range.step : step;
            if (nextMin === min && nextMax === max && nextStep === step) return;
            min = nextMin; max = nextMax; step = nextStep;
            for (const input of [sliderBar, sliderText]) {
                input.min = String(min); input.max = String(max); input.step = String(step);
            }
            const current = Number.parseFloat(sliderBar.value);
            const resolved = resolveSliderValue(current, { min, max, step });
            if (resolved !== null && resolved !== current) commit(resolved, { clamped: true });
            else announce(false);
        },
        getRange: () => ({ min, max, step }),
        getValue: () => {
            return Number.parseInt(sliderBar.value, 10);
        },
        getFloat: () => {
            return Number.parseFloat(sliderBar.value);
        },
        setTitle: (text) => {
            sliderSpan.textContent = text;
            sliderBar.title = text;
        }
    };
}
