/**
 * Bluesky feed channel configuration.
 */
export interface BlueskyConfig {
  enabled: boolean;
  /** AT Protocol feed URI, e.g. at://did:plc:.../app.bsky.feed.generator/<record-key> */
  feedUri: string;
  /** IRC channel to mirror feed posts into. */
  mirrorChannel?: string;
  /** Poll interval in milliseconds */
  pollIntervalMs: number;
  /** Maximum posts to fetch per poll */
  limit?: number;
  /** Bluesky AppView base URL */
  apiBaseUrl?: string;
}
