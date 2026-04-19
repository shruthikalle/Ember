/**
 * ERC-8021 Builder Code suffix for Base.
 *
 * Every onchain transaction the agent sends has the builder code
 * appended to the calldata so Base can attribute it.
 *
 * Uses the official ox/erc8021 library to generate proper ERC-8021 data suffixes.
 * See: https://docs.base.org/base-chain/builder-codes/app-developers
 *
 * Env var: BUILDER_CODE — the human-readable builder code from base.dev
 * (e.g. "bc_plqsugov" or "bc_b7k3p9da")
 */

import { Attribution } from 'ox/erc8021';

/**
 * Read the raw builder code string from env.
 */
export function getBuilderCode(): string {
  return (process.env.BUILDER_CODE || process.env.NEXT_PUBLIC_BUILDER_CODE || '').trim();
}

/**
 * Generate the ERC-8021 data suffix using the official ox library.
 *
 * This creates the proper ERC-8021 format that Base expects for attribution.
 * The suffix includes the builder code in the correct format.
 *
 * @param builderCode - Optional override; defaults to env BUILDER_CODE
 * @returns Hex string (without 0x prefix) representing the data suffix, or empty string if no code
 */
export function getDataSuffix(builderCode?: string): string {
  const code = builderCode ?? getBuilderCode();
  if (!code) return '';
  
  try {
    // Use ox library to generate proper ERC-8021 data suffix
    const suffix = Attribution.toDataSuffix({ codes: [code] });
    // Remove 0x prefix if present, return as hex string
    return suffix.startsWith('0x') ? suffix.slice(2) : suffix;
  } catch (error) {
    console.error('[BuilderCode] Error generating data suffix:', error);
    return '';
  }
}

/**
 * Append the builder code suffix to calldata using ERC-8021 format.
 *
 * @param calldata - The original transaction calldata (hex string starting with 0x)
 * @param builderCode - Optional override; defaults to env BUILDER_CODE
 * @returns calldata with builder suffix appended (valid hex)
 */
export function appendBuilderCodeSuffix(calldata: string, builderCode?: string): string {
  const suffix = getDataSuffix(builderCode);
  if (!suffix) {
    console.log('[BuilderCode] No builder code configured, skipping suffix');
    return calldata; // no builder code configured
  }
  
  // Ensure calldata starts with 0x
  const clean = calldata.startsWith('0x') ? calldata : `0x${calldata}`;
  
  // Check if suffix is already appended (avoid double-appending)
  const cleanLower = clean.toLowerCase();
  const suffixLower = suffix.toLowerCase();
  if (cleanLower.endsWith(suffixLower)) {
    console.log('[BuilderCode] Suffix already present, skipping append');
    return clean;
  }
  
  // Append suffix (suffix is already hex without 0x prefix)
  const result = `${clean}${suffix}`;
  console.log('[BuilderCode] Appended suffix:', {
    originalLength: clean.length,
    suffixLength: suffix.length,
    resultLength: result.length,
    suffixPreview: suffix.slice(0, 20) + '...' + suffix.slice(-20),
  });
  return result;
}

/**
 * Verify that calldata ends with the expected builder code suffix.
 *
 * @param calldata - Transaction calldata to verify
 * @param builderCode - Optional override; defaults to env BUILDER_CODE
 * @returns true if the calldata ends with the expected ERC-8021 suffix
 */
export function verifyBuilderSuffix(calldata: string, builderCode?: string): boolean {
  const suffix = getDataSuffix(builderCode);
  if (!suffix) return true; // nothing to verify if no code configured
  
  const clean = calldata.toLowerCase().replace(/^0x/, '');
  const suffixLower = suffix.toLowerCase();
  
  // ERC-8021 suffix should be at the end of the calldata
  return clean.endsWith(suffixLower);
}

/**
 * Legacy function for backward compatibility.
 * Converts builder code to hex (old method, kept for reference).
 * 
 * @deprecated Use getDataSuffix() instead for proper ERC-8021 format
 */
export function builderCodeToHex(code?: string): string {
  return getDataSuffix(code);
}
