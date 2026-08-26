export function assertHttpUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Protocolo não suportado: ${url.protocol}`);
  if (url.username || url.password) throw new Error('URLs contendo credenciais embutidas não são aceitas.');
  return url;
}

function hostMatchesAllowEntry(hostname: string, allowed: string): boolean {
  const host = hostname.toLowerCase();
  const entry = allowed.trim().toLowerCase().replace(/^\.+/, '');
  return Boolean(entry) && (host === entry || host.endsWith(`.${entry}`));
}

export function assertAllowedEndpoint(pageUrl: string, endpointUrl: string, explicitHosts: string[] = []): URL {
  const page = assertHttpUrl(pageUrl);
  const endpoint = assertHttpUrl(endpointUrl);
  const pageHost = page.hostname.toLowerCase();
  const endpointHost = endpoint.hostname.toLowerCase();

  if (explicitHosts.some((host) => hostMatchesAllowEntry(endpointHost, host))) return endpoint;
  if (endpointHost === pageHost || endpointHost.endsWith(`.${pageHost}`)) return endpoint;

  // Sibling hosts are intentionally not inferred as trusted. Without a Public Suffix List,
  // treating foo.example.com and bar.example.com as equivalent also trusts unrelated tenants
  // on domains such as github.io/pages.dev/vercel.app. Use --allow-endpoint-host explicitly.
  throw new Error(`Endpoint candidato fora do host confiável: ${endpoint.hostname}`);
}
