import type { KeyboardEvent } from 'react';
import type { NoteAnnotations, NoteComment } from '../shared/annotations';
import { TrashIcon } from './Icons';
import { OVERALL, type ReviewVoice } from './review-voice';
import { VoiceState } from './VoiceState';

/** A note's comments beside its text: words about the whole note, then one card per highlighted passage. */
export function NoteComments(props: {
  annotations: NoteAnnotations | undefined;
  activeId: string | undefined;
  /** Comments whose passage is no longer in the note. */
  missing: string[];
  voice: ReviewVoice;
  talking: boolean;
  onSelect: (id: string | undefined) => void;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onOverall: (text: string) => void;
  onKeyDown: (e: KeyboardEvent) => void;
}) {
  const comments = props.annotations?.comments ?? [];
  const count = comments.length;
  return (
    <aside className="review-notes note-comments" aria-label="Comments on this note" data-testid="note-comments">
      <label className={props.activeId === undefined && props.talking ? 'review-overall listening' : 'review-overall'}>
        <span className="section-head">Overall</span>
        <textarea
          placeholder={props.activeId === undefined && props.talking ? 'Listening…' : 'Anything about the note as a whole'}
          value={props.annotations?.overall ?? ''}
          onChange={(e) => props.onOverall(e.target.value)}
          onFocus={() => props.onSelect(undefined)}
          onKeyDown={props.onKeyDown}
          data-testid="note-overall"
        />
        <VoiceState voice={props.voice} target={OVERALL} />
      </label>
      <h3 className="section-head">
        Comments{count > 0 && <span className="count">{count}</span>}
      </h3>
      {count === 0 ? (
        <p className="muted review-empty" data-testid="note-comments-empty">
          {props.talking
            ? 'Select a passage to comment on it. What you say goes to the selected comment, or to Overall.'
            : 'Select a passage, then press Comment. Or turn on Talk and annotate and select as you talk.'}
        </p>
      ) : (
        <ol className="review-cards">
          {comments.map((c, i) => (
            <NoteCommentCard
              key={c.id}
              comment={c}
              n={i + 1}
              active={c.id === props.activeId}
              missing={props.missing.includes(c.id)}
              voice={props.voice}
              onSelect={() => props.onSelect(c.id)}
              onEdit={(text) => props.onEdit(c.id, text)}
              onRemove={() => props.onRemove(c.id)}
              onKeyDown={props.onKeyDown}
            />
          ))}
        </ol>
      )}
      <footer className="muted review-foot">
        {count > 0 ? `${count} comment${count === 1 ? '' : 's'} · Send hands Claude each passage with its comment` : 'Send hands Claude the note with your comments.'}
      </footer>
    </aside>
  );
}

function NoteCommentCard(props: {
  comment: NoteComment;
  n: number;
  active: boolean;
  missing: boolean;
  voice: ReviewVoice;
  onSelect: () => void;
  onEdit: (text: string) => void;
  onRemove: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
}) {
  const { comment: c } = props;
  const listening = props.voice.recording && props.voice.target === c.id;
  return (
    <li
      className={`review-card${props.active ? ' active' : ''}${listening ? ' listening' : ''}`}
      data-comment={c.id}
      data-testid="note-comment"
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('button, textarea')) props.onSelect();
      }}
    >
      <div className="review-card-head">
        <button className="ghost pin-badge" title="Show the passage" onClick={props.onSelect} data-testid="note-comment-pin">
          {props.n}
        </button>
        <span className="review-anchor">{c.heading ?? 'Passage'}</span>
        {props.missing && (
          <span className="review-missing" title="The note no longer has this passage" data-testid="note-comment-missing">
            Text changed
          </span>
        )}
        <button className="ghost icon-button small" aria-label={`Delete comment ${props.n}`} title="Delete" onClick={props.onRemove} data-testid="note-comment-delete">
          <TrashIcon />
        </button>
      </div>
      <blockquote className="review-quote" data-testid="note-comment-quote">
        {c.quote}
      </blockquote>
      <textarea
        placeholder={listening ? 'Listening…' : 'What should change here?'}
        value={c.text}
        rows={2}
        onChange={(e) => props.onEdit(e.target.value)}
        onFocus={props.onSelect}
        onKeyDown={props.onKeyDown}
        data-testid="note-comment-text"
      />
      <VoiceState voice={props.voice} target={c.id} />
    </li>
  );
}
