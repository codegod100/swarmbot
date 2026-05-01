import type { BlueskyConfig } from './types.js';
import { BlueskyAdapter, type BlueskyAdapterOptions } from './adapter.js';

/**
 * Create a ready-to-start Bluesky feed adapter.
 */
export async function createBlueskyAdapter(
  config: BlueskyConfig,
  options: BlueskyAdapterOptions = {},
): Promise<BlueskyAdapter> {
  return new BlueskyAdapter(config, options);
}
