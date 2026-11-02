/** Pairing, hand-offs and the LAN listener, tied together. The listener runs while the pair sheet is open or an iPad is paired. */

import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { BoardError, notFound } from '../board/errors';
import type { Handoff, HandoffRequest, IpadStatus } from '../protocol';
import type { IpadSheetStatus, SendPayload } from '../shared/ipc';
import { IPAD_LAN_PORT, pairUrl, type IpadDelivery, type IpadDeliveryResult, type LanHandoffDetail } from '../shared/ipad';
import { ensureCert, type LanCert } from './cert';
import { HandoffStore, publicHandoff, type StoredHandoff } from './handoffs';
import { lanAddresses, macNames, networkLabel, type Interfaces } from './lan';
import { createLanServer, type LanServer } from './lan-server';
import { PairingStore } from './pairing';

export const NO_LAN = "This Mac isn't on a private network. Join the same Wi-Fi as the iPad, then try again.";
export const NOT_PAIRED = 'No iPad is paired. On the Mac, choose Pair iPad… from the File menu.';
const UNPAIR_STOP_DELAY_MS = 500;

export interface IpadDeps {
  /** Pairing, the certificate and hand-offs live under `<dataDir>/ipad`. */
  dataDir: string;
  isLive(sessionId: string): boolean;
  /** The session's name as the panel shows it. */
  sessionLabel(sessionId: string): string;
  /** Resolves a requested base board to a stored one. Throws `not_found` for an unknown name. */
  resolveBoard(name: string): string;
  loadBoard(name: string): { scene: string | null; notes: string };
  /** Saves the iPad's work as this board. */
  saveBoard(name: string, scene: string, notes: string | undefined): void;
  /** Lists the board under the session, live or ended. */
  fileBoard(name: string, sessionId: string): void;
  /** Sends to exactly this session. */
  send(payload: SendPayload, sessionId: string): Promise<{ ok: boolean; message: string }>;
  /** Fires when the sheet's content changes. */
  onStatus?(status: IpadSheetStatus): void;
  /** Fires when an iPad is paired or forgotten. */
  onPairedChange?(paired: boolean): void;
  /** Binds here instead of every interface, and names it in the QR code. */
  host?: string;
  port?: number;
  interfaces?: () => Interfaces;
  names?: () => { computer: string; local?: string };
}

export class Ipad {
  private readonly pairing: PairingStore;
  private readonly handoffs: HandoffStore;
  private readonly interfaces: () => Interfaces;
  private readonly names: () => { computer: string; local?: string };
  private readonly inFlight = new Map<string, Promise<IpadDeliveryResult>>();
  private cert?: LanCert;
  private server?: LanServer;
  private port?: number;
  private sheetOpen = false;
  private link?: { url: string; qrSvg: string; network?: string };
  private error?: string;
  private refused?: string;
  /** Starts and stops run one at a time. */
  private work: Promise<void> = Promise.resolve();

  constructor(private readonly deps: IpadDeps) {
    const dir = join(deps.dataDir, 'ipad');
    this.pairing = new PairingStore({ devicesFile: join(dir, 'devices.json') });
    this.handoffs = new HandoffStore({ file: join(dir, 'handoffs.json') });
    this.interfaces = deps.interfaces ?? networkInterfaces;
    this.names = deps.names ?? macNames;
    let paired = this.pairing.paired;
    this.pairing.onChange(() => {
      if (paired !== this.pairing.paired) {
        paired = this.pairing.paired;
        deps.onPairedChange?.(paired);
      }
      this.publish();
    });
  }

  // ── Listener ──────────────────────────────────────────────────────────

  /** Brings the listener in line with whether anything needs it. */
  sync(): Promise<void> {
    this.work = this.work.then(async () => {
      const wanted = this.sheetOpen || this.pairing.paired;
      if (wanted && !this.server) await this.startServer();
      else if (!wanted && this.server) await this.stopServer();
    });
    return this.work;
  }

  /** Closes the listener for good, on quit. */
  stop(): Promise<void> {
    this.sheetOpen = false;
    this.work = this.work.then(() => this.stopServer());
    return this.work;
  }

  private async startServer(): Promise<void> {
    try {
      this.cert ??= ensureCert(join(this.deps.dataDir, 'ipad'));
      const server = createLanServer({
        cert: this.cert,
        host: this.deps.host ?? '0.0.0.0',
        port: this.deps.port ?? IPAD_LAN_PORT,
        interfaces: this.interfaces,
        onRefused: (address) => {
          this.refused = address;
          this.publish();
        },
        backend: {
          verify: (credential) => this.pairing.verify(credential),
          pair: (code, deviceName, installId) => {
            const redeemed = this.pairing.redeem(code, deviceName, installId);
            if (!redeemed) return undefined;
            this.link = undefined;
            this.publish();
            return { credential: redeemed.credential, macName: this.names().computer };
          },
          handoffs: () => ({ handoffs: this.handoffs.list({ open: true }).map(publicHandoff) }),
          detail: (id) => this.detail(id),
          deliver: (id, deviceId, delivery) => this.deliver(id, deviceId, delivery),
          unpair: (deviceId) => {
            this.pairing.revoke(deviceId);
            // The reply goes out before the listener may stop.
            setTimeout(() => void this.sync(), UNPAIR_STOP_DELAY_MS).unref();
          },
        },
      });
      this.port = await server.listen();
      this.server = server;
      this.error = undefined;
    } catch (err) {
      this.error = `Could not start the iPad listener: ${(err as Error).message}`;
    }
  }

