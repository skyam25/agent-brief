import { useEffect, useRef, useState } from 'react';
import type { Template } from '../shared/ipc';
import { TrashIcon } from './Icons';
import { SlotArea } from './SlotArea';
import type { TemplateShelf } from './templates';

/** Delete asks once more, then reverts after a few seconds. */
function DeleteButton(props: { what: string; onDelete: () => void; testId: string }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const timer = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(timer);
  }, [confirm]);
  return (
    <button
      className={confirm ? 'ghost danger' : 'ghost icon-button'}
      title={`Delete this ${props.what}`}
      aria-label={confirm ? 'Confirm delete' : 'Delete'}
      onClick={() => (confirm ? props.onDelete() : setConfirm(true))}
      data-testid={props.testId}
    >
      {confirm ? 'Delete?' : <TrashIcon />}
    </button>
  );
}

/** A template: its name and text. Use template starts a note from it. */
export function TemplateEditor(props: { shelf: TemplateShelf; template: Template; onUse: () => void; onDeleted: () => void }) {
  const { shelf, template } = props;
  const title = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (template.title === 'New template') title.current?.select();
  }, []);
  return (
    <section className="editor template-editor" data-testid="template-editor">
      <input
        ref={title}
        className="template-title"
        aria-label="Template name"
        placeholder="Template name"
        value={template.title}
        onChange={(e) => shelf.edit(template.id, { title: e.target.value })}
        data-testid="template-title"
      />
      <SlotArea
        value={template.body}
        onChange={(body) => shelf.edit(template.id, { body })}
        label="Template"
        testId="template-body"
        placeholder={'Write the prompt. Mark each blank with {{a name}}.\n\nWhen you use the template, Tab jumps from blank to blank.'}
      />
      <footer>
        <span className="muted">
          Blanks look like <code>{'{{goal}}'}</code>
        </span>
        <span className="spacer" />
        {shelf.saveError && (
          <span className="error" title={shelf.saveError} data-testid="template-save-error">
            Not saved: {shelf.saveError}
          </span>
        )}
        <DeleteButton
          what="template"
          testId="template-delete"
          onDelete={() => {
            shelf.remove(template.id);
            props.onDeleted();
          }}
        />
        <button className="primary" onClick={props.onUse} data-testid="template-use">
          Use template
        </button>
      </footer>
    </section>
  );
}
