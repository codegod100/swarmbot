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
    public readonly requestBaseUrl: string,
  ) {
    super(message);
    this.name = 'BlueskyFeedRequestError';
  }
}

interface BlueskyAuthSession {
  accessJwt: string;
  requestBaseUrl: string;
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
  private authSession: BlueskyAuthSession | null = null;
  private authSessionPromise: Promise<BlueskyAuthSession | null> | null = null;

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

  async fetchRecentPosts(limit = 5): Promise<InboundMessage[]> {
    const response = await this.fetchFeed(undefined, limit);
    const data = (await response.json()) as BlueskyFeedResponse;
    const posts = Array.isArray(data.feed) ? data.feed : [];

    return posts
      .map((entry) => {
        const post = entry?.post;
        const identifier = this.getPostIdentifier(post);
        if (!identifier) {
          return null;
        }

        return this.toInboundMessage(post, identifier);
      })
      .filter((message): message is InboundMessage => message !== null);
  }

  private getPollIntervalMs(): number {
    return this.config.pollIntervalMs > 0 ? this.config.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
  }

  private getLimit(): number {
    return this.config.limit && this.config.limit > 0 ? this.config.limit : DEFAULT_LIMIT;
  }

  private getAnonymousApiBaseUrl(): string {
    const base = (this.config.apiBaseUrl ?? 'https://public.api.bsky.app').trim();
    return base.replace(/\/+$/, '');
  }

  private getAuthRequestBaseUrl(): string {
    const base = (this.config.auth?.pdsUrl ?? 'https://bsky.social').trim();
    return base.replace(/\/+$/, '');
  }

  private hasAuthConfig(): boolean {
    return Boolean(this.config.auth?.identifier && this.config.auth?.appPassword);
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
          `Bluesky feed ${this.config.feedUri} is not usable via ${error.requestBaseUrl} (HTTP ${error.status}): ${error.message}`,
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

  private async ensureAuthSession(forceRefresh = false): Promise<BlueskyAuthSession | null> {
    if (!this.hasAuthConfig()) {
      return null;
    }

    if (!forceRefresh && this.authSession) {
      return this.authSession;
    }

    if (!forceRefresh && this.authSessionPromise) {
      return this.authSessionPromise;
    }

    const promise = this.createAuthSession();
    this.authSessionPromise = promise;

    try {
      const session = await promise;
      this.authSession = session;
      return session;
    } finally {
      if (this.authSessionPromise === promise) {
        this.authSessionPromise = null;
      }
    }
  }

  private async createAuthSession(): Promise<BlueskyAuthSession> {
    if (!this.config.auth) {
      throw new Error('Bluesky auth is not configured');
    }

    const requestBaseUrl = this.getAuthRequestBaseUrl();
    const url = new URL('/xrpc/com.atproto.server.createSession', requestBaseUrl);
    const response = await this.fetchImpl(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        identifier: this.config.auth.identifier,
        password: this.config.auth.appPassword,
      }),
    });

    if (!response.ok) {
      const body = await this.readResponseBody(response);
      throw new BlueskyFeedRequestError(
        `Bluesky auth failed with HTTP ${response.status}${body ? `: ${body}` : ''}`,
        response.status,
        this.config.feedUri,
        requestBaseUrl,
      );
    }

    const data = (await response.json()) as { accessJwt?: string };
    if (!data.accessJwt) {
      throw new Error('Bluesky auth response did not include an access token');
    }

    return {
      accessJwt: data.accessJwt,
      requestBaseUrl,
    };
  }

  private async readResponseBody(response: Response): Promise<string> {
    try {
      const body = await response.text();
      const trimmed = body.trim();
      return trimmed.length > 0 ? trimmed : response.statusText;
    } catch {
      return response.statusText;
    }
  }

  private async fetchFeed(cursor?: string, limitOverride?: number): Promise<Response> {
    const authSession = await this.ensureAuthSession();
    const requestBaseUrl = authSession?.requestBaseUrl ?? this.getAnonymousApiBaseUrl();
    const url = new URL('/xrpc/app.bsky.feed.getFeed', requestBaseUrl);
    url.searchParams.set('feed', this.config.feedUri);
    url.searchParams.set('limit', String(limitOverride ?? this.getLimit()));
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    const headers = authSession
      ? {
          authorization: `Bearer ${authSession.accessJwt}`,
        }
      : undefined;

    let response = await this.fetchImpl(url.toString(), headers ? { headers } : undefined);

    if (response.status === 401 && this.hasAuthConfig()) {
      this.authSession = null;
      const refreshedSession = await this.ensureAuthSession(true);
      if (refreshedSession) {
        response = await this.fetchImpl(url.toString(), {
          headers: {
            authorization: `Bearer ${refreshedSession.accessJwt}`,
          },
        });
      }
    }

    if (!response.ok) {
      const body = await this.readResponseBody(response);
      throw new BlueskyFeedRequestError(
        `Bluesky feed request failed with HTTP ${response.status}${body ? `: ${body}` : ''}`,
        response.status,
        this.config.feedUri,
        requestBaseUrl,
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
        postUrl: this.getAppViewPostUrl(post),
        postCid: post?.cid?.trim() ?? '',
        authorDid,
        authorHandle,
      },
    };
  }

  private getAppViewPostUrl(post: BlueskyFeedPost | undefined): string {
    const uri = post?.uri?.trim();
    const handle = post?.author?.handle?.trim();
    if (!uri || !handle) {
      return '';
    }

    const match = /^at:\/\/[^/]+\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri);
    if (!match) {
      return '';
    }

    return `https://bsky.app/profile/${handle}/post/${match[1]}`;
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
