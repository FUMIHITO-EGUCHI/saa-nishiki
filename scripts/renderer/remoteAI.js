import { sendWebSocketMessage } from '../webserver/front/wsRequest.js';
import { isOllamaChatUrl } from '../shared/ollamaUrl.js';
let lastAIPromot = '';

async function remoteGenerateWithPrompt(aiOptions = null) {
    try {
        const options = aiOptions || {
                apiUrl: globalThis.ai.remote_address.getValue(),
                apiKey: globalThis.ai.remote_apikey.getValue(),
                modelSelect: globalThis.ai.remote_model_select.getValue(),
                userPrompt: globalThis.prompt.ai.getValue(),
                systemPrompt: globalThis.ai.ai_system_prompt.getValue(),
                timeout: globalThis.ai.remote_timeout.getValue() * 1000
            };
        let result;
        if (globalThis.inBrowser) {
            result = await sendWebSocketMessage({ type: 'API', method: 'remoteAI', params: [options] });
        } else {
            result = await globalThis.api.remoteAI(options);
        }

        if(result.startsWith('Error:')){
            console.error('Request remote AI failed:', result);
            return '';
        }
        
        let parsedResult;
        try {
            parsedResult = JSON.parse(result);
        } catch (error) {
            console.error('Failed to parse JSON response:', error.message);
            return '';
        }

        const content = parsedResult?.choices?.[0]?.message?.content;
        if (!content) {
            console.error('Content not found in response:', parsedResult);
            return '';
        }
        // Just in case, trim off <think>...</think>
        const final_result = content.replace(/<think>[\s\S]*<\/think>\s*/, '').trim();
        return final_result;
    } catch (error) {
        console.error('Request remote AI failed:', error.message);
        return '';
    }
}

async function localGenerateWithPrompt(aiOptions = null) {
    try {
        const options = aiOptions || {
                apiUrl: globalThis.ai.local_address.getValue(),
                userPrompt: globalThis.prompt.ai.getValue(),
                systemPrompt: globalThis.ai.ai_system_prompt.getValue(),
                modelMode: globalThis.ai.local_model_mode.getValue(),
                aiUse: 'preview',
                promptMode: 'Expand',
                temperature: globalThis.ai.local_temp.getValue(),
                n_predict:globalThis.ai.local_n_predict.getValue(),
                timeout: globalThis.ai.local_timeout.getValue() * 1000
            };

        let result;
        if (globalThis.inBrowser) {
            result = await sendWebSocketMessage({ type: 'API', method: 'localAI', params: [options] });
        } else {
            result = await globalThis.api.localAI(options);
        }

        if(result.startsWith('Error:')){
            console.error('Request local AI failed:', result);
            return '';
        }
        
        let parsedResult;
        try {
            parsedResult = JSON.parse(result);
        } catch (error) {
            console.error('Failed to parse JSON local response:', error.message);
            return '';
        }

        const content = parsedResult?.choices?.[0]?.message?.content;
        if (!content) {
            console.error('Content not found in local response:', parsedResult);
            return '';
        }
        // trim off <think>...</think>
        const final_result = content.replace(/<think>[\s\S]*<\/think>\s*/, '').trim();
        return final_result;
    } catch (error) {
        console.error('Request local AI failed:', error.message);
        return '';
    }
}


export async function getAiPromptResult(loop, overlay_generate_ai, aiInterface=null, aiRole=null, aiOptions=null, runCache=null) {
    const currentInterface = aiInterface ?? globalThis.ai.interface.getValue();
    const currentRole = aiRole ?? globalThis.ai.ai_select.getValue();

    if(currentRole === 0)   // None
        return { content: '', fresh: false, source: 'none' };
    else if(currentRole === 1 && loop !== 0 && runCache?.lastAiPrompt)   // Once
        return { content: runCache?.lastAiPrompt ?? '', fresh: false, source: 'run-cache' };
    else if(currentRole === 3 )   // Last
        return { content: lastAIPromot, fresh: false, source: 'last-run' };
    if (currentInterface.toLowerCase() === 'none') {
        return { content: '', fresh: false, source: 'none' };
    } else if (currentInterface.toLowerCase() === 'remote') {     
        globalThis.generate.loadingMessage = overlay_generate_ai;
        lastAIPromot = await remoteGenerateWithPrompt(aiOptions);        
    } else {
        globalThis.generate.loadingMessage = overlay_generate_ai;
        lastAIPromot = await localGenerateWithPrompt(aiOptions);
    }
    if (runCache) runCache.lastAiPrompt = lastAIPromot;
    return { content: lastAIPromot, fresh: true, source: 'request' };
}

export async function getAiPrompt(loop, overlay_generate_ai, aiInterface=null, aiRole=null, aiOptions=null, runCache=null) {
    return (await getAiPromptResult(loop, overlay_generate_ai, aiInterface, aiRole, aiOptions, runCache)).content;
}

export function isStructuredRefineRequest({ aiInterface, aiOptions, runSame = false } = {}) {
    return !runSame
        && String(aiInterface ?? '').toLowerCase() === 'local'
        && String(aiOptions?.promptMode ?? '').toLowerCase() === 'refine'
        && isOllamaChatUrl(aiOptions?.apiUrl);
}
