import Letta from '@letta-ai/letta-client';
import type { ChannelAdapter, InboundMessage } from './channels/irc/channelTypes.js';
import { createBlueskyAdapter } from './channels/bluesky/runtime.js';
import type { BlueskyConfig } from './channels/bluesky/types.js';
import { createIrcAdapter } from './channels/irc/runtime.js';
import type { IrcConfig } from './channels/irc/types.js';
import type { SwarmConfig } from './config.js';
import { createLogger } from './logger.js';

interface LoggerLike {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

export interface StreamChunk {
  message_type?: string;
  content?: unknown;
}

export interface LettaConversation {
  id: string;
}

export interface LettaMessageClient {
  create(
    conversationId: string,
    body: {
      messages: Array<{ role: 'user'; content: string }>;
    },
  ): Promise<AsyncIterable<StreamChunk>> | AsyncIterable<StreamChunk>;
}

export interface LettaClientLike {
  conversations: {
    create(params: { agent_id: string }): Promise<LettaConversation>;
    messages: LettaMessageClient;
  };
  agents?: {
    list(params: Record<string, unknown>): Promise<unknown>;
  };
}

export interface SwarmBotOptions {
  config: SwarmConfig;
  client?: LettaClientLike;
  adapterFactory?: (config: IrcConfig) => Promise<ChannelAdapter>;
  blueskyAdapterFactory?: (config: BlueskyConfig) => Promise<ChannelAdapter>;
  logger?: LoggerLike;
}

type MentionTarget = {
  kind: 'agent';
  agentId: string;
  agentName: string;
  prompt: string;
};

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed.replace(/\/+$/, '');
  }
  if (trimmed.startsWith('localhost') || trimmed.startsWith('127.') || trimmed.startsWith('10.') || trimmed.startsWith('192.168.')) {
    return `http://${trimmed}`.replace(/\/+$/, '');
  }
  return `https://${trimmed}`.replace(/\/+$/, '');
}

function toAssistantText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }

      const record = item as Record<string, unknown>;
      return typeof record.text === 'string' ? record.text : '';
    })
    .join('');
}

function parseExplicitMention(text: string): { agentName: string; prompt: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('@')) {
    return null;
  }

  const match = trimmed.match(/^@([A-Za-z0-9._-]+)[,:;.!?]*\s*(.*)$/s);
  if (!match) {
    return null;
  }

  return {
    agentName: match[1] ?? '',
    prompt: (match[2] ?? '').trim(),
  };
}

function getConfiguredAgentMap(config: SwarmConfig): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, id] of Object.entries(config.agents ?? {})) {
    if (typeof id === 'string' && id.trim().length > 0) {
      map.set(name.toLowerCase(), id.trim());
    }
  }
  return map;
}

function normalizeAgentItems(result: unknown): Array<{ id?: unknown; name?: unknown }> {
  if (Array.isArray(result)) {
    return result as Array<{ id?: unknown; name?: unknown }>;
  }

  if (!result || typeof result !== 'object') {
    return [];
  }

  const record = result as Record<string, unknown>;
  for (const key of ['data', 'items', 'agents', 'results']) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value as Array<{ id?: unknown; name?: unknown }>;
    }
  }

  return [];
}

export function createLettaClient(config: SwarmConfig): LettaClientLike {
  const baseURL = normalizeBaseUrl(
    config.server.baseUrl?.trim() ||
      process.env.LETTA_BASE_URL?.trim() ||
      (config.server.mode === 'selfhosted' ? 'http://localhost:8283' : 'https://api.letta.com'),
  );
  const apiKey = config.server.apiKey?.trim() || process.env.LETTA_API_KEY?.trim() || '';

  if (!apiKey && baseURL === 'https://api.letta.com') {
    throw new Error('Missing LETTA_API_KEY for Letta Cloud. Set server.apiKey or LETTA_API_KEY.');
  }

  return new Letta({
    apiKey,
    baseURL,
  }) as unknown as LettaClientLike;
}

export class SwarmBot {
  private readonly config: SwarmConfig;
  private readonly client: LettaClientLike;
  private readonly adapterFactory: (config: IrcConfig) => Promise<ChannelAdapter>;
  private readonly blueskyAdapterFactory: (config: BlueskyConfig) => Promise<ChannelAdapter>;
  private readonly log: LoggerLike;
  private readonly configuredAgents: Map<string, string>;
  private readonly conversationIds = new Map<string, string>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly adapters = new Map<string, ChannelAdapter>();
  private started = false;
  private defaultAgentId: string | null = null;

