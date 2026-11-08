/** File › Pair iPad…: the QR code the iPad scans, and the iPads already paired. */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CompanionApi, IpadSheetStatus } from '../shared/ipc';
import { useEscape } from './hooks';
import { cleanError } from './ipc-error';

export type IpadSheetHost = Pick<CompanionApi, 'ipadSheetOpen' | 'ipadNewCode' | 'ipadSheetClose' | 'ipadForget' | 'onIpadStatus'>;

export function IpadSheet(props: { host: IpadSheetHost; onClose: () => void }) {
  const { host, onClose } = props;
  const [status, setStatus] = useState<IpadSheetStatus>();
  const [failure, setFailure] = useState<string>();
  useEscape(onClose);

  useEffect(() => {
    const stop = host.onIpadStatus(setStatus);
    host.ipadSheetOpen().then(setStatus, (err) => setFailure(cleanError(err)));
    return () => {
      if (typeof stop === 'function') stop();
      void host.ipadSheetClose();
    };
  }, [host]);

  const act = (run: () => Promise<IpadSheetStatus>) => () => {
    run().then(setStatus, (err) => setFailure(cleanError(err)));
  };
  const error = failure ?? status?.error;

  return createPortal(
    <div className="popover-panel cleanup ipad-sheet" role="dialog" aria-label="Pair iPad" data-escape-owner data-testid="ipad-sheet">
      <h2>Pair iPad</h2>
      {error && (
        <p className="error" role="alert" data-testid="ipad-error">
          {error}
        </p>
      )}
      {status?.url && (
        <div className="ipad-pairing">
          <ol>
            <li data-testid="ipad-network">
              {status.network ? `Join this Mac's network (${status.network}) on the iPad, and turn off any VPN.` : "Join this Mac's network on the iPad, and turn off any VPN."}
            </li>
            <li>In Agent Brief on the iPad, tap Scan QR Code and point it at this code.</li>
            <li>The code works once, for 10 minutes.</li>
          </ol>
          {/* The SVG comes from the qrcode library in main, not from a page. */}
          <div className="ipad-qr" data-testid="ipad-qr" data-url={status.url} dangerouslySetInnerHTML={{ __html: status.qrSvg ?? '' }} />
        </div>
      )}
      {status?.url && <p className="muted">If macOS asks whether Agent Brief may accept incoming connections, choose Allow.</p>}
      {status?.refused && (
        <p className="error" role="alert" data-testid="ipad-refused">
          The Mac turned away a device at {status.refused} because it is on another network.
        </p>
      )}
      <h3>Paired</h3>
      {status?.devices.length ? (
        <ul data-testid="ipad-devices">
          {status.devices.map((d) => (
            <li key={d.id} className="ipad-device">
              <span>
                {d.name}
                {d.pairedAt ? <small className="muted"> · paired {new Date(d.pairedAt).toLocaleDateString()}</small> : null}
              </span>
              <button className="ghost" onClick={act(() => host.ipadForget(d.id))} data-testid={`ipad-forget-${d.id}`}>
                Forget
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No iPad yet.</p>
      )}
      <div className="actions">
        {status && !status.url && (
          <button className="ghost" onClick={act(() => host.ipadNewCode())} data-testid="ipad-new-code">
            {status.devices.length ? 'Pair another iPad' : 'New code'}
          </button>
        )}
        <button className="primary" onClick={onClose} data-testid="ipad-close">
          Done
        </button>
      </div>
    </div>,
    document.body,
  );
}
