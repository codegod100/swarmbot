/**
 * Freeq PDS session auth for swarm IRC.
 *
 * Flow:
 * 1. Load a local Rookery-style creds record from FREEQ_CREDS_PATH or
 *    ~/.config/swarm/freeq-creds.json.
 * 2. POST /xrpc/com.atproto.server.createSession with DPoP auth.
 * 3. Use the returned accessJwt as the Freeq IRC SASL pds-session signature.
 */

import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_CREDS_PATH = join(homedir(), '.config', 'swarm', 'freeq-creds.json');

export interface RsaPublicJwk {
  kty: string;
  n: string;
  e: string;
}

interface RookeryCredsRecord {
  did: string;
  handle: string;
  access_token: string;
  private_key_pem: string;
  public_jwk: RsaPublicJwk;
  thumbprint?: string;
  pds_host?: string;
  pds_origin: string;
}

export interface FreeqCredentials {
  did: string;
  handle: string;
  accessToken: string;
  privateKeyPem: string;
  publicJwk: RsaPublicJwk;
  pdsOrigin: string;
}

export interface FreeqSession {
  did: string;
  handle: string;
  accessJwt: string;
  pdsOrigin: string;
}

function resolveCredsPath(filePath = process.env.FREEQ_CREDS_PATH?.trim() || DEFAULT_CREDS_PATH): string {
  return filePath;
}

function base64url(input: Buffer | Uint8Array): string {
  return Buffer.from(input).toString('base64url');
}

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, '');
}

function createJwt(header: object, payload: object, privateKeyPem: string): string {
  const encode = (value: object) => base64url(Buffer.from(JSON.stringify(value), 'utf8'));
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = crypto.createSign('SHA256');
  signature.update(signingInput);
  signature.end();
  return `${signingInput}.${base64url(signature.sign(privateKeyPem))}`;
}

function createDpopProof(
  method: string,
  url: string,
  accessToken: string,
  publicJwk: RsaPublicJwk,
  privateKeyPem: string,
): string {
  const ath = base64url(crypto.createHash('sha256').update(accessToken).digest());
  return createJwt(
    { typ: 'dpop+jwt', alg: 'RS256', jwk: publicJwk },
    {
      jti: crypto.randomUUID(),
      htm: method,
      htu: url,
      iat: Math.floor(Date.now() / 1000),
      ath,
    },
    privateKeyPem,
  );
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing or invalid ${field}`);
  }
  return value;
}

function parseRookeryCredsRecord(raw: unknown): RookeryCredsRecord {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Freeq creds file must contain a JSON object');
  }

  const record = raw as Record<string, unknown>;
  const publicJwk = record.public_jwk;
  if (!publicJwk || typeof publicJwk !== 'object') {
    throw new Error('Missing or invalid public_jwk');
  }

  const jwk = publicJwk as Record<string, unknown>;

  return {
    did: requireString(record.did, 'did'),
    handle: requireString(record.handle, 'handle'),
    access_token: requireString(record.access_token, 'access_token'),
    private_key_pem: requireString(record.private_key_pem, 'private_key_pem'),
    public_jwk: {
      kty: requireString(jwk.kty, 'public_jwk.kty'),
      n: requireString(jwk.n, 'public_jwk.n'),
      e: requireString(jwk.e, 'public_jwk.e'),
    },
    thumbprint: typeof record.thumbprint === 'string' ? record.thumbprint : undefined,
    pds_host: typeof record.pds_host === 'string' ? record.pds_host : undefined,
    pds_origin: requireString(record.pds_origin, 'pds_origin'),
  };
}

/**
 * Load a local Freeq creds record.
 */
export async function loadFreeqCredentials(filePath = resolveCredsPath()): Promise<FreeqCredentials> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const record = parseRookeryCredsRecord(JSON.parse(content));
    return {
      did: record.did,
      handle: record.handle,
      accessToken: record.access_token,
      privateKeyPem: record.private_key_pem,
      publicJwk: record.public_jwk,
      pdsOrigin: normalizeOrigin(record.pds_origin),
    };
  } catch (err) {
    const path = filePath;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to load Freeq creds from ${path}: ${detail}\n` +
      `Set FREEQ_CREDS_PATH to a rookery creds JSON file (for example scripts/rookery-creds.json).`,
    );
  }
}

/**
 * Create a short-lived Freeq session token from the local creds.
 */
export async function createFreeqSession(creds: FreeqCredentials): Promise<FreeqSession> {
  const url = `${normalizeOrigin(creds.pdsOrigin)}/xrpc/com.atproto.server.createSession`;
  const dpop = createDpopProof('POST', url, creds.accessToken, creds.publicJwk, creds.privateKeyPem);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `DPoP ${creds.accessToken}`,
      DPoP: dpop,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`createSession failed (${res.status}): ${body}`);
  }

  const data = await res.json() as Partial<{ did: string; handle: string; accessJwt: string }>;
  if (typeof data.accessJwt !== 'string' || data.accessJwt.length === 0) {
    throw new Error('createSession response missing accessJwt');
  }

  return {
    did: typeof data.did === 'string' ? data.did : creds.did,
    handle: typeof data.handle === 'string' ? data.handle : creds.handle,
    accessJwt: data.accessJwt,
    pdsOrigin: normalizeOrigin(creds.pdsOrigin),
  };
}

function parseChallengeNonce(challengeBase64url: string): string | undefined {
  try {
    const challengeJson = Buffer.from(challengeBase64url, 'base64url').toString('utf8');
    const challenge = JSON.parse(challengeJson) as { nonce?: unknown };
    return typeof challenge.nonce === 'string' ? challenge.nonce : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build a Freeq SASL response for pds-session auth.
 */
export function buildPdsSessionPayload(session: FreeqSession, challengeBase64url: string): string {
  const payload: Record<string, unknown> = {
    did: session.did,
    method: 'pds-session',
    signature: session.accessJwt,
    pds_url: session.pdsOrigin,
  };

  const challengeNonce = parseChallengeNonce(challengeBase64url);
  if (challengeNonce) {
    payload.challenge_nonce = challengeNonce;
  }

  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}
