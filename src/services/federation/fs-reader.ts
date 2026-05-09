/**
 * @fileoverview Filesystem-direct readers for federated (cross-vault) reads.
 * Federation registry stores filesystem paths per vault; cross-vault calls
 * bypass the Obsidian Local REST API (which is single-vault per process) and
 * read straight from disk. Returns shapes compatible with the REST API
 * service so tool handlers can stay format-agnostic.
 *
 * Scope is intentionally read-only: federated writes would need per-vault
 * REST API endpoints (one Obsidian app per vault, per port), which the
 * registry does not declare. Writes stay self-vault-only via the REST path.
 *
 * @module services/federation/fs-reader
 */

import { type Dirent, promises as fs, type Stats } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import type { NoteJson } from '../obsidian/types.js';
import type { ResolvedFederatedPath } from './resolve.js';

/**
 * Read one note from the resolved federated path. Mirrors the shape returned
 * by `ObsidianService.getNoteJson` — the tool handler does not need to know
 * which transport sourced the note.
 */
export async function readNoteJson(resolved: ResolvedFederatedPath): Promise<NoteJson> {
  const stat = await fs.stat(resolved.absPath);
  if (!stat.isFile()) {
    throw new FsReadError('not_a_file', `'${resolved.relPath}' is not a regular file`);
  }
  const content = await fs.readFile(resolved.absPath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(content);
  const tags = collectTags(frontmatter, body);
  return {
    content,
    frontmatter,
    path: resolved.relPath,
    stat: { ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size },
    tags,
  };
}

export async function readNoteContent(resolved: ResolvedFederatedPath): Promise<string> {
  const stat = await fs.stat(resolved.absPath);
  if (!stat.isFile()) {
    throw new FsReadError('not_a_file', `'${resolved.relPath}' is not a regular file`);
  }
  return fs.readFile(resolved.absPath, 'utf8');
}

export interface FederatedDirEntry {
  path: string;
  type: 'file' | 'directory';
}

/**
 * List notes under a federated directory. Recurses up to `depth` levels (1 =
 * just the immediate directory). Caller enforces an entry cap.
 *
 * Filters: `extension` (with leading dot, lower-case) and `nameRegex`.
 */
export async function listNotes(
  resolved: ResolvedFederatedPath,
  opts: {
    depth: number;
    extension?: string | undefined;
    nameRegex?: RegExp | undefined;
    entryCap: number;
  },
): Promise<{ entries: FederatedDirEntry[]; cappedByEntries: boolean }> {
  const stat = await fs.stat(resolved.absPath);
  if (!stat.isDirectory()) {
    throw new FsReadError('not_a_directory', `'${resolved.relPath}' is not a directory`);
  }
  const entries: FederatedDirEntry[] = [];
  let cappedByEntries = false;
  const vaultRoot = resolved.absPath; // anchor relative paths to the listed dir
  const baseRel = resolved.relPath.replace(/\/+$/, '');

  async function walk(absDir: string, currentDepth: number): Promise<void> {
    if (cappedByEntries) return;
    let dirents: Dirent[] = [];
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // directory disappeared mid-walk — silently skip
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      if (cappedByEntries) return;
      const name = dirent.name;
      if (name.startsWith('.')) continue; // skip dotfiles + .git etc.
      if (opts.nameRegex && !opts.nameRegex.test(name)) {
        // Apply nameRegex symmetrically to files and directories — directories
        // that fail the regex are skipped entirely (no recursion). Matches
        // upstream `obsidian_list_notes` semantics.
        continue;
      }
      const absChild = join(absDir, name);
      const relChild = relativePosix(vaultRoot, absChild, baseRel);
      let childStat: Stats;
      try {
        childStat = await fs.stat(absChild);
      } catch {
        continue;
      }
      if (childStat.isDirectory()) {
        entries.push({ path: relChild, type: 'directory' });
        if (entries.length >= opts.entryCap) {
          cappedByEntries = true;
          return;
        }
        if (currentDepth < opts.depth) {
          await walk(absChild, currentDepth + 1);
        }
      } else if (childStat.isFile()) {
        if (opts.extension !== undefined) {
          const ext = extname(name).toLowerCase();
          if (ext !== opts.extension) continue;
        }
        entries.push({ path: relChild, type: 'file' });
        if (entries.length >= opts.entryCap) {
          cappedByEntries = true;
          return;
        }
      }
    }
  }

  await walk(vaultRoot, 1);
  return { entries, cappedByEntries };
}

function relativePosix(root: string, abs: string, prefix: string): string {
  const rel = relative(root, abs).split(sep).join('/');
  if (prefix === '') return rel;
  return `${prefix}/${rel}`;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

interface ParsedFrontmatter {
  body: string;
  frontmatter: Record<string, unknown>;
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const m = FRONTMATTER_RE.exec(content);
  if (m === null) return { frontmatter: {}, body: content };
  const yamlText = m[1] ?? '';
  const body = m[2] ?? '';
  let parsed: unknown;
  try {
    parsed = yamlLoad(yamlText);
  } catch {
    return { frontmatter: {}, body };
  }
  if (
    parsed === null ||
    parsed === undefined ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    return { frontmatter: {}, body };
  }
  return { frontmatter: parsed as Record<string, unknown>, body };
}

const INLINE_TAG_RE = /(^|\s)#([\p{L}\p{N}_/-]+)/gu;

function collectTags(frontmatter: Record<string, unknown>, body: string): string[] {
  const out = new Set<string>();
  const fmTags = frontmatter.tags;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) {
      if (typeof t === 'string' && t.trim() !== '') out.add(stripHash(t));
    }
  } else if (typeof fmTags === 'string' && fmTags.trim() !== '') {
    for (const t of fmTags.split(/[,\s]+/)) {
      if (t !== '') out.add(stripHash(t));
    }
  }
  for (const m of body.matchAll(INLINE_TAG_RE)) {
    const tag = m[2];
    if (tag !== undefined && tag !== '') out.add(tag);
  }
  return [...out];
}

function stripHash(t: string): string {
  return t.startsWith('#') ? t.slice(1) : t;
}

export class FsReadError extends Error {
  readonly kind: 'not_a_file' | 'not_a_directory' | 'not_found';
  constructor(kind: FsReadError['kind'], message: string) {
    super(message);
    this.name = 'FsReadError';
    this.kind = kind;
  }
}
