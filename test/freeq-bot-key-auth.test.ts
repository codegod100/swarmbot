import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, webcrypto } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildPdsSessionPayload, createFreeqSession, type FreeqCredentials, type FreeqSession } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { IrcAdapter } from '../src/channels/irc/adapter.js';
import { channelPlugin } from '../src/channels/irc/plugin.js';

const crypto = globalThis.crypto ?? webcrypto;
const DEFAULT_URL = process.env.FREEQ_IRC_URL ?? 'wss://irc.freeq.at/irc';

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64url');
}

function decodeJwt(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [headerPart, payloadPart] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<string, unknown>,
  };
}

function makeFreeqCredentials(): FreeqCredentials {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const publicJwk = createPublicKey(publicKey).export({ format: 'jwk' }) as {
    kty: string;
    n: string;
    e: string;
  };

  return {
    did: 'did:plc:abc123',
    handle: 'swarm.example',
    accessToken: 'access-token-123',
    privateKeyPem: privateKey,
    publicJwk: {
      kty: publicJwk.kty,
      n: publicJwk.n,
      e: publicJwk.e,
    },
    pdsOrigin: 'https://pds.example',
  };
}

function installFetchMock(handler: typeof fetch): () => void {
  const original = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: handler,
  });

  return () => {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: original,
    });
  };
}

class MockIrcWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockIrcWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  readyState = MockIrcWebSocket.CONNECTING;
  bufferedAmount = 0;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockIrcWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== MockIrcWebSocket.CONNECTING) {
        return;
      }
      this.readyState = MockIrcWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  receive(data: string): void {
    this.onmessage?.({ data });
  }

  close(): void {
    if (this.readyState === MockIrcWebSocket.CLOSED) {
      return;
    }
    this.readyState = MockIrcWebSocket.CLOSED;
    this.onclose?.();
  }
}

