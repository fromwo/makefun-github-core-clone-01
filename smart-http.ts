// smart-http.ts — git smart HTTP: info/refs advertisements, upload-pack
// (protocol v2 ls-refs/fetch plus the v0 fallback) and receive-pack v0.
//
// The handlers work over the store only (Forge/Repo from ./forge.ts): refs
// live in repo.refs, objects in repo.objects. Nothing here touches the
// clock, randomness or the network, and no handler throws for a bad request
// body — a malformed body is a 400, a missing repository a 404, and the
// process keeps serving afterwards.
//
// Node built-ins only. Erasable TypeScript; every import carries .ts.

import {
  ZERO_OID,
  collectReachable,
  decodeAllPktLines,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  writePack,
} from './objects.ts';
import type { GitObject } from './objects.ts';
import type { Forge, Repo } from './forge.ts';

const AGENT = 'forge/1.0';
/** Largest pack payload one sideband frame may carry (65520 - 4 - 1). */
const SIDEBAND_CHUNK = 65515;
/** How many distinct packs the pack cache keeps (content-addressed, so safe). */
const PACK_CACHE_LIMIT = 32;

export type ServiceName = 'git-upload-pack' | 'git-receive-pack';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function jsonError(status: number, message: string): GitResponse {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

function repoMissing(): GitResponse {
  return jsonError(404, 'repository not found');
}

// ------------------------------------------------------------- advertisements

interface RefRow {
  name: string;
  oid: string;
  peeled?: string;
}

/** Every ref, sorted by name, with an annotated tag's peeled commit attached. */
function refRows(repo: Repo): RefRow[] {
  const rows: RefRow[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const row: RefRow = { name, oid };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = peelToCommit(oid, (id) => repo.objects.get(id));
      if (peeled !== oid) row.peeled = peeled;
    }
    rows.push(row);
  }
  return rows;
}

