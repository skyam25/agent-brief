/**
 * The Initiative view: the standing briefs above sessions. The list holds every initiative;
 * the pane shows the one picked, with Understanding editable in place, its decisions and open
 * questions, the folder map and the revision history.
 */

import { useEffect, useState } from 'react';
import { INITIATIVE_ROLES, type InitiativeFolder, type InitiativeRole } from '../protocol';
import { sectionBreak } from '../shared/brief-sections';
import type { InitiativeDetail, SessionBriefEntry } from '../shared/ipc';
import { shortPath } from '../shared/sessions';
import { SectionHeader } from './DraftList';
import { useStore } from './hooks';
import { CloseIcon, PlusIcon } from './Icons';
import { wordCount, type InitiativesStore } from './initiatives';

const ROLE_LABEL: Record<InitiativeRole, string> = {
  working: 'Working',
  sources: 'Sources',
  decisions: 'Decisions',
  grounding: 'Grounding',
  outputs: 'Outputs',
};

interface Props {
  store: InitiativesStore;
  /** Session tabs, for naming the attached sessions. */
  briefs: SessionBriefEntry[];
  home: string;
  /** Hands a session the discover prompt, the way Send does. */
  onDiscover: () => void;
  chooseFolder: () => Promise<string | undefined>;
  onReveal: (path: string) => void;
  onError: (message: string) => void;
}

/** `~/…` for a folder under home, as the brief writes it. */
const homePath = (path: string, home: string) => (path === home ? '~' : path.startsWith(home + '/') ? `~${path.slice(home.length)}` : path);

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function InitiativeView(props: Props) {
  const store = useStore(props.store);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void props.store.load().catch((err) => props.onError(`Could not read initiatives: ${(err as Error).message}`));
  }, [props.store]);

  const empty = store.loaded && store.list.length === 0;
  const pane = creating ? (
    <NewInitiative
      home={props.home}
      chooseFolder={props.chooseFolder}
      onCancel={() => setCreating(false)}
      onCreate={async (title, folder) => {
        try {
          await props.store.create(title, folder);
          setCreating(false);
        } catch (err) {
          props.onError(`Could not create the initiative: ${errorText(err)}`);
        }
      }}
    />
  ) : empty ? (
    <div className="initiative-empty" data-testid="initiative-empty">
      <h2>No initiatives yet</h2>
      <p className="muted">
        An initiative is a short standing brief that every session on that work starts from. Discover asks a session to survey its folder and list
        likely initiatives. New initiative starts an empty brief in a folder you pick.
      </p>
      <div className="initiative-actions">
        <button className="ghost" onClick={props.onDiscover} data-testid="initiative-discover">
          Discover
        </button>
        <button className="primary" onClick={() => setCreating(true)} data-testid="initiative-new">
          New initiative
        </button>
      </div>
    </div>
  ) : store.detail ? (
    <InitiativePane key={store.detail.initiative.id} {...props} detail={store.detail} />
  ) : null;

  return (
    <div className="write initiative-mode" data-testid="initiative-mode">
      <nav className="draft-list" aria-label="Initiatives">
        <div className="list-head">
          <button className="ghost" onClick={() => setCreating(true)} title="New initiative" data-testid="initiative-new-list">
            <PlusIcon /> New
          </button>
          <button className="ghost" onClick={props.onDiscover} title="Ask a session to find likely initiatives in its folder">
            Discover
          </button>
        </div>
        <div className="sections">
          <section>
            <SectionHeader title="Initiatives" count={store.list.length} />
            {empty && <p className="muted empty">None yet.</p>}
            <ul>
              {store.list.map((i) => (
                <li key={i.id}>
                  <button
                    className="ghost draft-row"
                    aria-current={!creating && i.id === store.selectedId}
                    onClick={() => {
                      setCreating(false);
                      void props.store.select(i.id).catch((err) => props.onError(errorText(err)));
                    }}
                    data-testid="initiative-row"
                  >
                    <span className="lines">
                      <span className="title-line">
                        <span className="title">{i.title}</span>
                      </span>
                      <span className="muted preview">{i.line || 'No Understanding yet'}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </nav>
      <div className="initiative-pane">{pane}</div>
    </div>
  );
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
}

function NewInitiative(props: {
  home: string;
  chooseFolder: () => Promise<string | undefined>;
  onCancel: () => void;
  onCreate: (title: string, folder: string) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [folder, setFolder] = useState<string>();
  const ready = title.trim() !== '' && !!folder;
  return (
    <form
      className="initiative-new"
      data-testid="initiative-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void props.onCreate(title.trim(), folder!);
      }}
    >
      <h2>New initiative</h2>
      <label>
        <span className="muted">Title</span>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Pricing" data-testid="initiative-title" />
      </label>
      <label>
        <span className="muted">Folder</span>
        <span className="initiative-actions">
          <button type="button" className="ghost" onClick={() => void props.chooseFolder().then((f) => f && setFolder(f))} data-testid="initiative-folder">
            {folder ? 'Change…' : 'Choose…'}
          </button>
          {folder && (
            <span className="path" title={folder}>
              {shortPath(folder, props.home)}
            </span>
          )}
        </span>
      </label>
      <p className="muted">
        The brief goes in that folder as “{title.trim() || 'Title'} brief.md”. It is plain Markdown you can edit anywhere, and the app keeps nothing else in the
        folder.
      </p>
      <div className="initiative-actions">
        <button type="button" className="ghost" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!ready} data-testid="initiative-create">
          Create
        </button>
      </div>
    </form>
  );
}

