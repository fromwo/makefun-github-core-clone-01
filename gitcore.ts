// gitcore.ts — git object model, packfile codec and pkt-line framing.
// Rewritten from the git object format spec (SHA-1 object ids, tree/commit/tag
// layouts, pack v2/v3, delta application, pkt-line framing). Node built-ins only.

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

const TYPE_TO_CODE: Record<GitObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};
const CODE_TO_TYPE: Record<number, GitObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

const OID_RE = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return OID_RE.test(value);
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const digest = createHash('sha1');
  digest.update(`${type} ${data.length}\0`, 'utf8');
  digest.update(data);
  return digest.digest('hex');
}

function sha1Of(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex');
}

// ------------------------------------------------------------------ trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    if (sp === -1) throw new Error('malformed tree: entry without mode');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul === -1 || nul + 21 > data.length) throw new Error('malformed tree: entry truncated');
    entries.push({
      mode: data.subarray(pos, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    pos = nul + 21;
  }
  return entries;
}

// Git sorts tree entries by name, treating a directory name as if it ended
// with '/'. Compare raw UTF-8 bytes so the order is byte-exact.
function treeSortKey(entry: { mode: string; name: string }): Buffer {
  return Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const ordered = [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  const chunks: Buffer[] = [];
  for (const entry of ordered) {
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    chunks.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------- commits/tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function splitHeaders(data: Buffer): { headers: string[]; message: string } {
  const sep = data.indexOf('\n\n');
  const headEnd = sep < 0 ? data.length : sep;
  const message = sep < 0 ? '' : data.subarray(sep + 2).toString('utf8');
  const text = data.subarray(0, headEnd).toString('utf8');
  return { headers: text === '' ? [] : text.split('\n'), message };
}

export function parseCommit(data: Buffer): CommitView {
  const { headers, message } = splitHeaders(data);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of headers) {
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
  }
  return view;
}

export interface BuildCommitFields {
  tree: string;
  parents?: string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
  timezone?: string;
}

export function buildCommit(fields: BuildCommitFields): Buffer {
  const tz = fields.timezone ?? '+0000';
  const head: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) head.push(`parent ${parent}`);
  head.push(`author ${fields.author} ${fields.timestamp} ${tz}`);
  head.push(`committer ${fields.committer} ${fields.timestamp} ${tz}`);
  // Header block, blank line, then the message verbatim.
  return Buffer.from(`${head.join('\n')}\n\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const { headers, message } = splitHeaders(data);
  const found = new Map<string, string>();
  for (const line of headers) {
    const sp = line.indexOf(' ');
    if (sp >= 0) found.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: found.get('object') ?? '',
    type: (found.get('type') ?? 'commit') as GitObjectType,
    tag: found.get('tag') ?? '',
    tagger: found.get('tagger') ?? '',
    message,
  };
}

// --------------------------------------------------------------- reachability

export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup, allowMissing = false): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const root of roots) {
    if (isObjectId(root)) stack.push(root);
  }
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
        // Skip gitlinks: they point at another repository's objects.
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    }
  }
  return seen;
}

function commitParents(oid: string, lookup: ObjectLookup): string[] {
  const object = lookup(oid);
  if (object === undefined || object.type !== 'commit') return [];
  return parseCommit(object.data).parents;
}

/** True when `ancestor` is reachable from `tip` (or equal to it) through commit parents. */
export function isAncestor(ancestor: string, tip: string, lookup: ObjectLookup): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>([tip]);
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    for (const parent of commitParents(oid, lookup)) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        stack.push(parent);
      }
    }
  }
  return false;
}

/** The nearest common ancestor of two commits, or null. */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  const fromA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop() as string;
    if (fromA.has(oid)) continue;
    fromA.add(oid);
    for (const parent of commitParents(oid, lookup)) stackA.push(parent);
  }
  const seenB = new Set<string>();
  const stackB = [b];
  while (stackB.length > 0) {
    const oid = stackB.pop() as string;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (fromA.has(oid)) return oid;
    for (const parent of commitParents(oid, lookup)) stackB.push(parent);
  }
  return null;
}

/** Peel an annotated tag to the commit it points at (following tag chains). */
export function peelToCommit(oid: string, lookup: ObjectLookup): string {
  let current = oid;
  for (let hops = 0; hops < 10; hops += 1) {
    const object = lookup(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// ----------------------------------------------------------------- tree maps

export interface FileEntry {
  mode: string;
  oid: string;
}

/** Flatten a tree to path -> file entry (files only, recursive). */
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

function emptyNode(): DirNode {
  return { files: new Map(), dirs: new Map() };
}

function byName(a: [string, unknown], b: [string, unknown]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/**
 * Build a tree from a flat path map, storing every intermediate tree through `put`.
 * Returns the root tree oid.
 */
export function buildTreeFromMap(
  files: Map<string, FileEntry>,
  put: (type: GitObjectType, data: Buffer) => string,
): string {
  const root = emptyNode();
  for (const [path, file] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i] as string;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = emptyNode();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, file);
  }
  const build = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of [...node.files.entries()].sort(byName)) {
      entries.push({ mode: file.mode, name, oid: file.oid });
    }
    for (const [name, child] of [...node.dirs.entries()].sort(byName)) {
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    return put('tree', buildTree(entries));
  };
  return build(root);
}

// ------------------------------------------------------------------ packfile

// Pack object header: type in bits 4-6 of the first byte, size as a
// little-endian varint with 4 bits in the first byte and 7 in each following.
function parsePackHeader(buf: Buffer, at: number): { size: number; typeCode: number; next: number } {
  let byte = buf[at] as number;
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let pos = at + 1;
  while ((byte & 0x80) !== 0) {
    byte = buf[pos] as number;
    pos += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, typeCode, next: pos };
}

// OFS_DELTA base offset: each byte contributes 7 bits, with +1 per
// continuation byte (the git "offset encoding").
function parseOfsBase(buf: Buffer, at: number): { baseOffset: number; next: number } {
  let byte = buf[at] as number;
  let pos = at + 1;
  let value = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    byte = buf[pos] as number;
    pos += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: pos };
}

// Inflate the zlib stream at `at`; returns the data and the offset just past
// the stream (Node reports how many input bytes the inflater consumed).
function inflateStream(buf: Buffer, at: number): { data: Buffer; next: number } {
  const result = inflateSync(buf.subarray(at), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: at + result.engine.bytesWritten };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] as number;
      pos += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if ((op & 0x80) !== 0) {
      // Copy from the base: offset/size bytes selected by the opcode bits.
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          copyOffset |= (delta[pos] as number) << shift;
          pos += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          copySize |= (delta[pos] as number) << shift;
          pos += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, pos, pos + literal);
      pos += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackReadResult {
  version: number;
  declaredCount: number;
  objects: Map<string, GitObject>;
  deltaCount: number;
  checksumOk: boolean;
}

interface PackEntry {
  offset: number;
  typeCode: number;
  size: number;
  payload: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: GitObjectType;
  resolvedData?: Buffer;
  oid?: string;
}

/** Read a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA against the pack itself. `external` supplies objects the pack may delta against but does not carry (a thin push pack deltas against objects the server already holds). */
export function readPack(pack: Buffer, external?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerAt = pack.length - 20;
  const checksumOk = pack.subarray(trailerAt).toString('hex') === sha1Of(pack.subarray(0, trailerAt));

  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let pos = 12;
  for (let i = 0; i < declaredCount; i += 1) {
    const entryAt = pos;
    const header = parsePackHeader(pack, pos);
    pos = header.next;
    const entry: PackEntry = { offset: entryAt, typeCode: header.typeCode, size: header.size, payload: Buffer.alloc(0) };
    if (header.typeCode === 6) {
      const base = parseOfsBase(pack, pos);
      pos = base.next;
      entry.baseOffset = entryAt - base.baseOffset;
    } else if (header.typeCode === 7) {
      entry.baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else if (CODE_TO_TYPE[header.typeCode] === undefined) {
      throw new Error(`pack entry ${i} has unknown type code ${header.typeCode}`);
    }
    const inflated = inflateStream(pack.subarray(0, trailerAt), pos);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryAt} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.payload = inflated.data;
    pos = inflated.next;
    entries.push(entry);
    byOffset.set(entryAt, entry);
  }

  // Plain entries first, so a delta can resolve against one regardless of order.
  const byOid = new Map<string, PackEntry>();
  for (const entry of entries) {
    if (entry.typeCode === 6 || entry.typeCode === 7) continue;
    const type = CODE_TO_TYPE[entry.typeCode] as GitObjectType;
    entry.resolvedType = type;
    entry.resolvedData = entry.payload;
    entry.oid = hashObject(type, entry.payload);
    byOid.set(entry.oid, entry);
  }

  const inProgress = new Set<number>();
  const resolve = (entry: PackEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolvedType !== undefined && entry.resolvedData !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolvedData, oid: entry.oid };
    }
    if (inProgress.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    inProgress.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.payload);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const inPack = byOid.get(wanted);
      if (inPack !== undefined) {
        const base = resolve(inPack);
        type = base.type;
        data = applyDelta(base.data, entry.payload);
      } else {
        const outside = external?.(wanted);
        if (outside === undefined) throw new Error(`ref-delta base ${wanted} is not in the pack`);
        type = outside.type;
        data = applyDelta(outside.data, entry.payload);
      }
    } else {
      type = CODE_TO_TYPE[entry.typeCode] as GitObjectType;
      data = entry.payload;
    }
    const oid = hashObject(type, data);
    entry.resolvedType = type;
    entry.resolvedData = data;
    entry.oid = oid;
    byOid.set(oid, entry);
    inProgress.delete(entry.offset);
    return { type, data, oid };
  };

  const objects = new Map<string, GitObject>();
  let deltaCount = 0;
  for (const entry of entries) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { version, declaredCount, objects, deltaCount, checksumOk };
}

function packHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_TO_CODE[type];
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

/** Build a packfile from plain objects (no deltas). Order is the caller's. */
export function writePack(objects: GitObject[]): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  chunks.push(header);
  for (const object of objects) {
    chunks.push(packHeader(object.type, object.data.length));
    chunks.push(deflateSync(object.data));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ------------------------------------------------------------------ pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error('pkt-line payload too long');
  const head = Buffer.allocUnsafe(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
  /** Byte offset just past this packet in the source buffer. */
  end: number;
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

function readOnePkt(buf: Buffer, at: number): { pkt: Pkt; next: number } | null {
  if (at + 4 > buf.length) return null;
  const head = buf.subarray(at, at + 4).toString('ascii');
  if (!HEX4.test(head)) return null;
  const len = Number.parseInt(head, 16);
  if (len === 0) return { pkt: { kind: 'flush', payload: Buffer.alloc(0), end: at + 4 }, next: at + 4 };
  if (len === 1) return { pkt: { kind: 'delim', payload: Buffer.alloc(0), end: at + 4 }, next: at + 4 };
  if (len === 2) return { pkt: { kind: 'response-end', payload: Buffer.alloc(0), end: at + 4 }, next: at + 4 };
  if (len < 4 || len > PKT_LINE_MAX || at + len > buf.length) return null;
  return { pkt: { kind: 'data', payload: buf.subarray(at + 4, at + len), end: at + len }, next: at + len };
}

/** Decode pkt-lines from `buf` starting at `start`; stops at the first flush/delim/response-end or the end. */
export function decodePktLines(buf: Buffer, start = 0): Pkt[] {
  const out: Pkt[] = [];
  let pos = start;
  for (;;) {
    const read = readOnePkt(buf, pos);
    if (read === null) return out;
    out.push(read.pkt);
    if (read.pkt.kind !== 'data') return out;
    pos = read.next;
  }
}

/** Decode ALL pkt-lines in a buffer (a whole request body section), tolerating trailing raw bytes. */
export function decodeAllPktLines(buf: Buffer): { packets: Pkt[]; trailing: Buffer } {
  const packets: Pkt[] = [];
  let pos = 0;
  for (;;) {
    const read = readOnePkt(buf, pos);
    if (read === null) break;
    packets.push(read.pkt);
    pos = read.next;
  }
  return { packets, trailing: buf.subarray(pos) };
}
