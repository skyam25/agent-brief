import type { ErrorBody } from '../protocol';

/** An error the socket server turns into a status code by its `code`. */
export class BoardError extends Error {
  constructor(
    readonly code: ErrorBody['code'],
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new BoardError('bad_request', message);
export const notFound = (message: string) => new BoardError('not_found', message);
