import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createSwarmBot, type LettaClientLike, type StreamChunk } from '../src/bot.ts';
import { BlueskyAdapter } from '../src/channels/bluesky/adapter.ts';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from '../src/channels/irc/channelTypes.ts';

class FakeAdapter implements ChannelAdapter {
  readonly id: string;
  readonly name: string;
  onMessage?: (msg: InboundMessage) => Promise<void>;
  started = false;
  stopped = false;
  sent: OutboundMessage[] = [];

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  isRunning(): boolean {
    return this.started && !this.stopped;
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId: string }> {
    this.sent.push(msg);
    return { messageId: `msg-${this.sent.length}` };
  }

  async editMessage(_chatId: string, _messageId: string, _text: string): Promise<void> {
    return;
  }

  async sendTypingIndicator(_chatId: string): Promise<void> {
    return;
  }

  getFormatterHints() {
    return { supportsReactions: false, supportsFiles: false, formatHint: 'plain' };
  }

  async emit(msg: InboundMessage): Promise<void> {
    if (!this.onMessage) {
      throw new Error('onMessage handler not attached');
    }
    await this.onMessage(msg);
  }
}

function makeStream(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

function createFakeClient() {
  const conversationCreates: Array<{ agent_id: string }> = [];
  const messageCreates: Array<{ conversationId: string; body: { messages: Array<{ role: 'user'; content: string }> } }> = [];
  const streams = new Map<string, AsyncIterable<StreamChunk>>();
  let conversationCounter = 0;

  const client: LettaClientLike = {
    conversations: {
      async create(params: { agent_id: string }) {
        conversationCreates.push(params);
        conversationCounter += 1;
        return { id: `conv-${conversationCounter}` };
      },
      messages: {
        async create(conversationId: string, body: { messages: Array<{ role: 'user'; content: string }> }) {
          messageCreates.push({ conversationId, body });
          return streams.get(conversationId) ?? makeStream([]);
        },
      },
    },
    agents: {
      async list() {
        return [];
      },
    },
  };

  return {
    client,
    conversationCreates,
    messageCreates,
    streams,
  };
}

function createFeedResponse(uri: string, text: string, createdAt = '2026-04-30T00:00:00.000Z') {
  return {
    feed: [
      {
        post: {
          uri,
          cid: `${uri}-cid`,
          indexedAt: createdAt,
          author: {
            did: 'did:plc:author',
            handle: 'author.bsky.social',
            displayName: 'Author',
          },
          record: {
            text,
            createdAt,
          },
        },
      },
    ],
  };
}

function createJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('bluesky adapter polls a feed and deduplicates posts', async () => {
  const messages: InboundMessage[] = [];
  const feedUri = 'at://did:plc:feed/app.bsky.feed.generator/whimsy';
  const postUri = 'at://did:plc:author/app.bsky.feed.post/123';
  const fetchImpl = async () => createJsonResponse(createFeedResponse(postUri, 'Hello from Bluesky'));

  const adapter = new BlueskyAdapter(
    {
      enabled: true,
      feedUri,
      pollIntervalMs: 60_000,
      limit: 1,
    },
    {
      fetchImpl: fetchImpl as typeof fetch,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
    },
  );

  adapter.onMessage = async (msg) => {
    messages.push(msg);
  };

  const pollingAdapter = adapter as unknown as { pollOnce(): Promise<void>; running: boolean };
  pollingAdapter.running = true;
  await pollingAdapter.pollOnce();
  await pollingAdapter.pollOnce();
  pollingAdapter.running = false;

  assert.equal(messages.length, 1);
  assert.equal(messages[0].channel, 'bluesky');
  assert.equal(messages[0].chatId, postUri);
  assert.equal(messages[0].userName, 'author.bsky.social');
  assert.equal(messages[0].text, 'Hello from Bluesky');
  assert.equal(messages[0].groupName, feedUri);
  assert.equal(messages[0].messageType, 'public');
  assert.equal(messages[0].isGroup, true);

  const outbound = await adapter.sendMessage({ chatId: feedUri, text: 'ignored' });
  assert.equal(outbound.messageId, '');
});

test('bluesky adapter fails fast on an invalid feed response', async () => {
  const adapter = new BlueskyAdapter(
    {
      enabled: true,
      feedUri: 'at://did:plc:feed/app.bsky.feed.generator/whimsy',
      pollIntervalMs: 60_000,
      limit: 1,
    },
    {
      fetchImpl: async () => createJsonResponse({ error: 'Bad Request' }, 400) as Response,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
    },
  );

  await assert.rejects(() => adapter.start(), /HTTP 400/);
  assert.equal(adapter.isRunning(), false);
});

test('swarm bot mirrors Bluesky feed posts into #latha', async () => {
  const ircAdapter = new FakeAdapter('irc', 'fake-irc');
  const blueskyAdapter = new FakeAdapter('bluesky', 'fake-bluesky');
  const fakeClient = createFakeClient();

  const bot = createSwarmBot({
    config: {
      server: { mode: 'api', apiKey: 'key' },
      agent: { name: 'swarm', id: 'agent-default' },
      channels: {
        irc: {
          enabled: true,
          server: 'wss://irc.example/irc',
          nick: 'swarmbot',
          channel: '#swarm',
          joinChannels: ['#swarm', '#latha'],
          dmPolicy: 'allowlist',
          allowedUsers: ['alice'],
          maxMessageLength: 400,
          chunkDelay: 0,
          messageReadDelayMs: 0,
        },
        bluesky: {
          enabled: true,
          feedUri: 'at://did:plc:feed/app.bsky.feed.generator/whimsy',
          mirrorChannel: '#latha',
          pollIntervalMs: 60_000,
          limit: 1,
        },
      },
    },
    client: fakeClient.client,
    adapterFactory: async () => ircAdapter,
    blueskyAdapterFactory: async () => blueskyAdapter,
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
  });

  await bot.start();
  assert.equal(bot.isRunning(), true);
  assert.equal(typeof blueskyAdapter.onMessage, 'function');
  assert.equal(typeof ircAdapter.onMessage, 'function');

  await blueskyAdapter.emit({
    channel: 'bluesky',
    chatId: 'at://did:plc:author/app.bsky.feed.post/123',
    userId: 'did:plc:author',
    userName: 'author.bsky.social',
    userHandle: 'author.bsky.social',
    messageId: 'at://did:plc:author/app.bsky.feed.post/123',
    text: 'Hello from Bluesky',
    timestamp: new Date('2026-04-30T00:00:00.000Z'),
    messageType: 'public',
    isGroup: true,
    groupName: 'at://did:plc:feed/app.bsky.feed.generator/whimsy',
    extraContext: {
      feedUri: 'at://did:plc:feed/app.bsky.feed.generator/whimsy',
      postUri: 'at://did:plc:author/app.bsky.feed.post/123',
      authorDid: 'did:plc:author',
      authorHandle: 'author.bsky.social',
    },
  });

  assert.equal(fakeClient.conversationCreates.length, 0);
  assert.equal(fakeClient.messageCreates.length, 0);
  assert.equal(ircAdapter.sent.length, 1);
  assert.deepEqual(ircAdapter.sent[0].chatId, '#latha');
  assert.match(ircAdapter.sent[0].text, /Bluesky feed \| author\.bsky\.social:/);
  assert.match(ircAdapter.sent[0].text, /Hello from Bluesky/);
  assert.match(ircAdapter.sent[0].text, /at:\/\/did:plc:author\/app\.bsky\.feed\.post\/123/);

  await bot.stop();
  assert.equal(ircAdapter.stopped, true);
  assert.equal(blueskyAdapter.stopped, true);
});
