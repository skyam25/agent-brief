/** Item format is generated from the app; this module owns plugin path helpers. */
export { parseItems, awaitsUser, withDecisions, decisionsDraft } from './generated/items'
export type { ItemLine, Item, ItemsDoc, Decision } from './generated/items'

export function itemsRelPath(sessionId: string): string {
  return `.feedback/items/${sessionId}.md`
}

export function itemsFile(cwd: string, sessionId: string): string {
  return `${cwd}/${itemsRelPath(sessionId)}`
}
