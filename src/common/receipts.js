import { createHmac, timingSafeEqual } from 'node:crypto';
import { sha256 } from './db.js';

/**
 * Signed receipt envelope.
 *
 * Every receipt is signed by the service that emitted it over a canonical
 * serialisation of all business fields. The exchange service verifies the
 * signature, then checks that (batchId, attemptId, token) still identify a
 * live attempt before letting the receipt change any state. Receipts are
 * therefore self-contained: a duplicate, a late delivery or a receipt that
 * names the wrong batch can be recognised without trusting arrival order.
 */
export const RECEIPT_KINDS = Object.freeze({
  RECEIVED: 'received',
  FORMAT: 'format',
  INGEST: 'ingest',
});

export const RECEIPT_ISSUERS = Object.freeze({
  EXCHANGE: 'exchange',
  VALIDATION: 'validation',
  INGESTION: 'ingestion',
});

export function receiptBody({ issuer, kind, batchId, attemptId, token, seq, outcome, details, emittedAt }) {
  return { issuer, kind, batchId, attemptId, token, seq, outcome, details: details ?? null, emittedAt };
}

export function signReceipt(secret, body) {
  return createHmac('sha256', secret)
    .update(
      JSON.stringify({
        issuer: body.issuer ?? null,
        kind: body.kind ?? null,
        batchId: body.batchId ?? null,
        attemptId: body.attemptId ?? null,
        token: body.token ?? null,
        seq: body.seq ?? null,
        outcome: body.outcome ?? null,
        details: body.details ?? null,
        emittedAt: body.emittedAt ?? null,
      }),
    )
    .digest('hex');
}

export function makeReceipt(secret, fields) {
  const body = receiptBody(fields);
  return { ...body, signature: signReceipt(secret, body) };
}

export function verifyReceipt(secret, receipt) {
  if (!receipt || typeof receipt !== 'object') return false;
  if (typeof receipt.signature !== 'string') return false;
  const expected = signReceipt(secret, receipt);
  const a = Buffer.from(receipt.signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Content fingerprint of an uploaded file. The filename is deliberately not
 * part of the hash: the same payload re-uploaded under another name is a
 * duplicate, while a changed payload under the same name is not.
 */
export function fileFingerprint(contentBase64) {
  const digest = sha256(Buffer.from(contentBase64, 'base64'));
  return `sha256:${digest}`;
}

/** Stable key for exact-duplicate detection (signature included). */
export function receiptKey(receipt) {
  return sha256(
    JSON.stringify({
      issuer: receipt.issuer ?? null,
      kind: receipt.kind ?? null,
      batchId: receipt.batchId ?? null,
      attemptId: receipt.attemptId ?? null,
      token: receipt.token ?? null,
      seq: receipt.seq ?? null,
      outcome: receipt.outcome ?? null,
      details: receipt.details ?? null,
      emittedAt: receipt.emittedAt ?? null,
      signature: receipt.signature ?? null,
    }),
  );
}
