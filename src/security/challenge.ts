import type { Page } from 'playwright';
import { anyVisible, bodyText } from '../runtime/ui-dom.js';

export type BrowserGateKind = 'captcha' | 'anti_bot' | 'login';

export interface BrowserGate {
  kind: BrowserGateKind;
  message: string;
}

const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha" i]',
  'iframe[src*="hcaptcha" i]',
  'iframe[src*="challenges.cloudflare.com" i]',
  '[class*="captcha" i]',
  '[id*="captcha" i]',
  '[data-sitekey]'
];

const LOGIN_SELECTORS = [
  'input[type="password"]',
  'form[action*="login" i]',
  'form[action*="signin" i]',
  'button:has-text("Log in")',
  'button:has-text("Sign in")'
];

const CAPTCHA_TEXT = /(captcha|verify (?:that )?you are human|confirm you are human|complete the challenge)/i;
const ANTI_BOT_TEXT = /(checking your browser|security check|unusual traffic|automated requests|please wait while we verify)/i;
const LOGIN_TEXT = /(^|\n)\s*(log in|sign in|continue with google|continue with apple)\s*($|\n)/i;

export async function detectBrowserGate(page: Page, chatInputSelectors: readonly string[]): Promise<BrowserGate | null> {
  // A visible chat input takes precedence over generic page text such as help articles mentioning CAPTCHA.
  if (await anyVisible(page, chatInputSelectors)) return null;

  const url = page.url().toLowerCase();
  if (/captcha|challenge|checkpoint/.test(url) || await anyVisible(page, CAPTCHA_SELECTORS)) {
    return { kind: 'captcha', message: 'CAPTCHA/desafio humano detectado.' };
  }

  const text = await bodyText(page);
  if (CAPTCHA_TEXT.test(text)) return { kind: 'captcha', message: 'CAPTCHA/desafio humano detectado.' };
  if (ANTI_BOT_TEXT.test(text)) return { kind: 'anti_bot', message: 'Verificação anti-bot detectada.' };
  if (/login|signin|auth/.test(url) || await anyVisible(page, LOGIN_SELECTORS) || LOGIN_TEXT.test(text)) {
    return { kind: 'login', message: 'Login/autenticação manual necessária.' };
  }
  return null;
}
