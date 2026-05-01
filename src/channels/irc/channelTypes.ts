export interface FormatterHints {
  supportsReactions?: boolean;
  supportsFiles?: boolean;
  formatHint?: string;
}

export interface InboundMessage {
  channel: string;
  chatId: string;
  userId: string;
  userName?: string;
  userHandle?: string;
  messageId?: string;
  text: string;
  timestamp: Date;
  threadId?: string;
  messageType?: 'dm' | 'group' | 'public';
  isGroup?: boolean;
  groupName?: string;
  wasMentioned?: boolean;
  replyToUser?: string;
  isBatch?: boolean;
  batchedMessages?: InboundMessage[];
  isListeningMode?: boolean;
  forcePerChat?: boolean;
  formatterHints?: FormatterHints;
  extraContext?: Record<string, string>;
}

export interface OutboundMessage {
  chatId: string;
  text: string;
  replyToMessageId?: string;
  threadId?: string;
  parseMode?: string;
}

export interface ChannelAdapter {
  readonly id: string;
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  sendMessage(msg: OutboundMessage): Promise<{ messageId: string }>;
  editMessage(chatId: string, messageId: string, text: string): Promise<void>;
  sendTypingIndicator(chatId: string): Promise<void>;
  stopTypingIndicator?(chatId: string): Promise<void>;
  getFormatterHints(): FormatterHints;
  onMessage?: (msg: InboundMessage) => Promise<void>;
}

