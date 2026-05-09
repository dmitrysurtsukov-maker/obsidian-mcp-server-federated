/**
 * @fileoverview Shared types for cross-vault federation.
 * Mirrors the schema declared in `_federation/vaults.json` (see
 * trusty-vault-bot-clone open vault, schema_version 1.0).
 * @module services/federation/types
 */

export type VaultKind = 'open' | 'sensitive';

/**
 * One vault entry from `_federation/vaults.json`. Only fields we actually use
 * are typed strictly; the registry tolerates extra fields (forward-compat with
 * future schema bumps).
 */
export interface VaultEntry {
  access?: string | undefined;
  kind: VaultKind;
  name: string;
  owner?: string | undefined;
  /**
   * Absolute filesystem path to the vault root (Windows paths with backslashes
   * accepted; normalized at load time). May be absent for vaults that have not
   * been cloned locally — those vaults are listed as "remote-only" and
   * unresolved reads against them throw `vault_unavailable`.
   */
  path?: string | undefined;
  url?: string | undefined;
  [extra: string]: unknown;
}

export interface FederationRegistry {
  generated?: string | undefined;
  schemaVersion: string;
  selfVaultName: string | undefined;
  vaults: ReadonlyMap<string, VaultEntry>;
}

/**
 * Result of parsing a `<vault>:<path>` prefix expression. The `vault` name is
 * the prefix before the first `:`; `relPath` is everything after it (already
 * stripped of `[[ ]]` wrapping if present).
 */
export interface PrefixParse {
  relPath: string;
  vault: string;
}
