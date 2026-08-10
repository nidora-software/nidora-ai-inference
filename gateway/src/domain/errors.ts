/**
 * The error envelope, in the shape OpenAI clients already handle.
 *
 *   { "error": { "message": "…", "type": "…", "code": "…", "param": "…" } }
 *
 * The same reasoning as the video object: a client written against SGLang or
 * OpenAI should not need a second error path for this gateway. `message` is
 * the human-readable line; `type` is the broad class a client branches on;
 * `code` is the machine-readable reason, stable across message rewordings;
 * `param` names the offending field when there is one.
 *
 * Every route sends errors through here rather than composing bodies inline —
 * that is what keeps a future route from inventing a sixth shape, and what
 * kept the admin plane from describing its own credential in a 401.
 */
export type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'not_found_error'
  | 'server_error';

export interface ApiError {
  error: {
    message: string;
    type: ErrorType;
    code: string | null;
    param: string | null;
  };
}

/**
 * The class of error a status implies. Kept as a function rather than a table
 * on each call site so a route cannot pair a 401 with `invalid_request_error`.
 */
function typeFor(status: number): ErrorType {
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 404) return 'not_found_error';
  if (status >= 500 || status === 503) return 'server_error';
  return 'invalid_request_error';
}

export function apiError(
  status: number,
  message: string,
  opts: { code?: string; param?: string } = {},
): ApiError {
  return {
    error: {
      message,
      type: typeFor(status),
      code: opts.code ?? null,
      param: opts.param ?? null,
    },
  };
}
