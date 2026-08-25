const MULTI_LEVEL_PUBLIC_SUFFIX = new Set([
  'com.br', 'net.br', 'org.br', 'gov.br',
  'co.uk', 'org.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au',
  'co.jp', 'co.nz', 'com.mx', 'com.ar'
]);

export function assertHttpUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Protocolo não suportado: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('URLs contendo credenciais embutidas não são aceitas.');
  }
  return url;
}

function siteKey(hostname: string): string {
  const parts = hostname.toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  return MULTI_LEVEL_PUBLIC_SUFFIX.has(lastTwo)
    ? parts.slice(-3).join('.')
    : parts.slice(-2).join('.');
}

export function assertAllowedEndpoint(pageUrl: string, endpointUrl: string, explicitHosts: string[] = []): URL {
  const page = assertHttpUrl(pageUrl);
  const endpoint = assertHttpUrl(endpointUrl);
  const endpointHost = endpoint.hostname.toLowerCase();
  if (explicitHosts.some((host) => endpointHost === host || endpointHost.endsWith(`.${host}`))) return endpoint;
  if (siteKey(page.hostname) !== siteKey(endpoint.hostname)) {
    throw new Error(`Endpoint candidato fora do site alvo: ${endpoint.hostname}`);
  }
  return endpoint;
}
