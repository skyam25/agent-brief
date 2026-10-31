/** IPC wraps main's errors in Electron's own words. This keeps main's. */
export const cleanError = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
