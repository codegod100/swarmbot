/**
 * Swarm configuration types.
 */

import type { BlueskyConfig } from './channels/bluesky/types.js';
import type { IrcConfig } from './channels/irc/types.js';

export interface SwarmConfig {
  server: {
    mode: 'api' | 'selfhosted';
    apiKey?: string;
    baseUrl?: string;
  };
  agent: {
    name: string;
    id?: string;
  };
  channels: {
    irc: IrcConfig;
    bluesky?: BlueskyConfig;
  };
  /** Map of agent name → Letta agent ID for @mention dispatch */
  agents?: Record<string, string>;
}

/**
 * Load swarm config from YAML file.
 */
export async function loadConfig(path: string): Promise<SwarmConfig> {
  const { readFile } = await import('node:fs/promises');
  const YAML = await import('yaml');

  const content = await readFile(path, 'utf-8');
  const parsed = YAML.parse(content);

  // Expand env vars in strings
  const expanded = expandEnvVars(parsed) as SwarmConfig;

  const bluesky = normalizeBlueskyConfig(expanded.channels.bluesky);

  return {
    ...expanded,
    channels: {
      ...expanded.channels,
      irc: normalizeIrcConfig(expanded.channels.irc, bluesky),
      bluesky,
    },
  };
}

function normalizeIrcConfig(irc: IrcConfig, bluesky?: BlueskyConfig): IrcConfig {
  const mirrorChannel = bluesky?.enabled ? bluesky.mirrorChannel?.trim() || '#latha' : undefined;
  const joinChannels = normalizeJoinChannels([
    ...(irc.joinChannels ?? (irc.channel ? [irc.channel] : [])),
    ...(mirrorChannel ? [mirrorChannel] : []),
  ]);

  return {
    ...irc,
    channel: irc.channel ?? joinChannels[0],
    joinChannels,
  };
}

function normalizeBlueskyConfig(bluesky: BlueskyConfig | undefined): BlueskyConfig | undefined {
  if (!bluesky) {
    return undefined;
  }

  const feedUri = bluesky.feedUri.trim();
  if (!feedUri) {
    throw new Error('Bluesky config must define a feedUri');
  }

  const auth = normalizeBlueskyAuth(bluesky.auth);

  return {
    ...bluesky,
    feedUri,
    mirrorChannel: bluesky.mirrorChannel?.trim() || '#latha',
    pollIntervalMs: bluesky.pollIntervalMs > 0 ? bluesky.pollIntervalMs : 60_000,
    limit: bluesky.limit && bluesky.limit > 0 ? bluesky.limit : 1,
    apiBaseUrl: bluesky.apiBaseUrl?.trim() || undefined,
    auth,
  };
}

function normalizeBlueskyAuth(auth: BlueskyConfig['auth'] | undefined): BlueskyConfig['auth'] | undefined {
  if (!auth) {
    return undefined;
  }

  const identifier = auth.identifier.trim();
  const appPassword = auth.appPassword.trim();
  if (!identifier || !appPassword) {
    throw new Error('Bluesky auth must define identifier and appPassword');
  }

  return {
    identifier,
    appPassword,
    pdsUrl: auth.pdsUrl?.trim() || undefined,
  };
}

function normalizeJoinChannels(channels: string[]): string[] {
  const normalized = channels
    .map((channel) => channel.trim())
    .filter((channel) => channel.length > 0);
  const unique = [...new Set(normalized)];
  if (unique.length === 0) {
    throw new Error('IRC config must define at least one join channel');
  }
  return unique;
}

/**
 * Recursively expand ${VAR} environment variables in a config object.
 */
function expandEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_, name) => {
      const value = process.env[name];
      if (value === undefined) {
        throw new Error(`Environment variable ${name} is not set`);
      }
      return value;
    });
  }

  if (Array.isArray(obj)) {
    return obj.map(expandEnvVars);
  }

  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandEnvVars(value);
    }
    return result;
  }

  return obj;
}
