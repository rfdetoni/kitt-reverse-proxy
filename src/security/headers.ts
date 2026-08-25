const FORWARD_DENYLIST = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'cookie',
  'host',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

export function sanitizeCapturedHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => !FORWARD_DENYLIST.has(name.toLowerCase()))
      .map(([name, value]) => [name.toLowerCase(), String(value)])
  );
}

export function mergeRotatingHeaders(
  current: Record<string, string>,
  responseHeaders: Record<string, string>
): Record<string, string> {
  const next = { ...current };
  for (const name of Object.keys(current)) {
    if (name in responseHeaders && !FORWARD_DENYLIST.has(name)) {
      next[name] = responseHeaders[name]!;
    }
  }
  return next;
}
