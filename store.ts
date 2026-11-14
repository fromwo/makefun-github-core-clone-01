// store.ts — the forge's in-memory store.
//
// One Forge holds every repository: its refs, its git objects, its labels,
// issues and pull requests. Nothing touches disk and nothing reads a clock:
// a logical counter hands out timestamps, so replaying the same requests
// always produces the same bytes.
//
// The other modules only ever see this file's exports. The shapes below
// (Forge, Repo, Issue, Pull, the three *View functions) are the contract
// they import against; the inside of each method is free to differ as long
// as the observable behaviour matches.

import {
  ZERO_OID,
  buildCommit,
  buildTreeFromMap,
  collectReachable,
  flattenTree,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  peelToCommit,
} from './gitcore.ts';
import type { FileEntry, GitObject, GitObjectType } from './gitcore.ts';

/** The single account this forge serves; every repo belongs to it. */
export const VIEWER_LOGIN = process.env.MAKEFUN_VIEWER_LOGIN ?? 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: { login: string };
  created_at: string;
  updated_at: string;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  user: { login: string };
  created_at: string;
  updated_at: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  default_branch: string;
  created_at: string;
  updated_at: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  seq: number;
}

/** A GraphQL-style global id: base64 of "Kind:key". */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

/** Number of lines in a blob, counting a trailing newline as a terminator, not a line. */
function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n').length;
  return data[data.length - 1] === 0x0a ? lines - 1 : lines;
}

/** Two file entries are the same version when both exist with the same blob (or both absent). */
function sameEntry(a: FileEntry | undefined, b: FileEntry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.oid === b.oid;
}

export class Forge {
  repos = new Map<string, Repo>();
  private repoSeq = 1;
  private idSeq = 1;
  /** Logical clock, in seconds since 2025-01-01T00:00:00Z; advanced one tick per event. */
  private clockSec = 1735689600;
  private seqCounter = 0;

  /** A deterministic timestamp: one second per event, from a fixed epoch. */
  nowIso(): string {
    this.clockSec += 1;
    return new Date(this.clockSec * 1000).toISOString();
  }

  nowSec(): number {
    this.clockSec += 1;
    return this.clockSec;
  }

  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  // ---------------------------------------------------------------- repositories

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    const key = this.repoKey(VIEWER_LOGIN, name);
    if (this.repos.has(key)) return null;
    const stamp = this.nowIso();
    const repo: Repo = {
      id: this.repoSeq++,
      owner: VIEWER_LOGIN,
      name,
      private: isPrivate,
      description,
      default_branch: 'main',
      created_at: stamp,
      updated_at: stamp,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      seq: this.nextSeq(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER_LOGIN) return false;
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  // ---------------------------------------------------------------- git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    const existing = repo.objects.get(oid);
    if (existing === undefined) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    const objects = repo.objects;
    return (oid: string) => objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** The commit a ref points at (peeling annotated tags). */
  refCommit(repo: Repo, ref: string): string | undefined {
    const oid = repo.refs.get(ref);
    if (oid === undefined) return undefined;
    return peelToCommit(oid, this.lookup(repo));
  }

  branchNames(repo: Repo): string[] {
    const prefix = 'refs/heads/';
    const names: string[] = [];
    for (const ref of repo.refs.keys()) {
      if (ref.startsWith(prefix)) names.push(ref.slice(prefix.length));
    }
    return names;
  }

  /** Commits reachable from `ref`, newest first (tip-first DFS). */
  commitsFrom(repo: Repo, ref: string): string[] {
    const tip = this.refCommit(repo, ref);
    if (tip === undefined) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
    }
    return out;
  }

  /** The flat path map of the tree a commit points at. */
  private treeFiles(repo: Repo, commitOid: string): Map<string, FileEntry> {
    const commit = repo.objects.get(commitOid);
    if (commit === undefined) return new Map();
    return flattenTree(this.lookup(repo), parseCommit(commit.data).tree);
  }