function installMockWebSocket(): () => void {
  const original = (globalThis as { WebSocket?: unknown }).WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: MockIrcWebSocket,
  });

  return () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: original,
    });
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('normalizes a single IRC channel into joinChannels', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-config-'));
  const configPath = join(dir, 'swarm.yaml');
  try {
    await writeFile(configPath, `server:\n  mode: api\nagent:\n  name: swarm\nchannels:\n  irc:\n    enabled: true\n    server: wss://irc.freeq.at/irc\n    nick: swarmbot\n    channel: \"#swarm\"\n    dmPolicy: allowlist\n    allowedUsers:\n      - nandi.latha.org\n    maxMessageLength: 400\n    chunkDelay: 1.0\n`);

    const config = await loadConfig(configPath);
    assert.deepEqual(config.channels.irc.joinChannels, ['#swarm']);
    assert.equal(config.channels.irc.channel, '#swarm');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('irc channel plugin exposes metadata', () => {
  assert.equal(channelPlugin.metadata.id, 'irc');
  assert.equal(channelPlugin.metadata.displayName, 'IRC');
});

test('creates a PDS session token from rookery creds', async () => {
  const creds = makeFreeqCredentials();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const restoreFetch = installFetchMock((async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), `DPoP ${creds.accessToken}`);

    const dpop = headers.get('DPoP');
    assert.ok(dpop, 'expected DPoP header');

    const { header, payload } = decodeJwt(dpop);
    assert.equal(header.typ, 'dpop+jwt');
    assert.equal(header.alg, 'RS256');
    assert.deepEqual(header.jwk, creds.publicJwk);
    assert.equal(payload.htm, 'POST');
    assert.equal(payload.htu, `${creds.pdsOrigin}/xrpc/com.atproto.server.createSession`);
    assert.equal(payload.ath, base64url(createHash('sha256').update(creds.accessToken).digest()));

    return new Response(
      JSON.stringify({
        did: creds.did,
        handle: creds.handle,
        accessJwt: 'session-token-123',
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof fetch);

  try {
    const session = await createFreeqSession(creds);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `${creds.pdsOrigin}/xrpc/com.atproto.server.createSession`);
    assert.equal(session.did, creds.did);
    assert.equal(session.handle, creds.handle);
    assert.equal(session.accessJwt, 'session-token-123');
    assert.equal(session.pdsOrigin, creds.pdsOrigin);
  } finally {
    restoreFetch();
  }
});

test('builds a pds-session SASL payload', () => {
  const session: FreeqSession = {
    did: 'did:plc:abc123',
    handle: 'swarm.example',
    accessJwt: 'session-token-123',
    pdsOrigin: 'https://pds.example',
  };

  const challenge = { session_id: 'sess-1', nonce: 'nonce-1', timestamp: 1_735_123_456 };
  const encoded = buildPdsSessionPayload(session, base64url(Buffer.from(JSON.stringify(challenge), 'utf8')));
  const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
    did: string;
    method: string;
    signature: string;
    pds_url: string;
    challenge_nonce?: string;
  };

  assert.equal(decoded.did, session.did);
  assert.equal(decoded.method, 'pds-session');
  assert.equal(decoded.signature, session.accessJwt);
  assert.equal(decoded.pds_url, session.pdsOrigin);
  assert.equal(decoded.challenge_nonce, 'nonce-1');
});

test('swarm raw IRC adapter negotiates SASL and joins', async () => {
  const restoreWebSocket = installMockWebSocket();
  MockIrcWebSocket.instances = [];

  const session: FreeqSession = {
    did: 'did:plc:abc123',
    handle: 'swarm.example',
    accessJwt: 'session-token-123',
    pdsOrigin: 'https://pds.example',
  };

  const adapter = new IrcAdapter(
    {
      enabled: true,
      server: 'wss://irc.example/irc',
      nick: 'swarmbot',
      joinChannels: ['#swarm', '#ops'],
      dmPolicy: 'allowlist',
      allowedUsers: ['alice'],
      maxMessageLength: 400,
      chunkDelay: 0,
      messageReadDelayMs: 0,
    },
    session,
  );

  const received: Array<{
    chatId: string;
    text: string;
    messageId?: string;
    timestamp: Date;
  }> = [];
  adapter.onMessage = async (msg) => {
    received.push({
      chatId: msg.chatId,
      text: msg.text,
      messageId: msg.messageId,
      timestamp: msg.timestamp,
    });
  };

  try {
    await adapter.start();
    await flush();

    const ws = MockIrcWebSocket.instances[0];
    assert.ok(ws, 'expected a websocket to be created');
    assert.equal(ws.url, 'wss://irc.example/irc');
    assert.deepEqual(ws.sent.slice(0, 3), [
      'CAP LS 302\r\n',
      'NICK swarmbot\r\n',
      'USER swarmbot 0 * :swarm\r\n',
    ]);

    ws.receive('CAP * LS :message-tags server-time batch multi-prefix echo-message account-notify extended-join away-notify sasl');
    assert.ok(
      ws.sent.includes('CAP REQ :message-tags server-time batch multi-prefix echo-message account-notify extended-join away-notify sasl\r\n'),
      `expected CAP REQ, got: ${JSON.stringify(ws.sent)}`,
    );

    ws.receive('CAP * ACK :message-tags server-time batch multi-prefix echo-message account-notify extended-join away-notify sasl');
    assert.equal(ws.sent.at(-1), 'AUTHENTICATE ATPROTO-CHALLENGE\r\n');

    const challenge = {
      session_id: 'sess-1',
      nonce: 'nonce-1',
      timestamp: 1_735_123_456,
    };
    ws.receive(`AUTHENTICATE ${base64url(Buffer.from(JSON.stringify(challenge), 'utf8'))}`);

    const authResponseLine = ws.sent.find((line) => line.startsWith('AUTHENTICATE ') && line !== 'AUTHENTICATE ATPROTO-CHALLENGE\r\n');
    assert.ok(authResponseLine, `expected AUTHENTICATE response, got: ${JSON.stringify(ws.sent)}`);
    const encodedResponse = authResponseLine.slice('AUTHENTICATE '.length);
    const decodedResponse = JSON.parse(Buffer.from(encodedResponse, 'base64url').toString('utf8')) as {
      did: string;
      method: string;
      signature: string;
      pds_url: string;
      challenge_nonce?: string;
    };
    assert.equal(decodedResponse.did, session.did);
    assert.equal(decodedResponse.method, 'pds-session');
    assert.equal(decodedResponse.signature, session.accessJwt);
    assert.equal(decodedResponse.pds_url, session.pdsOrigin);
    assert.equal(decodedResponse.challenge_nonce, 'nonce-1');

    ws.receive(':irc.freeq.at 903 swarmbot :SASL authentication successful');
    assert.equal(ws.sent.at(-1), 'CAP END\r\n');

    ws.receive(':irc.freeq.at 001 swarmbot :Welcome to Freeq');
    assert.equal(adapter.isRunning(), true);
    assert.deepEqual(ws.sent.slice(-4), [
      'POLICY #swarm ACCEPT\r\n',
      'JOIN #swarm\r\n',
      'POLICY #ops ACCEPT\r\n',
      'JOIN #ops\r\n',
    ]);

    ws.receive('@msgid=msg-1;time=2099-01-01T00:00:00.000Z :alice!user@host PRIVMSG #swarm :@firebird hello swarm');
    await flush();

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], {
      chatId: '#swarm',
      text: '@firebird hello swarm',
      messageId: 'msg-1',
      timestamp: new Date('2099-01-01T00:00:00.000Z'),
    });

    ws.receive('@msgid=msg-2;time=2099-01-01T00:00:01.000Z :alice!user@host PRIVMSG #ops :@firebird hello ops');
    await flush();

    assert.equal(received.length, 2);
    assert.deepEqual(received[1], {
      chatId: '#ops',
      text: '@firebird hello ops',
      messageId: 'msg-2',
      timestamp: new Date('2099-01-01T00:00:01.000Z'),
    });

    const outboundStart = ws.sent.length;
    const result = await adapter.sendMessage({
      chatId: '#ops',
      text: 'hello from ops',
    });
    assert.notEqual(result.messageId, '');
    assert.equal(ws.sent[outboundStart], 'PRIVMSG #ops :hello from ops\r\n');

    const multilineStart = ws.sent.length;
    await adapter.sendMessage({
      chatId: '#ops',
      text: 'first line\nsecond line',
    });
    assert.equal(ws.sent[multilineStart], 'PRIVMSG #ops :first line second line\r\n');
  } finally {
    await adapter.stop();
    restoreWebSocket();
  }
});