  constructor(options: SwarmBotOptions) {
    this.config = options.config;
    this.client = options.client ?? createLettaClient(options.config);
    this.adapterFactory = options.adapterFactory ?? (async (ircConfig) => createIrcAdapter(ircConfig));
    this.blueskyAdapterFactory = options.blueskyAdapterFactory ?? (async (blueskyConfig) => createBlueskyAdapter(blueskyConfig));
    this.log = options.logger ?? createLogger('SwarmBot');
    this.configuredAgents = getConfiguredAgentMap(options.config);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const adapters = await this.createAdapters();
    if (adapters.length === 0) {
      throw new Error('No enabled channels are configured');
    }

    this.adapters.clear();
    for (const { key, adapter } of adapters) {
      adapter.onMessage = async (msg) => {
        try {
          await this.handleInboundMessage(adapter, msg);
        } catch (error) {
          this.log.error(
            `Failed to process ${adapter.name} message: ${error instanceof Error ? error.message : String(error)}`,
            error,
          );
        }
      };
      this.adapters.set(key, adapter);
    }

    try {
      for (const adapter of this.adapters.values()) {
        await adapter.start();
      }
      this.started = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const adapters = [...this.adapters.values()];
    this.adapters.clear();
    this.started = false;

    for (const adapter of adapters) {
      if (adapter.isRunning()) {
        await adapter.stop();
      }
    }
  }

  isRunning(): boolean {
    return this.started && this.adapters.size > 0 && [...this.adapters.values()].every((adapter) => adapter.isRunning());
  }

  private async createAdapters(): Promise<Array<{ key: string; adapter: ChannelAdapter }>> {
    const adapters: Array<{ key: string; adapter: ChannelAdapter }> = [];

    if (this.config.channels.bluesky?.enabled && !this.config.channels.irc.enabled) {
      throw new Error('Bluesky mirroring requires IRC to be enabled');
    }

    if (this.config.channels.irc.enabled) {
      const factory = this.adapterFactory;
      const adapter = await factory(this.config.channels.irc);
      adapters.push({ key: 'irc', adapter });
    }

    if (this.config.channels.bluesky?.enabled) {
      const blueskyConfig = this.config.channels.bluesky;
      const factory = this.blueskyAdapterFactory;
      const adapter = await factory(blueskyConfig);
      adapters.push({ key: 'bluesky', adapter });
    }

    return adapters;
  }

  private async handleInboundMessage(adapter: ChannelAdapter, msg: InboundMessage): Promise<void> {
    if (msg.channel === 'bluesky') {
      await this.mirrorBlueskyMessage(msg);
      return;
    }

    if (this.isFromBot(msg)) {
      return;
    }

    const target = await this.resolveTarget(adapter, msg);
    if (!target) {
      return;
    }

    const queueKey = `${target.agentId}:${msg.chatId}`;
    await this.enqueue(queueKey, async () => {
      const conversationId = await this.getConversationId(target.agentId, msg.chatId);
      const prompt = target.prompt.trim();
      if (!prompt) {
        await this.reply(adapter, msg.chatId, `${this.displayName(msg)}: Please include a prompt after the mention.`);
        return;
      }

      const responseText = await this.sendPrompt(conversationId, prompt);
      if (!responseText.trim()) {
        this.log.warn(`Empty response for conversation ${conversationId}`);
        return;
      }

      await this.reply(adapter, msg.chatId, `${this.displayName(msg)}: ${responseText.trim()}`);
    });
  }

  private displayName(msg: InboundMessage): string {
    return msg.userName?.trim() || msg.userId.trim() || 'someone';
  }

  private async mirrorBlueskyMessage(msg: InboundMessage): Promise<void> {
    const ircAdapter = this.getAdapter('irc');
    if (!ircAdapter) {
      this.log.warn(`Cannot mirror Bluesky post ${msg.chatId}: IRC adapter is unavailable`);
      return;
    }

    const mirrorChannel = this.config.channels.bluesky?.mirrorChannel?.trim() || '#latha';
    const text = this.formatBlueskyMirrorMessage(msg);
    await ircAdapter.sendMessage({ chatId: mirrorChannel, text });
  }

  private formatBlueskyMirrorMessage(msg: InboundMessage): string {
    const author = msg.userHandle?.trim() || msg.userName?.trim() || msg.userId.trim() || 'unknown author';
    const postUrl = msg.extraContext?.postUri?.trim() || msg.messageId || msg.chatId;
    const text = msg.text.trim() || '(no text)';
    return `Bluesky feed | ${author}: ${text} [${postUrl}]`;
  }

  private isFromBot(msg: InboundMessage): boolean {
    const nick = this.config.channels.irc.nick.trim().toLowerCase();
    const candidates = [msg.userId, msg.userName, msg.userHandle].map((value) => value?.trim().toLowerCase());
    return candidates.some((value) => value === nick);
  }

  private async reply(adapter: ChannelAdapter, chatId: string, text: string): Promise<void> {
    await adapter.sendMessage({ chatId, text });
  }

  private getAdapter(id: string): ChannelAdapter | null {
    for (const adapter of this.adapters.values()) {
      if (adapter.id === id) {
        return adapter;
      }
    }
    return null;
  }

  private async sendPrompt(conversationId: string, prompt: string): Promise<string> {
    const stream = await this.client.conversations.messages.create(conversationId, {
      messages: [{ role: 'user', content: prompt }],
    });

    let response = '';
    for await (const chunk of stream) {
      if (chunk.message_type !== 'assistant_message') {
        continue;
      }
      response += toAssistantText(chunk.content);
    }

    return response;
  }

  private async getConversationId(agentId: string, chatId: string): Promise<string> {
    const key = `${agentId}:${chatId}`;
    const existing = this.conversationIds.get(key);
    if (existing) {
      return existing;
    }

    const conversation = await this.client.conversations.create({ agent_id: agentId });
    this.conversationIds.set(key, conversation.id);
    return conversation.id;
  }

  private async enqueue(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, settled);
    try {
      await next;
    } finally {
      if (this.queues.get(key) === settled) {
        this.queues.delete(key);
      }
    }
  }

