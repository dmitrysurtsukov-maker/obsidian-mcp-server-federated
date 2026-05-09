/**
 * @fileoverview Unit tests for the federation prefix parser + resolver.
 * Uses an in-memory registry built from `parseRegistry`; no filesystem I/O.
 * @module tests/services/federation/resolve.test
 */

import { describe, expect, it } from 'vitest';
import { parseRegistry } from '@/services/federation/registry.js';
import {
  FederationResolveError,
  parsePrefix,
  resolveFederatedPath,
} from '@/services/federation/resolve.js';

function makeRegistry(opts: { selfName?: string; vaults: Array<Record<string, unknown>> }) {
  const payload: Record<string, unknown> = { schema_version: '1.0', vaults: opts.vaults };
  if (opts.selfName !== undefined) payload.vault_self = { name: opts.selfName };
  return parseRegistry(JSON.stringify(payload));
}

describe('parsePrefix', () => {
  it('parses bare `<vault>:<path>` form', () => {
    expect(parsePrefix('denis-personal:projects/x.md')).toEqual({
      vault: 'denis-personal',
      relPath: 'projects/x.md',
    });
  });

  it('parses wrapped `[[<vault>:<path>]]` form', () => {
    expect(parsePrefix('[[denis-personal:projects/x.md]]')).toEqual({
      vault: 'denis-personal',
      relPath: 'projects/x.md',
    });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parsePrefix('  [[ owner-personal:README.md ]] ')).toEqual({
      vault: 'owner-personal',
      relPath: 'README.md',
    });
  });

  it('returns undefined for unprefixed paths', () => {
    expect(parsePrefix('projects/foo.md')).toBeUndefined();
  });

  it('returns undefined when prefix contains slashes (looks like a path segment)', () => {
    expect(parsePrefix('projects/foo:bar.md')).toBeUndefined();
  });
});

describe('resolveFederatedPath', () => {
  const reg = makeRegistry({
    selfName: 'owner-personal',
    vaults: [
      { name: 'owner-personal', kind: 'open', path: '/tmp/owner' },
      { name: 'owner-sensitive', kind: 'sensitive', path: '/tmp/owner-sensitive' },
      { name: 'denis-personal', kind: 'open', path: '/tmp/denis' },
      { name: 'remote-only', kind: 'open' },
    ],
  });

  it('resolves a cross-vault prefix to an absolute path', () => {
    const res = resolveFederatedPath({ vault: 'denis-personal', relPath: 'projects/x.md' }, reg);
    expect(res.isSelf).toBe(false);
    expect(res.relPath).toBe('projects/x.md');
    expect(res.absPath).toMatch(/denis[\\/]projects[\\/]x\.md$/);
    expect(res.vault.name).toBe('denis-personal');
  });

  it('marks self-vault resolution with isSelf=true', () => {
    const res = resolveFederatedPath({ vault: 'owner-personal', relPath: 'README.md' }, reg);
    expect(res.isSelf).toBe(true);
    expect(res.relPath).toBe('README.md');
  });

  it('throws unknown_vault for prefixes not in the registry', () => {
    expect(() => resolveFederatedPath({ vault: 'mystery', relPath: 'x.md' }, reg)).toThrow(
      FederationResolveError,
    );
    try {
      resolveFederatedPath({ vault: 'mystery', relPath: 'x.md' }, reg);
    } catch (err) {
      expect(err).toBeInstanceOf(FederationResolveError);
      expect((err as FederationResolveError).detail.kind).toBe('unknown_vault');
    }
  });

  it('blocks cross-vault reads into sensitive vaults', () => {
    expect(() =>
      resolveFederatedPath({ vault: 'owner-sensitive', relPath: 'finance.md' }, reg),
    ).toThrow(/sensitive/);
    try {
      resolveFederatedPath({ vault: 'owner-sensitive', relPath: 'x.md' }, reg);
    } catch (err) {
      expect((err as FederationResolveError).detail.kind).toBe('sensitive_blocked');
    }
  });

  it('throws vault_unavailable when the entry has no local path', () => {
    expect(() => resolveFederatedPath({ vault: 'remote-only', relPath: 'x.md' }, reg)).toThrow(
      /remote-only/,
    );
    try {
      resolveFederatedPath({ vault: 'remote-only', relPath: 'x.md' }, reg);
    } catch (err) {
      expect((err as FederationResolveError).detail.kind).toBe('vault_unavailable');
    }
  });

  it('rejects empty relPath', () => {
    expect(() => resolveFederatedPath({ vault: 'denis-personal', relPath: '' }, reg)).toThrow(
      /Empty path/,
    );
  });

  it('rejects `..` traversal segments', () => {
    expect(() =>
      resolveFederatedPath({ vault: 'denis-personal', relPath: '../escape.md' }, reg),
    ).toThrow(/'\.\.' traversal/);
    expect(() =>
      resolveFederatedPath({ vault: 'denis-personal', relPath: 'a/../../escape.md' }, reg),
    ).toThrow(/'\.\.' traversal/);
  });

  it('rejects POSIX absolute paths', () => {
    expect(() =>
      resolveFederatedPath({ vault: 'denis-personal', relPath: '/etc/passwd' }, reg),
    ).toThrow(/absolute/);
  });

  it('rejects Windows drive-letter absolute paths', () => {
    expect(() =>
      resolveFederatedPath({ vault: 'denis-personal', relPath: 'C:\\Windows\\system.ini' }, reg),
    ).toThrow(/absolute/);
  });

  it('throws no_registry when registry is undefined', () => {
    expect(() => resolveFederatedPath({ vault: 'x', relPath: 'y.md' }, undefined)).toThrow(
      /Federation registry is not configured/,
    );
  });

  it('returns POSIX-style relPath even on Windows-style separators in input', () => {
    const res = resolveFederatedPath(
      { vault: 'denis-personal', relPath: 'projects\\sub\\file.md' },
      reg,
    );
    expect(res.relPath).toBe('projects/sub/file.md');
  });
});
