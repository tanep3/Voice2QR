/**
 * Library errors. Every failure the library reports is a
 * `Voice2QrError` with a stable `code` (docs/js-api.md §5). The library
 * never decides display wording — callers map codes to their own text.
 */
export type ErrorCode =
  | 'LOAD'
  | 'NOT_QV'
  | 'UNSUPPORTED_VERSION'
  | 'MALFORMED'
  | 'NO_VOICE'
  | 'UNSUPPORTED_BPS'
  | 'TOO_LARGE'
  | 'QR_NOT_FOUND'
  | 'QR_TOO_LARGE'
  | 'INVALID_ARGUMENT'
  // Extension beyond the table in docs/js-api.md §5: the core's CODEC
  // status (an internal libcodec2 failure, e.g. codec creation failed)
  // has no row there. It is passed through under its own code rather
  // than being misreported as one of the format errors.
  | 'CODEC';

export class Voice2QrError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'Voice2QrError';
    this.code = code;
  }
}

/** Map a core status code (docs/core-api.md §4) to a Voice2QrError. */
export function errorFromCoreStatus(status: number): Voice2QrError {
  switch (status) {
    case 1:
      return new Voice2QrError('NOT_QV', 'not a QV payload');
    case 2:
      return new Voice2QrError('UNSUPPORTED_VERSION', 'unsupported QV version');
    case 3:
      return new Voice2QrError('MALFORMED', 'malformed QV payload');
    case 4:
      return new Voice2QrError('NO_VOICE', 'payload has no VOICE section');
    case 5:
      return new Voice2QrError('UNSUPPORTED_BPS', 'unsupported bit rate');
    case 6:
      return new Voice2QrError('TOO_LARGE', 'payload exceeds capacity');
    case 7:
      return new Voice2QrError('CODEC', 'codec failure');
    case 8:
      return new Voice2QrError('INVALID_ARGUMENT', 'invalid argument');
    default:
      return new Voice2QrError('CODEC', `unknown core status ${status}`);
  }
}