function InitiativePane(props: Props & { detail: InitiativeDetail }) {
  const { initiative: i, history } = props.detail;
  const [understanding, setUnderstanding] = useState(i.understanding);
  const [saving, setSaving] = useState(false);
  // A push that changed Understanding replaces the text unless the PM is mid-edit.
  const [base, setBase] = useState(i.understanding);
  const dirty = understanding !== base;
  // Text that would split the brief into another section cannot be saved.
  const broken = dirty ? sectionBreak(understanding) : undefined;
  useEffect(() => {
    if (!dirty || understanding.trim() === i.understanding) setUnderstanding(i.understanding);
    setBase(i.understanding);
  }, [i.understanding]);

  const save = async (patch: Parameters<InitiativesStore['save']>[0]) => {
    setSaving(true);
    try {
      const result = await props.store.save(patch);
      if (!result.ok) props.onError(`Not saved: ${result.message}`);
      return result.ok;
    } catch (err) {
      props.onError(`Could not save: ${errorText(err)}`);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const sessions = (i.sessions ?? []).map((id) => props.briefs.find((b) => b.sessionId === id)?.title ?? id.slice(0, 8));

  return (
    <article className="initiative" data-testid="initiative-pane">
      <header className="initiative-head">
        <h2 data-testid="initiative-heading">{i.title}</h2>
        <p className="muted" data-testid="initiative-sessions">
          {sessions.length ? `Attached to ${sessions.join(', ')}` : 'No session attached'} · revision {i.revision} by {i.updatedBy}
        </p>
        {i.missing && <p className="error">The brief file is gone from {shortPath(i.path, props.home)}.</p>}
      </header>

      <section>
        <h3 className="section-head">
          Understanding
          <span className="count" data-testid="initiative-words">
            {wordCount(understanding)} words
          </span>
        </h3>
        <textarea
          className="initiative-understanding"
          value={understanding}
          placeholder="Where the work stands. Claude keeps this current; edit it whenever it drifts."
          onChange={(e) => setUnderstanding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.metaKey && dirty && !broken) {
              e.preventDefault();
              void save({ understanding });
            }
          }}
          data-testid="initiative-understanding"
        />
        {broken && (
          <p className="error" data-testid="initiative-understanding-error">
            {broken}
          </p>
        )}
        {dirty && (
          <div className="initiative-actions">
            <button className="ghost" onClick={() => setUnderstanding(base)}>
              Revert
            </button>
            <button className="primary" disabled={saving || !!broken} onClick={() => void save({ understanding })} data-testid="initiative-save">
              Save
            </button>
          </div>
        )}
      </section>

      <Lines title="Decisions" lines={i.decisions} empty="No decisions yet." />
      <Lines title="Open" lines={i.open} empty="Nothing open." />

      <FolderMap
        folders={i.folders}
        home={props.home}
        chooseFolder={props.chooseFolder}
        onReveal={props.onReveal}
        onSave={(folders) => save({ folders })}
      />

      <section>
        <h3 className="section-head">History</h3>
        <ul className="initiative-history" data-testid="initiative-history">
          {history.slice(0, 20).map((r) => (
            <li key={r.revision}>
              <span className="muted">r{r.revision}</span> {r.updatedBy} <span className="muted">· {when(r.updatedAt)}</span>
              {r.changed?.length ? <span className="muted"> · {r.changed.join(', ')}</span> : r.updatedBy === 'PM' ? <span className="muted"> · edited the file</span> : null}
            </li>
          ))}
        </ul>
      </section>

      <footer className="initiative-foot muted">
        <span className="path" title={i.path}>
          {shortPath(i.path, props.home)}
        </span>
        <button className="ghost small" onClick={() => props.onReveal(i.path)}>
          Reveal in Finder
        </button>
      </footer>
    </article>
  );
}

