// Structured JSON logs (one line per entry), parsed natively by Cloud Logging.
// Privacy: never log tab titles, URLs or queries — only counts, latency and errors.
const SILENT = process.env.LOG_LEVEL === 'silent';

function write(severity, message, fields = {}) {
  if (SILENT) return;
  const line = JSON.stringify({ severity, message, ...fields, time: new Date().toISOString() });
  if (severity === 'INFO') console.log(line);
  else console.error(line);
}

export const logger = {
  info: (message, fields) => write('INFO', message, fields),
  warn: (message, fields) => write('WARNING', message, fields),
  error: (message, fields) => write('ERROR', message, fields),
};