/** The tip of the default branch, or '' when the repo has no such ref. */
function defaultTip(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.default_branch}`) ?? '';
}

function capabilityText(repo: Repo, service: ServiceName): string {
  const shared = `agent=${AGENT} symref=HEAD:refs/heads/${repo.default_branch}`;
  if (service === 'git-receive-pack') {
    return `report-status report-status-v2 side-band-64k delete-refs ofs-delta ${shared}`;
  }
  return `multi_ack_detailed multi_ack side-band-64k thin-pack ofs-delta shallow ${shared}`;
}

/**
 * The v0 ref advertisement: "# service=..." preamble, a flush, then one
 * pkt-line per ref — the first line carries the capabilities after a NUL.
 * An empty repository advertises the zero-oid capabilities^{} pseudo-ref.
 */
export function advertisementV0(repo: Repo, service: ServiceName): Buffer {
  const caps = capabilityText(repo, service);
  const out: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = refRows(repo);
  if (refs.length === 0) {
    out.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = defaultTip(repo);
    const headOid = head !== '' ? head : (refs[0] as RefRow).oid;
    out.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      out.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) out.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

/**
 * The protocol v2 capability advertisement. It opens with "version 2"
 * (no service preamble) and lists ls-refs (with unborn), fetch (with
 * shallow), the object format and the agent.
 */
export function advertisementV2(service: 'git-upload-pack'): Buffer {
  void service;
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    pktFlush(),
  ]);
}

// ----------------------------------------------------------------- info/refs

/**
 * GET /{owner}/{repo}.git/info/refs?service=... — always the v0
 * advertisement for a known service (the router serves advertisementV2
 * directly when the request carries Git-Protocol: version=2). A missing
 * repository, an unknown service or no service at all is a 404.
 */
export function handleInfoRefs(forge: Forge, owner: string, repoName: string, service: string | null, gitProtocol?: string | null): GitResponse {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return repoMissing();
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertisementV2('git-upload-pack') };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertisementV0(repo, service) };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: advertisementV0(repo, service) };
  }
  return jsonError(404, 'unknown service');
}

// ------------------------------------------------------------ packfile cache

// Pack bytes are a pure function of the packed objects, and git objects are
// content-addressed and immutable, so a cache keyed by the sorted oid list
// is sound across repositories and time. The clone workload fetches the
// same tip fifty times concurrently; re-deflating that pack each time
// would be its whole cost.
const packCache = new Map<string, Buffer>();

function cachedPack(repo: Repo, oids: string[]): Buffer {
  const key = oids.join(',');
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const objects: GitObject[] = [];
  for (const oid of oids) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  const pack = writePack(objects);
  if (packCache.size >= PACK_CACHE_LIMIT) {
    const oldest = packCache.keys().next().value;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  packCache.set(key, pack);
  return pack;
}

/** Split a pack into sideband band-1 frames, each within the pkt-line limit. */
function packSideband(pack: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  for (let at = 0; at < pack.length; at += SIDEBAND_CHUNK) {
    const piece = pack.subarray(at, Math.min(pack.length, at + SIDEBAND_CHUNK));
    frames.push(pktLine(Buffer.concat([Buffer.from([1]), piece])));
  }
  return frames;
}

/** Wrap pkt-lined report bytes in sideband band-1 frames plus a closing flush. */
function sidebandWrap(payload: Buffer): Buffer {
  const frames: Buffer[] = [];
  for (let at = 0; at < payload.length; at += SIDEBAND_CHUNK) {
    const piece = payload.subarray(at, Math.min(payload.length, at + SIDEBAND_CHUNK));
    frames.push(pktLine(Buffer.concat([Buffer.from([1]), piece])));
  }
  frames.push(pktFlush());
  return Buffer.concat(frames);
}

// ------------------------------------------------------------ fetch planning

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function textLines(body: Buffer): string[] {
  const { packets } = decodeAllPktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.data.toString('utf8'));
  }
  return lines;
}

/** Parse the want/have/shallow/deepen lines of a fetch request. */
function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const raw of lines) {
    const text = raw.replace(/\n$/, '');
    if (text === '' || text.startsWith('command=') || text.startsWith('agent=') || text.startsWith('object-format=')) continue;
    if (text === 'thin-pack' || text === 'no-progress' || text === 'ofs-delta' || text === 'done') continue;
    if (text.startsWith('want ')) args.wants.push(text.slice(5).split(' ')[0] as string);
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).split(' ')[0] as string);
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
    // deepen-since, deepen-not and filter are accepted and ignored: the
    // fetch still returns the wanted set.
  }
  return args;
}

/**
 * Objects reachable from `tips`, stopping at (not crossing) the commits in
 * `stopAt` — a shallow boundary commit contributes itself, its tree and its
 * blobs, but not its parents.
 */
function reachablePastBoundary(repo: Repo, tips: string[], stopAt: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const tip of tips) if (isObjectId(tip)) stack.push(tip);
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
      if (!stopAt.has(oid)) {
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
 * Commits reachable from `roots` within `depth` generations (depth 1 is the
 * tips only), each with its distance from the nearest root. Every included
 * commit contributes its tree and blobs; a non-commit want contributes its
 * own closure.
 */
function reachableWithinDepth(
  repo: Repo,
  roots: string[],
  depth: number,
): { included: Set<string>; distance: Map<string, number> } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const commits = new Set<string>();
  const distance = new Map<string, number>();
  const queue: { oid: string; d: number }[] = [];
  for (const root of roots) {
    const peeled = peelToCommit(root, lookup);
    if (isObjectId(peeled)) queue.push({ oid: peeled, d: 0 });
  }
  const visited = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    const { oid, d } = queue[head] as { oid: string; d: number };
    head += 1;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    commits.add(oid);
    if (!distance.has(oid)) distance.set(oid, d);
    if (d + 1 < depth) {
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, d: d + 1 });
    }
  }
  const included = new Set<string>();
  for (const oid of commits) {
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    included.add(oid);
    const commit = parseCommit(object.data);
    for (const sub of collectReachable([commit.tree], lookup, true)) included.add(sub);
  }
  for (const root of roots) {
    const object = repo.objects.get(root);
    if (object === undefined) continue;
    if (object.type === 'tag') included.add(root);
    else if (object.type !== 'commit') {
      for (const sub of collectReachable([root], lookup, true)) included.add(sub);
    }
  }
  return { included, distance };
}

interface FetchPlan {
  /** Sorted oids to pack. */
  toSend: string[];
  shallow: string[];
  unshallow: string[];
}

/** Work out what a fetch must send, honouring haves and a depth limit. */
function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const boundaries = new Set(args.shallow);
  const alreadyHeld = reachablePastBoundary(repo, args.haves, boundaries);

  let target: Set<string>;
  let distance = new Map<string, number>();
  if (args.depth !== null) {
    const limited = reachableWithinDepth(repo, args.wants, args.depth);
    target = limited.included;
    distance = limited.distance;
  } else {
    target = collectReachable(args.wants, lookup, true);
  }
  const toSend = [...target].filter((oid) => !alreadyHeld.has(oid)).sort();

  // New shallow boundaries, only for a depth-limited fetch: a commit in the
  // target whose parent falls outside it, plus a root commit sitting
  // exactly at the depth cutoff (a depth-1 fetch of a one-commit history is
  // still a shallow clone; a depth that covers the whole history marks
  // nothing).
  const shallow: string[] = [];
  if (args.depth !== null) {
    for (const oid of [...target].sort()) {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => !target.has(parent))) shallow.push(oid);
      else if (parents.length === 0 && distance.get(oid) === args.depth - 1) shallow.push(oid);
    }
  }
  // Boundaries the client already had that are now fully included stop
  // being shallow: report them as unshallow.
  const unshallow: string[] = [];
  for (const boundary of [...boundaries].sort()) {
    if (!target.has(boundary)) continue;
    const object = repo.objects.get(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => target.has(parent))) unshallow.push(boundary);
  }
  return { toSend, shallow, unshallow };
}

// ------------------------------------------------------------------ ls-refs

/** Answer a v2 ls-refs command: refs, HEAD symref and peeled tags. */
function answerLsRefs(repo: Repo, lines: string[]): Buffer {
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
  for (const ref of refRows(repo)) {
    if (!wanted(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    out.push(pktLine(`${line}\n`));
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

// -------------------------------------------------------------- upload-pack

/** Answer a fetch, framed for protocol v2 or v0. */
function answerFetch(repo: Repo, lines: string[], version: 2 | 0): Buffer {
  const args = parseFetchArgs(lines);
  const plan = planFetch(repo, args);
  const pack = cachedPack(repo, plan.toSend);
  if (version === 2) {
    const parts: Buffer[] = [];
    // A client only reads an acknowledgments section when it sent haves;
    // with no haves it expects the packfile (or shallow-info) section next.
    if (args.haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktLine('ready\n'), pktDelim());
    }
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktDelim());
    }
    // The packfile section is always present, even when nothing is new:
    // the client reads the section header next, and a flush in its place
    // aborts the fetch. With no new objects the pack is a valid empty one.
    parts.push(pktLine('packfile\n'));
    parts.push(...packSideband(pack));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }

  // v0: a NAK, then shallow lines as plain packets, then the sideband pack.
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...packSideband(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function isVersion2(protocolVersion: string): boolean {
  return protocolVersion === 'version=2' || protocolVersion === '2';
}

/**
 * POST /{owner}/{repo}.git/git-upload-pack. Protocol v2 when the request
 * carries Git-Protocol: version=2, v0 otherwise. ls-refs needs v2; fetch
 * works in both. A body that is not a pkt-line request is a 400; a missing
 * repository is a 404. Never throws.
 */
export function handleUploadPack(
  forge: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
  protocolVersion: string,
): GitResponse {
  try {
    const repo = forge.getRepo(owner, repoName);
    if (repo === undefined) return repoMissing();
    const lines = textLines(body);
    if (lines.length === 0) return jsonError(400, 'bad request: not a pkt-line request');
    const commandLine = lines.find((line) => line.startsWith('command='));
    const command = commandLine === undefined ? '' : commandLine.slice('command='.length).trim();
    const version: 2 | 0 = isVersion2(protocolVersion) ? 2 : 0;
    if (command === 'ls-refs') {
      if (version !== 2) return jsonError(400, 'ls-refs needs protocol v2');
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: answerLsRefs(repo, lines) };
    }
    if (command === 'fetch' || command === '') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: answerFetch(repo, lines, version) };
    }
    return jsonError(400, `unknown command ${command}`);
  } catch (err) {
    return jsonError(400, `bad request: ${(err as Error).message}`);
  }
}

// ------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface ParsedPush {
  commands: PushCommand[];
  trailing: Buffer;
  sawFlush: boolean;
}

/** Split a receive-pack body into its command list and the packfile after it. */
function parsePushBody(body: Buffer): ParsedPush {
  const { packets, trailing } = decodeAllPktLines(body);
  const commands: PushCommand[] = [];
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    let text = packet.data.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.split(' ');
    if (parts.length < 3) throw new Error('push command line is malformed');
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid)) throw new Error('push command has a bad object id');
    if (!ref.startsWith('refs/')) throw new Error('push command has a bad ref');
    commands.push({ oldOid, newOid, ref });
  }
  return { commands, trailing, sawFlush };
}

interface RefOutcome {
  ref: string;
  ok: boolean;
  reason: string;
}

/**
 * POST /{owner}/{repo}.git/git-receive-pack (v0 only). Unpacks the pack
 * first — a pack that fails to unpack refuses every ref — then applies each
 * command on its own: creates and deletes are allowed, an update must
 * fast-forward (the new tip must descend from the old one). Accepted refs
 * move and their report line is "ok"; refused refs stay put and report
 * "ng <ref> non-fast-forward" (or the matching reason). The reply is a
 * report-status stream inside sideband band 1. A body that cannot be
 * parsed is a 400; a missing repository is a 404. Never throws.
 */
export function handleReceivePack(forge: Forge, owner: string, repoName: string, body: Buffer): GitResponse {
  try {
    const repo = forge.getRepo(owner, repoName);
    if (repo === undefined) return repoMissing();
    let parsed: ParsedPush;
    try {
      parsed = parsePushBody(body);
    } catch (err) {
      return jsonError(400, `bad request: ${(err as Error).message}`);
    }
    if (!parsed.sawFlush || parsed.commands.length === 0) {
      return jsonError(400, 'bad request: no push commands');
    }

    // Unpack first: a pack that fails to unpack refuses every ref, and
    // nothing from it is stored.
    let unpackOk = true;
    if (parsed.commands.some((command) => command.newOid !== ZERO_OID)) {
      if (parsed.trailing.length === 0) {
        unpackOk = false;
      } else {
        try {
          const read = readPack(parsed.trailing, (id) => repo.objects.get(id));
          if (!read.checksumOk) {
            unpackOk = false;
          } else {
            for (let i = 0; i < read.oids.length; i += 1) {
              const oid = read.oids[i] as string;
              if (!repo.objects.has(oid)) repo.objects.set(oid, read.objects[i] as GitObject);
            }
          }
        } catch {
          unpackOk = false;
        }
      }
    }

    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    const results: RefOutcome[] = [];
    for (const command of parsed.commands) {
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
      // Update: the old tip must match, the new object must be stored, and
      // the new tip must descend from the old one (tags peel to commits).
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else if (command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else if (!repo.objects.has(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'missing object' });
      } else {
        const newCommit = peelToCommit(command.newOid, lookup);
        const oldCommit = peelToCommit(command.oldOid, lookup);
        if (!isAncestor(oldCommit, newCommit, lookup)) {
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
    // With side-band-64k the report-status stream is itself pkt-lined
    // inside band 1, including its own terminating flush: without it the
    // client waits for more report lines and reports that the remote hung up.
    reportLines.push(pktFlush());
    return {
      status: 200,
      contentType: 'application/x-git-receive-pack-result',
      body: sidebandWrap(Buffer.concat(reportLines)),
    };
  } catch (err) {
    return jsonError(400, `bad request: ${(err as Error).message}`);
  }
}
