// forge.ts — the forge's in-memory data model.
//
// A single Forge instance owns every repository this process serves. Each
// repository keeps its refs, git objects, labels, issues and pull requests
// in Maps; nothing is written to disk and nothing reads the wall clock.
// Time comes from a logical counter that starts at 2025-01-01T00:00:00Z
// and advances one second per event, so replaying the same requests in
// the same order always yields the same timestamps, ids and hashes.
//
// The REST, GraphQL and MCP layers only ever talk to this file's exports:
// the Forge class, the Repo/Issue/Pull shapes and the three *View
// functions that render those shapes into REST-shaped plain objects.
// The git object primitives (hashing, trees, commits, ancestry) live in
// objects.ts; this file only orchestrates them.

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
} from './objects.ts';
import type { FileEntry, GitObject, GitObjectType } from './objects.ts';

/** The one account this forge serves; every repository belongs to it. */
export const VIEWER_LOGIN = process.env.MAKEFUN_VIEWER_LOGIN ?? 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** Logical-clock epoch: 2025-01-01T00:00:00Z, in seconds. */
const CLOCK_EPOCH_SEC = 1735689600;

/** The identity string stamped on commits this forge writes. */
const COMMIT_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;

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

/**
 * Lines in a blob. A trailing newline terminates the last line instead
 * of starting a new one, so "a\n" is one line and "" is zero lines.
 */
function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const chunks = data.toString('utf8').split('\n').length;
  return data[data.length - 1] === 0x0a ? chunks - 1 : chunks;
}

/** Two file entries count as the same version when both are absent, or both present with the same blob. */
function sameVersion(a: FileEntry | undefined, b: FileEntry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.oid === b.oid;
}

