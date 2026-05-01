import pino from 'pino';

/**
 * Shared logger factory for the swarm runtime.
 */
export function createLogger(name: string) {
  return pino({ name });
}
