/**
 * @fileoverview Unit tests for the federation registry parser.
 * @module tests/services/federation/registry.test
 */

import { describe, expect, it } from 'vitest';
import { parseRegistry } from '@/services/federation/registry.js';

const CANONICAL = {
  schema_version: '1.0',
  generated: '2026-05-06T15:07:27.751802+00:00',
  vault_self: { name: 'owner-personal', kind: 'open', owner: 'dmitry', access: 'owner-rw' },
  vaults: [
    {
      name: 'owner-personal',
      kind: 'open',
      path: 'C:\\Users\\dmitr\\trusty-vault-bot-clone\\open',
      url: 'git@github.com:dmitrysurtsukov-maker/trusty-vault.git',
      owner: 'dmitry',
      access: 'owner-rw',
    },
    {
      name: 'owner-sensitive',
      kind: 'sensitive',
      path: 'C:\\Users\\dmitr\\trusty-vault-bot-clone\\sensitive',
      owner: 'dmitry',
      access: 'owner+finance-rw',
    },
    {
      name: 'denis-personal',
      kind: 'open',
      url: 'git@github.com:dmitrysurtsukov-maker/trusty-vault-denis.git',
      owner: 'denis',
      path: 'C:\\Users\\dmitr\\trusty-vault-bot-clone-denis\\open',
    },
  ],
};

describe('parseRegistry', () => {
  it('parses the canonical schema and indexes vaults by name', () => {
    const reg = parseRegistry(JSON.stringify(CANONICAL));
    expect(reg.schemaVersion).toBe('1.0');
    expect(reg.selfVaultName).toBe('owner-personal');
    expect(reg.vaults.size).toBe(3);
    expect(reg.vaults.get('denis-personal')?.kind).toBe('open');
    expect(reg.vaults.get('denis-personal')?.path).toContain('trusty-vault-bot-clone-denis');
  });

  it('preserves extra fields on vault entries (forward-compat)', () => {
    const withExtras = {
      ...CANONICAL,
      vaults: [
        {
          ...CANONICAL.vaults[0],
          telegram_user_id: 160267559,
          _note: 'public-team readable',
        },
      ],
    };
    const reg = parseRegistry(JSON.stringify(withExtras));
    const v = reg.vaults.get('owner-personal');
    expect(v).toBeDefined();
    expect(v?.telegram_user_id).toBe(160267559);
    expect(v?._note).toBe('public-team readable');
  });

  it('treats empty path string as undefined (remote-only vault)', () => {
    const remoteOnly = {
      ...CANONICAL,
      vaults: [
        { name: 'remote', kind: 'open' },
        { name: 'has-path', kind: 'open', path: '' },
      ],
    };
    const reg = parseRegistry(JSON.stringify(remoteOnly));
    expect(reg.vaults.get('remote')?.path).toBeUndefined();
    expect(reg.vaults.get('has-path')?.path).toBeUndefined();
  });

  it('rejects non-JSON input', () => {
    expect(() => parseRegistry('not json{')).toThrow(/not valid JSON/);
  });

  it('rejects missing vaults array', () => {
    expect(() => parseRegistry(JSON.stringify({ schema_version: '1.0' }))).toThrow(
      /missing `vaults` array/,
    );
  });

  it('rejects unknown kind', () => {
    const bad = { vaults: [{ name: 'x', kind: 'private' }] };
    expect(() => parseRegistry(JSON.stringify(bad))).toThrow(/kind must be 'open' or 'sensitive'/);
  });

  it('rejects duplicate vault names', () => {
    const dup = {
      vaults: [
        { name: 'a', kind: 'open' },
        { name: 'a', kind: 'open' },
      ],
    };
    expect(() => parseRegistry(JSON.stringify(dup))).toThrow(/duplicate vault name 'a'/);
  });

  it('rejects vault entries without a name', () => {
    const noName = { vaults: [{ kind: 'open' }] };
    expect(() => parseRegistry(JSON.stringify(noName))).toThrow(/missing string `name`/);
  });

  it('returns selfVaultName undefined when vault_self.name is missing', () => {
    const reg = parseRegistry(
      JSON.stringify({ vaults: [{ name: 'a', kind: 'open', path: '/x' }] }),
    );
    expect(reg.selfVaultName).toBeUndefined();
  });
});
