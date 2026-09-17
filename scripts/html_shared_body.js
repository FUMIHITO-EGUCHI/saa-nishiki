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

          <div class="edit-history-controls" role="group" aria-label="Edit history">
            <button type="button" id="edit-history-undo" class="edit-history-button" disabled></button>
            <button type="button" id="edit-history-redo" class="edit-history-button" disabled></button>
            <span id="edit-history-status" class="edit-history-status" role="status" aria-live="polite"></span>
          </div>

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
                <span class="ui-card-sub" data-ui-text="ui_characters_sub">Characters (incl. OC) · weight per slot</span>
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
                      <div class="regional-condition-split"></div>
                      <div class="regional-condition-image-ratio"></div>
                      <div class="regional-condition-overlap-ratio"></div>
                    </div>
                    <div class="regional-condition-settings-2">
                      <div class="regional-condition-side regional-condition-side-left">
                        <div class="regional-condition-option-left"></div>
                        <div class="regional-condition-strength-left run-number"></div>
                      </div>
                      <div class="regional-condition-side regional-condition-side-right">
                        <div class="regional-condition-option-right"></div>
                        <div class="regional-condition-strength-right run-number"></div>
                      </div>
                      <div class="regional-condition-swap ui-switch"></div>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section class="ui-card artist-card" id="artist-card" aria-label="Artist" hidden>
              <div class="ui-card-head">
                <span class="ui-card-title" data-ui-text="ui_artist_title">Artist</span>
                <span class="ui-card-sub" data-ui-text="ui_artist_sub">sent as @name · one is usually enough</span>
              </div>
              <div class="ui-card-body">
                <div class="dropdown-artist" id="dropdown-artist"></div>
              </div>
            </section>

            <section class="ui-card prompts-card" id="prompt-text-container" aria-label="Prompts">
              <div class="ui-card-head">
                <span class="ui-card-title" data-ui-text="ui_prompts_title">Prompts</span>
                <span class="ui-card-sub" data-ui-text="ui_prompts_sub">Common → View → Background / Style → Character → Positive · Exclude applies to all</span>
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
                <div class="prompt-negative-left prompt-field" data-stripe="negative">negative-left</div>
                <div class="prompt-negative-right prompt-field" data-stripe="negative">negative-right</div>
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

            <section class="ui-card prose-card" id="prose-card" aria-label="Prose" hidden>
              <div class="ui-card-head">
                <span class="ui-card-title" data-ui-text="ui_prose_title">Prose</span>
                <div class="system-settings-ai-prose ui-switch" id="ai-prose-switch"></div>
                <span class="ui-card-sub" id="prose-card-status"></span>
                <div class="ui-card-tools">
                  <span class="prose-scope-label" data-ui-text="ui_prose_scope_label">Dissolve</span>
                  <div class="ai-mode-segment prose-scope-segment" id="prose-scope-segment" role="radiogroup" aria-label="Prose scope"></div>
                </div>
              </div>
              <div class="ui-card-body prose-card-body">
                <textarea class="prose-preview" id="prose-preview" rows="4" spellcheck="false"></textarea>
                <div class="prose-card-foot">
                  <span class="prose-card-note" id="prose-card-note"></span>
                  <button type="button" class="prose-button" id="prose-revert" data-ui-text="ui_prose_revert" hidden>Revert</button>
                  <button type="button" class="prose-button" id="prose-regenerate" data-ui-text="ui_prose_regenerate">Regenerate</button>
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
                <span class="run-param-label" id="run-size-label"><span data-ui-text="ui_run_size">Size</span> <span class="run-param-range" id="run-size-range" title="Size range for the current model type (Settings > Model)"></span></span>
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
                  <button type="button" class="run-mini-button" id="anima-defaults" data-ui-text="ui_anima_defaults" hidden>Anima defaults</button>
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
              <button class="settings-modal-nav-item" role="tab" type="button" data-settings-page="lists" aria-controls="settings-page-lists" aria-selected="false" tabindex="-1">
                <span data-settings-page-label="lists">Lists</span>
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
                  <div class="settings-group-title" data-ui-text="ui_settings_output_group">Output</div><span class="settings-info" tabindex="0" role="note"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"></circle><path d="M8 7.3v3.9"></path><circle cx="8" cy="5.1" r=".7" fill="currentColor" stroke="none"></circle></svg><span class="settings-info-text" data-ui-text="ui_settings_output_note">Save path: a folder under the backend's output directory (%date expands to today's date). Character name in folder prefix: the selected characters' names go in front of the output folder prefix.</span></span>
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
                <div class="settings-group" data-when-api="ComfyUI">
                  <div class="settings-group-title" data-ui-text="ui_comfy_proc_title">ComfyUI process</div><span class="settings-info" tabindex="0" role="note"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"></circle><path d="M8 7.3v3.9"></path><circle cx="8" cy="5.1" r=".7" fill="currentColor" stroke="none"></circle></svg><span class="settings-info-text" data-ui-text="ui_comfy_proc_note">Launch command: a start script (.ps1 / .cmd) or python main.py with its arguments. Start runs it and waits for the backend on the ComfyUI address above (loopback only); with Start ComfyUI with SAA on, it also runs at launch when the backend does not answer. Stop unloads the models, then ends whatever holds that port.</span></span>
                  <!-- Start / stop / restart of the local backend (scripts/renderer/comfyProcessControl.js);
                       hidden in the browser build, which has no process to talk to. -->
                  <div class="comfy-proc-panel">
                    <div class="settings-grid">
                      <div class="system-settings-comfy-launch-command"></div>
                      <div class="system-settings-comfy-autostart ui-switch"></div>
                    </div>
                    <div class="pod-row comfy-proc-row">
                      <span class="status-pill comfy-proc-pill" role="button" tabindex="0" title="Check"><i></i><span>—</span></span>
                      <span class="pod-facts comfy-proc-status"></span>
                      <div class="pod-row-actions">
                        <button type="button" class="pod-btn pod-btn-primary comfy-proc-start" data-ui-text="ui_comfy_start">Start</button>
                        <button type="button" class="pod-btn comfy-proc-restart" data-ui-text="ui_comfy_restart">Restart</button>
                        <button type="button" class="pod-btn pod-btn-danger comfy-proc-stop" data-ui-text="ui_comfy_stop">Stop</button>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="settings-group" data-when-api="ComfyUI">
                  <div class="settings-group-title">Runpod pod over SSH</div><span class="settings-info" tabindex="0" role="note"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"></circle><path d="M8 7.3v3.9"></path><circle cx="8" cy="5.1" r=".7" fill="currentColor" stroke="none"></circle></svg><span class="settings-info-text" data-ui-text="ui_settings_pod_ssh_note">Generation and the LLM run on the pod over one SSH session. Images stream over SSH and are saved locally only; nothing is written to the pod's disks. The API address above is ignored while this is on. Start / Stop need a Runpod API key (used for start / stop only) and never terminate the pod. SSH target: podid-user@ssh.runpod.io. SSH private key: empty = ~/.ssh/id_ed25519. Pod id: empty = taken from the SSH target.</span></span>
                  <!-- One state-driven panel (scripts/renderer/podControl.js): the pill reports
                       the pod, and an action is only rendered while it applies. -->
                  <div class="pod-panel">
                    <div class="pod-panel-head">
                      <span class="pod-panel-title" data-ui-text="ui_pod_panel_title">Runpod pod</span>
                      <span class="settings-info" tabindex="0" role="note"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"></circle><path d="M8 7.3v3.9"></path><circle cx="8" cy="5.1" r=".7" fill="currentColor" stroke="none"></circle></svg><span class="settings-info-text" data-ui-text="ui_pod_panel_sub">generation and the LLM run on the pod over one SSH session</span></span>
                      <div class="system-settings-api-pod-ssh-enable ui-switch pod-panel-switch"></div>
                    </div>
                    <div class="pod-panel-body">
                      <div class="pod-row pod-row-power">
                        <span class="status-pill pod-state-pill" role="button" tabindex="0"><i></i><span class="pod-state-text">—</span></span>
                        <span class="pod-facts"></span>
                        <div class="pod-row-actions">
                          <button type="button" class="pod-btn pod-btn-check" hidden data-ui-text="ui_pod_check">Check pod</button>
                          <button type="button" class="pod-btn pod-btn-primary pod-btn-start" hidden data-ui-text="ui_pod_start">Start pod</button>
                          <button type="button" class="pod-btn pod-btn-danger pod-btn-stop" hidden data-ui-text="ui_pod_stop">Stop pod</button>
                        </div>
                      </div>
                      <div class="pod-sep pod-sep-services" hidden></div>
                      <div class="pod-row pod-row-services" hidden>
                        <span class="pod-row-label" data-ui-text="ui_pod_row_services">Services</span>
                        <span class="status-pill pod-chip pod-chip-comfy"><i></i><span>ComfyUI</span></span>
                        <span class="status-pill pod-chip pod-chip-ollama"><i></i><span>Ollama</span></span>
                        <span class="pod-inventory"></span>
                        <div class="pod-row-actions">
                          <button type="button" class="pod-btn pod-btn-warn pod-btn-repair" hidden data-ui-text="ui_pod_repair">Restart services</button>
                          <button type="button" class="pod-btn pod-btn-models" data-ui-text="ui_pod_fetch_models">Refresh lists</button>
                        </div>
                      </div>
                      <div class="pod-sep"></div>
                      <div class="pod-row pod-row-setup">
                        <span class="pod-row-label" data-ui-text="ui_pod_row_setup">Setup</span>
                        <span class="pod-setup-summary"></span>
                        <div class="pod-row-actions">
                          <button type="button" class="pod-btn pod-btn-setup" data-ui-text="ui_pod_wizard_open">Pod setup</button>
                        </div>
                      </div>
                      <div class="pod-sep"></div>
                      <div class="pod-row pod-row-connection">
                        <span class="pod-row-label" data-ui-text="ui_pod_row_connection">Connection</span>
                        <span class="pod-connection-summary"></span>
                        <div class="pod-row-actions">
                          <button type="button" class="pod-btn pod-btn-edit" aria-expanded="false" data-ui-text="ui_pod_edit">Edit</button>
                        </div>
                      </div>
                      <div class="pod-connection-fields" hidden>
                        <div class="settings-grid">
                          <div class="system-settings-api-pod-ssh-target"></div>
                          <div class="system-settings-api-pod-ssh-key"></div>
                          <div class="system-settings-api-pod-ssh-port"></div>
                          <div class="system-settings-api-pod-save-dir"></div>
                          <div class="system-settings-api-pod-runpod-key"></div>
                          <div class="system-settings-api-pod-runpod-pod-id"></div>
                          <div class="system-settings-api-pod-civitai-token"></div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <p class="settings-note system-settings-api-pod-result"></p>
                </div>
                <div class="settings-group" data-when-api="ComfyUI">
                  <div class="settings-group-title" data-ui-text="ui_settings_fast_group">Fast generation</div><span class="settings-info" tabindex="0" role="note"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"></circle><path d="M8 7.3v3.9"></path><circle cx="8" cy="5.1" r=".7" fill="currentColor" stroke="none"></circle></svg><span class="settings-info-text" data-ui-text="ui_settings_fast_note">Applies a step-distillation LoRA (DMD2 / Hyper-SD / Lightning / LCM) and overrides steps, CFG, sampler and scheduler for the base, Hires fix and ADetailer passes. Works on the local ComfyUI and on the pod.</span></span>
                  <div class="settings-grid">
                    <div class="system-settings-api-fast-enable ui-switch"></div>
                    <div class="system-settings-api-fast-lora"></div>
                    <div class="system-settings-api-fast-lora-strength"></div>
                    <div class="system-settings-api-fast-steps"></div>
                    <div class="system-settings-api-fast-cfg"></div>
                    <div class="system-settings-api-fast-sampler"></div>
                    <div class="system-settings-api-fast-scheduler"></div>
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
                    <div class="size-limit-checkpoint"></div>
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
                    <div class="size-limit-diffusion"></div>
                  </div>
                </div>
              </section>

              <section id="settings-page-ai" class="settings-modal-page" role="tabpanel" data-settings-page-content="ai" aria-labelledby="settings-page-ai-title" tabindex="0" hidden>
                <h2 id="settings-page-ai-title" data-settings-page-label="ai">AI<span class="settings-info" tabindex="0" role="note"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"></circle><path d="M8 7.3v3.9"></path><circle cx="8" cy="5.1" r=".7" fill="currentColor" stroke="none"></circle></svg><span class="settings-info-text" data-ui-text="ui_settings_ai_note">Mode (Off / Expand / Refine) and role are on the AI card of the prompt panel.</span></span></h2>
                <div class="settings-group" data-when-ai="Local">
                  <div class="settings-group-title">Local (Ollama / llama.cpp)</div><span class="settings-info" tabindex="0" role="note"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"></circle><path d="M8 7.3v3.9"></path><circle cx="8" cy="5.1" r=".7" fill="currentColor" stroke="none"></circle></svg><span class="settings-info-text" data-ui-text="ui_settings_ai_local_note">Endpoint: an Ollama /api/chat or llama.cpp server URL. Prompt mode: Expand grows the prompt, Refine edits the existing prompts and weights.</span></span>
                  <div class="settings-grid">
                    <div class="system-settings-ai-local-address"></div>
                  </div>
                </div>
                <div class="settings-group" data-when-ai="Pod">
                  <div class="settings-group-title">Runpod pod (Ollama)</div><span class="settings-info" tabindex="0" role="note"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"></circle><path d="M8 7.3v3.9"></path><circle cx="8" cy="5.1" r=".7" fill="currentColor" stroke="none"></circle></svg><span class="settings-info-text" data-ui-text="ui_settings_pod_llm_note">The model list comes from the pod itself. Download fetches the named model into the pod's workspace (minutes); Unload frees the GPU, and image generation unloads the model by itself. Keep-alive: 10m, 1h, or 0 = unload after each call. The endpoint (https://{pod}-11434.proxy.runpod.net) and auth (Bearer token or user:pass) below are only used when Pod SSH is not configured.</span></span>
                  <!-- The model row IS the model list: listing is not an action, and Download /
                       Unload only appear in the state that calls for them. -->
                  <div class="pod-panel pod-llm-panel">
                    <div class="pod-panel-body">
                      <div class="pod-row pod-row-llm">
                        <span class="pod-row-label" data-ui-text="ui_pod_row_model">Model</span>
                        <div class="system-settings-ai-pod-model pod-llm-model"></div>
                        <span class="status-pill pod-chip pod-chip-llm" hidden><i></i><span></span></span>
                        <div class="pod-row-actions">
                          <button type="button" class="pod-btn pod-btn-primary pod-btn-llm-pull" hidden data-ui-text="ui_pod_llm_pull">Download</button>
                          <button type="button" class="pod-btn pod-btn-llm-unload" hidden data-ui-text="ui_pod_llm_unload">Unload</button>
                          <button type="button" class="pod-btn pod-btn-llm-check" data-ui-text="ui_pod_llm_models">Check models</button>
                        </div>
                      </div>
                      <div class="pod-row pod-row-llm-keep">
                        <span class="pod-row-label"></span>
                        <span class="settings-info" tabindex="0" role="note"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"></circle><path d="M8 7.3v3.9"></path><circle cx="8" cy="5.1" r=".7" fill="currentColor" stroke="none"></circle></svg><span class="settings-info-text" data-ui-text="ui_pod_llm_hint">unloaded automatically before each image generation</span></span>
                        <div class="system-settings-ai-pod-keep-alive pod-llm-keep"></div>
                      </div>
                    </div>
                  </div>
                  <p class="settings-note system-settings-ai-pod-llm-result"></p>
                  <div class="pod-llm-proxy">
                    <div class="settings-grid">
                      <div class="system-settings-ai-pod-address"></div>
                      <div class="system-settings-ai-pod-share ui-switch"></div>
                      <div class="system-settings-ai-pod-auth"></div>
                    </div>
                  </div>
                </div>
                <div class="settings-group" data-when-ai="Local|Pod">
                  <div class="settings-group-title">Model &amp; sampling</div>
                  <div class="settings-grid">
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
                  <div class="system-settings-tag-chip-alias ui-switch"></div>
                </div>
              </section>

              <section id="settings-page-lists" class="settings-modal-page" role="tabpanel" data-settings-page-content="lists" aria-labelledby="settings-page-lists-title" tabindex="0" hidden>
                <h2 id="settings-page-lists-title" data-settings-page-label="lists">Lists<span class="settings-info" tabindex="0" role="note"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"></circle><path d="M8 7.3v3.9"></path><circle cx="8" cy="5.1" r=".7" fill="currentColor" stroke="none"></circle></svg><span class="settings-info-text" data-ui-text="ui_lists_settings_note">Add, override or hide entries of the character / original character / angle / camera lists. Upstream data stays read-only; your edits are saved as a diff (settings/user_lists.json) and can be exported / imported.</span></span></h2>
                <div class="settings-grid">
                  <button id="list-manager-open" type="button" class="settings-action-button">
                    <span data-ui-text="ui_lists_open_settings">Open list manager…</span>
                  </button>
                </div>
              </section>

              <section id="settings-page-advanced" class="settings-modal-page" role="tabpanel" data-settings-page-content="advanced" aria-labelledby="settings-page-advanced-title" tabindex="0" hidden>
                <h2 id="settings-page-advanced-title" data-settings-page-label="advanced">Advanced<span class="settings-info" tabindex="0" role="note"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"></circle><path d="M8 7.3v3.9"></path><circle cx="8" cy="5.1" r=".7" fill="currentColor" stroke="none"></circle></svg><span class="settings-info-text" data-ui-text="ui_settings_advanced_note">Settings are saved automatically (settings/app.json, state.json). Presets live in settings/presets/&lt;section&gt;/. SAAC web service and the CDP debug port are configured outside this window (app.json / SAA_CDP_PORT).</span></span></h2>
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
              </section>
            </main>
          </div>
        </section>
      </div>

    </div>`;
