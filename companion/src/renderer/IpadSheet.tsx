import type { IpadStatus } from '../shared/ipc';

const FIREWALL_NOTE =
  'macOS will ask whether Agent Brief may accept incoming network connections. Choose Allow, or the iPad cannot reach the Mac.';

/** The pairing sheet: QR code, link, paired devices and Stop. */
export function IpadSheet(props: {
  status: IpadStatus;
  onNewCode: () => void;
  onStop: () => void;
  onRevoke: (id: string) => void;
  onClose: () => void;
}) {
  const { status } = props;
  return (
    <div className="sheet-backdrop" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <section className="sheet" role="dialog" aria-label="Open on iPad" data-testid="ipad-sheet">
        <header>
          <h2>Open on iPad</h2>
          <button className="ghost" onClick={props.onClose} aria-label="Close" data-testid="ipad-close">
            ×
          </button>
        </header>
        {status.error && (
          <p className="error" role="alert" data-testid="ipad-error">
            {status.error}
          </p>
        )}
        {status.running && status.url && (
          <>
            <p>Scan this with the iPad camera. The code works once, for 10 minutes. Both devices must be on the same network.</p>
            {/* The QR SVG comes from the qrcode library in main, not from a page. */}
            <div className="qr" data-testid="ipad-qr" dangerouslySetInnerHTML={{ __html: status.qrSvg ?? '' }} />
            <code className="url" data-testid="ipad-url">
              {status.url}
            </code>
            {status.firstRun && (
              <p className="muted" data-testid="ipad-firewall">
                {FIREWALL_NOTE}
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
