/**
 * @fileoverview Tool-side bridge between the federation service and the
 * existing Obsidian REST tool handlers. Handlers call `classifyPath` first;
 * if the input path carries a `<vault>:<rel-path>` prefix, the bridge
 * resolves it via the registry and reads from the federated vault on disk.
 * If the prefix is absent (or matches the self-vault), the handler falls
 * through to its regular REST API logic.
 *
 * Self-vault prefix is treated as "strip prefix and route normally" — the
 * REST API server is already pointed at the self-vault, so prefixing is
 * just a documentation convenience for explicit cross-vault references.
 *
 * Federation errors are surfaced as plain `McpError`s (not contract-bound
 * `ctx.fail`), since the federation reasons are wider than any one tool's
 * declared `errors[]` and we don't want to grow every contract.
 *
 * @module mcp-server/tools/definitions/_shared/federation-bridge
 */

import {
  forbidden,
  internalError,
  type McpError,
  notFound,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  type FederatedDirEntry,
  FederationResolveError,
  FsReadError,
  fsListNotes,
  parsePrefix,
  type ResolvedFederatedPath,
  readNoteContent,
  readNoteJson,
  resolveFederatedPath,
} from '@/services/federation/index.js';
import type { NoteJson } from '@/services/obsidian/types.js';

export type PathClassification =
  | { kind: 'no_prefix' }
  | { kind: 'self'; relPath: string; vaultName: string }
  | { kind: 'federated'; resolved: ResolvedFederatedPath }
  | { kind: 'error'; error: FederationResolveError };

/**
 * Inspect `pathInput`. Routes:
 * - No `<prefix>:` → `no_prefix` (caller routes via REST API as usual).
 * - `<self>:<rel>` → `self` (caller may strip the prefix and route via REST).
 * - `<other>:<rel>` → `federated` (caller reads via filesystem).
 * - registry/path error → `error` (caller decides how to surface it).
 */
export function classifyPath(pathInput: string): PathClassification {
  const parsed = parsePrefix(pathInput);
  if (parsed === undefined) return { kind: 'no_prefix' };
  let resolved: ResolvedFederatedPath;
  try {
    resolved = resolveFederatedPath(parsed);
  } catch (err) {
    if (err instanceof FederationResolveError) return { kind: 'error', error: err };
    throw err;
  }
  if (resolved.isSelf) {
    return { kind: 'self', relPath: resolved.relPath, vaultName: resolved.vault.name };
  }
  return { kind: 'federated', resolved };
}

/**
 * Translate a {@link FederationResolveError} or {@link FsReadError} into the
 * `McpError` shape that tool handlers expose to clients. Maps subreasons to
 * stable JSON-RPC codes via the helper factories.
 */
export function federationError(err: FederationResolveError | FsReadError): McpError {
  if (err instanceof FsReadError) {
    return notFound(err.message, { reason: 'federation_fs_error', subreason: err.kind });
  }
  const detail = err.detail;
  switch (detail.kind) {
    case 'unknown_vault':
      return notFound(detail.message, {
        reason: 'federation_unknown_vault',
        vault: detail.vault,
        availableVaults: detail.available,
      });
    case 'sensitive_blocked':
      return forbidden(detail.message, {
        reason: 'federation_sensitive_blocked',
        vault: detail.vault,
      });
    case 'vault_unavailable':
      return notFound(detail.message, {
        reason: 'federation_vault_unavailable',
        vault: detail.vault,
      });
    case 'no_registry':
      return validationError(detail.message, { reason: 'federation_disabled' });
    case 'invalid_path':
    case 'path_escape':
      return validationError(detail.message, {
        reason: 'federation_invalid_path',
        vault: detail.vault,
        relPath: detail.relPath,
      });
    default: {
      const _never: never = detail;
      return internalError(`Unhandled federation error: ${JSON.stringify(_never)}`, {});
    }
  }
}

/** Read a federated note as JSON. Re-throws translated MCP errors. */
export async function federatedGetJson(resolved: ResolvedFederatedPath): Promise<NoteJson> {
  try {
    return await readNoteJson(resolved);
  } catch (err) {
    if (err instanceof FsReadError) throw federationError(err);
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw federationError(
        new FsReadError(
          'not_found',
          `Note not found in vault '${resolved.vault.name}': ${resolved.relPath}`,
        ),
      );
    }
    throw err;
  }
}

/** Read a federated note's raw markdown body. */
export async function federatedGetContent(resolved: ResolvedFederatedPath): Promise<string> {
  try {
    return await readNoteContent(resolved);
  } catch (err) {
    if (err instanceof FsReadError) throw federationError(err);
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw federationError(
        new FsReadError(
          'not_found',
          `Note not found in vault '${resolved.vault.name}': ${resolved.relPath}`,
        ),
      );
    }
    throw err;
  }
}

/** List entries under a federated directory. */
export async function federatedListNotes(
  resolved: ResolvedFederatedPath,
  opts: {
    depth: number;
    extension?: string | undefined;
    nameRegex?: RegExp | undefined;
    entryCap: number;
  },
): Promise<{ entries: FederatedDirEntry[]; cappedByEntries: boolean }> {
  try {
    return await fsListNotes(resolved, opts);
  } catch (err) {
    if (err instanceof FsReadError) throw federationError(err);
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw federationError(
        new FsReadError(
          'not_found',
          `Directory not found in vault '${resolved.vault.name}': ${resolved.relPath}`,
        ),
      );
    }
    throw err;
  }
}

/** Form a vault-prefixed display path (e.g., `denis-personal:projects/foo.md`). */
export function withVaultPrefix(vaultName: string, relPath: string): string {
  return `${vaultName}:${relPath}`;
}
