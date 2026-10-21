import { element,button,select,field,tr,image } from './workflowUi.js';
export async function showWorkflowRun(container,id,openImage,guard) {
    const api=globalThis.api,run=await api.workflowReadRun(id);
    container.replaceChildren(element('h3',`${run.status} · ${new Date(run.createdAt).toLocaleString()}`));
    const samplers=Object.entries(run.provenance.nodes).filter(([,node])=>node.onOutputPath&&/Sampler|Detailer/.test(node.classType));
    const table=element('table');
    const head=element('tr');for(const text of [tr('工程','Stage'),tr('モデルの接続元','Model sources'),'Seed','Steps','CFG','Sampler / Scheduler','Denoise',tr('証跡','Evidence')])head.append(element('th',text));table.append(head);
    for(const [id,node] of samplers){
        const sourceIds=node.sources.model??node.sources.basic_pipe??[];
        const models=sourceIds.flatMap(source=>{const inputs=run.apiPrompt[source]?.inputs??{};return [inputs.ckpt_name,inputs.unet_name,inputs.lora_name].filter(Boolean);});
        const row=element('tr');for(const text of [`${node.classType} #${id}`,models.join(', ')||'unknown',node.inputs.seed??node.inputs.noise_seed??'—',node.inputs.steps??'—',node.inputs.cfg??'—',`${node.inputs.sampler_name??'—'} / ${node.inputs.scheduler??'—'}`,node.inputs.denoise??'—',node.state])row.append(element('td',String(text)));table.append(row);
    }
    container.append(table);
    container.append(element('p',tr('モデル欄は接続元です。Detailer内部の検出対象数・再描画の有無は、証跡を取得できない場合は不明です。','Model sources show graph connections. Detailer target counts and internal repainting are unknown when no evidence is available.')));
    if(run.error)container.append(element('p',run.error,'workflow-error'));
    if(run.output){
        const final=await api.workflowImage('runs',id,run.output.asset);
        const controls=element('div','','workflow-actions');
        const chooser=select([{value:run.output.asset,label:tr('最終画像','Final image')},...run.stages.filter(s=>s.asset).map(s=>({value:s.asset,label:s.label}))]);
        const preview=image(final,tr('同一runの段階比較','Compare stages from this run'));preview.className='workflow-run-image';
        chooser.addEventListener('change',()=>guard(async()=>{preview.src=await api.workflowImage('runs',id,chooser.value);}));
        field(controls,tr('比較する工程','Stage'),chooser);
        controls.append(button(tr('この画像を部分編集','Edit this image'),()=>guard(()=>openImage(final,`Run ${id.slice(0,8)}`,id))));
        container.append(controls,preview);
    }
    const details=element('details');details.append(element('summary',tr('指定・送信API・工程の由来・実行証跡','Requested settings, API, provenance and execution evidence')));
    details.append(element('p',tr('接続は静的な依存関係です。unknownは実行証跡を確認できていない状態です。','Connections describe static dependencies. Unknown means execution evidence is unavailable.')));
    details.append(element('pre',JSON.stringify(run,null,2)));container.append(details);
}
