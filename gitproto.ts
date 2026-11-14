// gitproto.ts — git smart HTTP: ref advertisements, protocol v2 ls-refs/fetch,
// protocol v0 upload-pack, and receive-pack pushes. Framing over the store only.

import {
  ZERO_OID,
  decodeAllPktLines,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  writePack,
} from './gitcore.ts';
import type { GitObject } from './gitcore.ts';
import { collectReachable, isAncestor, peelToCommit } from './gitcore.ts';
import type { Forge, Repo } from './store.ts';

const AGENT = 'forge/1.0';
const SIDEBAND_CHUNK = 65515;

interface RefRow {
  name: string;
  oid: string;
  peeled?: string;
}

function listRefs(repo: Repo): RefRow[] {
  const rows: RefRow[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const row: RefRow = { name, oid };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (target !== oid) row.peeled = peelToCommit(oid, (id) => repo.objects.get(id));
    }
    rows.push(row);
  }
  return rows;
}

function defaultTip(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.default_branch}`) ?? '';
}

type ServiceName = 'git-upload-pack' | 'git-receive-pack';

function capabilityLine(repo: Repo, service: ServiceName): string {
  const caps =
    service === 'git-receive-pack'
      ? 'report-status report-status-v2 side-band-64k delete-refs ofs-delta'
      : 'side-band-64k thin-pack ofs-delta multi_ack shallow';
  return `${caps} agent=${AGENT} symref=HEAD:refs/heads/${repo.default_branch}`;
}

/** The v0 ref advertisement body (with the `# service=` preamble). */
export function advertisementV0(repo: Repo, service: ServiceName): Buffer {
  const caps = capabilityLine(repo, service);
  const out: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = listRefs(repo);
  if (refs.length === 0) {
    out.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = defaultTip(repo);
    out.push(pktLine(`${head !== '' ? head : (refs[0] as RefRow).oid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      out.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) out.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

/** The protocol v2 capability advertisement body (with the `# service=` preamble). */
export function advertisementV2(service: 'git-upload-pack'): Buffer {
  return Buffer.concat([
    pktLine(`# service=${service}\n`),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    pktFlush(),
  ]);
}

// ------------------------------------------------------------ fetch helpers

/** Reachable objects from `roots`, stopping at (not crossing) shallow boundary commits. */
function reachablePastBoundary(repo: Repo, roots: string[], boundaries: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const root of roots) {
    if (isObjectId(root)) stack.push(root);
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!boundaries.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
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

/**
 * Commits reachable from `roots` within `depth` generations (depth 1 = the
 * tips only), with each commit's distance in generations from the nearest
 * root (0 = a root). Expands each included commit to its tree and blobs.
 */
function reachableWithinDepth(
  repo: Repo,
  roots: string[],
  depth: number,
): { target: Set<string>; distances: Map<string, number> } {
  const commits = new Set<string>();
  const distances = new Map<string, number>();
  const queue: { oid: string; d: number }[] = [];
  for (const root of roots) {
    const peeled = peelToCommit(root, (id) => repo.objects.get(id));
    if (isObjectId(peeled)) queue.push({ oid: peeled, d: 0 });
  }
  const visited = new Set<string>();
  while (queue.length > 0) {
    const { oid, d } = queue.shift() as { oid: string; d: number };
    if (visited.has(oid)) continue;
    visited.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    commits.add(oid);
    distances.set(oid, d);
    if (d + 1 < depth) {
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, d: d + 1 });
    }
  }
  const target = new Set<string>();
  for (const oid of commits) {
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    target.add(oid);
    const commit = parseCommit(object.data);
    for (const sub of collectReachable([commit.tree], (id) => repo.objects.get(id), true)) target.add(sub);
  }
  for (const root of roots) {
    const object = repo.objects.get(root);
    if (object !== undefined && object.type === 'tag') target.add(root);
  }
  return { target, distances };
}

// Pack bytes are a pure function of the packed objects, and git objects are
// content-addressed and immutable, so a cache keyed by the sorted oid list is
// sound across repositories and time. The clone workload fetches the same tip
// fifty times concurrently; rebuilding (re-deflating) that pack each time is
// its whole cost.
const PACK_CACHE = new Map<string, Buffer>();
const PACK_CACHE_LIMIT = 32;

function packObjects(repo: Repo, oids: string[]): Buffer {
  const present = oids.filter((oid) => repo.objects.has(oid));
  const key = [...present].sort().join(',');
  const hit = PACK_CACHE.get(key);
  if (hit !== undefined) return hit;
  const objects: GitObject[] = [];
  for (const oid of present) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  const pack = writePack(objects);
  if (PACK_CACHE.size >= PACK_CACHE_LIMIT) {
    const oldest = PACK_CACHE.keys().next().value;
    if (oldest !== undefined) PACK_CACHE.delete(oldest);
  }
  PACK_CACHE.set(key, pack);
  return pack;
}

function packIntoSideband(pack: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  for (let at = 0; at < pack.length; at += SIDEBAND_CHUNK) {
    const piece = pack.subarray(at, Math.min(pack.length, at + SIDEBAND_CHUNK));
    frames.push(pktLine(Buffer.concat([Buffer.from([1]), piece])));
  }
  return frames;
}

function sidebandWrap(payload: Buffer): Buffer {
  const frames: Buffer[] = [];
  for (let at = 0; at < payload.length; at += SIDEBAND_CHUNK) {
    const piece = payload.subarray(at, Math.min(payload.length, at + SIDEBAND_CHUNK));
    frames.push(pktLine(Buffer.concat([Buffer.from([1]), piece])));
  }
  frames.push(pktFlush());
  return Buffer.concat(frames);
}

// --------------------------------------------------------------- info/refs

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function notFound(): GitResponse {
  return { status: 404, contentType: 'text/plain', body: Buffer.from('Not Found\n') };
}

export function handleInfoRefs(
  forge: Forge,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string | undefined,
): GitResponse {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertisementV2('git-upload-pack') };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertisementV0(repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: advertisementV0(repo, 'git-receive-pack') };
  }
  return notFound();
}

// ------------------------------------------------------------- upload-pack

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function readRequestLines(body: Buffer): { lines: string[]; ok: boolean } {
  const { packets } = decodeAllPktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return { lines, ok: packets.length > 0 };
}

function handleLsRefs(repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of lines) {
    const text = raw.replace(/\n$/, '');
    if (text.startsWith('command=') || text.startsWith('agent=') || text.startsWith('object-format=')) continue;
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const wanted = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const head = defaultTip(repo);
  if (symrefs && wanted('HEAD')) {
    if (head !== '') {
      out.push(pktLine(`${head} HEAD symref-target:refs/heads/${repo.default_branch}\n`));
    } else if (unborn) {
      out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.default_branch}\n`));
    }
  }
  for (const ref of listRefs(repo)) {
    if (!wanted(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    out.push(pktLine(`${line}\n`));
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

function parseFetchArgs(lines: string[]): FetchRequest {
  const args: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const raw of lines) {
    const text = raw.replace(/\n$/, '');
    if (text === '' || text.startsWith('command=')) continue;
    if (text.startsWith('agent=') || text.startsWith('object-format=')) continue;
    if (text === 'thin-pack' || text === 'no-progress' || text === 'ofs-delta') continue;
    if (text.startsWith('want ')) args.wants.push(text.slice(5).split(' ')[0] as string);
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).split(' ')[0] as string);
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7), 10);
      if (Number.isFinite(n)) args.depth = n;
    } else if (text.startsWith('deepen-since ') || text.startsWith('deepen-not ') || text.startsWith('filter ')) {
      // Accepted and ignored: the fetch still returns the full wanted set.
    }
    // 'done' and anything else carry no state for this handler.
  }
  return args;
}

function handleFetch(repo: Repo, lines: string[], version: 2 | 0): Buffer {
  const args = parseFetchArgs(lines);
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const boundaries = new Set(args.shallow);
  const alreadyHeld = reachablePastBoundary(repo, args.haves, boundaries);

  let target: Set<string>;
  let distances = new Map<string, number>();
  if (args.depth !== null) {
    const limited = reachableWithinDepth(repo, args.wants, args.depth);
    target = limited.target;
    distances = limited.distances;
  } else {
    target = collectReachable(args.wants, lookup, true);
  }
  const toSend = [...target].filter((oid) => !alreadyHeld.has(oid));

  // New shallow boundaries, only for a depth-limited fetch: a commit in the
  // target whose parent falls outside it, plus a root commit sitting exactly
  // at the depth cutoff (a depth-1 fetch of a one-commit history is still a
  // shallow clone; a depth that covers the whole history marks nothing).
  const shallowList: string[] = [];
  if (args.depth !== null) {
    for (const oid of target) {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => !target.has(parent))) shallowList.push(oid);
      else if (parents.length === 0 && distances.get(oid) === args.depth - 1) shallowList.push(oid);
    }
  }
  // Boundaries the client already had that are now fully included stop being
  // shallow: report them as unshallow.
  const unshallowList: string[] = [];
  for (const boundary of args.shallow) {
    if (!target.has(boundary)) continue;
    const object = repo.objects.get(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => target.has(parent))) unshallowList.push(boundary);
  }

  const pack = packObjects(repo, toSend);
  if (version === 2) {
    const parts: Buffer[] = [];
    // A client only reads an acknowledgments section when it sent haves;
    // with no haves it expects the packfile (or shallow-info) section next,
    // and a stray acknowledgments header aborts the fetch. When haves were
    // sent, the section ends with "ready".
    if (args.haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktLine('ready\n'), pktDelim());
    }
    if (shallowList.length > 0 || unshallowList.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of shallowList) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallowList) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktDelim());
    }
    // The packfile section is always present, even when nothing is new: the
    // client reads the section header next, and a flush in its place aborts
    // the fetch. With no new objects the pack is a valid empty one.
    parts.push(pktLine('packfile\n'));
    parts.push(...packIntoSideband(pack));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }

  // v0: NAK / shallow lines as plain packets, then the sideband pack (an
  // empty pack when nothing is new, for the same reason as above).
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of shallowList) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallowList) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...packIntoSideband(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleUploadPack(
  forge: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocol: string | undefined,
): GitResponse {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  const { lines, ok } = readRequestLines(body);
  if (!ok) return { status: 400, contentType: 'text/plain', body: Buffer.from('bad request\n') };
  const commandLine = lines.find((line) => line.startsWith('command='));
  const command = commandLine === undefined ? '' : commandLine.slice('command='.length).trim();
  const version: 2 | 0 = gitProtocol === 'version=2' ? 2 : 0;
  if (command === 'ls-refs') {
    if (version !== 2) return { status: 400, contentType: 'text/plain', body: Buffer.from('ls-refs needs protocol v2\n') };
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleLsRefs(repo, lines) };
  }
  if (command === 'fetch' || command === '') {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleFetch(repo, lines, version) };
  }
  return { status: 400, contentType: 'text/plain', body: Buffer.from(`unknown command ${command}\n`) };
}

// ------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushCommands(body: Buffer): { commands: PushCommand[]; trailing: Buffer; sawFlush: boolean } {
  const { packets, trailing } = decodeAllPktLines(body);
  const commands: PushCommand[] = [];
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  return { commands, trailing, sawFlush };
}

interface RefOutcome {
  ref: string;
  ok: boolean;
  reason: string;
}

export function handleReceivePack(forge: Forge, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  const { commands, trailing, sawFlush } = parsePushCommands(body);
  if (!sawFlush || commands.length === 0) {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('bad request\n') };
  }

  // Unpack first: a pack that fails to unpack refuses every ref.
  let unpackOk = true;
  if (commands.some((command) => command.newOid !== ZERO_OID)) {
    if (trailing.length === 0) {
      unpackOk = false;
    } else {
      try {
        const read = readPack(trailing, (id) => repo.objects.get(id));
        if (!read.checksumOk) {
          unpackOk = false;
        } else {
          for (const [oid, object] of read.objects) {
            if (!repo.objects.has(oid)) repo.objects.set(oid, object);
          }
        }
      } catch {
        unpackOk = false;
      }
    }
  }

  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const results: RefOutcome[] = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else if (!repo.objects.has(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'missing object' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update: old must match the current tip, the new object must exist,
    // and a branch update must fast-forward.
    if (current === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
    } else if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'missing object' });
    } else {
      let fastForward = true;
      if (command.ref.startsWith('refs/heads/')) {
        const newCommit = peelToCommit(command.newOid, lookup);
        const oldCommit = peelToCommit(command.oldOid, lookup);
        fastForward = isAncestor(oldCommit, newCommit, lookup);
      }
      if (!fastForward) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
    }
  }

  const reportLines: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : 'unpack error\n')];
  for (const result of results) {
    reportLines.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  // With side-band-64k the report-status stream is itself pkt-lined inside
  // band 1, including its own terminating flush: without it the client waits
  // for more report lines and reports that the remote hung up.
  reportLines.push(pktFlush());
  return {
    status: 200,
    contentType: 'application/x-git-receive-pack-result',
    body: sidebandWrap(Buffer.concat(reportLines)),
  };
}
