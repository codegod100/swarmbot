import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from '../src/channels/irc/channelTypes.ts';
import { createSwarmBot, type LettaClientLike, type StreamChunk } from '../src/bot.ts';

class FakeAdapter implements ChannelAdapter {
  readonly id = 'irc' as const;
  readonly name = 'fake-irc';
  onMessage?: (msg: InboundMessage) => Promise<void>;
  started = false;
  stopped = false;
  sent: OutboundMessage[] = [];

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
    await new Promise((resolve) => setImmediate(resolve));
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

function makeInboundMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'irc',
    chatId: '#swarm',
    userId: 'alice',
    userName: 'alice',
    text: '@researcher What is the capital of France?',
    timestamp: new Date('2026-04-30T00:00:00.000Z'),
    messageType: 'group',
    isGroup: true,
    ...overrides,
  };
}

test('routes explicit mentions to configured agents and relays the answer', async () => {
  const fakeAdapter = new FakeAdapter();
  const fakeClient = createFakeClient();
  fakeClient.streams.set(
    'conv-1',
    makeStream([
      { message_type: 'reasoning_message', content: 'thinking' },
      { message_type: 'assistant_message', content: 'Paris' },
    ]),
  );

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
          joinChannels: ['#swarm'],
          dmPolicy: 'allowlist',
          allowedUsers: ['alice'],
          maxMessageLength: 400,
          chunkDelay: 0,
          messageReadDelayMs: 0,
        },
      },
      agents: {
        researcher: 'agent-researcher',
      },
    },
    client: fakeClient.client,
    adapterFactory: async () => fakeAdapter,
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
  });

  await bot.start();
  assert.equal(typeof fakeAdapter.onMessage, 'function');
  assert.equal(bot.isRunning(), true);
  await fakeAdapter.emit(makeInboundMessage());

  assert.equal(fakeAdapter.started, true);
  assert.equal(fakeClient.conversationCreates.length, 1);
  assert.deepEqual(fakeClient.conversationCreates[0], { agent_id: 'agent-researcher' });
  assert.equal(fakeClient.messageCreates.length, 1);
  assert.equal(fakeClient.messageCreates[0].conversationId, 'conv-1');
  assert.equal(fakeClient.messageCreates[0].body.messages[0].content, 'What is the capital of France?');
  assert.equal(fakeAdapter.sent.length, 1);
  assert.equal(fakeAdapter.sent[0].chatId, '#swarm');
  assert.equal(fakeAdapter.sent[0].text, 'alice: Paris');

  await bot.stop();
  assert.equal(fakeAdapter.stopped, true);
});

test('uses the default agent for direct messages without a mention', async () => {
  const fakeAdapter = new FakeAdapter();
  const fakeClient = createFakeClient();
  fakeClient.streams.set('conv-1', makeStream([{ message_type: 'assistant_message', content: 'Hello there' }]));

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
          joinChannels: ['#swarm'],
          dmPolicy: 'allowlist',
          allowedUsers: ['alice'],
          maxMessageLength: 400,
          chunkDelay: 0,
          messageReadDelayMs: 0,
        },
      },
    },
    client: fakeClient.client,
    adapterFactory: async () => fakeAdapter,
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
  });

  await bot.start();
  assert.equal(typeof fakeAdapter.onMessage, 'function');
  assert.equal(bot.isRunning(), true);
  await fakeAdapter.emit(
    makeInboundMessage({
      chatId: 'alice',
      messageType: 'dm',
      isGroup: false,
      text: 'Tell me something useful',
    }),
  );

  assert.deepEqual(fakeClient.conversationCreates[0], { agent_id: 'agent-default' });
  assert.equal(fakeClient.messageCreates[0].body.messages[0].content, 'Tell me something useful');
  assert.equal(fakeAdapter.sent[0].text, 'alice: Hello there');

  await bot.stop();
});

test('rejects unknown agent mentions with a helpful reply', async () => {
  const fakeAdapter = new FakeAdapter();
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
          joinChannels: ['#swarm'],
          dmPolicy: 'allowlist',
          allowedUsers: ['alice'],
          maxMessageLength: 400,
          chunkDelay: 0,
          messageReadDelayMs: 0,
        },
      },
      agents: {
        researcher: 'agent-researcher',
      },
    },
    client: fakeClient.client,
    adapterFactory: async () => fakeAdapter,
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
  });

  await bot.start();
  await fakeAdapter.emit(
    makeInboundMessage({ text: '@unknown what can you do?' }),
  );

  assert.equal(fakeClient.conversationCreates.length, 0);
  assert.equal(fakeClient.messageCreates.length, 0);
  assert.equal(fakeAdapter.sent.length, 1);
  assert.equal(fakeAdapter.sent[0].text, "Unknown agent '@unknown'. Available: researcher, swarm");

  await bot.stop();
});
