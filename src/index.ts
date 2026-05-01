/**
 * Swarm — IRC bot for Letta agents using Freeq pds-session auth.
 *
 * Usage:
 *   npm start
 *
 * First time:
 *   1. Set FREEQ_CREDS_PATH to a rookery creds JSON file.
 *   2. Run npm start.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createLogger } from './logger.js';
import { createSwarmBot } from './bot.js';
import { loadConfig } from './config.js';

const log = createLogger('Swarm');
const __dirname = dirname(fileURLToPath(import.meta.url));

export async function loadDotEnv(filePath: string): Promise<void> {
  if (!existsSync(filePath)) {
    return;
  }

  const content = await readFile(filePath, 'utf-8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const entry = line.startsWith('export ') ? line.slice(7).trim() : line;
    const equals = entry.indexOf('=');
    if (equals < 0) {
      continue;
    }

    const key = entry.slice(0, equals).trim();
    if (!key || (process.env[key] !== undefined && process.env[key] !== '')) {
      continue;
    }

    let value = entry.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t');
  }
}

async function main() {
  const configPath = resolve(__dirname, '..', 'swarm.yaml');
  if (!existsSync(configPath)) {
    log.error(`Config file not found: ${configPath}`);
    process.exit(1);
  }

  await loadDotEnv(resolve(__dirname, '..', '.env'));

  log.info('Loading config...');
  const config = await loadConfig(configPath);

  const enabledChannels = [
    config.channels.irc.enabled ? `irc:${(config.channels.irc.joinChannels ?? []).join(', ')}` : null,
    config.channels.bluesky?.enabled ? `bluesky:${config.channels.bluesky.feedUri}` : null,
  ].filter((value): value is string => Boolean(value));

  if (enabledChannels.length === 0) {
    log.error('No channels are enabled in swarm.yaml');
    process.exit(1);
  }

  const bot = createSwarmBot({ config, logger: log });

  log.info(`Starting ${config.agent.name} on ${enabledChannels.join(' | ')}...`);
  await bot.start();
  log.info('Swarm bot running. Press Ctrl+C to stop.');

  const shutdown = async () => {
    log.info('Shutting down...');
    await bot.stop();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((err) => {
    log.error({ err }, 'Fatal error');
    process.exit(1);
  });
}
