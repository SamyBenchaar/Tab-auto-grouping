// Express application: GET /health, GET /privacy, GET /me, POST /classify.
import express from 'express';
import { runClassification } from './core/pipeline.js';
import { normalizeClassifyRequest, RequestError } from './core/request.js';
import { logger } from './logger.js';
import { renderPrivacyPage } from './privacy.js';
import { authenticate, cors, rateLimit } from './security.js';

const PAGE_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'public, max-age=3600',
};

/**
 * @param {{config: ReturnType<import('./config.js').loadConfig>,
 *          generate: (input: object) => Promise<string>,
 *          verifyGoogleToken: (token: string) => Promise<{subject: string}>,
 *          quota: ReturnType<import('./quota.js').createQuota>}} deps injected for tests
 */
export function createApp({ config, generate, verifyGoogleToken, quota }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Cloud Run front end: req.ip = real client address
  app.use(cors(config));
  app.use(express.json({ limit: '64kb' }));

  // Rate limit first: it also bounds the Google token checks a single client can trigger.
  const limited = [rateLimit(config), authenticate(config, { verifyGoogleToken })];
  const privacyPage = renderPrivacyPage(config);

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      provider: config.provider,
      model: config.model,
      location: config.provider === 'vertex' ? config.location : undefined,
      version: config.version,
    });
  });

  // Public privacy policy (Chrome Web Store listing, Google sign-in consent screen).
  app.get('/privacy', (req, res) => {
    res.set(PAGE_HEADERS).type('html').send(privacyPage);
  });

  // Who is calling and today's usage (options page). Counts nothing.
  app.get('/me', ...limited, async (req, res) => {
    if (req.auth.kind !== 'google') return res.json({ auth: req.auth.kind, quota: null });
    try {
      res.json({ auth: 'google', quota: await quota.peek(req.auth.userKey) });
    } catch (error) {
      logger.error('Quota indisponible', { error: error?.message });
      res.status(503).json({ error: 'Compteur quotidien momentanément indisponible.', code: 'quota_unavailable' });
    }
  });

  app.post('/classify', ...limited, async (req, res, next) => {
    const started = Date.now();
    try {
      normalizeClassifyRequest(req.body); // invalid input: 400 before anything is counted

      let usage = null;
      if (req.auth.kind === 'google') {
        let decision;
        try {
          decision = await quota.consume(req.auth.userKey);
        } catch (error) {
          logger.error('Quota indisponible', { error: error?.message });
          return res.status(503).json({ error: 'Compteur quotidien momentanément indisponible.', code: 'quota_unavailable' });
        }
        if (!decision.allowed) {
          logger.info('daily_limit', { scope: decision.scope });
          const seconds = Math.ceil((Date.parse(decision.quota.resetAt) - Date.now()) / 1000);
          res.set('Retry-After', String(Math.max(seconds, 1)));
          return res.status(429).json({
            error:
              decision.scope === 'user'
                ? `Limite quotidienne atteinte (${config.dailyLimitPerUser} regroupements IA par jour).`
                : 'Capacité quotidienne du service atteinte.',
            code: 'daily_limit',
            scope: decision.scope,
            quota: decision.quota,
          });
        }
        usage = decision.quota;
      }

      const result = await runClassification(req.body, {
        generate,
        retries: 1,
        onError: (error, attempt) =>
          logger.warn('Échec de l’appel Gemini', { attempt: attempt + 1, status: error?.status, error: error?.message }),
      });
      const latencyMs = Date.now() - started;
      logger.info('classify', {
        auth: req.auth.kind,
        tabs: req.body.tabs.length,
        existingGroups: Array.isArray(req.body.existingGroups) ? req.body.existingGroups.length : 0,
        groups: result.groups.length,
        ungrouped: result.ungrouped.length,
        source: result.source,
        attempts: result.attempts,
        latencyMs,
      });
      res.json({
        groups: result.groups,
        ungrouped: result.ungrouped,
        source: result.source,
        model: result.source === 'gemini' ? config.model : null,
        latencyMs,
        ...(result.error ? { error: result.error } : {}),
        ...(usage ? { quota: usage } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((req, res) => res.status(404).json({ error: 'Route inconnue.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error instanceof RequestError) return res.status(400).json({ error: error.message });
    if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalide.' });
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Requête trop volumineuse.' });
    logger.error('Erreur interne', { error: error?.message, stack: error?.stack });
    res.status(500).json({ error: 'Erreur interne.' });
  });

  return app;
}
