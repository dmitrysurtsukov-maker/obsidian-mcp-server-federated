/**
 * @fileoverview Resolves prefixed wikilinks/paths of the form
 * `<vault>:<rel-path>` (with or without surrounding `[[ ]]`) against the
 * federation registry. Returns an absolute filesystem path under the target
 * vault's declared root, after rejecting traversal attempts.
 *
 * Self-vault prefix (matching `vault_self.name`) is treated as a no-op pass-
 * through — the caller should fall back to its regular routing (REST API in
 * this server). Sensitive-kind vaults are rejected at the resolver level —
 * cross-vault reads from a federated client into the sensitive vault are
 * forbidden by ADR 0001 §A4 of the trusty-vault-federation plan.
 *
 * @module services/federation/resolve
 */

import { isAbsolute, normalize, relative, resolve as resolvePath, sep } from 'node:path';
import { getFederationRegistry } from './registry.js';
import type { FederationRegistry, PrefixParse, VaultEntry } from './types.js';

const WIKILINK_RE = /^\s*\[\[(.+)\]\]\s*$/;
/**
 * Matches `<prefix>:<rest>` where `prefix` is a vault name. Vault names in
 * the canonical registry use `[a-z0-9-]`. We are permissive here (allow `_`
 * and uppercase) to accept future schema, but disallow `:` in the prefix to
 * keep the split unambiguous, and disallow `/` and `\` to keep the prefix
 * from looking like a path segment.
 */
const PREFIX_RE = /^([A-Za-z0-9_-]+):(.*)$/s;

/**
 * Strip optional `[[ ]]` wrapping and split into `vault` + `relPath` if a
 * prefix is present. Returns undefined when there is no `<prefix>:` —
 * caller treats that as "not a federated reference, route normally".
 */
export function parsePrefix(input: string): PrefixParse | undefined {
  let s = input.trim();
  const wm = WIKILINK_RE.exec(s);
  if (wm?.[1] !== undefined) {
    s = wm[1].trim();
  }
  const m = PREFIX_RE.exec(s);
  if (m === null || m[1] === undefined || m[2] === undefined) return;
  return { vault: m[1], relPath: m[2].trim() };
}

export interface ResolvedFederatedPath {
  /** Absolute filesystem path, OS-native separators. */
  absPath: string;
  /** True when the prefix matched the self-vault. Caller may bypass federation and route via REST API. */
  isSelf: boolean;
  /** Vault-relative POSIX-style path (forward slashes) — the original `relPath` after normalization. */
  relPath: string;
  vault: VaultEntry;
}

export type ResolveError =
  | { kind: 'no_registry'; message: string }
  | { kind: 'unknown_vault'; message: string; vault: string; available: readonly string[] }
  | { kind: 'vault_unavailable'; message: string; vault: string }
  | { kind: 'sensitive_blocked'; message: string; vault: string }
  | { kind: 'invalid_path'; message: string; vault: string; relPath: string }
  | { kind: 'path_escape'; message: string; vault: string; relPath: string };

export class FederationResolveError extends Error {
  readonly detail: ResolveError;
  constructor(detail: ResolveError) {
    super(detail.message);
    this.name = 'FederationResolveError';
    this.detail = detail;
  }
}

/**
 * Resolve a parsed prefix to an absolute filesystem path under the vault's
 * root. Reuses the cached registry by default; tests inject a stub registry
 * via the second argument.
 */
export function resolveFederatedPath(
  parse: PrefixParse,
  registry: FederationRegistry | undefined = getFederationRegistry(),
): ResolvedFederatedPath {
  if (registry === undefined) {
    throw new FederationResolveError({
      kind: 'no_registry',
      message:
        'Federation registry is not configured (set OBSIDIAN_FEDERATION_REGISTRY to the path of vaults.json).',
    });
  }
  const vault = registry.vaults.get(parse.vault);
  if (vault === undefined) {
    throw new FederationResolveError({
      kind: 'unknown_vault',
      message: `Unknown vault prefix '${parse.vault}'. Available: ${[...registry.vaults.keys()].join(', ') || '(none)'}`,
      vault: parse.vault,
      available: [...registry.vaults.keys()],
    });
  }
  const isSelf = registry.selfVaultName === vault.name;
  if (vault.kind === 'sensitive' && !isSelf) {
    // Per ADR 0001 §A4: cross-vault wikilinks into the sensitive vault are blocked.
    throw new FederationResolveError({
      kind: 'sensitive_blocked',
      message: `Vault '${parse.vault}' is sensitive — cross-vault reads are blocked by federation policy.`,
      vault: parse.vault,
    });
  }
  if (vault.path === undefined || vault.path.trim() === '') {
    throw new FederationResolveError({
      kind: 'vault_unavailable',
      message: `Vault '${parse.vault}' has no local \`path\` in the registry — it is remote-only and cannot be read here.`,
      vault: parse.vault,
    });
  }
  const relRaw = parse.relPath;
  if (relRaw === '') {
    throw new FederationResolveError({
      kind: 'invalid_path',
      message: `Empty path after prefix '${parse.vault}:'.`,
      vault: parse.vault,
      relPath: relRaw,
    });
  }
  // Allow `.` to mean the vault root itself — useful for `obsidian_list_notes`
  // which lists `<vault>:.` to walk from the root.
  const isRootRef = relRaw === '.' || relRaw === './';
  // Reject absolute paths (Windows drive letter or POSIX root) — federation
  // paths are vault-relative by contract.
  if (isAbsolute(relRaw) || /^[A-Za-z]:[\\/]/.test(relRaw)) {
    throw new FederationResolveError({
      kind: 'invalid_path',
      message: `Path '${relRaw}' is absolute; federation paths must be vault-relative.`,
      vault: parse.vault,
      relPath: relRaw,
    });
  }
  // Reject explicit `..` segments early — covered again by the post-normalize
  // escape check, but a clear early error is friendlier.
  const segments = relRaw.split(/[\\/]/);
  if (segments.some((seg) => seg === '..')) {
    throw new FederationResolveError({
      kind: 'invalid_path',
      message: `Path '${relRaw}' contains '..' traversal.`,
      vault: parse.vault,
      relPath: relRaw,
    });
  }
  const vaultRoot = resolvePath(vault.path);
  if (isRootRef) {
    return {
      vault,
      relPath: '',
      absPath: vaultRoot,
      isSelf,
    };
  }
  const candidate = resolvePath(vaultRoot, relRaw);
  // Defence in depth: even with the segment check above, ensure the resolved
  // candidate stays under the vault root after path normalization.
  const rel = relative(vaultRoot, candidate);
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new FederationResolveError({
      kind: 'path_escape',
      message: `Resolved path escapes vault '${parse.vault}' root.`,
      vault: parse.vault,
      relPath: relRaw,
    });
  }
  // Vault-relative path normalized to POSIX separators for echoing back to
  // tool callers — the tool's `path` output is always forward-slash.
  const relPosix = normalize(rel).split(sep).join('/');
  return {
    vault,
    relPath: relPosix,
    absPath: candidate,
    isSelf,
  };
}
