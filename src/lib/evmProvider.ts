'use client';

/**
 * EIP-6963 multi-wallet provider discovery + preference picker.
 *
 * Modern EVM wallets (MetaMask, Phantom, Rabby, Coinbase Wallet, etc.)
 * announce themselves via `eip6963:announceProvider` events. When multiple
 * extensions are installed they fight over `window.ethereum` — and Phantom
 * often wins, which means `window.ethereum` returns Phantom's embedded EVM
 * wallet instead of the user's MetaMask account. This helper lets us pick
 * MetaMask (or any non-Phantom provider) explicitly.
 */

export interface EIP6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string; // reverse DNS — e.g. "io.metamask", "app.phantom"
}

export interface EIP6963ProviderDetail {
  info: EIP6963ProviderInfo;
  provider: any; // EIP-1193 provider
}

const detected: EIP6963ProviderDetail[] = [];
let listenerAttached = false;

function attachListener(): void {
  if (listenerAttached || typeof window === 'undefined') return;
  listenerAttached = true;
  window.addEventListener('eip6963:announceProvider', ((event: any) => {
    const detail = event.detail as EIP6963ProviderDetail | undefined;
    if (!detail?.info?.uuid) return;
    if (detected.some((d) => d.info.uuid === detail.info.uuid)) return;
    detected.push(detail);
  }) as EventListener);
}

/** Ask wallets to announce themselves via `eip6963:announceProvider`. */
export function requestEvmProviders(): void {
  if (typeof window === 'undefined') return;
  attachListener();
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

/** Read everything discovered so far — does NOT dispatch. Safe in effects/handlers. */
export function getDetectedEvmProviders(): EIP6963ProviderDetail[] {
  if (typeof window === 'undefined') return [];
  attachListener();
  return [...detected];
}

/**
 * Trigger provider announcements *and* return everything discovered so far.
 * Calling this inside an `eip6963:announceProvider` handler creates an
 * infinite loop (announce → dispatch → announce → …), so prefer the split
 * `requestEvmProviders` + `getDetectedEvmProviders` pair for that case.
 */
export function listEvmProviders(): EIP6963ProviderDetail[] {
  requestEvmProviders();
  return getDetectedEvmProviders();
}

// ── Last-used provider memory (localStorage) ────────────────────
const LAST_USED_KEY = 'ember:evmProviderRdns';

export function rememberEvmProvider(rdns: string): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(LAST_USED_KEY, rdns); } catch { /* storage blocked */ }
}

export function forgetEvmProvider(): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(LAST_USED_KEY); } catch { /* storage blocked */ }
}

export function getRememberedEvmProvider(): EIP6963ProviderDetail | null {
  if (typeof window === 'undefined') return null;
  let rdns: string | null = null;
  try { rdns = window.localStorage.getItem(LAST_USED_KEY); } catch { /* storage blocked */ }
  if (!rdns) return null;
  const list = getDetectedEvmProviders();
  return list.find((p) => p.info.rdns === rdns) ?? null;
}

/**
 * Legacy fallback — returns `window.ethereum` when no 6963 provider picked.
 * Used only when we have no remembered provider and the caller has to act.
 */
export function getLegacyEthereumProvider(): any | null {
  if (typeof window === 'undefined') return null;
  return (window as any).ethereum ?? null;
}

/**
 * Get Phantom's Solana provider — never falls back to generic `window.solana`
 * (which might be Solflare, Backpack, or anything else).
 */
export function getPhantomSolanaProvider(): any | null {
  if (typeof window === 'undefined') return null;
  const p = (window as any)?.phantom?.solana;
  return p?.isPhantom ? p : null;
}

/**
 * Check whether Phantom is installed at all (for UX messages).
 */
export function isPhantomInstalled(): boolean {
  return !!getPhantomSolanaProvider();
}
