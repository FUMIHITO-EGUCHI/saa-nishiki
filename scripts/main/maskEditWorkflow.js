import { gzipSync } from 'node:zlib';
import { splitLoraText } from '../shared/loraStageModels.js';

export function maskEditWorkflow(prepared, settings) {
    const { tags, plain } = splitLoraText(settings.positive);
    const node = (class_type, inputs) => ({ class_type, inputs });
    return {
        '1': node('GzippedBase64ToImage', { base64text: gzipSync(prepared.inputImage).toString('base64') }),
        '2': node('GzippedBase64ToImage', { base64text: gzipSync(prepared.generationMask).toString('base64') }),
        '3': node('ImageToMask', { image: ['2',0], channel: 'red' }),
        '4': node('CheckpointLoaderSimple', { ckpt_name: settings.model }),
        '5': node('LoRAfromText', { model:['4',0], clip:['4',1], text:tags }),
        '6': node('CLIPTextEncode', { clip:['5',1], text:plain }),
        '7': node('CLIPTextEncode', { clip:['5',1], text:settings.negative }),
        '8': node('ToBasicPipe', { model:['5',0],clip:['5',1],vae:['4',2],positive:['6',0],negative:['7',0] }),
        '9': node('MaskDetailerPipe', { image:['1',0],mask:['3',0],basic_pipe:['8',0],
            guide_size:512,guide_size_for:false,max_size:1024,mask_mode:true,seed:settings.seed,
            steps:settings.steps,cfg:settings.cfg,sampler_name:settings.sampler,scheduler:settings.scheduler,
            denoise:settings.denoise,feather:0,crop_factor:3,drop_size:1,refiner_ratio:0.2,batch_size:1,cycle:1,
            inpaint_model:false,noise_mask_feather:0,bbox_fill:false,contour_fill:false }),
        '29': node('PreviewImage', { images:['9',0] }),
    };
}
