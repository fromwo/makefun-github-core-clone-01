// objects.ts — the git object model: SHA-1 ids, tree/commit/tag codecs,
// reachability over the object graph, packfile reading/writing (plain,
// OFS_DELTA and REF_DELTA) and pkt-line framing.
//
// Everything here is pure and deterministic: no clock, no randomness, no
// I/O. Objects are content-addressed, so the same bytes always hash to the
// same id, and a pack built from the same object list in the same order is
// byte-identical every time.
//
// Node built-ins only (node:crypto, node:zlib). Erasable TypeScript.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const PKT_LINE_MAX = 65520;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

const OID_PATTERN = /^[0-9a-f]{40}$/;

/** True for a lowercase 40-hex object id. */
export function isObjectId(value: string): boolean {
  return OID_PATTERN.test(value);
}

/** git's object id: SHA-1 over "<type> <size>\0" followed by the raw bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const digest = createHash('sha1');
  digest.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  digest.update(data);
  return digest.digest('hex');
}

function sha1Hex(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex');
}

// --------------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries, in stored order. Throws on truncation. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) throw new Error('malformed tree: entry without a mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree: entry truncated');
    entries.push({
      mode: data.subarray(at, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    at = nul + 21;
  }
  return entries;
}

/**
 * git's tree sort key: a directory name compares as if it ended with '/'.
 * Comparing raw UTF-8 bytes keeps the order byte-exact.
 */
