import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countLabel,
  summarizeADetailer,
  summarizeControlNet,
  summarizeHires,
  summarizeJson,
  summarizeLoRA,
  summarizeRefiner,
  summarizeRegional,
} from '../scripts/renderer/tools/pipelineSummary.js';

test('hires summary lists scale, upscaler stem, denoise, steps and the resulting size', () => {
  const summary = summarizeHires({ api_hf_scale: 1.5, api_hf_upscaler_selected: 'RealESRGAN_x4plus_anime_6B.pth', api_hf_denoise: 0.4, api_hf_steps: 20, width: 1024, height: 1024 });
  assert.equal(summary, '×1.5 · RealESRGAN_x4plus_anime_6B · denoise 0.40 · 20 steps · → 1536 × 1536');
  assert.equal(summarizeHires({}), '');
  assert.equal(summarizeHires({ api_hf_scale: 2, width: 1000, height: 600 }), '×2.0 · → 2000 × 1200');
});

test('refiner summary uses the model stem, ratio and add-noise flag', () => {
  assert.equal(summarizeRefiner({ api_refiner_model: 'sub\\waiIllustriousSDXL_v170.safetensors', api_refiner_ratio: 0.4, api_refiner_add_noise: true }), 'waiIllustriousSDXL_v170 · ratio 0.4 · add noise');
  assert.equal(summarizeRefiner({ api_refiner_model: 'x.safetensors', api_refiner_ratio: 1, api_refiner_add_noise: false }), 'x · ratio 1.0');
});

test('slot summaries: ADetailer, ControlNet, LoRA, JSON', () => {
  assert.equal(summarizeADetailer([]), 'no slots');
  assert.equal(summarizeADetailer([{ model: 'face_yolov8m.pt', sam: 'sam_vit_b_01ec64.pth', denoise: 0.5 }, { model: 'hand_yolov8n.pt', enabled: true }]), 'face_yolov8m · sam_vit_b · denoise 0.50 · +1');
  assert.equal(summarizeADetailer([{ model: 'face_yolov8m.pt', enabled: false }], { noSlots: 'なし' }), 'なし');
  assert.equal(summarizeControlNet([{ model: 'control_openpose.safetensors', strength: 0.8 }, { model: '', strength: 1 }]), 'control_openpose 0.8 · slot 1.0');
  assert.equal(summarizeLoRA([{ name: 'add_detail_xl.safetensors', strength: 0.8 }, { name: 'ibuki_douji_v2', strength: 0.6, enabled: false }]), 'add_detail_xl 0.8 · ibuki_douji_v2 (off)');
  assert.equal(summarizeLoRA([]), 'none');
  assert.equal(summarizeJson([{ name: 'poses.json' }, { name: 'styles.csv', enabled: false }]), 'poses.json · styles.csv (off)');
});

test('regional summary and count labels', () => {
  assert.equal(summarizeRegional({ regional_image_ratio: 50, regional_overlap_ratio: 20, regional_str_left: 1, regional_str_right: 1.2, regional_swap: true }), 'L/R 50 · overlap 20 · 1.0 / 1.2 · swapped');
  assert.equal(countLabel(2), '2');
  assert.equal(countLabel(undefined), '0');
  assert.equal(countLabel(-1), '0');
});