test('swarm raw IRC adapter parts channels that are no longer configured', async () => {
  const restoreWebSocket = installMockWebSocket();
  MockIrcWebSocket.instances = [];

  const session: FreeqSession = {
    did: 'did:plc:abc123',
    handle: 'swarm.example',
    accessJwt: 'session-token-123',
    pdsOrigin: 'https://pds.example',
  };

  const adapter = new IrcAdapter(
    {
      enabled: true,
      server: 'wss://irc.example/irc',
      nick: 'swarmbot',
      joinChannels: ['#swarm'],
      dmPolicy: 'allowlist',
      allowedUsers: ['alice'],
      maxMessageLength: 400,
      chunkDelay: 0,
      messageReadDelayMs: 0,
    },
    session,
  );

  try {
    await adapter.start();
    await flush();

    const ws = MockIrcWebSocket.instances[0];
    assert.ok(ws, 'expected a websocket to be created');

    (adapter as unknown as { joinedChannels: Set<string> }).joinedChannels.add('#latha');

    ws.receive('CAP * LS :message-tags server-time batch multi-prefix echo-message account-notify extended-join away-notify sasl');
    ws.receive('CAP * ACK :message-tags server-time batch multi-prefix echo-message account-notify extended-join away-notify sasl');

    const challenge = {
      session_id: 'sess-1',
      nonce: 'nonce-1',
      timestamp: 1_735_123_456,
    };
    ws.receive(`AUTHENTICATE ${base64url(Buffer.from(JSON.stringify(challenge), 'utf8'))}`);
    ws.receive(':irc.freeq.at 903 swarmbot :SASL authentication successful');
    ws.receive(':irc.freeq.at 001 swarmbot :Welcome to Freeq');

    assert.ok(ws.sent.includes('PART #latha :not in configured joinChannels\r\n'));
    assert.ok(ws.sent.includes('JOIN #swarm\r\n'));
  } finally {
    await adapter.stop();
    restoreWebSocket();
  }
});

test('swarm raw IRC adapter ignores scrollback during read delay', async () => {
  const restoreWebSocket = installMockWebSocket();
  MockIrcWebSocket.instances = [];

  const session: FreeqSession = {
    did: 'did:plc:abc123',
    handle: 'swarm.example',
    accessJwt: 'session-token-123',
    pdsOrigin: 'https://pds.example',
  };

  const adapter = new IrcAdapter(
    {
      enabled: true,
      server: 'wss://irc.example/irc',
      nick: 'swarmbot',
      channel: '#swarm',
      dmPolicy: 'allowlist',
      allowedUsers: ['alice'],
      maxMessageLength: 400,
      chunkDelay: 0,
      messageReadDelayMs: 5_000,
    },
    session,
  );

  const received: string[] = [];
  adapter.onMessage = async (msg) => {
    received.push(msg.text);
  };

  try {
    await adapter.start();
    await flush();

    const ws = MockIrcWebSocket.instances[0];
    assert.ok(ws, 'expected a websocket to be created');

    ws.receive('CAP * LS :message-tags server-time batch multi-prefix echo-message account-notify extended-join away-notify sasl');
    ws.receive('CAP * ACK :message-tags server-time batch multi-prefix echo-message account-notify extended-join away-notify sasl');

    const challenge = {
      session_id: 'sess-1',
      nonce: 'nonce-1',
      timestamp: 1_735_123_456,
    };
    ws.receive(`AUTHENTICATE ${base64url(Buffer.from(JSON.stringify(challenge), 'utf8'))}`);
    ws.receive(':irc.freeq.at 903 swarmbot :SASL authentication successful');
    ws.receive(':irc.freeq.at 001 swarmbot :Welcome to Freeq');

    ws.receive('@msgid=msg-1;time=2026-04-29T06:00:00.000Z :alice!user@host PRIVMSG #swarm :@firebird scrollback');
    await flush();

    assert.equal(received.length, 0);
  } finally {
    await adapter.stop();
    restoreWebSocket();
  }
});

