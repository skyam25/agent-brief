/** "Open on iPad": the LAN web server, its pairing code and its devices. */

import { networkInterfaces } from 'node:os';
import type { Delivery } from '../protocol';
import type { DeliveryInput } from '../server/contract';
import type { IpadStatus } from '../shared/ipc';
import { pickLanInterface, type LanInterface } from '../web/lan';
import type { SyncHub } from '../web/sync-hub';
import { createWebServer, DEFAULT_PORT, type WebServer } from '../web/web-server';

export interface IpadOptions {
  hub: SyncHub;
  staticDir: string;
  devicesFile: string;
  deliver: (input: DeliveryInput) => Promise<Delivery>;
  /** The board the Mac shows, which the iPad opens first. */
  currentBoard: () => string;
  /** A session's title or folder name, for "Sent to …" on the iPad. */
  describeSession: (sessionId: string) => string;
  /** Fixed address, for tests. Otherwise the Mac's private LAN address. */
  host?: string;
  port?: number;
  /** Whether the macOS firewall note was shown before. */
  introShown: () => boolean;
  markIntroShown: () => void;
  onStatus: (status: IpadStatus) => void;
  interfaces?: () => ReturnType<typeof networkInterfaces>;
}

export const NO_LAN =
  'No private network found. Join the same Wi-Fi as the iPad, then try again. The board is never served to the internet.';

/** `192.168.1.x` for a /24 network, otherwise the CIDR. */
export function networkLabel(iface: LanInterface): string {
  const [base, prefix] = iface.cidr.split('/');
  return prefix === '24' ? base.replace(/\.0$/, '.x') : iface.cidr;
}

export class Ipad {
  private server?: WebServer;
  private status: IpadStatus = { running: false, devices: [] };

  constructor(private readonly opts: IpadOptions) {}

  current(): IpadStatus {
    return this.status;
  }

  private publish(patch: Partial<IpadStatus>): IpadStatus {
    this.status = { ...this.status, ...patch, devices: this.server?.devices() ?? this.status.devices };
    this.opts.onStatus(this.status);
    return this.status;
  }

  /** Starts the server when needed and makes a fresh pairing code. */
  async open(): Promise<IpadStatus> {
    if (!this.server) {
      const iface = this.opts.host ? undefined : pickLanInterface((this.opts.interfaces ?? networkInterfaces)());
      const host = this.opts.host ?? iface?.address;
      if (!host) return this.publish({ running: false, url: undefined, qrSvg: undefined, error: NO_LAN });
      this.status = { ...this.status, network: iface && networkLabel(iface), refused: undefined };
      const server = createWebServer({
        host,
        port: this.opts.port ?? DEFAULT_PORT,
        staticDir: this.opts.staticDir,
        devicesFile: this.opts.devicesFile,
        hub: this.opts.hub,
        deliver: this.opts.deliver,
        current: this.opts.currentBoard,
        describeSession: this.opts.describeSession,
      });
      server.onChange((s) => {
        if (!s.running && this.server === server) this.server = undefined;
        this.publish({
          running: s.running,
          devices: s.devices,
          refused: s.refused,
          ...(s.running ? {} : { url: undefined, qrSvg: undefined }),
        });
      });
      try {
        const bound = await server.start();
        this.server = server;
        this.publish({ host: bound.host, port: bound.port });
      } catch (err) {
        return this.publish({ running: false, error: `Could not start the iPad server: ${(err as Error).message}` });
      }
    }
    const firstRun = !this.opts.introShown();
    if (firstRun) this.opts.markIntroShown();
    const { url, qrSvg } = await this.server!.newPairingUrl();
    return this.publish({ running: true, url, qrSvg, error: undefined, firstRun });
  }

  async stop(): Promise<IpadStatus> {
    const server = this.server;
    this.server = undefined;
    await server?.stop();
    return this.publish({ running: false, url: undefined, qrSvg: undefined });
  }

  revoke(id: string): IpadStatus {
    this.server?.revoke(id);
    return this.publish({});
  }
}
