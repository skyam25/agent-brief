/** Keeps one device, paired or not, from wearing out the Mac. Real use stays well under each cap. */

/** Requests per device, or per address before pairing. */
export const REQUEST_RATE = { burst: 120, perSecond: 20 };
/** Pairing attempts per address. */
export const PAIR_RATE = { burst: 10, perSecond: 1 / 6 };
/** Deliveries per device. The outbox retries, so this leaves it room. */
export const DELIVER_RATE = { burst: 20, perSecond: 1 / 3 };
/** Any body other than a delivery, such as a pairing code. */
export const MAX_SMALL_BODY_BYTES = 4 * 1024;

/** A token bucket per key. Each key starts full. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

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
