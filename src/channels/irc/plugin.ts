import { createIrcAdapter } from './runtime.js';
import type { ChannelAdapter } from './channelTypes.js';
import type { IrcConfig } from './types.js';

export interface IrcChannelAccount {
  config: IrcConfig;
}

export interface ChannelPluginMetadata {
  id: string;
  displayName: string;
  description?: string;
}

export interface ChannelPlugin {
  metadata: ChannelPluginMetadata;
  createAdapter(account: IrcChannelAccount): Promise<ChannelAdapter>;
}

export const channelPlugin: ChannelPlugin = {
  metadata: {
    id: 'irc',
    displayName: 'IRC',
    description: 'Freeq-backed IRC channel adapter',
  },
  async createAdapter(account: IrcChannelAccount) {
    return createIrcAdapter(account.config);
  },
};
