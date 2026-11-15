// Runtime configuration (environment variables; see .env.example).
import { DEFAULT_GEMINI_MODEL } from './core/constants.js';

function toNumber(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function loadConfig(env = process.env) {
  const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '';
  const forceVertex = env.GOOGLE_GENAI_USE_VERTEXAI === 'true' || env.GOOGLE_GENAI_USE_ENTERPRISE === 'true';
  return {
    port: toNumber(env.PORT, 8080),
    // 'vertex': Vertex AI with Application Default Credentials (service account on Cloud Run).
    // 'gemini-api': AI Studio key, handy for local development without a GCP project.
    provider: forceVertex || !apiKey ? 'vertex' : 'gemini-api',
    project: env.GOOGLE_CLOUD_PROJECT || '',
    // 'eu' = EU multi-region endpoint (aiplatform.eu.rep.googleapis.com), keeps processing in the EU.
    location: env.GOOGLE_CLOUD_LOCATION || 'eu',
    apiKey,
    model: env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    thinking: env.GEMINI_THINKING_LEVEL || '',
    temperature: env.GEMINI_TEMPERATURE ? toNumber(env.GEMINI_TEMPERATURE, undefined) : undefined,
    timeoutMs: toNumber(env.GEMINI_TIMEOUT_MS, 8000),
    extensionToken: env.EXTENSION_TOKEN || '',
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(/[\s,;]+/).filter(Boolean),
    rateLimitPerMinute: toNumber(env.RATE_LIMIT_PER_MINUTE, 30),
    onCloudRun: Boolean(env.K_SERVICE),
    version: env.K_REVISION || 'local',
  };
}
