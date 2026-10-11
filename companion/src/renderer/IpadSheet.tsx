import { useState } from 'react';
import type { IpadStatus } from '../shared/ipc';
import { CloseIcon, LinkIcon } from './Icons';

const FIREWALL_NOTE =
  'When macOS asks whether Agent Brief may accept incoming network connections, choose Allow. Otherwise the iPad cannot reach the Mac.';

/** The pairing sheet: QR code, link, paired devices and Stop. */
export function IpadSheet(props: {
  status: IpadStatus;
  onNewCode: () => void;
  onStop: () => void;
  onRevoke: (id: string) => void;
  onClose: () => void;
}) {
  const { status } = props;
  const [copiedUrl, setCopiedUrl] = useState<string>();
  const copy = async () => {
    await navigator.clipboard.writeText(status.url ?? '');
    setCopiedUrl(status.url);
  };
  return (
    <div className="sheet-backdrop" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <section className="sheet" role="dialog" aria-label="Open on iPad" data-testid="ipad-sheet">
        <header>
          <h2>Open on iPad</h2>
          <button className="ghost icon-button" onClick={props.onClose} aria-label="Close" data-testid="ipad-close">
            <CloseIcon />
          </button>
        </header>
        {status.error && (
          <p className="error" role="alert" data-testid="ipad-error">
            {status.error}
          </p>
        )}
        {status.running && status.url && (
          <>
            <div className="pairing">
              <ol className="steps">
                <li data-testid="ipad-network">
                  {status.network
                    ? `Join this Mac's Wi-Fi network (${status.network}) on the iPad, and turn off any VPN.`
                    : "Join this Mac's Wi-Fi on the iPad, and turn off any VPN."}
                </li>
                <li>Scan the code with the iPad camera. It works once, for 10 minutes.</li>
                {status.firstRun && <li data-testid="ipad-firewall">{FIREWALL_NOTE}</li>}
              </ol>
              {/* The QR SVG comes from the qrcode library in main, not from a page. */}
              <div className="qr" data-testid="ipad-qr" dangerouslySetInnerHTML={{ __html: status.qrSvg ?? '' }} />
            </div>
            <div className="link-row">
              <code className="url" title={status.url} data-testid="ipad-url">
                {status.url}
              </code>
              <button onClick={() => void copy()} data-testid="ipad-copy">
                <LinkIcon />
                {copiedUrl === status.url ? 'Copied' : 'Copy link'}
              </button>
            </div>
            {status.refused && (
              <p className="error" role="alert" data-testid="ipad-refused">
                The Mac turned away a device at {status.refused} because it is on another network. Join the iPad to
                this Mac's Wi-Fi and turn off any VPN, then scan again.
              </p>
            )}
          </>
        )}
        <h3>Paired devices</h3>
        {status.devices.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <ul className="devices" data-testid="ipad-devices">
            {status.devices.map((d) => (
              <li key={d.id}>
                <span>{d.name}</span>
                <button onClick={() => props.onRevoke(d.id)} data-testid={`ipad-revoke-${d.id}`}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
        <footer>
          {status.running ? (
            <>
              <button onClick={props.onNewCode} data-testid="ipad-new-code">
                New code
              </button>
              <button onClick={props.onStop} data-testid="ipad-stop">
                Stop
              </button>
            </>
          ) : (
            <button className="primary" onClick={props.onNewCode} data-testid="ipad-start">
              Start
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
