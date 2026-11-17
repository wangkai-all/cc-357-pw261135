import express from 'express';
import { HttpError, newId, nowIso } from './db.js';

export function requestIdMiddleware(req, res, next) {
  req.requestId = req.get('x-request-id') || newId('req');
  res.set('x-request-id', req.requestId);
  next();
}

export function createApp(name) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '8mb' }));
  app.use(requestIdMiddleware);
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      console.log(
        JSON.stringify({
          ts: nowIso(),
          service: name,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms: Math.round(ms),
          requestId: req.requestId,
        }),
      );
    });
    next();
  });
  return app;
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `no route ${req.method} ${req.path}` } });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details ?? null },
      requestId: req.requestId,
    });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { code: 'INVALID_JSON', message: 'request body is not valid JSON' },
      requestId: req.requestId,
    });
  }
  console.error('unhandled', err);
  return res.status(500).json({
    error: { code: 'INTERNAL', message: 'internal error' },
    requestId: req.requestId,
  });
}

/** Small async wrapper so route handlers can throw. */
export const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
