/**
 * @fileoverview Public surface for federation: prefix detection + resolution
 * + filesystem readers. Tool handlers should import from this barrel only.
 * @module services/federation
 */

export {
  type FederatedDirEntry,
  FsReadError,
  listNotes as fsListNotes,
  readNoteContent,
  readNoteJson,
} from './fs-reader.js';
export {
  getFederationRegistry,
  getFederationRegistryPath,
  getLoadedRegistryPath,
  parseRegistry,
  reloadFederationRegistry,
  resetFederationRegistry,
} from './registry.js';
export {
  FederationResolveError,
  parsePrefix,
  type ResolvedFederatedPath,
  type ResolveError,
  resolveFederatedPath,
} from './resolve.js';
export type { FederationRegistry, PrefixParse, VaultEntry, VaultKind } from './types.js';
