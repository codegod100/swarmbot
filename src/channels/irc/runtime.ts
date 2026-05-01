import { createFreeqSession, loadFreeqCredentials } from '../../auth.js';
import type { FreeqSession, IrcConfig } from './types.js';
import { IrcAdapter } from './adapter.js';

/**
 * Create a ready-to-start IRC adapter from the local Freeq credentials.
 */
export async function createIrcAdapter(config: IrcConfig): Promise<IrcAdapter> {
  const creds = await loadFreeqCredentials();
  const session: FreeqSession = await createFreeqSession(creds);
  return new IrcAdapter(config, session);
}