test('swarm raw IRC adapter accepts fresh messages during read delay', async () => {
  const restoreWebSocket = installMockWebSocket();
  MockIrcWebSocket.instances = [];

  const session: FreeqSession = {
    did: 'did:plc:abc123',
    handle: 'swarm.example',
    accessJwt: 'session-token-123',
    pdsOrigin: 'https://pds.example',
  };

  const adapter = new IrcAdapter(
    {
      enabled: true,
      server: 'wss://irc.example/irc',
      nick: 'swarmbot',
      channel: '#swarm',
      dmPolicy: 'allowlist',
      allowedUsers: ['alice'],
      maxMessageLength: 400,
      chunkDelay: 0,
      messageReadDelayMs: 5_000,
    },
    session,
  );

  const received: string[] = [];
  adapter.onMessage = async (msg) => {
    received.push(msg.text);
  };

  try {
    await adapter.start();
    await flush();

    const ws = MockIrcWebSocket.instances[0];
    assert.ok(ws, 'expected a websocket to be created');

    ws.receive('CAP * LS :message-tags server-time batch multi-prefix echo-message account-notify extended-join away-notify sasl');
    ws.receive('CAP * ACK :message-tags server-time batch multi-prefix echo-message account-notify extended-join away-notify sasl');

    const challenge = {
      session_id: 'sess-1',
      nonce: 'nonce-1',
      timestamp: 1_735_123_456,
    };
    ws.receive(`AUTHENTICATE ${base64url(Buffer.from(JSON.stringify(challenge), 'utf8'))}`);
    ws.receive(':irc.freeq.at 903 swarmbot :SASL authentication successful');
    ws.receive(':irc.freeq.at 001 swarmbot :Welcome to Freeq');

    ws.receive('@msgid=msg-1;time=2099-01-01T00:00:00.000Z :alice!user@host PRIVMSG #swarm :@firebird hello now');
    await flush();

    assert.deepEqual(received, ['@firebird hello now']);
  } finally {
    await adapter.stop();
    restoreWebSocket();
  }
});

test('swarm raw IRC adapter disconnects on SASL failure', async () => {
  const restoreWebSocket = installMockWebSocket();
  MockIrcWebSocket.instances = [];

  const session: FreeqSession = {
    did: 'did:plc:abc123',
    handle: 'swarm.example',
    accessJwt: 'session-token-123',
    pdsOrigin: 'https://pds.example',
  };

  const adapter = new IrcAdapter(
    {
      enabled: true,
      server: 'wss://irc.example/irc',
      nick: 'swarmbot',
      channel: '#swarm',
      dmPolicy: 'allowlist',
      allowedUsers: ['alice'],
      maxMessageLength: 400,
      chunkDelay: 0,
      messageReadDelayMs: 0,
    },
    session,
  );

  try {
    await adapter.start();
    await flush();

    const ws = MockIrcWebSocket.instances[0];
    assert.ok(ws, 'expected a websocket to be created');

    ws.receive('CAP * LS :message-tags server-time batch multi-prefix echo-message account-notify extended-join away-notify sasl');
    ws.receive('CAP * ACK :message-tags server-time batch multi-prefix echo-message account-notify extended-join away-notify sasl');

    const challenge = {
      session_id: 'sess-1',
      nonce: 'nonce-1',
      timestamp: 1_735_123_456,
    };
    ws.receive(`AUTHENTICATE ${base64url(Buffer.from(JSON.stringify(challenge), 'utf8'))}`);
    ws.receive(':irc.freeq.at 904 swarmbot :SASL authentication failed');
    await flush();

    assert.equal(adapter.isRunning(), false);
    assert.equal(ws.sent.some((line) => line === 'JOIN #swarm'), false);

    const outboundStart = ws.sent.length;
    const result = await adapter.sendMessage({
      chatId: '#swarm',
      text: 'should not send',
    });
    assert.equal(result.messageId, '');
    assert.equal(ws.sent.length, outboundStart);
  } finally {
    await adapter.stop();
    restoreWebSocket();
  }
});
