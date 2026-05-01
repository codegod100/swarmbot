/**
 * Bluesky feed channel configuration.
 */
export interface BlueskyAuthConfig {
  /** Bluesky handle or DID used to create a session. */
  identifier: string;
  /** Bluesky app password for the session. */
  appPassword: string;
  /** PDS base URL used for authenticated app requests. */
  pdsUrl?: string;
}

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
  /** Bluesky AppView base URL for anonymous requests */
  apiBaseUrl?: string;
  /** Optional Bluesky auth session used for personalized feeds. */
  auth?: BlueskyAuthConfig;
}