function treeSortKey(entry: { mode: string; name: string }): Buffer {
  return Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const ordered = [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  const chunks: Buffer[] = [];
  for (const entry of ordered) {
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    chunks.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

// -------------------------------------------------------------- commits/tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Split an object into its header lines and its message (after the blank line). */
function splitObjectText(data: Buffer): { headers: string[]; message: string } {
  const blank = data.indexOf('\n\n');
  const headEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  const text = data.subarray(0, headEnd).toString('utf8');
  return { headers: text === '' ? [] : text.split('\n'), message };
}

/** Parse a commit object. Unknown headers are ignored. */
export function parseCommit(data: Buffer): CommitView {
  const { headers, message } = splitObjectText(data);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of headers) {
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
  }
  return view;
}

export interface BuildCommitFields {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}

/**
 * Build a commit object's bytes. `author` / `committer` are "Name <email>"
 * identities; the timestamp and "+0000" zone are appended, so the result is
 * fully determined by the fields.
 */
export function buildCommit(fields: BuildCommitFields): Buffer {
  const stamp = `${fields.timestamp} +0000`;
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${stamp}`);
  lines.push(`committer ${fields.committer} ${stamp}`);
  lines.push('');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const { headers } = splitObjectText(data);
  const found = new Map<string, string>();
  for (const line of headers) {
    const space = line.indexOf(' ');
    if (space >= 0) found.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: found.get('object') ?? '',
    type: (found.get('type') ?? 'commit') as GitObjectType,
    tag: found.get('tag') ?? '',
    tagger: found.get('tagger') ?? '',
  };
}

// --------------------------------------------------------------- reachability

/**
 * Every object reachable from `roots`: a commit leads to its tree and its
 * parents, a tag to its target, a tree to its entries (gitlinks point at
 * another repository and are skipped), a blob to nothing. Throws on a
 * missing object unless `allowMissing` is set.
 */
export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup, allowMissing = false): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const root of roots) if (isObjectId(root)) stack.push(root);
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) {
      if (allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    }
  }
  return seen;
}

/** A commit's parents, or [] when the object is missing or not a commit. */
function parentIds(oid: string, lookup: ObjectLookup): string[] {
  const object = lookup(oid);
  if (object === undefined || object.type !== 'commit') return [];
  return parseCommit(object.data).parents;
}

/** True when `ancestor` equals `tip` or is reachable from it via parents. */
export function isAncestor(ancestor: string, tip: string, lookup: ObjectLookup): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>([tip]);
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    for (const parent of parentIds(oid, lookup)) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        stack.push(parent);
      }
    }
  }
  return false;
}

/**
 * A common ancestor of two commits, or null. Walks `a`'s whole ancestry
 * first, then breadth-first from `b` so the first hit is the closest one
 * to `b`.
 */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  const fromA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop() as string;
    if (fromA.has(oid)) continue;
    fromA.add(oid);
    for (const parent of parentIds(oid, lookup)) stackA.push(parent);
  }
  const seenB = new Set<string>();
  const queueB = [b];
  let head = 0;
  while (head < queueB.length) {
    const oid = queueB[head] as string;
    head += 1;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (fromA.has(oid)) return oid;
    for (const parent of parentIds(oid, lookup)) queueB.push(parent);
  }
  return null;
}

/**
 * Follow annotated tags to the commit underneath. A non-tag id is returned
 * unchanged; a missing object stops the walk at the id that could not be
 * resolved.
 */
export function peelToCommit(oid: string, lookup: ObjectLookup): string {
  let current = oid;
  for (let hops = 0; hops < 32; hops += 1) {
    const object = lookup(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// ------------------------------------------------------------------ tree maps

export interface FileEntry {
  mode: string;
  oid: string;
}

/** Flatten a tree to full-path -> file entry, recursing into directories. */
export function flattenTree(lookup: ObjectLookup, treeOid: string, prefix = ''): Map<string, FileEntry> {
  const out = new Map<string, FileEntry>();
  const object = lookup(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [sub, file] of flattenTree(lookup, entry.oid, path)) out.set(sub, file);
    } else if (entry.mode !== '160000') {
      out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
  return out;
}

interface DirNode {
  files: Map<string, FileEntry>;
  dirs: Map<string, DirNode>;
}

function newDir(): DirNode {
  return { files: new Map(), dirs: new Map() };
}

function compareNames(a: [string, unknown], b: [string, unknown]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/**
 * Build nested trees from a flat path map, storing every intermediate tree
 * through `put`. Returns the root tree oid; an empty map yields the empty
 * tree oid.
 */
export function buildTreeFromMap(
  files: Map<string, FileEntry>,
  put: (type: GitObjectType, data: Buffer) => string,
): string {
  const root = newDir();
  for (const [path, file] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i] as string;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = newDir();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, file);
  }
  const build = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of [...node.files.entries()].sort(compareNames)) {
      entries.push({ mode: file.mode, name, oid: file.oid });
    }
    for (const [name, child] of [...node.dirs.entries()].sort(compareNames)) {
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    return put('tree', buildTree(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------------- delta

/**
 * Apply a git delta to a base object's bytes. The delta is: a varint source
 * length, a varint target length, then copy-from-base and insert-literal
 * instructions. Throws on any malformed or out-of-range instruction.
 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (at >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[at] as number;
      at += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (at < delta.length) {
    const op = delta[at] as number;
    at += 1;
    if ((op & 0x80) !== 0) {
      // Copy from the base: the opcode's low bits say which offset/size
      // bytes follow (offset bytes first, then size bytes).
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          if (at >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset |= (delta[at] as number) << shift;
          at += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          if (at >= delta.length) throw new Error('delta copy size is truncated');
          copySize |= (delta[at] as number) << shift;
          at += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy runs past the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (at + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, at, at + literal);
      at += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

// ------------------------------------------------------------------- packfile

export interface PackReadResult {
  /** The resolved objects, in pack order (duplicates removed). */
  objects: GitObject[];
  /** The id of each entry in `objects`, in the same order. */
  oids: string[];
  version: number;
  declaredCount: number;
  deltaCount: number;
  checksumOk: boolean;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  payload: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** Read one pack-entry header: type in bits 4-6, size as a varint. */
function readEntryHeader(buf: Buffer, at: number): { size: number; typeCode: number; next: number } {
  if (at >= buf.length) throw new Error('pack entry has no size header');
  let byte = buf[at] as number;
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let pos = at + 1;
  while ((byte & 0x80) !== 0) {
    if (pos >= buf.length) throw new Error('pack entry size varint is truncated');
    byte = buf[pos] as number;
    pos += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, typeCode, next: pos };
}

/** Read an OFS_DELTA base offset (git's offset encoding: +1 per continuation). */
function readOfsBase(buf: Buffer, at: number): { baseOffset: number; next: number } {
  if (at >= buf.length) throw new Error('ofs-delta has no base offset');
  let byte = buf[at] as number;
  let pos = at + 1;
  let value = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    if (pos >= buf.length) throw new Error('ofs-delta base offset is truncated');
    byte = buf[pos] as number;
    pos += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: pos };
}

/**
 * Inflate the zlib stream starting at `at`; returns the bytes and the offset
 * just past the stream (Node reports how many input bytes were consumed).
 */
function inflateAt(buf: Buffer, at: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buf.subarray(at), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${at} did not inflate: ${(err as Error).message}`);
  }
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error(`zlib stream at offset ${at} consumed no bytes`);
  return { data: result.buffer, next: at + consumed };
}

