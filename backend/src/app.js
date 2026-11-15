// Express application: GET /health, POST /classify.
import express from 'express';
import { runClassification } from './core/pipeline.js';
import { RequestError } from './core/request.js';
import { logger } from './logger.js';
import { cors, rateLimit, requireToken } from './security.js';

/**
 * @param {{config: ReturnType<import('./config.js').loadConfig>,
 *          generate: (input: object) => Promise<string>}} deps generate = model call (injected for tests)
 */
export function createApp({ config, generate }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Cloud Run front end: req.ip = real client address
  app.use(cors(config));
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      provider: config.provider,
      model: config.model,
      location: config.provider === 'vertex' ? config.location : undefined,
      version: config.version,
    });
  });

  app.post('/classify', requireToken(config), rateLimit(config), async (req, res, next) => {
    const started = Date.now();
    try {
      const result = await runClassification(req.body, {
        generate,
        retries: 1,
        onError: (error, attempt) =>
          logger.warn('Échec de l’appel Gemini', { attempt: attempt + 1, status: error?.status, error: error?.message }),
      });
      const latencyMs = Date.now() - started;
      logger.info('classify', {
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
