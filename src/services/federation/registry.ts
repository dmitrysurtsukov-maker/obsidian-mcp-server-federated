/**
 * @fileoverview Loads `_federation/vaults.json` registry from the path
 * declared by `OBSIDIAN_FEDERATION_REGISTRY`. Sync read at first access,
 * cached for the process lifetime; `resetFederationRegistry()` exposed for
 * tests. Tolerates extra fields and missing optional keys — only `name` and
 * `kind` are required per vault entry.
 * @module services/federation/registry
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { FederationRegistry, VaultEntry } from './types.js';

interface RawRegistry {
  generated?: string;
  schema_version?: string;
  vault_self?: { name?: string };
  vaults?: unknown[];
}

let _registry: FederationRegistry | undefined;
let _loadedFrom: string | undefined;

/**
 * Path to the registry file, resolved from `OBSIDIAN_FEDERATION_REGISTRY` env.
 * Returns undefined when the env var is unset (federation disabled).
 */
export function getFederationRegistryPath(): string | undefined {
  const raw = process.env.OBSIDIAN_FEDERATION_REGISTRY;
  if (raw === undefined || raw.trim() === '') return;
  return resolvePath(raw.trim());
}

/**
 * Returns the parsed registry, loading it on first access. Returns undefined
 * when federation is disabled (env var unset) — callers should treat that as
 * "no prefix routing, fall through to the regular REST API path".
 *
 * Throws when the env var is set but the file cannot be read or parsed —
 * misconfigured federation should fail loud, not silently degrade.
 */
export function getFederationRegistry(): FederationRegistry | undefined {
  if (_registry !== undefined) return _registry;
  const path = getFederationRegistryPath();
  if (path === undefined) return;
  _registry = loadRegistry(path);
  _loadedFrom = path;
  return _registry;
}

/**
 * Force a reload from the current `OBSIDIAN_FEDERATION_REGISTRY` value. Used
 * by tests and by the (future) `obsidian_federation_reload` admin tool. No-op
 * when federation is disabled.
 */
export function reloadFederationRegistry(): FederationRegistry | undefined {
  _registry = undefined;
  _loadedFrom = undefined;
  return getFederationRegistry();
}

/** Test hook — drops the cached parse without re-reading. */
export function resetFederationRegistry(): void {
  _registry = undefined;
  _loadedFrom = undefined;
}

/** Diagnostic — returns the path the cached registry was loaded from. */
export function getLoadedRegistryPath(): string | undefined {
  return _loadedFrom;
}

/**
 * Parse a registry from arbitrary JSON text. Exposed for tests; the file-read
 * variant lives in {@link loadRegistry}.
 */
export function parseRegistry(jsonText: string, source = '<inline>'): FederationRegistry {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `OBSIDIAN_FEDERATION_REGISTRY (${source}): not valid JSON — ${(err as Error).message}`,
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`OBSIDIAN_FEDERATION_REGISTRY (${source}): top-level must be an object`);
  }
  const reg = raw as RawRegistry;
  if (!Array.isArray(reg.vaults)) {
    throw new Error(`OBSIDIAN_FEDERATION_REGISTRY (${source}): missing \`vaults\` array`);
  }
  const vaults = new Map<string, VaultEntry>();
  for (const [idx, entryRaw] of reg.vaults.entries()) {
    if (entryRaw === null || typeof entryRaw !== 'object' || Array.isArray(entryRaw)) {
      throw new Error(`OBSIDIAN_FEDERATION_REGISTRY (${source}): vaults[${idx}] is not an object`);
    }
    const e = entryRaw as Record<string, unknown>;
    const name = e.name;
    const kind = e.kind;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error(
        `OBSIDIAN_FEDERATION_REGISTRY (${source}): vaults[${idx}] missing string \`name\``,
      );
    }
    if (kind !== 'open' && kind !== 'sensitive') {
      throw new Error(
        `OBSIDIAN_FEDERATION_REGISTRY (${source}): vaults[${idx}] kind must be 'open' or 'sensitive', got '${String(kind)}'`,
      );
    }
    if (vaults.has(name)) {
      throw new Error(`OBSIDIAN_FEDERATION_REGISTRY (${source}): duplicate vault name '${name}'`);
    }
    const entry: VaultEntry = {
      ...(e as Record<string, unknown>),
      name,
      kind,
    };
    if (typeof e.path === 'string' && e.path.trim() !== '') {
      entry.path = e.path;
    } else {
      entry.path = undefined;
    }
    vaults.set(name, entry);
  }
  const selfVaultName =
    typeof reg.vault_self?.name === 'string' && reg.vault_self.name.trim() !== ''
      ? reg.vault_self.name
      : undefined;
  return {
    schemaVersion: typeof reg.schema_version === 'string' ? reg.schema_version : 'unknown',
    generated: typeof reg.generated === 'string' ? reg.generated : undefined,
    selfVaultName,
    vaults,
  };
}

function loadRegistry(filePath: string): FederationRegistry {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(
      `OBSIDIAN_FEDERATION_REGISTRY=${filePath}: cannot read — ${(err as Error).message}`,
    );
  }
  return parseRegistry(text, filePath);
}
