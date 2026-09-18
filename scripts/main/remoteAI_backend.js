import { ipcMain, net } from 'electron';
import {
    buildOllamaChatRequest,
    isOllamaChatUrl,
    normalizeOllamaChatResponse,
    resolveChatTimeout,
} from './ollamaSaaAdapter.js';
import { backendAuthHeaders } from '../shared/backendAddress.js';
import { isPodSshChatUrl } from '../shared/llmEndpoint.js';
import { podOllamaRequest } from './podSshTransport.js';
import { normalizeKeepAlive } from '../shared/ollamaModels.js';
import { getGlobalSettings } from './globalSettings.js';
import { armRequestTimeout } from './requestTimeout.js';

const CAT = '[ModelAPI]';

function requestRemote(options) {
    return new Promise((resolve, reject) => {
        const { apiUrl, apiKey, modelSelect, userPrompt, systemPrompt, timeout } = options;

        const requestBody = {
            model: modelSelect,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `${userPrompt};Response in English` }
            ],
        };
        const body = JSON.stringify(requestBody);

        let request = net.request({
            method: 'POST',
            url: apiUrl,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            timeout: timeout,
        });


        // net.request has no working timeout option or 'timeout' event (requestTimeout.js)
        const clearRequestTimeout = armRequestTimeout({
            timeout,
            onTimeout: ms => {
                console.error(`${CAT} Request timed out after ${ms}ms`);
                resolve(`Error: Request timed out after ${ms}ms`);
            },
            abort: () => request.abort(),
        });

        request.on('response', (response) => {
            let responseData = ''
            response.on('data', (chunk) => {
                responseData += chunk
            })
            response.on('end', () => {
                clearRequestTimeout();
                if (response.statusCode !== 200) {
                    console.error(`${CAT} HTTP error: ${response.statusCode} - ${responseData}`);
                    return resolve(`Error: HTTP error: ${response.statusCode}`);
                }

                resolve(responseData);
            })
        })

        request.on('error', (error) => {
            clearRequestTimeout();
            let ret = '';
            if (error.code === 'ECONNABORTED') {
                console.error(`${CAT} Request timed out after ${timeout}ms`);
                ret = `Request timed out after ${timeout}ms`;
            } else {
                console.error(CAT, 'Request failed:', error.message);
                ret = `Request failed:, ${error.message}`;
            }
            resolve(ret);
        });

        request.on('timeout', () => {
            request.abort();
            console.error(`${CAT} Request timed out after ${timeout}ms`);
            resolve(`Error: Request timed out after ${timeout}ms`);
        });

        request.write(body);
        request.end();        
    });
}

