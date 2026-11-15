// Runtime configuration (environment variables; see .env.example).
import { DEFAULT_GEMINI_MODEL } from './core/constants.js';

function toNumber(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

const toList = (value) => String(value ?? '').split(/[\s,;]+/).filter(Boolean);
const toLimit = (value, fallback) => Math.max(0, Math.floor(toNumber(value, fallback)));

export function loadConfig(env = process.env) {
  const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '';
  const forceVertex = env.GOOGLE_GENAI_USE_VERTEXAI === 'true' || env.GOOGLE_GENAI_USE_ENTERPRISE === 'true';
  const onCloudRun = Boolean(env.K_SERVICE);
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
    // Owner token (Secret Manager): full access, no daily limit. Never share it.
    extensionToken: env.EXTENSION_TOKEN || '',
    // Google sign-in: OAuth client IDs (type "Chrome extension") whose access tokens are accepted.
    oauthClientIds: toList(env.GOOGLE_OAUTH_CLIENT_IDS),
    // Gemini classifications per signed-in user and per UTC day, and for all users together (0 = no limit).
    dailyLimitPerUser: toLimit(env.DAILY_LIMIT_PER_USER, 50),
    globalDailyLimit: toLimit(env.GLOBAL_DAILY_LIMIT, 300),
    // 'firestore': counters shared by every Cloud Run instance. 'memory': local development and tests.
    quotaStore: ['firestore', 'memory'].includes(env.QUOTA_STORE) ? env.QUOTA_STORE : onCloudRun ? 'firestore' : 'memory',
    privacyContact: String(env.PRIVACY_CONTACT ?? '').trim(),
    allowedOrigins: toList(env.ALLOWED_ORIGINS),
    rateLimitPerMinute: toNumber(env.RATE_LIMIT_PER_MINUTE, 30),
    onCloudRun,
    version: env.K_REVISION || 'local',
  };
}
