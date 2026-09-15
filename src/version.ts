import { readFileSync } from 'node:fs';

export const SERVICE_NAME = 'kitt-reverse-proxy';

interface PackageMetadata {
  version?: unknown;
}

export function readPackageVersion(moduleUrl: string = import.meta.url): string {
  const candidates = [
    new URL('../package.json', moduleUrl),
    // Tests are emitted under dist-test/src, one level deeper than production dist.
    new URL('../../package.json', moduleUrl)
  ];

  for (const candidate of candidates) {
    try {
      const metadata = JSON.parse(readFileSync(candidate, 'utf8')) as PackageMetadata;
      if (typeof metadata.version === 'string' && metadata.version.trim()) {
        return metadata.version.trim();
      }
    } catch {
      // Try the next known package location. Version display must never block startup.
    }
  }

  return 'unknown';
}

export const SERVICE_VERSION = readPackageVersion();
