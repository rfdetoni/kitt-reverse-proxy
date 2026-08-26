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

const SENSITIVE_FORWARD_HEADER = /(authorization|token|secret|api[-_]?key|csrf|xsrf|session)/i;

export function sanitizeCapturedHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => !FORWARD_DENYLIST.has(name.toLowerCase()))
      .map(([name, value]) => [name.toLowerCase(), String(value)])
  );
}

export function hasSensitiveForwardHeaders(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => SENSITIVE_FORWARD_HEADER.test(name));
}

export function mergeRotatingHeaders(
  current: Record<string, string>,
  responseHeaders: Record<string, string>
): Record<string, string> {
  const next = { ...current };
  for (const name of Object.keys(current)) {
    const normalized = name.toLowerCase();
    if (normalized in responseHeaders && !FORWARD_DENYLIST.has(normalized)) next[normalized] = responseHeaders[normalized]!;
  }
  return next;
}
