type TransportState = 'disconnected' | 'connecting' | 'connected';

interface TransportOptions {
  url: string;
  onLine: (line: string) => void;
  onStateChange?: (state: TransportState) => void;
  reconnectDelayMs?: number;
  heartbeatIntervalMs?: number;
}

/**
 * Thin WebSocket transport for raw IRC traffic.
 */
export class Transport {
  private readonly opts: TransportOptions;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private intentionalClose = false;

  constructor(opts: TransportOptions) {
    this.opts = {
      reconnectDelayMs: 1_000,
      heartbeatIntervalMs: 45_000,
      ...opts,
    };
  }

  connect(): void {
    if (this.ws) {
      return;
    }

    if (typeof WebSocket === 'undefined') {
      throw new Error('WebSocket is not available in this runtime');
    }

    this.intentionalClose = false;
    this.clearReconnect();
    this.setState('connecting');

    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.onopen = () => {
      this.setState('connected');
      this.startHeartbeat();
    };

    ws.onmessage = (event) => {
      this.opts.onLine(String(event.data));
    };

    ws.onerror = () => {
      // Let onclose drive the reconnect path.
    };

    ws.onclose = () => {
      this.stopHeartbeat();
      this.ws = null;
      this.setState('disconnected');

      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };
  }

  send(line: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(`${line}\r\n`);
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearReconnect();
    this.stopHeartbeat();

    if (!this.ws) {
      this.setState('disconnected');
      return;
    }

    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send('QUIT :Leaving');
      }
      this.ws.close();
    } finally {
      this.ws = null;
      this.setState('disconnected');
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.intentionalClose) {
        this.connect();
      }
    }, this.opts.reconnectDelayMs);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send('PING :heartbeat');
      }
    }, this.opts.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(state: TransportState): void {
    this.opts.onStateChange?.(state);
  }
}
