import { normalizeADetailerSeed } from '../shared/adetailerSettings.js';

export function refreshADetailerSettings() {
    const panel = document.getElementById('adetailer-settings');
    if (!panel) return;
    const settings = globalThis.globalSettings;
    panel.hidden = settings.api_interface !== 'ComfyUI';
    const japanese = settings.language === 'ja-JP';
    panel.querySelector('[data-ad-label="prompt"]').textContent = japanese ? 'プロンプト空欄時' : 'When a prompt is blank';
    panel.querySelector('option[value="inherit"]').textContent = japanese ? '本体の生成条件を引き継ぐ' : 'Inherit generation conditioning';
    panel.querySelector('option[value="empty"]').textContent = japanese ? '空の条件を使う（従来の動作）' : 'Use empty conditioning (legacy)';
    panel.querySelector('[data-ad-label="seed"]').textContent = japanese ? 'Seed（-1：本体と同じ）' : 'Seed (-1: same as generation)';
    panel.querySelector('select').value = settings.api_adetailer_prompt_mode === 'empty' ? 'empty' : 'inherit';
    panel.querySelector('input').value = normalizeADetailerSeed(settings.api_adetailer_seed);
}

export function setupADetailerSettings() {
    const slots = document.querySelector('.adetailer-main');
    if (!slots || document.getElementById('adetailer-settings')) return;
    // Slot reload replaces only registered rows, leaving these shared controls.
    const panel = document.createElement('div');
    panel.id = 'adetailer-settings';
    panel.innerHTML = '<label><span data-ad-label="prompt"></span><select id="adetailer-prompt-mode"><option value="inherit"></option><option value="empty"></option></select></label>'
        + '<label><span data-ad-label="seed"></span><input id="adetailer-seed" type="number" min="-1" max="4294967295" step="1"></label>';
    slots.prepend(panel);
    panel.querySelector('select').addEventListener('change', event => {
        globalThis.globalSettings.api_adetailer_prompt_mode = event.target.value;
    });
    panel.querySelector('input').addEventListener('change', event => {
        if (!event.target.reportValidity()) return;
        const seed = normalizeADetailerSeed(event.target.value);
        globalThis.globalSettings.api_adetailer_seed = seed;
        event.target.value = seed;
    });
    document.addEventListener('saa-settings-applied', refreshADetailerSettings);
    refreshADetailerSettings();
}
