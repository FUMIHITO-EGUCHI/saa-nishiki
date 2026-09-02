// Shared body layout for index.html and index_electron.html
// This file contains the common HTML structure used by both entry points.
// Edit this file to update the layout for both Electron and Web versions.
//
// 2026-08-30 layout (see wai-stack/SAA-ui-redesign.md):
//   header  — profile · checkpoint · backend status pills · layout swap · settings
//   #left   — viewer (gallery) + resizable info panel (Info / Characters / AI tabs)
//   #right  — Characters & Views card → Prompts card (+ AI card) → Pipeline rows,
//             with the run bar pinned to the bottom of the column.
// Container class names consumed by renderer.js / language.js / callbacks.js are unchanged;
// only their placement moved. Every "*-dummy" duplicate control is gone except
// .regional-condition-trigger-dummy (it is the one real Regional switch).

export const sharedBodyHTML = `
    <div id="full-body">
      <div id="top-header">
        <div id="global-settings-left"></div>

        <div id="global-settings-middle">
          <div class="model-select"></div>
          <div class="model-refresh">
            <button id="model-refresh-toggle" title="Reload Model">
              <img id="model-refresh-icon" src="scripts/svg/reload.svg" alt="model-refresh" fill="currentColor">
            </button>
          </div>
        </div>

        <div id="global-settings-right">
          <div class="header-status" id="header-status"></div>

          <div class="global-settings-right-to-left">
            <button id="global-settings-swap-layout-toggle" title="Right to left" >
              <img id="global-settings-swap-layout-icon" src="scripts/svg/swap.svg" alt="Right to left" fill="currentColor">
            </button>
          </div>

          <div class="settings-modal-launcher">
            <button id="settings-modal-toggle" title="Settings" aria-controls="settings-modal" aria-expanded="false">
              <img id="settings-modal-icon" src="scripts/svg/sliders.svg" alt="Settings" fill="currentColor">
            </button>
          </div>
        </div>
      </div>

      <div id="split">
        <div id="left">
          <div class="gallery-main-container ui-card">
            <div class="gallery-main-header ui-card-head">
              <span class="ui-card-title" id="viewer-title">Viewer</span>
              <span class="ui-card-sub" id="viewer-status"></span>
              <div class="ui-card-tools">
                <div class="gallery-main-latest"></div>
                <div class="gallery-main-keep"></div>
                <span class="gallery-main-header-span" hidden>
                  <span id="gallery-main-span"></span>
                  <img id="gallery-main-toggle" src="scripts/svg/mydropdown-arrow.svg" alt="><" fill="currentColor">
                </span>
              </div>
            </div>
            <div class="gallery-main-main"></div>
          </div>

          <div class="left-splitter" id="left-splitter" role="separator" aria-orientation="horizontal" aria-label="Resize info panel" tabindex="0"></div>

          <div class="image-infobox-container ui-card" id="info-panel">
            <div class="image-infobox-header ui-card-head info-tabs" role="tablist">
              <button type="button" class="info-tab is-active" role="tab" data-info-tab="info" aria-selected="true">Info</button>
              <button type="button" class="info-tab" role="tab" data-info-tab="characters" aria-selected="false">Characters</button>
              <button type="button" class="info-tab" role="tab" data-info-tab="ai" aria-selected="false">AI</button>
              <span class="ui-card-tools">
                <span class="image-infobox-header-span" hidden>
                  <span id="image-infobox-span"></span>
                  <img id="image-infobox-toggle" src="scripts/svg/mydropdown-arrow.svg" alt="><" fill="currentColor">
                </span>
              </span>
            </div>
            <div class="info-panels">
              <div class="info-panel image-infobox-main" data-info-panel="info" role="tabpanel"></div>
              <div class="info-panel gallery-thumb-container" data-info-panel="characters" role="tabpanel" hidden>
                <div class="gallery-thumb-header" hidden>
                  <div class="gallery-thumb-header-span">
                    <span id="gallery-thumb-span"></span>
                    <img id="gallery-thumb-toggle" src="scripts/svg/mydropdown-arrow.svg" alt="><" fill="currentColor">
                  </div>
                </div>
                <div class="gallery-thumb-main"></div>
              </div>
              <div class="info-panel ai-result-panel" data-info-panel="ai" role="tabpanel" hidden>
                <pre class="ai-result-text"></pre>
              </div>
            </div>
          </div>
        </div>

        <div id="right">
          <div id="right-scroll">
            <section class="ui-card characters-card" aria-label="Characters and views">
              <div class="ui-card-head">
                <span class="ui-card-title" data-ui-text="ui_characters_title">Characters &amp; Views</span>
                <span class="ui-card-sub" data-ui-text="ui_characters_sub">3 lists + OC · Angle / Camera</span>
                <div class="ui-card-tools">
                  <div class="regional-condition-trigger-dummy ui-switch"></div>
                </div>
              </div>
              <div class="ui-card-body">
                <div class="dropdown-character"></div>
                <div class="dropdown-character-regional"></div>
                <div class="dropdown-view"></div>
                <div class="regional-condition-container">
                  <div class="regional-condition-header" hidden>
                    <span id="regional-condition-span"></span>
                    <img id="regional-condition-toggle" src="scripts/svg/mydropdown-arrow.svg" alt="><" fill="currentColor">
                  </div>
                  <div class="regional-condition-main">
                    <div class="regional-condition-settings-1">
                      <div class="regional-condition-image-ratio"></div>
                      <div class="regional-condition-overlap-ratio"></div>
                      <div class="regional-condition-strength-left"></div>
                      <div class="regional-condition-strength-right"></div>
                      <div class="regional-condition-option-left"></div>
                      <div class="regional-condition-option-right"></div>
                      <div class="regional-condition-swap ui-switch"></div>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section class="ui-card prompts-card" id="prompt-text-container" aria-label="Prompts">
              <div class="ui-card-head">
                <span class="ui-card-title" data-ui-text="ui_prompts_title">Prompts</span>
                <span class="ui-card-sub" data-ui-text="ui_prompts_sub">Common → Background / Style → Character → Positive · Exclude applies to all</span>
                <div class="ui-card-tools">
                  <span class="preset-host" data-preset-host="prompt"></span>
                </div>
              </div>
              <div class="ui-card-body prompt-fields">
                <div class="prompt-common prompt-field" data-stripe="common">common</div>
                <div class="prompt-background prompt-field" data-stripe="view">background</div>
                <div class="prompt-style prompt-field" data-stripe="view">style</div>
                <div class="prompt-positive prompt-field" data-stripe="positive">positive</div>
                <div class="prompt-positive-right prompt-field" data-stripe="positive">positive-right</div>
                <div class="prompt-negative prompt-field" data-stripe="negative">negative</div>
                <div class="prompt-exclude prompt-field" data-stripe="exclude">exclude</div>

                <div class="ai-card" id="ai-card">
                  <div class="ai-card-head">
                    <span class="ai-card-title" data-ui-text="ui_ai_title">AI prompt</span>
                    <div class="ai-mode-segment" id="ai-mode-segment" role="radiogroup" aria-label="AI prompt mode"></div>
                    <div class="system-settings-ai-select ai-role"></div>
                    <span class="ai-card-status" id="ai-card-status"></span>
                    <div class="system-settings-ai-interface" hidden></div>
                    <div class="system-settings-ai-local-prompt-mode" hidden></div>
                  </div>
                  <div class="ai-card-body">
                    <div class="prompt-ai prompt-field" data-stripe="ai">ai</div>
                    <div class="ai-card-foot">
                      <span class="ai-card-note" id="ai-card-note" data-ui-text="ui_ai_note">Refine adds one Ollama call per batch before the first image.</span>
                      <div class="system-settings-ai-preview ui-switch"></div>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section class="ui-card pipeline-card" id="pipeline-card" aria-label="Pipeline">
              <div class="ui-card-head">
                <span class="ui-card-title" data-ui-text="ui_pipeline_title">Pipeline</span>
                <span class="ui-card-sub" data-ui-text="ui_pipeline_sub">runs in this order after the base image</span>
                <div class="ui-card-tools">
                  <span class="preset-host" data-preset-host="generation"></span>
                </div>
              </div>

              <div class="highres-fix-container pipe-row" data-pipe="hires">
                <div class="highres-fix-header pipe-row-head">
                  <div class="generate-hires-fix ui-switch pipe-row-switch"></div>
                  <span class="pipe-row-name" id="highres-fix-span" data-ui-text="ui_pipe_hires">Hires fix</span>
                  <span class="pipe-row-summary" data-pipe-summary="hires"></span>
                  <button type="button" class="pipe-row-chevron" data-pipe-toggle="highres-fix" aria-expanded="false"><img id="highres-fix-toggle" src="scripts/svg/mydropdown-arrow.svg" alt="" fill="currentColor"></button>
                </div>
                <div class="highres-fix-main pipe-row-body">
                  <div class="highres-fix-settings-1 pipe-grid">
                    <div class="hires-fix-model"></div>
                    <div class="hires-fix-scale"></div>
                    <div class="hires-fix-color-transfer"></div>
                    <div class="hires-fix-denoise"></div>
                    <div class="hires-fix-steps"></div>
                    <div class="hires-fix-random-seed ui-switch"></div>
                  </div>
                  <div class="hires-fix-resolution pipe-note"></div>
                </div>
              </div>

              <div class="refiner-container pipe-row" data-pipe="refiner">
                <div class="refiner-header pipe-row-head">
                  <div class="generate-refiner ui-switch pipe-row-switch"></div>
                  <span class="pipe-row-name" id="refiner-span" data-ui-text="ui_pipe_refiner">Refiner</span>
                  <span class="pipe-row-summary" data-pipe-summary="refiner"></span>
                  <button type="button" class="pipe-row-chevron" data-pipe-toggle="refiner" aria-expanded="false"><img id="refiner-toggle" src="scripts/svg/mydropdown-arrow.svg" alt="" fill="currentColor"></button>
                </div>
                <div class="refiner-main pipe-row-body">
                  <div class="refiner-settings-1 pipe-grid">
                    <div class="refiner-model"></div>
                    <div class="refiner-vpred"></div>
                    <div class="refiner-ratio"></div>
                    <div class="refiner-addnoise ui-switch"></div>
                  </div>
                </div>
              </div>

              <div class="adetailer-container pipe-row" data-pipe="adetailer">
                <div class="adetailer-header pipe-row-head">
                  <div class="generate-adetailer ui-switch pipe-row-switch"></div>
                  <span class="pipe-row-name" id="adetailer-span" data-ui-text="ui_pipe_adetailer">ADetailer</span>
                  <span class="pipe-row-summary" data-pipe-summary="adetailer"></span>
                  <span class="preset-host" data-preset-host="adetailer"></span>
                  <button type="button" class="pipe-row-chevron" data-pipe-toggle="adetailer" aria-expanded="false"><img id="adetailer-toggle" src="scripts/svg/mydropdown-arrow.svg" alt="" fill="currentColor"></button>
                </div>
                <div class="adetailer-main pipe-row-body"></div>
              </div>

              <div class="controlnet-container pipe-row" data-pipe="controlnet">
                <div class="controlnet-header pipe-row-head">
                  <div class="generate-controlnet ui-switch pipe-row-switch"></div>
                  <span class="pipe-row-name" id="controlnet-span" data-ui-text="ui_pipe_controlnet">ControlNet</span>
                  <span class="pipe-row-summary" data-pipe-summary="controlnet"></span>
                  <span class="preset-host" data-preset-host="controlnet"></span>
                  <button type="button" class="pipe-row-chevron" data-pipe-toggle="controlnet" aria-expanded="false"><img id="controlnet-toggle" src="scripts/svg/mydropdown-arrow.svg" alt="" fill="currentColor"></button>
                </div>
                <div class="controlnet-main pipe-row-body"></div>
              </div>

              <div class="add-lora-container pipe-row" data-pipe="lora">
                <div class="add-lora-header pipe-row-head">
                  <span class="pipe-row-count" data-pipe-count="lora">0</span>
                  <span class="pipe-row-name" id="add-lora-span">LoRA</span>
                  <span class="pipe-row-summary" data-pipe-summary="lora"></span>
                  <span class="preset-host" data-preset-host="lora"></span>
                  <button type="button" class="pipe-row-chevron" data-pipe-toggle="add-lora" aria-expanded="false"><img id="add-lora-toggle" src="scripts/svg/mydropdown-arrow.svg" alt="" fill="currentColor"></button>
                </div>
                <div class="add-lora-main pipe-row-body"></div>
              </div>

              <div class="jsonlist-container pipe-row" data-pipe="json">
                <div class="jsonlist-header pipe-row-head">
                  <span class="pipe-row-count" data-pipe-count="json">0</span>
                  <span class="pipe-row-name" id="jsonlist-span">JSON/CSV</span>
                  <span class="pipe-row-summary" data-pipe-summary="json"></span>
                  <button type="button" class="pipe-row-chevron" data-pipe-toggle="jsonlist" aria-expanded="false"><img id="jsonlist-toggle" src="scripts/svg/mydropdown-arrow.svg" alt="" fill="currentColor"></button>
                </div>
                <div class="jsonlist-main pipe-row-body"></div>
              </div>
            </section>
          </div>

          <div id="run-bar">
            <div class="run-status">
              <div class="run-progress" id="run-progress"></div>
              <div id="generate-buttons-2">
                <div class="generate-button-skip"></div>
                <div class="generate-button-cancel"></div>
              </div>
            </div>
            <div class="run-params">
              <div class="run-param run-param-seed">
                <span class="run-param-label" data-ui-text="ui_run_seed">Seed</span>
                <div class="run-param-controls">
                  <div class="generate-random-seed run-number"></div>
                  <button type="button" class="run-icon-button" id="seed-random-button" title="Random seed (-1)"></button>
                  <button type="button" class="run-icon-button" id="seed-reuse-button" title="Reuse last seed"></button>
                </div>
              </div>
              <div class="run-param run-param-size">
                <span class="run-param-label" data-ui-text="ui_run_size">Size</span>
                <div class="run-param-controls">
                  <div class="generate-width run-number"></div>
                  <span class="run-param-x">×</span>
                  <div class="generate-height run-number"></div>
                  <div class="generate-landscape run-icon-check" title="Landscape"></div>
                </div>
              </div>
              <div class="run-param run-param-steps">
                <span class="run-param-label" data-ui-text="ui_run_steps_cfg">Steps · CFG</span>
                <div class="run-param-controls">
                  <div class="generate-step run-number"></div>
                  <div class="generate-cfg run-number"></div>
                </div>
              </div>
              <div class="run-param run-param-batch">
                <span class="run-param-label" data-ui-text="ui_run_batch">Batch</span>
                <div class="run-param-controls">
                  <div class="generate-batch run-number"></div>
                </div>
              </div>
              <div class="run-param run-param-sampler">
                <span class="run-param-label" data-ui-text="ui_run_sampler">Sampler · Scheduler</span>
                <div class="run-param-controls">
                  <div class="generate-sampler run-select"></div>
                  <div class="generate-scheduler run-select"></div>
                </div>
              </div>
            </div>
            <div class="run-actions">
              <button type="button" class="queue-status" id="queue-status" aria-expanded="false" aria-controls="queue-drawer"></button>
              <span class="run-footnote" id="run-footnote"></span>
              <span class="run-saved" id="run-saved" hidden></span>
              <div id="generate-buttons-container">
                <div id="generate-buttons-1">
                  <div class="generate-button-single"></div>
                  <div class="generate-batch-menu" id="generate-batch-menu">
                    <button type="button" class="generate-batch-menu-button" id="generate-batch-menu-button" aria-haspopup="menu" aria-expanded="false"></button>
                    <div class="generate-batch-menu-list" id="generate-batch-menu-list" role="menu" hidden>
                      <div class="generate-button-batch" role="menuitem"></div>
                      <div class="generate-button-same" role="menuitem"></div>
                      <button type="button" class="generate-batch-menu-item" id="generate-batch-expand" role="menuitem"></button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div class="queue-drawer" id="queue-drawer" hidden>
              <div class="queue-container">
                <div class="queue-header">
                  <div class="queue-autostart-generate ui-switch"></div>
                  <div class="queue-header-span">
                    <span id="queue-span">Queue</span>
                    <img id="queue-toggle" src="scripts/svg/mydropdown-arrow.svg" alt="><" fill="currentColor" hidden>
                  </div>
                </div>
                <div class="queue-main"></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div id="settings-modal" hidden aria-hidden="true">
        <div class="settings-modal-backdrop" data-settings-modal-close></div>
        <section id="settings-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title" tabindex="-1">
          <div class="settings-modal-header">
            <span id="settings-modal-title">Settings</span>
            <button id="settings-modal-close" type="button" title="Close Settings" aria-label="Close Settings">×</button>
          </div>
          <div class="settings-modal-layout">
            <nav class="settings-modal-nav" role="tablist" aria-label="Settings sections">
              <button class="settings-modal-nav-item is-active" role="tab" type="button" data-settings-page="general" aria-controls="settings-page-general" aria-selected="true" tabindex="0">
                <span data-settings-page-label="general">General</span>
              </button>
              <button class="settings-modal-nav-item" role="tab" type="button" data-settings-page="backend" aria-controls="settings-page-backend" aria-selected="false" tabindex="-1">
                <span data-settings-page-label="backend">Backend</span>
              </button>
              <button class="settings-modal-nav-item" role="tab" type="button" data-settings-page="model" aria-controls="settings-page-model" aria-selected="false" tabindex="-1">
                <span data-settings-page-label="model">Model</span>
              </button>
              <button class="settings-modal-nav-item" role="tab" type="button" data-settings-page="ai" aria-controls="settings-page-ai" aria-selected="false" tabindex="-1">
                <span data-settings-page-label="ai">AI</span>
              </button>
              <button class="settings-modal-nav-item" role="tab" type="button" data-settings-page="prompt-editing" aria-controls="settings-page-prompt-editing" aria-selected="false" tabindex="-1">
                <span data-settings-page-label="prompt-editing">Prompt editing</span>
              </button>
              <button class="settings-modal-nav-item" role="tab" type="button" data-settings-page="advanced" aria-controls="settings-page-advanced" aria-selected="false" tabindex="-1">
                <span data-settings-page-label="advanced">Advanced</span>
              </button>
            </nav>

            <main class="settings-modal-content">
              <section id="settings-page-general" class="settings-modal-page" role="tabpanel" data-settings-page-content="general" aria-labelledby="settings-page-general-title" tabindex="0">
                <h2 id="settings-page-general-title" data-settings-page-label="general">General</h2>
                <div class="settings-grid">
                  <div class="global-settings-language"></div>
                  <div class="global-settings-themes">
                    <button id="global-settings-theme-toggle" title="Toggle Theme">
                      <img id="global-settings-theme-icon" src="scripts/svg/moon.svg" alt="Toggle Theme" fill="currentColor">
                    </button>
                  </div>
                  <div class="prompt-textbox-autoresize ui-switch"></div>
                  <div class="prompt-textbox-fontsize"></div>
                </div>
              </section>

              <section id="settings-page-backend" class="settings-modal-page" role="tabpanel" data-settings-page-content="backend" aria-labelledby="settings-page-backend-title" tabindex="0" hidden>
                <h2 id="settings-page-backend-title" data-settings-page-label="backend">Backend</h2>
                <div class="settings-grid">
                  <div class="system-settings-api-interface"></div>
                  <div class="system-settings-api-address"></div>
                  <div class="system-settings-api-refresh-rate"></div>
                  <div class="system-settings-api-subfolder ui-switch"></div>
                </div>
                <div class="settings-group">
                  <div class="settings-group-title" data-ui-text="ui_settings_models_group">Model folders &amp; filters</div>
                  <div class="settings-grid">
                    <div class="system-settings-api-fliter ui-switch"></div>
                    <div class="system-settings-api-fliter-list"></div>
                    <div class="system-settings-api-fliter-diffusion-list" data-when-model-type="Diffusion"></div>
                    <div class="system-settings-api-comfyui" data-when-api="ComfyUI"></div>
                    <div class="system-settings-api-webui" data-when-api="WebUI"></div>
                  </div>
                </div>
                <div class="settings-group">
                  <div class="settings-group-title" data-ui-text="ui_settings_output_group">Output</div>
                  <div class="settings-grid">
                    <div class="system-settings-api-comfyui-image-save-path" data-when-api="ComfyUI"></div>
                    <div class="system-settings-api-webui-image-save-path" data-when-api="WebUI"></div>
                    <div class="system-settings-api-embed_character_name ui-switch"></div>
                  </div>
                </div>
                <div class="settings-group" data-when-api="WebUI">
                  <div class="settings-group-title">WebUI (Forge)</div>
                  <div class="settings-grid">
                    <div class="system-settings-api-webui-auth"></div>
                    <div class="system-settings-api-webui-auth-enable"></div>
                  </div>
                </div>
              </section>

              <section id="settings-page-model" class="settings-modal-page" role="tabpanel" data-settings-page-content="model" aria-labelledby="settings-page-model-title" tabindex="0" hidden>
                <h2 id="settings-page-model-title" data-settings-page-label="model">Model</h2>
                <div class="settings-grid">
                  <div class="model-type"></div>
                  <div class="model-vpred"></div>
                  <div class="thumb-select"></div>
                </div>
                <div class="settings-group">
                  <div class="settings-group-title">Checkpoint: SDXL / Noob / IL / Pony / SD15</div>
                  <div class="settings-grid">
                    <div class="vae-sdxl"></div>
                    <div class="vae-override ui-switch"></div>
                  </div>
                </div>
                <div class="settings-group" data-when-model-type="Diffusion">
                  <div class="settings-group-title">Diffusion: Anima / Z Image / Qwen Image / Flux</div>
                  <div class="settings-grid">
                    <div class="diffusion-model-weight-dtype"></div>
                    <div class="vae-unet"></div>
                    <div class="text-encoder"></div>
                    <div class="text-encoder-type"></div>
                    <div class="text-encoder-device"></div>
                  </div>
                </div>
              </section>

              <section id="settings-page-ai" class="settings-modal-page" role="tabpanel" data-settings-page-content="ai" aria-labelledby="settings-page-ai-title" tabindex="0" hidden>
                <h2 id="settings-page-ai-title" data-settings-page-label="ai">AI</h2>
                <p class="settings-note" data-ui-text="ui_settings_ai_note">Mode (Off / Expand / Refine) and role are on the AI card of the prompt panel.</p>
                <div class="settings-group" data-when-ai="Local">
                  <div class="settings-group-title">Local (Ollama / llama.cpp)</div>
                  <div class="settings-grid">
                    <div class="system-settings-ai-local-address"></div>
                    <div class="system-settings-ai-local-model-mode"></div>
                    <div class="system-settings-ai-local-timeout"></div>
                    <div class="system-settings-ai-local-temperature"></div>
                    <div class="system-settings-ai-local-npredict"></div>
                  </div>
                </div>
                <div class="settings-group" data-when-ai="Remote">
                  <div class="settings-group-title">Remote (OpenAI-compatible)</div>
                  <div class="settings-grid">
                    <div class="system-settings-ai-address"></div>
                    <div class="system-settings-ai-modelselect"></div>
                    <div class="system-settings-ai-apikey"></div>
                    <div class="system-settings-ai-timeout"></div>
                  </div>
                </div>
                <div class="settings-group">
                  <div class="settings-group-title" data-ui-text="ui_settings_ai_prompts_group">System prompts</div>
                  <div class="settings-grid settings-grid-1">
                    <div class="system-settings-ai-sysprompt"></div>
                    <div class="system-settings-ai-refine-sysprompt"></div>
                  </div>
                </div>
              </section>

              <section id="settings-page-prompt-editing" class="settings-modal-page" role="tabpanel" data-settings-page-content="prompt-editing" aria-labelledby="settings-page-prompt-editing-title" tabindex="0" hidden>
                <h2 id="settings-page-prompt-editing-title" data-settings-page-label="prompt-editing">Prompt editing</h2>
                <div class="settings-grid">
                  <div class="generate-tag-assist ui-switch"></div>
                  <div class="generate-wildcard-random ui-switch"></div>
                </div>
              </section>

              <section id="settings-page-advanced" class="settings-modal-page" role="tabpanel" data-settings-page-content="advanced" aria-labelledby="settings-page-advanced-title" tabindex="0" hidden>
                <h2 id="settings-page-advanced-title" data-settings-page-label="advanced">Advanced</h2>
                <div class="settings-grid">
                  <div class="global-refresh">
                    <button id="settings-open-folder" type="button" title="Open settings folder" class="settings-action-button">
                      <span data-ui-text="ui_settings_open_folder">Open settings folder</span>
                    </button>
                    <button id="global-refresh-toggle" title="Refresh Page" class="settings-action-button">
                      <img id="global-refresh-icon" src="scripts/svg/refresh.svg" alt="refresh" fill="currentColor">
                      <span data-ui-text="ui_settings_refresh_page">Refresh page</span>
                    </button>
                  </div>
                </div>
                <p class="settings-note" data-ui-text="ui_settings_advanced_note">Settings are saved automatically (settings/app.json, state.json). Presets live in settings/presets/&lt;section&gt;/. SAAC web service and the CDP debug port are configured outside this window (app.json / SAA_CDP_PORT).</p>
              </section>
            </main>
          </div>
        </section>
      </div>

    </div>`;