  private async stopServer(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    await server?.close();
  }

  // ── Pair sheet ────────────────────────────────────────────────────────

  async openSheet(): Promise<IpadSheetStatus> {
    this.sheetOpen = true;
    this.refused = undefined;
    await this.sync();
    return this.newCode();
  }

  async closeSheet(): Promise<void> {
    this.sheetOpen = false;
    this.pairing.cancelCode();
    this.link = undefined;
    await this.sync();
  }

  /** Makes a QR code with a fresh pairing code. The previous code stops working. */
  async newCode(): Promise<IpadSheetStatus> {
    this.link = undefined;
    if (!this.server || !this.cert || this.port === undefined) return this.publish();
    const addresses = lanAddresses(this.interfaces());
    const names = this.names();
    const hosts = this.deps.host ? [this.deps.host] : [...(names.local && addresses.length ? [names.local] : []), ...addresses];
    if (!hosts.length) {
      this.error = NO_LAN;
      return this.publish();
    }
    this.error = undefined;
    const url = pairUrl({ hosts, port: this.port, code: this.pairing.newCode(), fingerprint: this.cert.fingerprint, mac: names.computer });
    const qrSvg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
    this.link = { url, qrSvg, ...(addresses[0] ? { network: networkLabel(addresses[0], this.interfaces()) } : {}) };
    return this.publish();
  }

  forget(id: string): IpadSheetStatus {
    this.pairing.revoke(id);
    void this.sync();
    return this.sheetStatus();
  }

  sheetStatus(): IpadSheetStatus {
    return {
      devices: this.pairing.list(),
      ...(this.link ?? {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.refused ? { refused: this.refused } : {}),
    };
  }

  private publish(): IpadSheetStatus {
    const status = this.sheetStatus();
    this.deps.onStatus?.(status);
    return status;
  }

  // ── Socket routes ─────────────────────────────────────────────────────

  status(): IpadStatus {
    return { paired: this.pairing.paired, devices: this.pairing.list() };
  }

  createHandoff(req: HandoffRequest): Handoff {
    if (!this.pairing.paired) throw new BoardError('conflict', NOT_PAIRED);
    return publicHandoff(
      this.handoffs.create({
        sessionId: req.sessionId,
        sessionLabel: this.deps.sessionLabel(req.sessionId),
        ...(req.prompt ? { prompt: req.prompt } : {}),
        ...(req.board ? { baseBoard: this.deps.resolveBoard(req.board) } : {}),
      }),
    );
  }

  listHandoffs(sessionId?: string): Handoff[] {
    return this.handoffs.list(sessionId ? { sessionId } : {}).map(publicHandoff);
  }

  removeHandoff(id: string): boolean {
    return this.handoffs.remove(id);
  }

  // ── LAN routes ────────────────────────────────────────────────────────

  private stored(id: string): StoredHandoff {
    const handoff = this.handoffs.get(id);
    if (!handoff) throw notFound(`no hand-off ${id}`);
    return handoff;
  }

  private detail(id: string): LanHandoffDetail {
    const handoff = this.stored(id);
    const base = handoff.baseBoard ? this.deps.loadBoard(handoff.baseBoard) : { scene: null, notes: '' };
    return { handoff: publicHandoff(handoff), scene: base.scene, notes: base.notes };
  }

  /**
   * The same iPad delivering twice gets its first result and writes nothing.
   * Another iPad's delivery is its own Send to the same session, on its own board.
   */
  private deliver(id: string, deviceId: string, delivery: IpadDelivery): Promise<IpadDeliveryResult> {
    const handoff = this.stored(id);
    const first = handoff.results?.[deviceId];
    if (first) return Promise.resolve(first);
    const key = `${id}:${deviceId}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const answered = Object.keys(handoff.results ?? {}).length > 0 || [...this.inFlight.keys()].some((k) => k.startsWith(`${id}:`));
    const board = answered ? `${handoff.boardName}-${deviceId.slice(0, 6)}` : handoff.boardName;
    const work = this.settle(handoff, deviceId, board, delivery).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }

  private async settle(handoff: StoredHandoff, deviceId: string, board: string, delivery: IpadDelivery): Promise<IpadDeliveryResult> {
    const { id, sessionId, sessionLabel } = handoff;

    // The work reaches the Mac's board first, so a failed Send loses nothing.
    this.deps.saveBoard(board, JSON.stringify(delivery.scene), delivery.notes);
    let result: IpadDeliveryResult;
    if (this.deps.isLive(sessionId)) {
      const sent = await this.deps.send(toSendPayload(board, delivery), sessionId);
      if (!sent.ok) throw new BoardError('unavailable', sent.message);
      result = { ok: true, state: 'delivered', message: sent.message };
    } else {
      result = { ok: true, state: 'filed', message: `"${sessionLabel}" has ended, so your work waits on the Mac under that session.` };
    }
    this.deps.fileBoard(board, sessionId);
    this.handoffs.settle(id, deviceId, result);
    return result;
  }
}

function toSendPayload(board: string, d: IpadDelivery): SendPayload {
  return {
    boardName: board,
    png: Buffer.from(d.pngBase64, 'base64'),
    scene: d.scene,
    notes: d.notes ?? '',
    strokes: d.strokes,
    segments: [],
    utterances: d.utterances,
    bounds: d.bounds,
  };
}
