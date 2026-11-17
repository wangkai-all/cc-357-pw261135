import { timingSafeEqual } from 'node:crypto';
import { HttpError } from './db.js';

export function internalAuth(expectedToken) {
  return (req, res, next) => {
    const supplied = req.get('x-internal-token') || '';
    const a = Buffer.from(supplied, 'utf8');
    const b = Buffer.from(expectedToken, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return next(new HttpError(401, 'UNAUTHORIZED', 'missing or invalid internal token'));
    }
    return next();
  };
}

export class RemoteError extends Error {
  constructor(message, { status = 0, body = null, code = 'REMOTE_ERROR', url } = {}) {
    super(message);
    this.name = 'RemoteError';
    this.status = status;
    this.body = body;
    this.code = code;
    this.url = url;
  }
}

export async function requestJson(url, { method = 'GET', body, token, timeoutMs = 4000, requestId } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { 'x-internal-token': token } : {}),
        ...(requestId ? { 'x-request-id': requestId } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text.slice(0, 500) };
      }
    }
    if (!response.ok) {
      throw new RemoteError(parsed?.error?.message || `remote responded ${response.status}`, {
        status: response.status,
        body: parsed,
        code: parsed?.error?.code || 'REMOTE_HTTP_ERROR',
        url,
      });
    }
    return { status: response.status, body: parsed };
  } catch (error) {
    if (error instanceof RemoteError) throw error;
    const reason = error?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : error?.message || String(error);
    throw new RemoteError(`cannot reach ${url}: ${reason}`, { code: 'REMOTE_UNREACHABLE', url });
  } finally {
    clearTimeout(timer);
  }
}

export function decodeBase64Strict(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  if (value.length % 4 !== 0) return null;
  const buffer = Buffer.from(value, 'base64');
  const normalised = buffer.toString('base64').replace(/=+$/, '');
  // Round-trip check catches strings that decode to different bytes than they claim.
  if (normalised !== value.replace(/=+$/, '')) return null;
  return buffer;
}
