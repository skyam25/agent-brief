/**
 * An item's before and after pictures. Both pictures of a round show as one slider.
 * One picture shows alone with its label. A selector picks the round when several have pictures.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import type { FeedbackItem } from '../protocol';
import { defaultPictureRound, picturesByRound } from '../shared/feedback-pictures';
import type { CompanionApi } from '../shared/ipc';

export type PictureHost = Pick<CompanionApi, 'readFeedbackPicture'>;

/** A picture as a data URL, undefined while it loads, or null when the file is gone. */
function usePicture(host: PictureHost, sessionId: string | undefined, output: string, picture: string | undefined) {
  const [url, setUrl] = useState<{ picture: string; url?: string }>();
  useEffect(() => {
    if (!sessionId || !picture) return;
    let gone = false;
    host
      .readFeedbackPicture(sessionId, output, picture)
      .catch(() => undefined)
      .then((next) => !gone && setUrl({ picture, url: next }));
    return () => {
      gone = true;
    };
  }, [host, sessionId, output, picture]);
  if (!picture || url?.picture !== picture) return undefined;
  return url.url ?? null;
}

export function BeforeAfter(props: { host: PictureHost; sessionId?: string; output: string; item: FeedbackItem }) {
  const rounds = picturesByRound(props.item);
  const [picked, setPicked] = useState<number>();
  const [split, setSplit] = useState(50);
  const round = rounds.find((r) => r.round === picked) ?? rounds.find((r) => r.round === defaultPictureRound(rounds));
  const before = usePicture(props.host, props.sessionId, props.output, round?.before);
  const after = usePicture(props.host, props.sessionId, props.output, round?.after);
  if (!round) return null;
  const n = round.round;
  const both = round.before && round.after;
  const one = round.before ? { url: before, label: 'Before' } : { url: after, label: 'After' };

  return (
    <div className="feedback-pictures" data-testid="feedback-pictures">
      <div className="feedback-pictures-head">
        <span className="muted">{both ? `Before and after · round ${n}` : `${one.label} · round ${n}`}</span>
        {rounds.length > 1 && (
          <select aria-label="Round of pictures" value={n} onChange={(e) => setPicked(Number(e.target.value))} data-testid="feedback-picture-round">
            {rounds.map((r) => (
              <option key={r.round} value={r.round}>
                Round {r.round}
              </option>
            ))}
          </select>
        )}
      </div>
      {both ? (
        <div className="before-after" style={{ '--split': `${split}%` } as CSSProperties} data-testid="feedback-slider">
          {after ? <img src={after} alt={`After, round ${n}`} /> : after === null && <div className="before-after-gone muted">After picture not found</div>}
          {before && <img className="before" src={before} alt={`Before, round ${n}`} />}
          <span className="before-after-tag left">Before</span>
          <span className="before-after-tag right">After</span>
          <input type="range" min={0} max={100} value={split} aria-label={`Before and after, round ${n}`} onChange={(e) => setSplit(Number(e.target.value))} />
        </div>
      ) : (
        <figure className="before-after single" data-testid="feedback-picture">
          {one.url ? <img src={one.url} alt={`${one.label}, round ${n}`} /> : one.url === null && <div className="before-after-gone muted">Picture not found</div>}
          <figcaption className="before-after-tag left">{one.label}</figcaption>
        </figure>
      )}
    </div>
  );
}
