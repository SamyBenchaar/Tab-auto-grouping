// Gemini call through the Google Gen AI SDK: Vertex AI (service account / ADC) or AI Studio key.
import { GoogleGenAI } from '@google/genai';
import { thinkingConfigFor } from './core/thinking.js';

class GenerationError extends Error {
  constructor(message, { status = 0, retryable = true } = {}) {
    super(message);
    this.name = 'GenerationError';
    this.status = status;
    this.retryable = retryable;
  }
}

function toGenerationError(error, timeoutMs) {
  if (error instanceof GenerationError) return error;
  const aborted = error?.name === 'AbortError' || /aborted|abort/i.test(String(error?.message));
  if (aborted) return new GenerationError(`Délai de ${timeoutMs / 1000} s dépassé.`, { status: 408 });
  const status = Number(error?.status ?? error?.code) || 0;
  // 400 (bad argument), 401/403 (permissions), 404 (unknown model or location): retrying will not help.
  const retryable = !status || status === 408 || status === 429 || status >= 500;
  return new GenerationError(`${status ? `Gemini ${status} : ` : ''}${error?.message ?? error}`.slice(0, 500), { status, retryable });
}

/**
 * @param {ReturnType<import('./config.js').loadConfig>} config
 * @returns {(input: {systemInstruction: string, userContent: string, schema: object}) => Promise<string>}
 */
export function createGeminiGenerator(config) {
  let client = null;
  const getClient = () => {
    if (client) return client;
    if (config.provider === 'vertex') {
      if (!config.project) {
        throw new GenerationError('GOOGLE_CLOUD_PROJECT non défini (mode Vertex AI).', { retryable: false });
      }
      client = new GoogleGenAI({ vertexai: true, project: config.project, location: config.location });
    } else {
      client = new GoogleGenAI({ apiKey: config.apiKey });
    }
    return client;
  };
  const thinkingConfig = thinkingConfigFor(config.model, config.thinking);

  return async function generate({ systemInstruction, userContent, schema }) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, config.timeoutMs);
    });
    try {
      const request = getClient().models.generateContent({
        model: config.model,
        contents: [{ role: 'user', parts: [{ text: userContent }] }],
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
          maxOutputTokens: 8192,
          ...(thinkingConfig ? { thinkingConfig } : {}),
          // Gemini 3.x: Google recommends keeping the default temperature (1.0); override only on purpose.
          ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
          abortSignal: controller.signal,
        },
      });
      const response = await Promise.race([request, timeout]);
      const text = response.text;
      if (!text) {
        throw new GenerationError(`Réponse vide du modèle (finishReason : ${response.candidates?.[0]?.finishReason ?? 'inconnu'}).`);
      }
      return text;
    } catch (error) {
      throw toGenerationError(error, config.timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  };
}
