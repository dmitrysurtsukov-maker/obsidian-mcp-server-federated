/**
 * @fileoverview Unit tests for the federation filesystem readers. Uses a
 * temporary directory built per test; no fixtures committed to the repo.
 * @module tests/services/federation/fs-reader.test
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fsListNotes,
  readNoteContent,
  readNoteJson,
  resolveFederatedPath,
} from '@/services/federation/index.js';
import { parseRegistry } from '@/services/federation/registry.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'mcp-fed-fsr-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function buildRegistry() {
  return parseRegistry(
    JSON.stringify({
      schema_version: '1.0',
      vault_self: { name: 'self' },
      vaults: [{ name: 'denis', kind: 'open', path: tmpRoot }],
    }),
  );
}

describe('readNoteJson + readNoteContent', () => {
  it('parses frontmatter, body, and inline tags', async () => {
    const file = join(tmpRoot, 'note.md');
    await writeFile(
      file,
      `---\ntitle: Hello\ntags: [alpha, beta]\n---\nBody #gamma here.\n`,
      'utf8',
    );
    const reg = buildRegistry();
    const resolved = resolveFederatedPath({ vault: 'denis', relPath: 'note.md' }, reg);
    const note = await readNoteJson(resolved);
    expect(note.path).toBe('note.md');
    expect(note.frontmatter.title).toBe('Hello');
    expect(note.tags.sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(note.content).toContain('Body #gamma here');
    expect(note.stat.size).toBeGreaterThan(0);
    const raw = await readNoteContent(resolved);
    expect(raw).toBe(note.content);
  });

  it('handles notes without frontmatter', async () => {
    await writeFile(join(tmpRoot, 'plain.md'), 'no frontmatter here\n', 'utf8');
    const reg = buildRegistry();
    const resolved = resolveFederatedPath({ vault: 'denis', relPath: 'plain.md' }, reg);
    const note = await readNoteJson(resolved);
    expect(note.frontmatter).toEqual({});
    expect(note.tags).toEqual([]);
  });

  it('throws ENOENT-translated error for missing files', async () => {
    const reg = buildRegistry();
    const resolved = resolveFederatedPath({ vault: 'denis', relPath: 'missing.md' }, reg);
    await expect(readNoteJson(resolved)).rejects.toThrow();
  });
});

describe('fsListNotes', () => {
  it('walks directories with depth and filters', async () => {
    await mkdir(join(tmpRoot, 'projects', 'sub'), { recursive: true });
    await writeFile(join(tmpRoot, 'README.md'), '# r\n', 'utf8');
    await writeFile(join(tmpRoot, 'notes.txt'), 'plain\n', 'utf8');
    await writeFile(join(tmpRoot, 'projects', 'a.md'), 'a\n', 'utf8');
    await writeFile(join(tmpRoot, 'projects', 'sub', 'deep.md'), 'd\n', 'utf8');

    const reg = buildRegistry();
    // depth=1 only sees the immediate directory
    const resolvedRoot = resolveFederatedPath({ vault: 'denis', relPath: '.' }, reg);
    const top = await fsListNotes(resolvedRoot, { depth: 1, entryCap: 100 });
    const topNames = top.entries.map((e) => e.path).sort();
    expect(topNames).toContain('README.md');
    expect(topNames).toContain('projects');
    // depth=1 should not surface `projects/a.md` or `projects/sub`
    expect(topNames.some((n) => n.startsWith('projects/'))).toBe(false);

    // Filter by extension
    const mdOnly = await fsListNotes(resolvedRoot, {
      depth: 5,
      extension: '.md',
      entryCap: 100,
    });
    const mdPaths = mdOnly.entries.filter((e) => e.type === 'file').map((e) => e.path);
    expect(mdPaths).toContain('README.md');
    expect(mdPaths).toContain('projects/a.md');
    expect(mdPaths).toContain('projects/sub/deep.md');
    expect(mdPaths).not.toContain('notes.txt');

    // nameRegex filters both files and directories
    const filtered = await fsListNotes(resolvedRoot, {
      depth: 5,
      nameRegex: /^projects$|\.md$/,
      entryCap: 100,
    });
    const names = filtered.entries.map((e) => e.path);
    expect(names).toContain('projects');
    expect(names).toContain('README.md');
    expect(names.includes('notes.txt')).toBe(false);
  });

  it('caps entries with cappedByEntries flag', async () => {
    for (let i = 0; i < 10; i++) {
      await writeFile(join(tmpRoot, `n${i}.md`), 'x\n', 'utf8');
    }
    const reg = buildRegistry();
    const resolved = resolveFederatedPath({ vault: 'denis', relPath: '.' }, reg);
    const res = await fsListNotes(resolved, { depth: 1, entryCap: 3 });
    expect(res.cappedByEntries).toBe(true);
    expect(res.entries.length).toBe(3);
  });

  it('skips dotfiles and dot-directories', async () => {
    await writeFile(join(tmpRoot, '.git'), 'fake\n', 'utf8');
    await mkdir(join(tmpRoot, '.obsidian'), { recursive: true });
    await writeFile(join(tmpRoot, 'visible.md'), 'v\n', 'utf8');
    const reg = buildRegistry();
    const resolved = resolveFederatedPath({ vault: 'denis', relPath: '.' }, reg);
    const res = await fsListNotes(resolved, { depth: 5, entryCap: 100 });
    const paths = res.entries.map((e) => e.path);
    expect(paths).toContain('visible.md');
    expect(paths.some((p) => p.startsWith('.'))).toBe(false);
  });
});
