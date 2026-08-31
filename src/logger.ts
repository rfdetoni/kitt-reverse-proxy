function stripSensitiveUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const hadSensitiveTail = Boolean(url.search || url.hash);
    url.search = '';
    url.hash = '';
    const clean = url.toString();
    return hadSensitiveTail ? `${clean}?[redacted]` : clean;
  } catch {
    return raw;
  }
}

export function safeUrlForLog(raw: string): string {
  return stripSensitiveUrl(raw);
}

export function sanitizeLogMessage(message: string): string {
  return message.replace(/https?:\/\/[^\s<>"']+/gi, (match) => {
    const trailing = match.match(/[),.;:]+$/)?.[0] ?? '';
    const url = trailing ? match.slice(0, -trailing.length) : match;
    return `${stripSensitiveUrl(url)}${trailing}`;
  });
}

function clean(message: string): string {
  return sanitizeLogMessage(String(message));
}

export const logger = Object.freeze({
  step(current: number, total: number, message: string): void {
    console.log(`[${current}/${total}] ${clean(message)}`);
  },
  success(message: string): void {
    console.log(`[+] ${clean(message)}`);
  },
  info(message: string): void {
    console.log(`[i] ${clean(message)}`);
  },
  warn(message: string): void {
    console.warn(`[!] ${clean(message)}`);
  },
  error(message: string): void {
    console.error(`[-] ${clean(message)}`);
  }
});
