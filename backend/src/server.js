// Entry point (Cloud Run sets PORT).
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createGeminiGenerator } from './gemini.js';
import { logger } from './logger.js';

const config = loadConfig();
const app = createApp({ config, generate: createGeminiGenerator(config) });

const server = app.listen(config.port, () => {
  logger.info('tab-classifier démarré', {
    port: config.port,
    provider: config.provider,
    model: config.model,
    location: config.provider === 'vertex' ? config.location : undefined,
    auth: Boolean(config.extensionToken),
    allowedOrigins: config.allowedOrigins.length ? config.allowedOrigins : 'chrome-extension://*',
  });
  if (config.provider === 'vertex' && !config.project) {
    logger.warn('GOOGLE_CLOUD_PROJECT non défini : chaque requête utilisera le repli heuristique.');
  }
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