const CODE_TO_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

class MissingBaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingBaseError';
  }
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including
 * OFS_DELTA and REF_DELTA. A REF_DELTA base may live inside the pack, in
 * `external`, or be a delta in the pack that resolves on a later pass.
 * Throws on a bad magic, an unsupported version, truncation, a zlib failure
 * or an unresolvable delta base. The trailer checksum is reported, not
 * thrown on, so the caller can decide what a mismatch means.
 */
export function readPack(pack: Buffer, external?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerAt = pack.length - 20;
  const checksumOk = pack.subarray(trailerAt).toString('hex') === sha1Hex(pack.subarray(0, trailerAt));

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let at = 12;
  for (let i = 0; i < declaredCount; i += 1) {
    const entryAt = at;
    const header = readEntryHeader(pack, at);
    at = header.next;
    const entry: RawPackEntry = { offset: entryAt, typeCode: header.typeCode, size: header.size, payload: Buffer.alloc(0) };
    if (header.typeCode === 6) {
      const base = readOfsBase(pack, at);
      at = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryAt) {
        throw new Error(`ofs-delta at ${entryAt} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryAt - base.baseOffset;
    } else if (header.typeCode === 7) {
      if (at + 20 > trailerAt) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(at, at + 20).toString('hex');
      at += 20;
    } else if (CODE_TO_TYPE[header.typeCode] === undefined) {
      throw new Error(`pack entry ${i} has unknown type code ${header.typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerAt), at);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryAt} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.payload = inflated.data;
    at = inflated.next;
    raw.push(entry);
    byOffset.set(entryAt, entry);
  }
  if (at !== trailerAt) throw new Error(`pack has ${trailerAt - at} stray bytes before its trailer`);

  // Resolved objects by id. A REF_DELTA whose base is itself a delta only
  // becomes resolvable once that base has resolved, so entries are retried
  // in passes until a pass makes no progress.
  const resolvedByOid = new Map<string, { type: GitObjectType; data: Buffer }>();
  const resolvedEntry = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
  const inFlight = new Set<number>();

  const resolveOne = (entry: RawPackEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    const done = resolvedEntry.get(entry.offset);
    if (done !== undefined) return done;
    if (inFlight.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    inFlight.add(entry.offset);
    try {
      let type: GitObjectType;
      let data: Buffer;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset as number);
        if (baseEntry === undefined) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
        const base = resolveOne(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.payload);
      } else if (entry.typeCode === 7) {
        const wanted = entry.baseOid as string;
        const inPack = resolvedByOid.get(wanted);
        if (inPack !== undefined) {
          type = inPack.type;
          data = applyDelta(inPack.data, entry.payload);
        } else {
          const outside = external?.(wanted);
          if (outside === undefined) throw new MissingBaseError(`ref-delta base ${wanted} is not in the pack`);
          type = outside.type;
          data = applyDelta(outside.data, entry.payload);
        }
      } else {
        type = CODE_TO_TYPE[entry.typeCode] as GitObjectType;
        data = entry.payload;
      }
      const oid = hashObject(type, data);
      const solved = { type, data, oid };
      resolvedEntry.set(entry.offset, solved);
      resolvedByOid.set(oid, solved);
      return solved;
    } finally {
      inFlight.delete(entry.offset);
    }
  };

  const pending = new Set<RawPackEntry>(raw);
  let deltaCount = 0;
  for (const entry of raw) if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
  for (;;) {
    let progressed = false;
    for (const entry of [...pending]) {
      try {
        resolveOne(entry);
        pending.delete(entry);
        progressed = true;
      } catch (err) {
        if (err instanceof MissingBaseError) continue;
        throw err;
      }
    }
    if (pending.size === 0) break;
    if (!progressed) {
      const stuck = [...pending][0] as RawPackEntry;
      throw new Error(`ref-delta base ${stuck.baseOid ?? '?'} is neither in the pack nor supplied`);
    }
  }

  const objects: GitObject[] = [];
  const oids: string[] = [];
  const seenOid = new Set<string>();
  for (const entry of raw) {
    const solved = resolvedEntry.get(entry.offset) as { type: GitObjectType; data: Buffer; oid: string };
    if (seenOid.has(solved.oid)) continue;
    seenOid.add(solved.oid);
    objects.push({ type: solved.type, data: solved.data });
    oids.push(solved.oid);
  }
  return { objects, oids, version, declaredCount, deltaCount, checksumOk };
}

