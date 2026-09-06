import { ipcMain, net } from 'electron';
import {
    buildOllamaChatRequest,
    isOllamaChatUrl,
    normalizeOllamaChatResponse,
} from './ollamaSaaAdapter.js';
import { backendAuthHeaders } from '../shared/backendAddress.js';
import { isPodSshChatUrl } from '../shared/llmEndpoint.js';
import { podOllamaRequest } from './podSshTransport.js';
import { getGlobalSettings } from './globalSettings.js';

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
       

        request.on('response', (response) => {
            let responseData = ''            
            response.on('data', (chunk) => {
                responseData += chunk
            })
            response.on('end', () => {
                if (response.statusCode !== 200) {
                    console.error(`${CAT} HTTP error: ${response.statusCode} - ${responseData}`);
                    resolve(`Error: HTTP error: ${response.statusCode}`);
                }

                resolve(responseData);
            })
        })

        request.on('error', (error) => {
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
            req.destroy();
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
        } = options;

        const useOllama = isOllamaChatUrl(apiUrl);
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
            const podBody = podModel ? { ...requestBody, model: podModel } : requestBody;
            podOllamaRequest({ settings, method: 'POST', path: '/api/chat', body: podBody, timeoutMs: timeout })
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
            timeout: timeout,
        });
       

        request.on('response', (response) => {
            let responseData = ''            
            response.on('data', (chunk) => {
                responseData += chunk
            })
            response.on('end', () => {
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