function requestLocal(options) {
    return new Promise((resolve, reject) => {
        const {
            apiUrl,
            apiAuth,
            userPrompt,
            systemPrompt,
            temperature,
            n_predict,
            timeout,
            modelMode,
            aiUse,
            promptMode,
            refineSystemPrompt,
            existingPositive,
            existingNegative,
            existingPositiveRight,
            editorFields,
            generationContext,
            keepAlive,
        } = options;

        const useOllama = isOllamaChatUrl(apiUrl);
        // a structured Refine writes every field again and is floored above the AI card's
        // timeout: cutting it loses the whole edit, waiting only costs time (ollamaSaaAdapter.js)
        const requestTimeout = resolveChatTimeout({ timeout, promptMode, editorFields, generationContext });
        const requestBody = useOllama
            ? buildOllamaChatRequest({
                mode: modelMode,
                use: aiUse,
                promptMode,
                systemPrompt,
                refineSystemPrompt,
                userPrompt,
                existingPositive,
                existingNegative,
                existingPositiveRight,
                editorFields,
                generationContext,
                temperature,
                n_predict,
                ...(keepAlive === undefined ? {} : { keepAlive: normalizeKeepAlive(keepAlive, 0) }),
            })
            : {
                temperature: temperature,
                n_predict: n_predict,
                cache_prompt: true,
                stop: ["<|im_end|>"],
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `${userPrompt};Response in English` }
                ],
            };
        if (isPodSshChatUrl(apiUrl)) {
            // Pod Ollama over the SSH relay: same request body, the reply comes back
            // as JSON from the relay instead of an HTTP response.
            const settings = getGlobalSettings();
            const podModel = String(settings?.ai_pod_model ?? '').trim();
            // the pod keeps the model warm between Refine / Expand calls (ai_pod_keep_alive);
            // runPodWorkflow unloads it before an image generation needs the VRAM
            const podBody = {
                ...requestBody,
                ...(podModel ? { model: podModel } : {}),
                keep_alive: normalizeKeepAlive(settings?.ai_pod_keep_alive, '10m'),
            };
            // no limit asked for: the relay keeps its own default rather than 0ms
            podOllamaRequest({ settings, method: 'POST', path: '/api/chat', body: podBody, timeoutMs: requestTimeout || undefined })
                .then(reply => {
                    if (!reply.ok) {
                        console.error(`${CAT} pod ollama: ${reply.message}`);
                        return resolve(`Error: ${reply.message}`);
                    }
                    try {
                        return resolve(JSON.stringify(normalizeOllamaChatResponse(JSON.stringify(reply.json))));
                    } catch (error) {
                        console.error(`${CAT} Invalid Ollama response: ${error.message}`);
                        return resolve('Error: Invalid Ollama response');
                    }
                })
                .catch(error => resolve(`Error: ${error.message}`));
            return;
        }
        const body = JSON.stringify(requestBody);

        let request = net.request({
            method: 'POST',
            url: apiUrl,
            headers: {
                'Content-Type': 'application/json',
                ...backendAuthHeaders(apiAuth),
            },
            timeout: requestTimeout || undefined,
        });
       

        // net.request has no working timeout option or 'timeout' event: a stalled local LLM
        // would hold the queue forever, so the limit is armed here (requestTimeout.js)
        const clearRequestTimeout = armRequestTimeout({
            timeout: requestTimeout,
            onTimeout: ms => {
                console.error(`${CAT} Request timed out after ${ms}ms`);
                resolve(`Error: Request timed out after ${ms}ms`);
            },
            abort: () => request.abort(),
        });

        request.on('response', (response) => {
            let responseData = ''            
            response.on('data', (chunk) => {
                responseData += chunk
            })
            response.on('end', () => {
                clearRequestTimeout();
                if (response.statusCode !== 200) {
                    console.error(`${CAT} HTTP error: ${response.statusCode} - ${responseData}`);
                    return resolve(`Error: HTTP error: ${response.statusCode}`);
                }

                if (useOllama) {
                    try {
                        return resolve(JSON.stringify(normalizeOllamaChatResponse(responseData)));
                    } catch (error) {
                        console.error(`${CAT} Invalid Ollama response: ${error.message}`);
                        return resolve('Error: Invalid Ollama response');
                    }
                }

                return resolve(responseData);
            })
        })

        request.on('error', (error) => {
            clearRequestTimeout();
            let ret = '';
            if (error.code === 'ECONNABORTED') {
                console.error(`${CAT} Request timed out after ${timeout}ms`);
                ret = `Request timed out after ${timeout}ms`;
            } else {
                console.error(CAT, 'Request failed:', error.message);
                ret = `Request failed:, ${error.message}`;
            }
            resolve(ret);
        });

        request.on('timeout', () => {
            request.destroy();
            console.error(`${CAT} Request timed out after ${timeout}ms`);
            resolve(`Error: Request timed out after ${timeout}ms`);
        });

        request.write(body);
        request.end();        
    });
}

function setupModelApi() {
    ipcMain.handle('request-ai-remote', async (event, options) => {
        return await requestRemote(options);
    });

    ipcMain.handle('request-ai-local', async (event, options) => {
        return await requestLocal(options);
    });
}

async function remoteAI(options){
    return await requestRemote(options);
}

async function localAI(options){
    return await requestLocal(options);
}

export {
    setupModelApi,
    remoteAI,
    localAI
};
