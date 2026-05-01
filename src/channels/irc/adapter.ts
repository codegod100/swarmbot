/**
 * IRC channel adapter for the standalone Freeq transport.
 *
 * This follows the same shape as Rookery's freeq-connect script:
 * WebSocket open -> CAP LS/NICK/USER -> CAP REQ sasl -> AUTHENTICATE pds-session
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../../logger.js';
import { buildPdsSessionPayload } from '../../auth.js';
import { formatForIrc } from './formatter.js';
import { Transport } from './transport.js';
import type { ChannelAdapter, FormatterHints, InboundMessage, OutboundMessage } from './channelTypes.js';
import type { FreeqSession, IrcConfig } from './types.js';

const log = createLogger('IrcAdapter');

const REQUESTED_CAPS = [
  'message-tags',
  'server-time',
  'batch',
  'multi-prefix',
  'echo-message',
  'account-notify',
  'extended-join',
  'away-notify',
] as const;

interface ParsedIrcLine {
  tags: Record<string, string>;
  prefix: string;
  command: string;
  params: string[];
}

/**
 * IRC channel adapter using a raw Freeq transport.
 */
export class IrcAdapter implements ChannelAdapter {
  readonly id = 'irc' as const;
  readonly name: string;

  private transport: Transport | null = null;
  private config: IrcConfig;
  private session: FreeqSession;
  private running = false;
  private joinedChannels = new Set<string>();
  private joinedAt = 0;
  private readDelayUntil = 0;

  onMessage?: (msg: InboundMessage) => Promise<void>;


  constructor(config: IrcConfig, session: FreeqSession) {
    this.config = config;
    this.session = session;
    this.name = `irc:${this.getJoinChannels().join(',')}`;
  }

  private getJoinChannels(): string[] {
    const channels = this.config.joinChannels ?? (this.config.channel ? [this.config.channel] : ['#swarm']);
    const normalized = channels
      .map((channel) => channel.trim())
      .filter((channel) => channel.length > 0);
    return [...new Set(normalized)];
  }

  private getPrimaryChannel(): string {
    return this.getJoinChannels()[0] ?? '#swarm';
  }

  /**
   * Connect to the IRC server and join the configured channels.
   */
  async start(): Promise<void> {
    if (this.transport) {
      this.transport.disconnect();
      this.transport = null;
    }

    this.resetConnectionState();

    this.transport = new Transport({
      url: this.config.server,
      onLine: (line) => this.handleLine(line),
      onStateChange: (state) => this.handleTransportState(state),
    });

    log.info(`Connecting to ${this.config.server}...`);
    this.transport.connect();
  }

  /**
   * Disconnect from the IRC server.
   */
  async stop(): Promise<void> {
    if (!this.transport) {
      return;
    }

    log.info('Disconnecting from IRC...');
    this.transport.disconnect();
    this.transport = null;
    this.resetConnectionState();
  }

  /**
   * Check if the adapter is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Send a message to the IRC channel.
   *
   * Chunks long messages at maxMessageLength with delay between chunks.
   */
  async sendMessage(msg: OutboundMessage): Promise<{ messageId: string }> {
    if (!this.transport || !this.running) {
      log.warn('Cannot send message: not connected');
      return { messageId: '' };
    }

    const text = formatForIrc(msg.text);
    const chunks = this.chunkMessage(text);
    const targetChannel = msg.chatId || this.getPrimaryChannel();

    log.info(`Sending IRC message to ${targetChannel}: len=${text.length}, chunks=${chunks.length}`);

    let lastMsgId = '';
    for (const [index, chunk] of chunks.entries()) {
      log.info(`Sending IRC chunk ${index + 1}/${chunks.length}: len=${chunk.length}`);
      this.sendLine(`PRIVMSG ${targetChannel} :${chunk}`);
      lastMsgId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (chunks.length > 1) {
        await this.delay(this.config.chunkDelay * 1000);
      }
    }

    return { messageId: lastMsgId };
  }

