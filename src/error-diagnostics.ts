/** Response hints are bounded diagnostics, never authority to retry a mutation. */
export function responseDiagnostics(headers: Headers, now = Date.now()) {
  const rawId = headers.get('X-Request-ID');
  const requestId = rawId !== null && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(rawId) ? rawId : undefined;
  const rawRetry = headers.get('Retry-After');
  let retryAfterSeconds: number | undefined;
  if (rawRetry !== null) {
    if (/^[0-9]{1,10}$/.test(rawRetry)) retryAfterSeconds = Number(rawRetry);
    else {
      const date = Date.parse(rawRetry);
      if (Number.isFinite(date) && new Date(date).toUTCString() === rawRetry)
        retryAfterSeconds = Math.max(0, Math.ceil((date - now) / 1000));
    }
    if (retryAfterSeconds !== undefined && (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds > 86_400)) retryAfterSeconds = undefined;
  }
  return { requestId, retryAfterSeconds };
}
