/** Caps that keep one iPad, paired or not, from wearing out the Mac. Real drawing stays well under each. */

/** HTTP requests per device, or per address before pairing. A cold page load fetches a few hundred files. */
export const HTTP_RATE = { burst: 600, perSecond: 60 };
/** WebSocket messages per device. A drawing client pushes at most every 40 ms. */
export const WS_RATE = { burst: 250, perSecond: 60 };
/** Sends per device. */
export const SEND_RATE = { burst: 3, perSecond: 1 / 10 };
/** Open WebSockets per device. */
export const MAX_SOCKETS_PER_DEVICE = 8;
/** One Send body: the PNG, the scene and the notes. */
export const MAX_SEND_BYTES = 20 * 1024 * 1024;
/** One WebSocket message. */
export const MAX_MESSAGE_BYTES = 20 * 1024 * 1024;
/** Every element of one board as JSON, deleted ones included. */
export const MAX_BOARD_BYTES = 64 * 1024 * 1024;
/** Any other request body, such as a pairing code. */
export const MAX_SMALL_BODY_BYTES = 4 * 1024;

/** A token bucket per key. Each key starts full. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly rate: { burst: number; perSecond: number },
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes one token for `key`. Returns false when the bucket is empty. */
  take(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.rate.burst, at: t };
    b.tokens = Math.min(this.rate.burst, b.tokens + ((t - b.at) / 1000) * this.rate.perSecond);
    b.at = t;
    this.buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
