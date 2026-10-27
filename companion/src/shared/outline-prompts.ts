/**
 * The prompts the outline panel sends. Each names `(outline-first)`, which the outline-first skill keys on.
 */

import type { DirectionScope, OutlineDocument } from '../protocol';

const targetOf = (doc: Pick<OutlineDocument, 'target' | 'kind'>) => doc.target ?? `the ${doc.kind}`;

export function generatePrompt(doc: Pick<OutlineDocument, 'path' | 'target' | 'kind'>): string {
  if (doc.target) return `Generate ${doc.target} from ${doc.path} (outline-first). Read each source and mark its cites, write it fresh from the outline, then check it against the outline.`;
  return `Generate the ${doc.kind} from ${doc.path} (outline-first). Read each source and mark its cites, pick a target path beside the outline, set it with setMeta, write it, then check it against the outline.`;
}

/** A question or request about the outline, scoped to one section when `sectionId` names one. */
export function askPrompt(doc: Pick<OutlineDocument, 'path' | 'target' | 'sections'>, sectionId: string | undefined, text: string): string {
  const section = sectionId ? doc.sections.find((s) => s.id === sectionId) : undefined;
  const where = section ? `, section "${section.title}" (${section.id})` : '';
  return `On ${doc.path} (outline-first)${where}: ${text.trim()}\nUpdate the outline only, through agent-brief outline apply. Do not write ${doc.target ?? 'the target'}.`;
}

export function acceptDirectionPrompt(doc: Pick<OutlineDocument, 'path' | 'target' | 'kind'>, scope: DirectionScope): string {
  return `Direction accepted for ${doc.path} (outline-first). Revise ${targetOf(doc)} at scope ${scope} from the updated outline, check it against the outline, then clear the direction.`;
}

/** The ask line for a Send of comments on a target that has an outline. */
export function outlineFeedbackAsk(source: string, outlinePath: string, what: string): string {
  return `Comments on ${source} from Agent Brief, ${what}. ${source} has an outline at ${outlinePath} (outline-first). Do not change ${source} yet. Read the comments together, update the outline, and propose a direction with setDirection. The user accepts it in Agent Brief.`;
}

/**
 * The ask line for a Send that carries pane edits on a target with an outline. The edits stay in
 * the target, and their wording goes back into the outline so the next Generate keeps it.
 * `what` counts comments sent with them, if any.
 */
export function outlineEditsAsk(source: string, outlinePath: string, edits: string, what?: string): string {
  const fold = 'Write their wording back into the matching outline points with agent-brief outline apply, so the next Generate keeps it, and flag any edit that changes a claim, number or cite.';
  if (what) return `${outlineFeedbackAsk(source, outlinePath, what)} The review also lists ${edits} already saved in ${source}. ${fold}`;
  return `Edits to ${source} from Agent Brief, ${edits} made in the pane and already saved in the file. ${source} has an outline at ${outlinePath} (outline-first). Keep the edits in ${source}. ${fold}`;
}
