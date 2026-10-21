// Interactive verification helper. Uses an isolated settings directory.
// node tests/e2e/workflow-edit-session.mjs
import fs from 'node:fs';
import path from 'node:path';
import { launchApp, REPO_ROOT } from './harness.mjs';
const app=await launchApp({settings:{api_addr:process.env.SAA_E2E_COMFY??'127.0.0.1:8189',
    api_model_file_select:'waiIllustriousSDXL_v160.safetensors',width:768,height:512,step:24,cfg:5,
    custom_prompt:'still life, wicker basket filled with yellow pears on the left, folded plain beige linen cloth on the right, wooden table, soft window light, painting, no people',
    api_prompt:'',api_prompt_right:'',api_neg_prompt:'person, human, text, watermark, blurry'}});
const evidence=path.join(REPO_ROOT,'reports','workflow-edit-2026-10-21');
fs.mkdirSync(evidence,{recursive:true});
fs.writeFileSync(path.join(evidence,'session.json'),JSON.stringify({runDir:app.runDir,settingsDir:app.settingsDir,webSocketUrl:app.page.ws.url}));
console.log('Verification session:',app.runDir);
process.on('SIGINT',async()=>{await app.close();process.exit(0);});