  /** Store a commit object for `files` on `branch`, parented on `parent` (if any). */
  private writeCommit(
    repo: Repo,
    branch: string,
    files: Map<string, FileEntry>,
    parents: string[],
    message: string,
  ): string {
    const treeOid = buildTreeFromMap(files, (type, data) => this.putObject(repo, type, data));
    const identity = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const commitData = buildCommit({
      tree: treeOid,
      parents,
      message,
      author: identity,
      committer: identity,
      timestamp: this.nowSec(),
    });
    const sha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, sha);
    return sha;
  }

  // ---------------------------------------------------------------- contents commits

  /** Commit one file change on `branch` (creating the branch from the default tip when missing). */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; blobSha: string } {
    const ref = `refs/heads/${branch}`;
    let tip = this.refCommit(repo, ref);
    if (tip === undefined) {
      const defaultTip = this.refCommit(repo, `refs/heads/${repo.default_branch}`);
      if (defaultTip !== undefined) {
        repo.refs.set(ref, defaultTip);
        tip = defaultTip;
      }
    }
    const blobSha = this.putObject(repo, 'blob', content);
    const files = tip === undefined ? new Map<string, FileEntry>() : this.treeFiles(repo, tip);
    files.set(path, { mode: '100644', oid: blobSha });
    const commitSha = this.writeCommit(repo, branch, files, tip === undefined ? [] : [tip], message);
    return { commitSha, blobSha };
  }

  /** Delete one file on `branch`, committing the removal. Returns the new commit sha or null. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const ref = `refs/heads/${branch}`;
    const tip = this.refCommit(repo, ref);
    if (tip === undefined) return null;
    const files = this.treeFiles(repo, tip);
    if (!files.has(path)) return null;
    files.delete(path);
    return this.writeCommit(repo, branch, files, [tip], message);
  }

  /** The blob at `path` in the tree of `ref` (or null). */
  fileAt(repo: Repo, ref: string, path: string): { blobSha: string; content: Buffer } | null {
    const tip = this.refCommit(repo, ref);
    if (tip === undefined) return null;
    const entry = this.treeFiles(repo, tip).get(path);
    if (entry === undefined) return null;
    const blob = repo.objects.get(entry.oid);
    if (blob === undefined) return null;
    return { blobSha: entry.oid, content: blob.data };
  }

  /** Directory entries under `prefix` ('' for the root) in the tree of `ref`. */
  dirAt(repo: Repo, ref: string, prefix: string): { type: 'file' | 'dir'; name: string; path: string; sha: string }[] | null {
    const tip = this.refCommit(repo, ref);
    if (tip === undefined) return null;
    const files = this.treeFiles(repo, tip);
    const seen = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
    for (const [path, entry] of files) {
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        seen.set(rest, { type: 'file', name: rest, path, sha: entry.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (!seen.has(dir)) {
          seen.set(dir, { type: 'dir', name: dir, path: prefix === '' ? dir : `${prefix}/${dir}`, sha: '' });
        }
      }
    }
    if (seen.size === 0) return null;
    return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  // ---------------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (label === undefined) return { error: `label ${name} does not exist` };
      labels.push(label);
    }
    const number = repo.nextNumber++;
    const stamp = this.nowIso();
    const issue: Issue = {
      id: this.idSeq++,
      number,
      title,
      body,
      state: 'open',
      labels,
      user: { login: VIEWER_LOGIN },
      created_at: stamp,
      updated_at: stamp,
      comments: [],
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createIssueDirect(repo: Repo, title: string, body: string): Issue {
    const result = this.createIssue(repo, title, body, []);
    if ('error' in result) throw new Error(result.error);
    return result;
  }

  // ---------------------------------------------------------------- pull requests

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string } {
    const headRef = `refs/heads/${head}`;
    const baseRef = `refs/heads/${base}`;
    const headTip = this.refCommit(repo, headRef);
    const baseTip = this.refCommit(repo, baseRef);
    if (headTip === undefined) return { error: `head branch ${head} does not exist` };
    if (baseTip === undefined) return { error: `base branch ${base} does not exist` };
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.head.ref === head && pull.base.ref === base) {
        return { error: 'a pull request from this head already exists' };
      }
    }
    const number = repo.nextNumber++;
    const stamp = this.nowIso();
    const pull: Pull = {
      id: this.idSeq++,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      head: { ref: head, sha: headTip },
      base: { ref: base, sha: baseTip },
      user: { login: VIEWER_LOGIN },
      created_at: stamp,
      updated_at: stamp,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /** The files changed between the base tip and the head tip of a pull request. */
  pullFiles(repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const baseTip = this.refCommit(repo, `refs/heads/${pull.base.ref}`);
    const headTip = this.refCommit(repo, `refs/heads/${pull.head.ref}`);
    if (baseTip === undefined || headTip === undefined) return [];
    const baseFiles = this.treeFiles(repo, baseTip);
    const headFiles = this.treeFiles(repo, headTip);
    const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const inBase = baseFiles.get(path);
      const inHead = headFiles.get(path);
      if (inBase !== undefined && inHead === undefined) {
        const blob = repo.objects.get(inBase.oid);
        const deletions = blob === undefined ? 0 : lineCount(blob.data);
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (inBase === undefined && inHead !== undefined) {
        const blob = repo.objects.get(inHead.oid);
        const additions = blob === undefined ? 0 : lineCount(blob.data);
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (inBase !== undefined && inHead !== undefined && inBase.oid !== inHead.oid) {
        const oldBlob = repo.objects.get(inBase.oid);
        const newBlob = repo.objects.get(inHead.oid);
        const oldLines = oldBlob === undefined ? 0 : lineCount(oldBlob.data);
        const newLines = newBlob === undefined ? 0 : lineCount(newBlob.data);
        // Line-level diffs are approximated from the two line counts: a file
        // that changed at all counts at least one added line.
        const additions = Math.max(1, Math.max(0, newLines - oldLines) + (newLines > 0 && oldLines > 0 ? 1 : 0));
        const deletions = Math.max(0, oldLines - newLines);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** Whether a pull request merges cleanly (three-way, no conflict). */
  mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const result = this.threeWayMerge(repo, pull);
    if (result === null) return 'UNKNOWN';
    return result.conflict ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * The three-way merge of a pull request: returns the merged file map, or null when a tip is missing.
   * `conflict` is true when the head and the base both changed the same path differently since the base.
   */
  threeWayMerge(repo: Repo, pull: Pull): { files: Map<string, FileEntry>; conflict: boolean } | null {
    const baseTip = this.refCommit(repo, `refs/heads/${pull.base.ref}`);
    const headTip = this.refCommit(repo, `refs/heads/${pull.head.ref}`);
    if (baseTip === undefined || headTip === undefined) return null;
    const base = mergeBase(baseTip, headTip, this.lookup(repo));
    const ancestorFiles = base === null ? new Map<string, FileEntry>() : this.treeFiles(repo, base);
    const baseTipFiles = this.treeFiles(repo, baseTip);
    const headFiles = this.treeFiles(repo, headTip);
    const merged = new Map<string, FileEntry>(baseTipFiles);
    let conflict = false;
    const paths = new Set([...ancestorFiles.keys(), ...baseTipFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const ancestor = ancestorFiles.get(path);
      const onBase = baseTipFiles.get(path);
      const onHead = headFiles.get(path);
      if (sameEntry(onHead, onBase)) continue;
      if (sameEntry(onBase, ancestor)) {
        // Base unchanged since the merge base: take the head's version (or its deletion).
        if (onHead !== undefined) merged.set(path, onHead);
        else merged.delete(path);
        continue;
      }
      if (sameEntry(onHead, ancestor)) continue; // Head unchanged: keep the base's version.
      conflict = true; // Both sides changed the path differently.
    }
    return { files: merged, conflict };
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit sha, or an error. */
  mergePull(repo: Repo, pull: Pull, method: string): { sha: string } | { error: string; status: number } {
    if (pull.state !== 'open') return { error: 'pull request is not open', status: 405 };
    const merged = this.threeWayMerge(repo, pull);
    if (merged === null) return { error: 'cannot merge: missing branch tip', status: 405 };
    if (merged.conflict) return { error: 'merge conflict', status: 405 };
    const baseTip = this.refCommit(repo, `refs/heads/${pull.base.ref}`);
    if (baseTip === undefined) return { error: 'cannot merge: missing base tip', status: 405 };
    const treeOid = buildTreeFromMap(merged.files, (type, data) => this.putObject(repo, type, data));
    const message = `Merge pull request #${pull.number} from ${pull.head.ref}\n\n${pull.title}\n`;
    const identity = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const commitData = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      message,
      author: identity,
      committer: identity,
      timestamp: this.nowSec(),
    });
    const sha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.base.ref}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = this.nowIso();
    pull.merge_commit_sha = sha;
    pull.updated_at = pull.merged_at;
    pull.base.sha = sha;
    return { sha };
  }
}

// --------------------------------------------------------------------------- REST views

export function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

export function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.owner}/${repo.name}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: issue.user.login },
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

export function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.owner}/${repo.name}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    mergeable: pull.state === 'open',
    head: { ref: pull.head.ref, sha: pull.head.sha, label: `${repo.owner}:${pull.head.ref}` },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: `${repo.owner}:${pull.base.ref}` },
    user: { login: pull.user.login },
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function isRepoName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name);
}

export function isZeroOid(oid: string): boolean {
  return oid === ZERO_OID;
}

export { isObjectId, isAncestor, collectReachable };
