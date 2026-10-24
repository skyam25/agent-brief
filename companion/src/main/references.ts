/** The line Copy reference puts on the clipboard, for pasting into a new Claude Code session. */

import { join } from 'node:path';
import type { ItemReference } from '../shared/ipc';
import { shellQuote } from './launch';

/** Names the item and the `agent-brief` commands that pick it up. A note names its file too, since no command prints its text. */
export function referenceText(ref: ItemReference, draftsDir: string): string {
  const name = (s: string) => JSON.stringify(s);
  switch (ref.kind) {
    case 'board':
      return `Open my Agent Brief board ${name(ref.name)} with agent-brief open --board ${shellQuote(ref.name)}, then read it with agent-brief read --board ${shellQuote(ref.name)}.`;
    case 'note': {
      const file = shellQuote(join(draftsDir, `${ref.id}.json`));
      return `Read my Agent Brief note ${name(ref.title)} in ${file}. Show it with agent-brief open --note ${shellQuote(ref.id)}, and save changes with agent-brief note --id ${shellQuote(ref.id)}.`;
    }
    case 'initiative':
      return `Attach my Agent Brief initiative ${name(ref.title)} with agent-brief initiative attach ${shellQuote(ref.id)}, then read it with agent-brief initiative show ${shellQuote(ref.id)}.`;
  }
}
