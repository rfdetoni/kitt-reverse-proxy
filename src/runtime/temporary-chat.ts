import type { Page } from 'playwright';

export type TemporaryChatMode = 'off' | 'supported' | 'required';

export function temporaryChatMode(env: NodeJS.ProcessEnv = process.env): TemporaryChatMode {
  const mode = (env.PROXY_TEMPORARY_CHAT || 'off').toLowerCase();
  if (mode !== 'off' && mode !== 'supported' && mode !== 'required') {
    throw new Error('PROXY_TEMPORARY_CHAT must be off, supported or required.');
  }
  return mode;
}

/**
 * Require positive UI evidence before a prompt can be sent.
 * This creates a temporary *provider conversation*, not a new browser profile.
 * Authenticated cookies are intentionally retained in the KITT-managed profile.
 */
export async function activateTemporaryChat(
  page: Page,
  providerId: string,
  mode: TemporaryChatMode,
  timeoutMs = 12_000
): Promise<void> {
  if (mode === 'off') return;
  if (providerId !== 'chatgpt') {
    if (mode === 'required') throw new Error('Temporary conversations are not verified for provider: ' + providerId);
    return;
  }

  // The documented web UX is independently verified below; the URL alone
  // does not prove the service accepted temporary-chat mode.
  await page.goto('https://chatgpt.com/?temporary-chat=true', {
    waitUntil: 'domcontentloaded',
    timeout: Math.min(timeoutMs, 60_000)
  });
  const current = new URL(page.url());
  if (current.origin !== 'https://chatgpt.com'
      || current.searchParams.get('temporary-chat') !== 'true') {
    throw new Error('Temporary chat navigation was not preserved by the provider.');
  }

  // New chat UI uses a visible temporary-chat heading. Localized UIs are supported.
  // Do not fall back to ordinary chats if selectors or provider behavior change.
  const title = page.getByRole('heading', { name: /^(temporary chat|chat temporário)$/i }).first();
  await title.waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {
    throw new Error('Provider did not confirm temporary chat mode. Chat was not sent.');
  });
}
