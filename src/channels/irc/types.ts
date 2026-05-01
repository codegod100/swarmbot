/**
 * IRC channel types for Freeq-backed transport.
 */

/**
 * IRC channel configuration.
 */
export interface IrcConfig {
  enabled: boolean;
  /** WebSocket URL for Freeq IRC server */
  server: string;
  /** Desired IRC nick */
  nick: string;
  /** Legacy single-channel fallback */
  channel?: string;
  /** Channels to join (e.g., ["#swarm"]) */
  joinChannels?: string[];
  /** DM policy */
  dmPolicy: 'allowlist' | 'open';
  /** List of allowed nicks (exact match) */
  allowedUsers: string[];
  /** Max message length before chunking */
  maxMessageLength: number;
  /** Delay between chunks in seconds */
  chunkDelay: number;
  /** Delay after joining before processing messages, in milliseconds */
  messageReadDelayMs?: number;
}

/**
 * Short-lived PDS-backed Freeq session used for IRC SASL auth.
 */
export interface FreeqSession {
  did: string;
  handle: string;
  accessJwt: string;
  pdsOrigin: string;
}
