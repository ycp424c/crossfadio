export type SafeOperationalError = {
  code: string;
  status?: number;
  requestId?: string;
};

const SAFE_MACHINE_CODE = /^[a-z][a-z0-9_]{0,79}$/;
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Reduce an arbitrary provider/runtime error to fields that are safe to log or
 * expose on a wire response. Error messages, causes and response bodies are
 * deliberately excluded because providers may echo prompts or private context.
 */
export function safeOperationalError(
  error: unknown,
  fallbackCode: string
): SafeOperationalError {
  const details = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : {};
  const status = typeof details.status === 'number' && Number.isInteger(details.status)
    ? details.status
    : undefined;
  const explicitCode = typeof details.code === 'string' && SAFE_MACHINE_CODE.test(details.code)
    ? details.code
    : undefined;
  const name = error instanceof Error ? error.name : '';
  const code = explicitCode
    ?? (name === 'AbortError' ? 'request_aborted' : providerStatusCode(status))
    ?? fallbackCode;
  const rawRequestId = details.requestId ?? details.request_id;
  const requestId = typeof rawRequestId === 'string' && SAFE_REQUEST_ID.test(rawRequestId)
    ? rawRequestId
    : undefined;
  return {
    code,
    ...(status !== undefined ? { status } : {}),
    ...(requestId ? { requestId } : {})
  };
}

function providerStatusCode(status: number | undefined): string | undefined {
  if (status === 408 || status === 504) return 'provider_timeout';
  if (status === 429) return 'provider_rate_limited';
  if (status !== undefined && status >= 500) return 'provider_server_error';
  if (status !== undefined && status >= 400) return 'provider_client_error';
  return undefined;
}
