import { useEffect, useState } from 'react';
import type { BehaviorDecision, BehaviorDocument, BehaviorRule } from '../protocol';

export function BehaviorPanel(props: {
  doc?: BehaviorDocument;
  error?: string;
  onRefresh: () => void;
  onDecide: (decision: BehaviorDecision) => Promise<boolean>;
  onShow: (selector: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [editing, setEditing] = useState<string>();
  const [editVersion, setEditVersion] = useState<string>();
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { props.onBusy(!!editing || saving); return () => props.onBusy(false); }, [editing, saving, props.onBusy]);
  const decide = async (rule: BehaviorRule, status: BehaviorRule['status']) => {
    if (!props.doc || saving) return;
    setSaving(true);
    try {
      const ok = await props.onDecide({ version: editing === rule.id ? editVersion! : props.doc.version, id: rule.id, text: editing === rule.id ? text : rule.text, status, note: editing === rule.id ? note : rule.note });
      if (ok) setEditing(undefined);
    } finally { setSaving(false); }
  };
  const rules = props.doc?.rules ?? [];
  const open = rules.filter((r) => r.status === 'proposed').length;
  return <section className="behavior-panel" aria-label="Behavior" data-testid="behavior-panel">
    <div className="behavior-heading"><h3>Behavior{rules.length > 0 ? ` · ${open} open` : ''}</h3><button className="ghost" onClick={props.onRefresh}>Refresh</button></div>
    <p className="muted">Confirm what the product should do. Decisions save here; Send hands them to the agent.</p>
    {props.error && <p role="alert" className="behavior-error">{props.error}</p>}
    {!props.doc && !props.error && <p>Loading behavior…</p>}
    {props.doc && !rules.length && <p data-testid="behavior-empty">No behavior rules yet. Ask the agent to add them to this prototype, marking assumptions and simulated actions.</p>}
    {[...rules].sort((a, b) => Number(a.status === 'confirmed') - Number(b.status === 'confirmed')).map((rule) => <article className="behavior-rule" key={rule.id} data-testid={`behavior-rule-${rule.id}`}>
      <div className="behavior-heading"><span className={rule.status === 'proposed' ? 'behavior-status proposed' : 'behavior-status'}>{rule.status === 'proposed' ? 'Proposed' : 'Confirmed'}</span><span className="muted">{rule.delivery === 'planned' ? 'Not implemented' : rule.delivery === 'verified' ? 'Verified' : 'Implemented'}</span></div>
      {editing === rule.id ? <>
        {editVersion !== props.doc?.version && <div role="alert"><p>The specification changed while you were editing. Current behavior: {rule.text}</p><button className="ghost" onClick={() => setEditVersion(props.doc?.version)}>Use current revision for my edit</button></div>}
        <label>Behavior<textarea aria-label="Behavior" value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} autoFocus /></label>
        <label>Question or note<textarea aria-label="Question or note" value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} /></label>
      </> : <><p>{rule.text}</p>{rule.note && <p className="behavior-note">{rule.note}</p>}</>}
      <p className="muted behavior-source">{rule.source.kind === 'assumption' ? 'Agent assumption' : `Source · ${rule.source.kind}`}: {rule.source.ref}</p>
      {rule.target && <div><button className="ghost link" disabled={!!editing || saving} onClick={() => props.onShow(rule.target!.selector)}>Show element</button>{rule.target.state && <p className="muted">State: {rule.target.state}</p>}</div>}
      {rule.evidence && <p className="muted">Evidence: {rule.evidence}</p>}
      <div className="behavior-actions">
        {(rule.status === 'proposed' || editing === rule.id) && <button className="chip" disabled={saving || (!!editing && editing !== rule.id) || (editing === rule.id && (!text.trim() || editVersion !== props.doc?.version))} onClick={() => void decide(rule, 'confirmed')}>{editing === rule.id ? 'Save and confirm' : 'Confirm'}</button>}
        {editing === rule.id ? <>
          <button className="ghost" disabled={saving || !text.trim() || editVersion !== props.doc?.version} onClick={() => void decide(rule, 'proposed')}>Leave open</button>
          <button className="ghost" disabled={saving} onClick={() => setEditing(undefined)}>Cancel</button>
        </> : <button className="ghost" disabled={!!editing || saving} onClick={() => { setEditing(rule.id); setEditVersion(props.doc?.version); setText(rule.text); setNote(rule.note ?? ''); }}>Edit</button>}
      </div>
    </article>)}
    {!!props.doc?.limitations.length && <section><h3>Simulated or out of scope</h3><ul>{props.doc.limitations.map((s, i) => <li key={i}>{s}</li>)}</ul></section>}
    {!!props.doc?.history.length && <details><summary>Decision history</summary>{[...props.doc.history].reverse().slice(0, 10).map((h) => <div className="behavior-history" key={h.revision}><strong>Revision {h.revision} · {h.by}</strong><span className="muted"> · {new Date(h.at).toLocaleString()}</span>{h.after.map((r) => <p key={r.id}>{r.id} · {r.status}: {r.text}</p>)}{JSON.stringify(h.limitationsBefore) !== JSON.stringify(h.limitationsAfter) && <p>Limitations: {h.limitationsAfter.join('; ') || 'None'}</p>}</div>)}</details>}
  </section>;
}