function Lines(props: { title: string; lines: string[]; empty: string }) {
  return (
    <section>
      <SectionHeader title={props.title} count={props.lines.length} />
      {props.lines.length === 0 ? (
        <p className="muted">{props.empty}</p>
      ) : (
        <ul className="initiative-lines">
          {props.lines.map((line, n) => (
            <li key={n}>{line}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FolderMap(props: {
  folders: InitiativeFolder[];
  home: string;
  chooseFolder: () => Promise<string | undefined>;
  onReveal: (path: string) => void;
  onSave: (folders: InitiativeFolder[]) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<InitiativeFolder[]>();
  const set = (n: number, patch: Partial<InitiativeFolder>) => setEditing((rows) => rows!.map((r, k) => (k === n ? { ...r, ...patch } : r)));

  if (editing) {
    return (
      <section data-testid="initiative-map">
        <h3 className="section-head">Folders</h3>
        <ul className="initiative-map editing">
          {editing.map((f, n) => (
            <li key={n}>
              <input value={f.path} onChange={(e) => set(n, { path: e.target.value })} aria-label="Folder" />
              <select value={f.role} onChange={(e) => set(n, { role: e.target.value as InitiativeRole })} aria-label="Role">
                {INITIATIVE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
              <button className="ghost icon-button small" title="Remove" aria-label="Remove" onClick={() => setEditing(editing.filter((_, k) => k !== n))}>
                <CloseIcon />
              </button>
            </li>
          ))}
        </ul>
        <div className="initiative-actions">
          <button
            className="ghost"
            onClick={() => void props.chooseFolder().then((p) => p && setEditing([...editing, { path: homePath(p, props.home), role: 'working' }]))}
          >
            <PlusIcon /> Add folder
          </button>
          <span className="spacer" />
          <button className="ghost" onClick={() => setEditing(undefined)}>
            Cancel
          </button>
          <button
            className="primary"
            onClick={() => {
              const rows = editing.map((f) => ({ ...f, path: f.path.trim() })).filter((f) => f.path);
              void props.onSave(rows).then((ok) => ok && setEditing(undefined));
            }}
          >
            Save map
          </button>
        </div>
      </section>
    );
  }

  return (
    <section data-testid="initiative-map">
      <h3 className="section-head">
        Folders
        <button className="ghost small" onClick={() => setEditing(props.folders.map((f) => ({ ...f })))} data-testid="initiative-edit-map">
          Edit map
        </button>
      </h3>
      {props.folders.length === 0 ? (
        <p className="muted">No folders mapped.</p>
      ) : (
        <ul className="initiative-map">
          {props.folders.map((f, n) => (
            <li key={n} data-testid="initiative-folder-row">
              <span className="role">{ROLE_LABEL[f.role]}</span>
              <span className="path" title={f.path}>
                {f.path}
              </span>
              {f.note && <span className="muted note">{f.note}</span>}
              <button className="ghost small" onClick={() => props.onReveal(f.path)} data-testid="initiative-reveal">
                Reveal in Finder
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
