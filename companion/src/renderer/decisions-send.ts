/** While a Feedback view shows, the footer Send sends its decisions. The newest claim wins. */

export interface DecisionsClaim {
  /** Items with decisions since the last send. */
  count: number;
  /** False when the session has ended. */
  canSend: boolean;
  send: () => void;
}

const claims: DecisionsClaim[] = [];
const listeners = new Set<() => void>();
const changed = () => {
  for (const fn of listeners) fn();
};

/** Gives the footer Send to `claim` until the returned release runs. */
export function claimDecisions(claim: DecisionsClaim): () => void {
  claims.push(claim);
  changed();
  return () => {
    const at = claims.lastIndexOf(claim);
    if (at < 0) return;
    claims.splice(at, 1);
    changed();
  };
}

export const decisionsClaim = (): DecisionsClaim | undefined => claims.at(-1);

export function subscribeDecisions(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