/** Encode one object's pack header: type/size varint. */
function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = { commit: 1, tree: 2, blob: 3, tag: 4 }[type];
  const bytes: number[] = [];
  let rest = size;
  let first = (code << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a PACK v2 file from plain objects (no deltas, no thin pack, no
 * external bases). The order is the caller's; the trailer is the SHA-1 of
 * everything before it.
 */
export function writePack(objects: GitObject[]): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  chunks.push(header);
  for (const object of objects) {
    chunks.push(packObjectHeader(object.type, object.data.length));
    chunks.push(deflateSync(object.data));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ------------------------------------------------------------------- pkt-line

/** Encode one data packet: a 4-hex length prefix (payload + 4) then the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error('pkt-line payload too long');
  const head = Buffer.allocUnsafe(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

/** The flush packet, "0000". */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delim packet, "0001". */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  data: Buffer;
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Read one packet at `at`, or null when the bytes there are not a packet. */
function readOnePkt(buf: Buffer, at: number): { pkt: Pkt; next: number } | null {
  if (at + 4 > buf.length) return null;
  const head = buf.subarray(at, at + 4).toString('ascii');
  if (!HEX4.test(head)) return null;
  const len = Number.parseInt(head, 16);
  if (len === 0) return { pkt: { kind: 'flush', data: Buffer.alloc(0) }, next: at + 4 };
  if (len === 1) return { pkt: { kind: 'delim', data: Buffer.alloc(0) }, next: at + 4 };
  if (len === 2) return { pkt: { kind: 'response-end', data: Buffer.alloc(0) }, next: at + 4 };
  if (len < 4 || len > PKT_LINE_MAX || at + len > buf.length) return null;
  return { pkt: { kind: 'data', data: buf.subarray(at + 4, at + len) }, next: at + len };
}

/**
 * Decode pkt-lines from `buf` starting at `start`; stops after the first
 * flush/delim/response-end packet, at the end, or at the first undecodable
 * bytes. Never throws on malformed input.
 */
export function decodePktLines(buf: Buffer, start = 0): Pkt[] {
  const out: Pkt[] = [];
  let at = start;
  for (;;) {
    const read = readOnePkt(buf, at);
    if (read === null) return out;
    out.push(read.pkt);
    if (read.pkt.kind !== 'data') return out;
    at = read.next;
  }
}

/**
 * Decode every pkt-line in a buffer. `trailing` is whatever could not be
 * decoded as a packet — for a receive-pack body that is the packfile after
 * the command list's flush.
 */
export function decodeAllPktLines(buf: Buffer): { packets: Pkt[]; trailing: Buffer } {
  const packets: Pkt[] = [];
  let at = 0;
  for (;;) {
    const read = readOnePkt(buf, at);
    if (read === null) break;
    packets.push(read.pkt);
    at = read.next;
  }
  return { packets, trailing: buf.subarray(at) };
}
