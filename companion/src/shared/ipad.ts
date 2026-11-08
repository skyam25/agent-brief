/**
 * The iPad's LAN API. HTTP/1.1 and JSON over TLS on the local network. The app's certificate is
 * self-signed, and the iPad pins its SHA-256 fingerprint from the pairing QR code.
 *
 * POST /v1/pair                  PairRequest → PairResponse (no credential)
 * GET  /v1/handoffs              → LanHandoffsResponse
 * GET  /v1/handoffs/:id          → LanHandoffDetail
 * GET  /v1/handoffs/:id/page/*  → a file of a page hand-off's project, as is. HTML gets the review overlay.
 * POST /v1/handoffs/:id/deliver  IpadDelivery or IpadPageDelivery → IpadDeliveryResult
 * DELETE /v1/handoffs/:id        → LanRemoveResponse. Removes the hand-off from the Mac and every device.
 * POST /v1/unpair                → UnpairResponse. Removes the calling iPad from this Mac.
 *
 * Other routes send `Authorization: Bearer <credential>`. A bad credential answers 401.
 * An iPad can pair with several Macs and a Mac with several iPads. Each pair has its own credential.
 * Errors use the socket protocol's ErrorBody. Add fields and routes only.
 *
 * ios/AgentBrief/Sources/LanProtocol.swift mirrors these shapes.
 */

import type { Handoff } from '../protocol';
import type { StrokeEvent } from '../voice/types';

export const IPAD_LAN_PORT = 47613;

/** Largest delivery body. Board pictures travel inside the scene. */
export const IPAD_MAX_BODY_BYTES = 64 * 1024 * 1024;

/** What the pairing QR code carries. */
export interface PairLink {
  /** Addresses to try in order: the Mac's `.local` name, then its LAN IPs. */
  hosts: string[];
  port: number;
  /** One use, good for 10 minutes. */
  code: string;
  /** Base64url SHA-256 of the certificate's DER bytes. */
  fingerprint: string;
  /** The Mac's name, for the iPad to show. */
  mac: string;
}

export function pairUrl(link: PairLink): string {
  const q = new URLSearchParams({
    h: link.hosts.join(','),
    p: String(link.port),
    c: link.code,
    f: link.fingerprint,
    m: link.mac,
  });
  return `agentbrief://pair?${q}`;
}

export function parsePairUrl(url: string): PairLink | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'agentbrief:' || u.host !== 'pair') return undefined;
  const q = u.searchParams;
  const hosts = (q.get('h') ?? '').split(',').filter(Boolean);
  const port = Number(q.get('p'));
  const code = q.get('c') ?? '';
  const fingerprint = q.get('f') ?? '';
  if (!hosts.length || !Number.isInteger(port) || port < 1 || port > 65535 || !code || !fingerprint) return undefined;
  return { hosts, port, code, fingerprint, mac: q.get('m') ?? '' };
}

export interface PairRequest {
  code: string;
  /** The iPad's name, for the Mac's device list. */
  deviceName: string;
  /** Stays the same for this iPad, so pairing again replaces its old entry instead of adding one. */
  installId?: string;
}

export interface PairResponse {
  /** `<device id>.<secret>`. The iPad keeps it in its Keychain. */
  credential: string;
  macName: string;
}

export interface UnpairResponse {
  ok: true;
}

export interface LanHandoffsResponse {
  /** Open hand-offs, newest first. Every paired iPad sees them. */
  handoffs: Handoff[];
}

export interface LanRemoveResponse {
  /** False when the Mac had no such hand-off, which leaves the same result. */
  removed: boolean;
}

export interface LanHandoffDetail {
  handoff: Handoff;
  /** Excalidraw scene JSON to start from. Null starts a blank board. */
  scene: string | null;
  notes: string;
}

/** One phrase of on-device speech, in ms on the same clock as `strokes`. */
export interface IpadUtterance {
  t: number;
  tEnd: number;
  text: string;
}

/**
 * The finished work. The iPad rebases strokes and utterances so the earliest is 0.
 * The same iPad delivering a hand-off twice gets its first result and writes nothing, so the outbox can retry safely.
 * Another iPad's delivery is its own Send to the same session, so no one's work is dropped.
 */
export interface IpadDelivery {
  /** Long edge 1400 px or less. */
  pngBase64: string;
  scene: unknown;
  notes?: string;
  strokes: StrokeEvent[];
  utterances: IpadUtterance[];
  bounds: { x: number; y: number; width: number; height: number };
  /** Comments pinned on the iPad. The Mac checks them when it sends. */
  comments?: unknown;
}

/**
 * The finished review of a page hand-off. The Mac sends it as a review, so the session gets review.md.
 * `comments` are review comments pinned to the page. `body` is the overall note.
 */
export interface IpadPageDelivery {
  review: { comments: unknown; body?: string };
  notes?: string;
  utterances: IpadUtterance[];
}

/** The path a page hand-off's files load from: `/v1/handoffs/<id>/page/<project path>`. HTML comes with the review overlay added. */
export const IPAD_PAGE_SEGMENT = 'page';

export interface IpadDeliveryResult {
  ok: true;
  state: Extract<Handoff['state'], 'delivered' | 'filed'>;
  /** A sentence the iPad shows. */
  message: string;
}