  /**
   * Edit a message (not supported on IRC).
   */
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    log.debug('Message editing not supported on IRC');
  }

  /**
   * Send a typing indicator (not supported on IRC).
   */
  async sendTypingIndicator(chatId: string): Promise<void> {
    // IRC doesn't support typing indicators.
  }

  /**
   * Get formatter hints for the channel runtime.
   */
  getFormatterHints(): FormatterHints {
    return {
      supportsReactions: false,
      supportsFiles: false,
      formatHint: 'plain',
    };
  }

  /**
   * Handle a transport state change.
   */
  private handleTransportState(state: 'disconnected' | 'connecting' | 'connected'): void {
    if (state === 'connected') {
      this.beginHandshake();
      return;
    }

    this.running = false;
  }

  /**
   * Start the IRC registration handshake.
   */
  private beginHandshake(): void {

    this.sendLine('CAP LS 302');
    this.sendLine(`NICK ${this.config.nick}`);
    this.sendLine(`USER ${this.config.nick} 0 * :swarm`);
  }

  /**
   * Handle an incoming raw IRC line.
   */
  private handleLine(line: string): void {
    const msg = parseIrcLine(line);

    switch (msg.command) {
      case 'PING': {
        const token = msg.params.join(' ');
        this.sendLine(token ? `PONG :${token}` : 'PONG');
        return;
      }

      case 'CAP': {
        this.handleCap(msg);
        return;
      }

      case 'AUTHENTICATE': {
        this.handleAuthenticate(msg);
        return;
      }

      case '900': {
        log.info(`Logged in as ${this.session.handle} (${this.session.did})`);
        return;
      }

      case '903': {
        this.sendLine('CAP END');
        return;
      }

      case '904': {
        const reason = msg.params[msg.params.length - 1] || 'SASL failed';
        log.error(`IRC SASL authentication failed: ${reason}`);
        this.transport?.disconnect();
        this.transport = null;
        this.resetConnectionState();
        return;
      }

      case '001': {
        this.joinedAt = Date.now();
        this.running = true;
        this.readDelayUntil = this.joinedAt + (this.config.messageReadDelayMs ?? 2_000);
        this.syncChannelMembership();
        if (this.config.messageReadDelayMs !== 0) {
          log.info(`Ignoring scrollback for ${this.config.messageReadDelayMs ?? 2_000}ms`);
        }
        return;
      }

      case 'JOIN': {
        this.handleJoin(msg);
        return;
      }

      case 'PART':
      case 'KICK': {
        this.handlePart(msg);
        return;
      }

      case 'PRIVMSG': {
        this.handlePrivmsg(msg);
        return;
      }

      default:
        return;
    }
  }

  /**
   * Handle CAP negotiation.
   */
  private handleCap(msg: ParsedIrcLine): void {
    const subcommand = msg.params[1]?.toUpperCase();
    const capsText = msg.params.slice(2).join(' ');
    const caps = splitCaps(capsText);

    if (subcommand === 'LS') {
      const requested: string[] = REQUESTED_CAPS.filter((cap) => caps.includes(cap));
      if (caps.includes('sasl')) {
        requested.push('sasl');
      }

      if (requested.length > 0) {
        this.sendLine(`CAP REQ :${requested.join(' ')}`);
      } else {
        this.sendLine('CAP END');
      }
      return;
    }

    if (subcommand === 'ACK') {
      if (caps.includes('sasl')) {
        this.sendLine('AUTHENTICATE ATPROTO-CHALLENGE');
      } else {
        this.sendLine('CAP END');
      }
      return;
    }

    if (subcommand === 'NAK') {
      this.sendLine('CAP END');
    }
  }

  /**
   * Handle our own JOIN confirmation and leave any channel that is not configured.
   */
  private handleJoin(msg: ParsedIrcLine): void {
    const senderNick = prefixNick(msg.prefix);
    const channel = this.normalizeChannelName(msg.params[0]);
    if (!senderNick || !channel) {
      return;
    }

    if (senderNick !== this.config.nick) {
      return;
    }

    this.joinedChannels.add(channel);
    if (!this.isConfiguredChannel(channel)) {
      log.info(`Leaving unconfigured channel ${channel}`);
      this.sendLine(`PART ${channel} :not in configured joinChannels`);
      this.joinedChannels.delete(channel);
    }
  }

  /**
   * Handle our own PART/KICK confirmation.
   */
  private handlePart(msg: ParsedIrcLine): void {
    const senderNick = prefixNick(msg.prefix);
    const channel = this.normalizeChannelName(msg.params[0]);
    if (!senderNick || !channel) {
      return;
    }

    if (senderNick !== this.config.nick) {
      return;
    }

    this.joinedChannels.delete(channel);
  }

  /**
   * Reconcile the active IRC channels against the configured join list.
   */
  private syncChannelMembership(): void {
    const desiredChannels = this.getJoinChannels();
    const desiredSet = new Set(desiredChannels.map((channel) => channel.toLowerCase()));
    let joinedAny = false;

    for (const channel of [...this.joinedChannels]) {
      if (!desiredSet.has(channel.toLowerCase())) {
        log.info(`Leaving unconfigured channel ${channel}`);
        this.sendLine(`PART ${channel} :not in configured joinChannels`);
        this.joinedChannels.delete(channel);
      }
    }

    for (const channel of desiredChannels) {
      if (this.hasJoinedChannel(channel)) {
        continue;
      }

      this.sendLine(`POLICY ${channel} ACCEPT`);
      this.sendLine(`JOIN ${channel}`);
      joinedAny = true;
    }

    if (joinedAny) {
      log.info(`Joined channels ${desiredChannels.join(', ')}`);
    }
  }

  private hasJoinedChannel(channel: string): boolean {
    const normalized = channel.toLowerCase();
    return [...this.joinedChannels].some((current) => current.toLowerCase() === normalized);
  }

  private isConfiguredChannel(channel: string): boolean {
    const normalized = channel.toLowerCase();
    return this.getJoinChannels().some((configured) => configured.toLowerCase() === normalized);
  }

  private normalizeChannelName(channel: string | undefined): string | null {
    const trimmed = channel?.trim();
    return trimmed ? trimmed : null;
  }

  /**
   * Handle SASL challenge/continuation lines.
   */
  private handleAuthenticate(msg: ParsedIrcLine): void {
    const payload = msg.params[0] || '';
    if (!payload || payload === '+') {
      return;
    }

    const response = buildPdsSessionPayload(this.session, payload);
    this.sendAuthenticatePayload(response);
  }

  /**
   * Send the SASL response, chunking if needed.
   */
  private sendAuthenticatePayload(payload: string): void {
    if (payload.length <= 400) {
      this.sendLine(`AUTHENTICATE ${payload}`);
      return;
    }

    for (let i = 0; i < payload.length; i += 400) {
      this.sendLine(`AUTHENTICATE ${payload.slice(i, i + 400)}`);
    }
    this.sendLine('AUTHENTICATE +');
  }

  /**
   * Handle an incoming message from IRC.
   */
  private handlePrivmsg(msg: ParsedIrcLine): void {
    const senderNick = prefixNick(msg.prefix);
    if (!senderNick) {
      log.debug('Ignoring message with no sender');
      return;
    }

    if (senderNick === this.config.nick) {
      return;
    }

    const target = msg.params[0] || this.getPrimaryChannel();
    const isChannelTarget = target.startsWith('#') || target.startsWith('&');
    const replyTarget = isChannelTarget ? target : senderNick;
    const hasServerTime = typeof msg.tags.time === 'string' && msg.tags.time.length > 0;
    if (hasServerTime) {
      const messageTime = parseTimestamp(msg.tags.time).getTime();
      if (messageTime < this.joinedAt) {
        log.debug(`Ignoring scrollback message before join: ${senderNick}`);
        return;
      }
    } else if (Date.now() < this.readDelayUntil) {
      log.debug(`Ignoring message during scrollback delay: ${senderNick}`);
      return;
    }

    if (!this.config.allowedUsers.includes(senderNick)) {
      log.debug(`Ignoring message from unauthorized user: ${senderNick}`);
      if (this.transport) {
        this.sendLine(`PRIVMSG ${replyTarget} :${senderNick}: not authorized`);
      }
      return;
    }
    const messageText = msg.params.slice(1).join(' ').trim();
    if (!messageText) {
      log.debug(`Ignoring empty message from ${senderNick}`);
      return;
    }
    if (!this.onMessage) {
      log.warn('No onMessage handler set');
      return;
    }

    const inbound: InboundMessage = {
      channel: 'irc',
      chatId: replyTarget,
      userId: senderNick,
      userName: senderNick,
      messageId: msg.tags.msgid || randomUUID(),
      text: messageText,
      timestamp: parseTimestamp(msg.tags.time),
      messageType: isChannelTarget ? 'group' : 'dm',
      isGroup: isChannelTarget,
      groupName: isChannelTarget ? target : undefined,
    };

    this.onMessage(inbound).catch((err) => {
      log.error('Error delivering incoming IRC message:', err);
    });
  }

  /**
   * Send a raw IRC line.
   */
  private sendLine(line: string): void {
    if (!this.transport) {
      return;
    }

    this.transport.send(line);
  }

  /**
   * Reset runtime handshake state.
   */
  private resetConnectionState(): void {
    this.running = false;
    this.joinedChannels.clear();
    this.joinedAt = 0;
    this.readDelayUntil = 0;
  }

  /**
   * Chunk a message at maxMessageLength, respecting word boundaries.
   */
  private chunkMessage(text: string): string[] {
    const maxLen = this.config.maxMessageLength;

    if (text.length <= maxLen) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLen) {
      let breakPoint = remaining.lastIndexOf(' ', maxLen);
      if (breakPoint === -1 || breakPoint < maxLen * 0.5) {
        breakPoint = maxLen;
      }

      chunks.push(remaining.slice(0, breakPoint).trim());
      remaining = remaining.slice(breakPoint).trim();
    }

    if (remaining.length > 0) {
      chunks.push(remaining);
    }

    return chunks;
  }

  /**
   * Delay helper.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function parseIrcLine(raw: string): ParsedIrcLine {
  let line = raw.replace(/\r?\n$/, '');
  const tags: Record<string, string> = {};

  if (line.startsWith('@')) {
    const space = line.indexOf(' ');
    const tagSection = line.slice(1, space);
    line = line.slice(space + 1).trimStart();

    for (const tag of tagSection.split(';')) {
      const eq = tag.indexOf('=');
      if (eq >= 0) {
        tags[tag.slice(0, eq)] = tag
          .slice(eq + 1)
          .replace(/\\s/g, ' ')
          .replace(/\\:/g, ';')
          .replace(/\\\\/g, '\\')
          .replace(/\\r/g, '\r')
          .replace(/\\n/g, '\n');
      } else {
        tags[tag] = '';
      }
    }
  }

  let prefix = '';
  if (line.startsWith(':')) {
    const space = line.indexOf(' ');
    prefix = line.slice(1, space);
    line = line.slice(space + 1);
  }

  const params: string[] = [];
  while (line.length > 0) {
    if (line.startsWith(':')) {
      params.push(line.slice(1));
      break;
    }

    const space = line.indexOf(' ');
    if (space === -1) {
      params.push(line);
      break;
    }

    params.push(line.slice(0, space));
    line = line.slice(space + 1);
  }

  const command = (params.shift() || '').toUpperCase();
  return { tags, prefix, command, params };
}

function prefixNick(prefix: string): string {
  const bang = prefix.indexOf('!');
  return bang > 0 ? prefix.slice(0, bang) : prefix;
}

function splitCaps(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
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
