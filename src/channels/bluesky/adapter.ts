import { createLogger } from '../../logger.js';
import type { ChannelAdapter, FormatterHints, InboundMessage, OutboundMessage } from '../irc/channelTypes.js';
import type { BlueskyConfig } from './types.js';

interface LoggerLike {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

class BlueskyFeedRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly feedUri: string,
    public readonly apiBaseUrl: string,
  ) {
    super(message);
    this.name = 'BlueskyFeedRequestError';
  }
}

interface BlueskyFeedPostAuthor {
  did?: string;
  handle?: string;
  displayName?: string;
}

interface BlueskyFeedPostRecord {
  text?: string;
  createdAt?: string;
}

interface BlueskyFeedPost {
  uri?: string;
  cid?: string;
  indexedAt?: string;
  author?: BlueskyFeedPostAuthor;
  record?: BlueskyFeedPostRecord;
}

interface BlueskyFeedEntry {
  post?: BlueskyFeedPost;
}

interface BlueskyFeedResponse {
  cursor?: string;
  feed?: BlueskyFeedEntry[];
}

export interface BlueskyAdapterOptions {
  fetchImpl?: typeof fetch;
  logger?: LoggerLike;
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_LIMIT = 1;
const MAX_SEEN_POSTS = 2_000;
const MAX_PAGES_PER_POLL = 5;

/**
 * Polls a Bluesky feed generator and forwards new posts as inbound messages.
 *
 * This adapter is read-only: outbound writes are intentionally ignored.
 */
export class BlueskyAdapter implements ChannelAdapter {
  readonly id = 'bluesky' as const;
  readonly name: string;

  private readonly config: BlueskyConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly log: LoggerLike;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly seenPosts = new Set<string>();
  private readonly seenOrder: string[] = [];

  onMessage?: (msg: InboundMessage) => Promise<void>;

  constructor(config: BlueskyConfig, options: BlueskyAdapterOptions = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.logger ?? createLogger('BlueskyAdapter');
    this.name = `bluesky:${config.feedUri}`;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    await this.validateFeed();
    this.running = true;
    this.log.info(`Polling Bluesky feed ${this.config.feedUri} every ${this.getPollIntervalMs()}ms`);
    void this.pollCycle();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  async sendMessage(_msg: OutboundMessage): Promise<{ messageId: string }> {
    this.log.debug('Bluesky feed is read-only; outbound messages are ignored');
    return { messageId: '' };
  }

  async editMessage(_chatId: string, _messageId: string, _text: string): Promise<void> {
    this.log.debug('Bluesky feed is read-only; editMessage is ignored');
  }

  async sendTypingIndicator(_chatId: string): Promise<void> {
    this.log.debug('Bluesky feed is read-only; typing indicators are ignored');
  }

  getFormatterHints(): FormatterHints {
    return {
      supportsReactions: false,
      supportsFiles: false,
      formatHint: 'plain',
    };
  }

  private getPollIntervalMs(): number {
    return this.config.pollIntervalMs > 0 ? this.config.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
  }

  private getLimit(): number {
    return this.config.limit && this.config.limit > 0 ? this.config.limit : DEFAULT_LIMIT;
  }

  private getApiBaseUrl(): string {
    const base = (this.config.apiBaseUrl ?? 'https://api.bsky.app').trim();
    return base.replace(/\/+$/, '');
  }

  private async pollCycle(): Promise<void> {
    if (!this.running) {
      return;
    }

    try {
      await this.pollOnce();
    } catch (error) {
      if (error instanceof BlueskyFeedRequestError && error.status >= 400 && error.status < 500) {
        this.running = false;
        this.log.error(
          `Bluesky feed ${this.config.feedUri} is not usable via ${error.apiBaseUrl} (HTTP ${error.status}): ${error.message}`,
          error,
        );
        return;
      }

      this.log.error(
        `Failed to poll Bluesky feed ${this.config.feedUri}: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }

    if (!this.running) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollCycle();
    }, this.getPollIntervalMs());
  }

  private async pollOnce(): Promise<void> {
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES_PER_POLL && this.running; page += 1) {
      const response = await this.fetchFeed(cursor);
      const data = (await response.json()) as BlueskyFeedResponse;
      const posts = Array.isArray(data.feed) ? data.feed : [];
      let sawExistingPost = false;

      for (const entry of posts) {
        const post = entry?.post;
        const uri = this.getPostIdentifier(post);
        if (!uri) {
          continue;
        }

        if (this.seenPosts.has(uri)) {
          sawExistingPost = true;
          break;
        }

        const inbound = this.toInboundMessage(post, uri);
        this.markSeen(uri);

        if (!this.onMessage) {
          continue;
        }

        try {
          await this.onMessage(inbound);
        } catch (error) {
          this.log.error(
            `Failed to deliver Bluesky post ${uri}: ${error instanceof Error ? error.message : String(error)}`,
            error,
          );
        }
      }

      if (sawExistingPost || !data.cursor || posts.length === 0) {
        break;
      }

      cursor = data.cursor;
    }
  }

  private async validateFeed(): Promise<void> {
    await this.fetchFeed(undefined, 1);
  }

  private async fetchFeed(cursor?: string, limitOverride?: number): Promise<Response> {
    const apiBaseUrl = this.getApiBaseUrl();
    const url = new URL('/xrpc/app.bsky.feed.getFeed', apiBaseUrl);
    url.searchParams.set('feed', this.config.feedUri);
    url.searchParams.set('limit', String(limitOverride ?? this.getLimit()));
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    const response = await this.fetchImpl(url.toString());
    if (!response.ok) {
      throw new BlueskyFeedRequestError(
        `Bluesky feed request failed with HTTP ${response.status}`,
        response.status,
        this.config.feedUri,
        apiBaseUrl,
      );
    }

    return response;
  }

  private getPostIdentifier(post: BlueskyFeedPost | undefined): string {
    const uri = post?.uri?.trim();
    if (uri) {
      return uri;
    }

    const cid = post?.cid?.trim();
    return cid ?? '';
  }

  private toInboundMessage(post: BlueskyFeedPost | undefined, identifier: string): InboundMessage {
    const authorHandle = post?.author?.handle?.trim() || post?.author?.displayName?.trim() || 'bluesky-user';
    const authorDid = post?.author?.did?.trim() || authorHandle;
    const text = post?.record?.text?.trim() || '';
    const timestamp = parseTimestamp(post?.record?.createdAt ?? post?.indexedAt);

    return {
      channel: 'bluesky',
      chatId: identifier,
      userId: authorDid,
      userName: authorHandle,
      userHandle: authorHandle,
      messageId: identifier,
      text,
      timestamp,
      messageType: 'public',
      isGroup: true,
      groupName: this.config.feedUri,
      wasMentioned: false,
      formatterHints: this.getFormatterHints(),
      extraContext: {
        feedUri: this.config.feedUri,
        postUri: post?.uri?.trim() ?? identifier,
        postCid: post?.cid?.trim() ?? '',
        authorDid,
        authorHandle,
      },
    };
  }

  private markSeen(identifier: string): void {
    this.seenPosts.add(identifier);
    this.seenOrder.push(identifier);

    while (this.seenOrder.length > MAX_SEEN_POSTS) {
      const oldest = this.seenOrder.shift();
      if (oldest) {
        this.seenPosts.delete(oldest);
      }
    }
  }
}

function parseTimestamp(value: string | undefined): Date {
  if (!value) {
    return new Date();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }

  return parsed;
}
