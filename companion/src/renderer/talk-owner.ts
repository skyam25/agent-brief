/** Who ⌥T talks to. A view with its own mic claims the key while it shows; the newest claim wins. */

const owners: (() => void)[] = [];

/** Sends ⌥T to `talk` until the returned release runs. */
export function claimTalk(talk: () => void): () => void {
  owners.push(talk);
  return () => {
    const at = owners.lastIndexOf(talk);
    if (at >= 0) owners.splice(at, 1);
  };
}

/** The newest claim, if any view holds the key. */
export const talkOwner = (): (() => void) | undefined => owners.at(-1);