/** Sort helper for directory listings and file lists: plain name order. */
function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export class Forge {
  repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextGlobalId = 1;
  private clock = CLOCK_EPOCH_SEC;
  private orderCounter = 0;

  /** Advance the logical clock one second and return the new time as ISO text. */
  nowIso(): string {
    this.clock += 1;
    return new Date(this.clock * 1000).toISOString();
  }

  /** Advance the logical clock one second and return the new time in seconds. */
  nowSec(): number {
    this.clock += 1;
    return this.clock;
  }

  /** Hand out the next creation-order sequence number. */
  nextSeq(): number {
    this.orderCounter += 1;
    return this.orderCounter;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  // ------------------------------------------------------------ repositories

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    const key = this.repoKey(VIEWER_LOGIN, name);
    if (this.repos.has(key)) return null;
    const stamp = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
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

  // ------------------------------------------------------------ git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    const store = repo.objects;
    return (oid: string) => store.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** The commit a ref resolves to, peeling annotated tags on the way. */
  refCommit(repo: Repo, ref: string): string | undefined {
    const target = repo.refs.get(ref);
    if (target === undefined) return undefined;
    const peeled = peelToCommit(target, this.lookup(repo));
    return peeled ?? undefined;
  }

  branchNames(repo: Repo): string[] {
    const prefix = 'refs/heads/';
    const names: string[] = [];
    for (const ref of repo.refs.keys()) {
      if (ref.startsWith(prefix)) names.push(ref.slice(prefix.length));
    }
    return names;
  }

  /** Commits reachable from `ref`, tip first, parents walked depth-first. */
  commitsFrom(repo: Repo, ref: string): string[] {
    const tip = this.refCommit(repo, ref);
    if (tip === undefined) return [];
    const found: string[] = [];
    const visited = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (visited.has(oid)) continue;
      visited.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      found.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) {
        stack.push(parents[i] as string);
      }
    }
    return found;
  }

  /** The flat path map of the tree a commit points at; empty when unreadable. */
  private filesOfCommit(repo: Repo, commitOid: string): Map<string, FileEntry> {
    const commit = repo.objects.get(commitOid);
    if (commit === undefined) return new Map();
    return flattenTree(this.lookup(repo), parseCommit(commit.data).tree);
  }

  /**
   * Write a commit for `files` on `branch`, parented on `parents` (empty
   * for a root commit), and move the branch ref to it.
   */
  private recordCommit(
    repo: Repo,
    branch: string,
    files: Map<string, FileEntry>,
    parents: string[],
    message: string,
  ): string {
    const treeOid = buildTreeFromMap(files, (type, data) => this.putObject(repo, type, data));
    const raw = buildCommit({
      tree: treeOid,
      parents,
      message,
      author: COMMIT_IDENTITY,
      committer: COMMIT_IDENTITY,
      timestamp: this.nowSec(),
    });
    const sha = this.putObject(repo, 'commit', raw);
    repo.refs.set(`refs/heads/${branch}`, sha);
    return sha;
  }

  // ------------------------------------------------------------ file commits

  /**
   * Commit one file change on `branch`. A missing branch is seeded from
   * the default branch tip; with no tip at all the commit is a root
   * commit on an empty tree.
   */
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
      const mainTip = this.refCommit(repo, `refs/heads/${repo.default_branch}`);
      if (mainTip !== undefined) {
        repo.refs.set(ref, mainTip);
        tip = mainTip;
      }
    }
    const blobSha = this.putObject(repo, 'blob', content);
    const files = tip === undefined ? new Map<string, FileEntry>() : this.filesOfCommit(repo, tip);
    files.set(path, { mode: '100644', oid: blobSha });
    const commitSha = this.recordCommit(repo, branch, files, tip === undefined ? [] : [tip], message);
    return { commitSha, blobSha };
  }

  /** Delete one file on `branch`, committing the removal; null when there is nothing to delete. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const ref = `refs/heads/${branch}`;
    const tip = this.refCommit(repo, ref);
    if (tip === undefined) return null;
    const files = this.filesOfCommit(repo, tip);
    if (!files.has(path)) return null;
    files.delete(path);
    return this.recordCommit(repo, branch, files, [tip], message);
  }

  /** The blob at `path` in the tree `ref` points at, or null. */
  fileAt(repo: Repo, ref: string, path: string): { blobSha: string; content: Buffer } | null {
    const tip = this.refCommit(repo, ref);
    if (tip === undefined) return null;
    const entry = this.filesOfCommit(repo, tip).get(path);
    if (entry === undefined) return null;
    const blob = repo.objects.get(entry.oid);
    if (blob === undefined) return null;
    return { blobSha: entry.oid, content: blob.data };
  }

  /**
   * One level of directory entries under `prefix` ('' for the root) in
   * the tree `ref` points at; null when the ref is missing or the
   * directory holds nothing.
   */
  dirAt(repo: Repo, ref: string, prefix: string): { type: 'file' | 'dir'; name: string; path: string; sha: string }[] | null {
    const tip = this.refCommit(repo, ref);
    if (tip === undefined) return null;
    const files = this.filesOfCommit(repo, tip);
    const entries = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
    for (const [path, entry] of files) {
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.set(rest, { type: 'file', name: rest, path, sha: entry.oid });
      } else {
        const dirName = rest.slice(0, slash);
        if (!entries.has(dirName)) {
          entries.set(dirName, {
            type: 'dir',
            name: dirName,
            path: prefix === '' ? dirName : `${prefix}/${dirName}`,
            sha: '',
          });
        }
      }
    }
    if (entries.size === 0) return null;
    return [...entries.values()].sort(byName);
  }

  // ------------------------------------------------------------------ issues

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue | { error: string } {
    const attached: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (label === undefined) return { error: `label ${name} does not exist` };
      attached.push(label);
    }
    const number = repo.nextNumber++;
    const stamp = this.nowIso();
    const issue: Issue = {
      id: this.nextGlobalId++,
      number,
      title,
      body,
      state: 'open',
      labels: attached,
      user: { login: VIEWER_LOGIN },
      created_at: stamp,
      updated_at: stamp,
      comments: [],
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createIssueDirect(repo: Repo, title: string, body: string): Issue {
    const made = this.createIssue(repo, title, body, []);
    if ('error' in made) throw new Error(made.error);
    return made;
  }

  // ------------------------------------------------------------ pull requests

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string } {
    const headRef = `refs/heads/${head}`;
    const baseRef = `refs/heads/${base}`;
    const headTip = this.refCommit(repo, headRef);
    const baseTip = this.refCommit(repo, baseRef);
    if (headTip === undefined) return { error: `head branch ${head} does not exist` };
    if (baseTip === undefined) return { error: `base branch ${base} does not exist` };
    for (const open of repo.pulls.values()) {
      if (open.state === 'open' && open.head.ref === head && open.base.ref === base) {
        return { error: 'a pull request from this head already exists' };
      }
    }
    const number = repo.nextNumber++;
    const stamp = this.nowIso();
    const pull: Pull = {
      id: this.nextGlobalId++,
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

  /** Files changed between a pull request's base tip and its head tip. */
  pullFiles(repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const baseTip = this.refCommit(repo, `refs/heads/${pull.base.ref}`);
    const headTip = this.refCommit(repo, `refs/heads/${pull.head.ref}`);
    if (baseTip === undefined || headTip === undefined) return [];
    const before = this.filesOfCommit(repo, baseTip);
    const after = this.filesOfCommit(repo, headTip);
    const rows: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    const paths = new Set([...before.keys(), ...after.keys()]);
    for (const path of [...paths].sort()) {
      const oldEntry = before.get(path);
      const newEntry = after.get(path);
      if (oldEntry !== undefined && newEntry === undefined) {
        const blob = repo.objects.get(oldEntry.oid);
        const removed = blob === undefined ? 0 : countLines(blob.data);
        rows.push({ filename: path, status: 'removed', additions: 0, deletions: removed, changes: removed });
      } else if (oldEntry === undefined && newEntry !== undefined) {
        const blob = repo.objects.get(newEntry.oid);
        const added = blob === undefined ? 0 : countLines(blob.data);
        rows.push({ filename: path, status: 'added', additions: added, deletions: 0, changes: added });
      } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
        const oldBlob = repo.objects.get(oldEntry.oid);
        const newBlob = repo.objects.get(newEntry.oid);
        const oldLines = oldBlob === undefined ? 0 : countLines(oldBlob.data);
        const newLines = newBlob === undefined ? 0 : countLines(newBlob.data);
        // Line-level diffs are approximated from the two line counts: any
        // file that changed at all counts at least one added line.
        const additions = Math.max(1, Math.max(0, newLines - oldLines) + (newLines > 0 && oldLines > 0 ? 1 : 0));
        const deletions = Math.max(0, oldLines - newLines);
        rows.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return rows;
  }

  /** Whether a pull request merges cleanly (three-way, no conflict). */
  mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const attempt = this.threeWayMerge(repo, pull);
    if (attempt === null) return 'UNKNOWN';
    return attempt.conflict ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * The three-way merge of a pull request: the merged file map, or null
   * when a branch tip is missing. `conflict` is true when the head and
   * the base both changed the same path differently since the merge base.
   */
  threeWayMerge(repo: Repo, pull: Pull): { files: Map<string, FileEntry>; conflict: boolean } | null {
    const baseTip = this.refCommit(repo, `refs/heads/${pull.base.ref}`);
    const headTip = this.refCommit(repo, `refs/heads/${pull.head.ref}`);
    if (baseTip === undefined || headTip === undefined) return null;
    const ancestor = mergeBase(baseTip, headTip, this.lookup(repo));
    // No common ancestor (mergeBase answers null, or undefined when the
    // object layer has nothing to return) means an empty ancestor tree.
    const ancestorFiles = ancestor == null ? new Map<string, FileEntry>() : this.filesOfCommit(repo, ancestor);
    const baseFiles = this.filesOfCommit(repo, baseTip);
    const headFiles = this.filesOfCommit(repo, headTip);
    const merged = new Map<string, FileEntry>(baseFiles);
    let conflict = false;
    const paths = new Set([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const oldVersion = ancestorFiles.get(path);
      const baseVersion = baseFiles.get(path);
      const headVersion = headFiles.get(path);
      if (sameVersion(headVersion, baseVersion)) continue;
      if (sameVersion(baseVersion, oldVersion)) {
        // Base untouched since the merge base: take the head's version (or its deletion).
        if (headVersion !== undefined) merged.set(path, headVersion);
        else merged.delete(path);
        continue;
      }
      if (sameVersion(headVersion, oldVersion)) continue; // Head untouched: keep the base's version.
      conflict = true; // Both sides changed the path differently.
    }
    return { files: merged, conflict };
  }

  /**
   * Squash-merge a pull request onto its base branch. The merge commit
   * has only the base tip as its parent; the base ref moves to it and
   * the pull request becomes closed and merged.
   */
  mergePull(repo: Repo, pull: Pull, method: string): { sha: string } | { error: string; status: number } {
    void method;
    if (pull.state !== 'open') return { error: 'pull request is not open', status: 405 };
    const attempt = this.threeWayMerge(repo, pull);
    if (attempt === null) return { error: 'cannot merge: missing branch tip', status: 405 };
    if (attempt.conflict) return { error: 'merge conflict', status: 405 };
    const baseTip = this.refCommit(repo, `refs/heads/${pull.base.ref}`);
    if (baseTip === undefined) return { error: 'cannot merge: missing base tip', status: 405 };
    const treeOid = buildTreeFromMap(attempt.files, (type, data) => this.putObject(repo, type, data));
    const message = `Merge pull request #${pull.number} from ${pull.head.ref}\n\n${pull.title}\n`;
    const raw = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      message,
      author: COMMIT_IDENTITY,
      committer: COMMIT_IDENTITY,
      timestamp: this.nowSec(),
    });
    const sha = this.putObject(repo, 'commit', raw);
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

// ------------------------------------------------------------------ REST views

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