  private async resolveTarget(adapter: ChannelAdapter, msg: InboundMessage): Promise<MentionTarget | null> {
    const mention = parseExplicitMention(msg.text);
    if (mention) {
      const agentId = await this.resolveAgentId(mention.agentName);
      if (!agentId) {
        await this.reply(
          adapter,
          msg.chatId,
          `Unknown agent '@${mention.agentName}'. Available: ${this.listAvailableAgentNames()}`,
        );
        return null;
      }

      return {
        kind: 'agent',
        agentId,
        agentName: mention.agentName,
        prompt: mention.prompt,
      };
    }

    if (this.isDirectMessage(msg)) {
      const agentId = await this.resolveDefaultAgentId();
      if (agentId) {
        return {
          kind: 'agent',
          agentId,
          agentName: this.config.agent.name,
          prompt: msg.text.trim(),
        };
      }

      if (this.configuredAgents.size === 1) {
        const soleAgentId = [...this.configuredAgents.values()][0];
        if (soleAgentId) {
          return {
            kind: 'agent',
            agentId: soleAgentId,
            agentName: this.config.agent.name,
            prompt: msg.text.trim(),
          };
        }
      }
    }

    this.log.debug(`Ignoring message without explicit agent mention in ${msg.chatId}`);
    return null;
  }

  private isDirectMessage(msg: InboundMessage): boolean {
    return msg.messageType === 'dm' || msg.isGroup === false;
  }

  private listAvailableAgentNames(): string {
    const names = new Set<string>();
    for (const key of this.configuredAgents.keys()) {
      names.add(key);
    }
    if (this.config.agent.name?.trim()) {
      names.add(this.config.agent.name.trim().toLowerCase());
    }
    if (names.size === 0) {
      return '(none configured)';
    }
    return [...names].join(', ');
  }

  private async resolveAgentId(name: string): Promise<string | null> {
    const normalized = name.trim().toLowerCase();
    const configured = this.configuredAgents.get(normalized);
    if (configured) {
      return configured;
    }

    if (this.config.agent.name.trim().toLowerCase() === normalized) {
      return await this.resolveDefaultAgentId();
    }

    return null;
  }

  private async resolveDefaultAgentId(): Promise<string | null> {
    if (this.defaultAgentId) {
      return this.defaultAgentId;
    }

    if (this.config.agent.id?.trim()) {
      this.defaultAgentId = this.config.agent.id.trim();
      return this.defaultAgentId;
    }

    const agentName = this.config.agent.name.trim();
    if (!agentName) {
      return null;
    }

    const agents = this.client.agents;
    if (!agents) {
      return null;
    }

    try {
      const result = await agents.list({ name: agentName, limit: 100 });
      for (const candidate of normalizeAgentItems(result)) {
        const candidateName = typeof candidate.name === 'string' ? candidate.name.trim() : '';
        const candidateId = typeof candidate.id === 'string' ? candidate.id.trim() : '';
        if (candidateName.toLowerCase() === agentName.toLowerCase() && candidateId) {
          this.defaultAgentId = candidateId;
          return candidateId;
        }
      }
    } catch (error) {
      this.log.warn(`Failed to resolve default agent by name '${agentName}': ${error instanceof Error ? error.message : String(error)}`);
    }

    return null;
  }
}

export function createSwarmBot(options: SwarmBotOptions): SwarmBot {
  return new SwarmBot(options);
}
