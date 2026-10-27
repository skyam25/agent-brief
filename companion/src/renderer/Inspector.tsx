import { useEffect, useState, type KeyboardEvent } from 'react';
import { editCount } from '../shared/review';
import type { InsertKind, InspectorProp, SelectedElement, StyleSet } from '../shared/review-edit';
import { TrashIcon } from './Icons';

const GROUPS: { title: string; props: InspectorProp[] }[] = [
  { title: 'Layout', props: ['display', 'flex-direction', 'gap', 'align-items', 'justify-content'] },
  { title: 'Size', props: ['width', 'height'] },
  { title: 'Spacing', props: ['padding', 'margin'] },
  { title: 'Type', props: ['font-size', 'font-weight', 'color'] },
  { title: 'Fill', props: ['background', 'border-radius'] },
];

const CHOICES: Partial<Record<InspectorProp, string[]>> = {
  display: ['block', 'flex', 'inline-flex', 'grid', 'inline-block', 'none'],
  'flex-direction': ['row', 'column'],
  'align-items': ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'],
  'justify-content': ['flex-start', 'center', 'flex-end', 'space-between', 'space-around'],
};

const SHORT: Partial<Record<InspectorProp, string>> = { 'flex-direction': 'direction', 'align-items': 'align', 'justify-content': 'justify' };

/** Flex and grid fields show only on an element laid out that way. */
const LAYOUT_ONLY = new Set<InspectorProp>(['flex-direction', 'gap', 'align-items', 'justify-content']);
const shows = (prop: InspectorProp, el: SelectedElement) => {
  if (!LAYOUT_ONLY.has(prop)) return true;
  const display = el.inline.display || el.computed.display || '';
  if (prop === 'flex-direction') return display.includes('flex');
  return display.includes('flex') || display.includes('grid');
};

const INSERT_LABELS: [InsertKind, string][] = [
  ['text', 'Text'],
  ['row', 'Row'],
  ['column', 'Column'],
  ['button', 'Button'],
];

/**
 * Edit mode's side panel: the selected element's words and inline styles. A change
 * saves when the field loses focus or on Enter. Placeholders show what the page computed.
 */
export function Inspector(props: {
  selected: SelectedElement | null;
  edits: number;
  onStyle: (set: StyleSet) => void;
  onText: (text: string) => void;
  onAct: (act: 'parent' | 'duplicate' | 'remove') => void;
  onInsert: (what: InsertKind) => void;
}) {
  const el = props.selected;
  return (
    <aside className="review-notes inspector" aria-label="Inspector" data-testid="inspector">
      {!el ? (
        <div className="inspector-empty">
          <span className="section-head">Edit</span>
          <p className="muted">Click an element to select it.</p>
          <ul className="muted inspector-help">
            <li>Drag it to move it, into another container too</li>
            <li>Double-click or press Enter to retype its words</li>
            <li>
              While retyping, <kbd>⌘B</kbd> bolds, <kbd>⌘I</kbd> italicizes, <kbd>⇧↵</kbd> breaks the line
            </li>
            <li>Drag the corner handle to resize it</li>
            <li>
              <kbd>⌘D</kbd> duplicates, <kbd>⌫</kbd> deletes, <kbd>⌘Z</kbd> undoes
            </li>
          </ul>
        </div>
      ) : (
        <div className="inspector-body" key={el.at}>
          <div className="inspector-head">
            <span className="inspector-label" title={el.label} data-testid="inspector-label">
              {el.label}
            </span>
            {el.hasParent && (
              <button className="ghost small" title="Select the element around this one" onClick={() => props.onAct('parent')} data-testid="inspector-parent">
                Parent
              </button>
            )}
            <button className="ghost small" title="Duplicate (⌘D)" onClick={() => props.onAct('duplicate')} data-testid="inspector-duplicate">
              Duplicate
            </button>
            <button className="ghost icon-button small" title="Delete (⌫)" aria-label="Delete the element" onClick={() => props.onAct('remove')} data-testid="inspector-remove">
              <TrashIcon />
            </button>
          </div>
          {el.text !== undefined && <TextField value={el.text} onCommit={props.onText} />}
          {GROUPS.map((g) => (
            <fieldset className="inspector-group" key={g.title}>
              <legend className="section-head">{g.title}</legend>
              {g.props.filter((prop) => shows(prop, el)).map((prop) => (
                <StyleField key={`${prop}:${el.inline[prop] ?? ''}`} prop={prop} value={el.inline[prop] ?? ''} computed={el.computed[prop] ?? ''} onCommit={(v) => props.onStyle({ [prop]: v || null })} />
              ))}
            </fieldset>
          ))}
          {el.canInsert && (
            <div className="inspector-insert">
              <span className="section-head">{el.isContainer ? 'Add inside' : 'Add after'}</span>
              <div className="inspector-buttons">
                {INSERT_LABELS.map(([what, label]) => (
                  <button key={what} className="ghost small" onClick={() => props.onInsert(what)} data-testid={`insert-${what}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      <footer className="muted review-foot" data-testid="review-edits-count">
        {props.edits ? `${editCount(props.edits)} saved to the file · ⌘Z undoes` : 'Edits save to the file as you make them.'}
      </footer>
    </aside>
  );
}

function TextField(props: { value: string; onCommit: (text: string) => void }) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  const commit = () => text !== props.value && props.onCommit(text);
  return (
    <label className="inspector-text">
      <span className="section-head">Text</span>
      <textarea
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') setText(props.value);
        }}
        data-testid="inspector-text"
      />
    </label>
  );
}

function StyleField(props: { prop: InspectorProp; value: string; computed: string; onCommit: (value: string) => void }) {
  const [value, setValue] = useState(props.value);
  const commit = (v = value) => v.trim() !== props.value && props.onCommit(v.trim());
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') setValue(props.value);
  };
  const choices = CHOICES[props.prop];
  const name = SHORT[props.prop] ?? props.prop;
  return (
    <label className="inspector-field">
      <span className="muted">{name}</span>
      {choices ? (
        <select
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            commit(e.target.value);
          }}
          data-testid={`field-${props.prop}`}
        >
          <option value="">{props.computed ? `${props.computed} (page)` : 'unset'}</option>
          {choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      ) : (
        <input value={value} placeholder={props.computed} onChange={(e) => setValue(e.target.value)} onBlur={() => commit()} onKeyDown={keys} spellCheck={false} data-testid={`field-${props.prop}`} />
      )}
    </label>
  );
}
