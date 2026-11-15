// api.ts — the GitHub REST v3 surface: repositories, contents, labels,
// issues, pull requests, branches, commits and git refs.
//
// The handler gets everything it needs in one context object (built by
// http.ts): the shared Forge, the method, the path segments below /api/v3,
// the parsed URL, the already-parsed JSON body, and the reply helpers.
// Nothing here touches the socket or the disk; every lookup is a Map get,
// so the read workload's hot path (GET one issue) is a single hash lookup
// plus one JSON serialisation.

import { Forge, VIEWER_LOGIN, isRepoName, issueView, pullView, repoView } from './forge.ts';
import type { Issue, Pull, Repo } from './forge.ts';

/** What http.ts hands the REST handler for one request. */
export interface RestContext {
  forge: Forge;
  method: string;
  /** Path segments below /api/v3 (so [] is GET /api/v3/ itself). */
  segments: string[];
  url: URL;
  /** The request's JSON body, or {} when there was none. */
  body: Record<string, unknown>;
  /** The Host header, for absolute pagination links. */
  host: string;
  send: (status: number, payload: unknown, extra?: Record<string, string>) => void;
  sendBare: (status: number) => void;
}

type JsonObj = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isObject(value: unknown): value is JsonObj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Page parameters: ?page= (default 1) and ?per_page= (default 30, capped at 100). */
function pageParams(url: URL): { page: number; perPage: number } {
  const rawPage = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  const rawPerPage = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
  return {
    page: Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1,
    perPage: Number.isFinite(rawPerPage) && rawPerPage >= 1 ? Math.min(rawPerPage, 100) : 30,
  };
}

function slicePage<T>(items: readonly T[], page: number, perPage: number): { slice: T[]; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { slice: items.slice(start, start + perPage), pages };
}

/**
 * The Link header for a paginated list. Absolute URLs, so a client that
 * only follows same-origin links stays on this server. Only the relations
 * that exist are emitted: next/last while more pages follow, prev/first
 * once past the first page.
 */
function pageLinks(host: string, url: URL, page: number, perPage: number, pages: number): string {
  const base = `http://${host}${url.pathname}`;
  const link = (p: number, rel: string): string => `<${base}?page=${p}&per_page=${perPage}>; rel="${rel}"`;
  const parts: string[] = [];
  if (page < pages) parts.push(link(page + 1, 'next'), link(pages, 'last'));
  if (page > 1) parts.push(link(page - 1, 'prev'), link(1, 'first'));
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Commit listing: parsed straight from the stored commit objects, so this
// file needs no git helper module of its own.

interface Person {
  name: string;
  email: string;
  date: string;
}

/** Split "Name <email> 1735689600 +0000" into its parts. */
function splitPerson(line: string): Person {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: '' };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

interface CommitParts {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Split a raw commit object into headers and its verbatim message. */
function parseCommitObject(data: Buffer): CommitParts {
  const sep = data.indexOf('\n\n');
  const head = sep < 0 ? data.toString('utf8') : data.subarray(0, sep).toString('utf8');
  const message = sep < 0 ? '' : data.subarray(sep + 2).toString('utf8');
  const out: CommitParts = { tree: '', parents: [], author: '', committer: '', message };
  if (head === '') return out;
  for (const line of head.split('\n')) {
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') out.tree = value;
    else if (key === 'parent') out.parents.push(value);
    else if (key === 'author') out.author = value;
    else if (key === 'committer') out.committer = value;
  }
  return out;
}

interface CommitRow {
  sha: string;
  commit: JsonObj;
  parents: { sha: string }[];
}

/**
 * Every commit reachable from `tip`, newest first. When the tip is a
 * branch other than the default, commits the default branch already holds
 * are left out, so a branch's own commits read back on the branch only.
 */
function walkCommits(repo: Repo, tip: string): CommitRow[] {
  const defaultTip = repo.refs.get(`refs/heads/${repo.default_branch}`);
  const hidden = new Set<string>();
  if (defaultTip !== undefined && defaultTip !== tip) {
    const stack = [defaultTip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (hidden.has(oid)) continue;
      hidden.add(oid);
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') {
        for (const parent of parseCommitObject(object.data).parents) stack.push(parent);
      }
    }
  }
  const rows: CommitRow[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    if (hidden.has(oid)) continue;
    const parsed = parseCommitObject(object.data);
    const author = splitPerson(parsed.author);
    const committer = splitPerson(parsed.committer);
    rows.push({
      sha: oid,
      commit: {
        message: parsed.message,
        author: { name: author.name, email: author.email, date: author.date },
        committer: { name: committer.name, email: committer.email, date: committer.date },
        tree: { sha: parsed.tree },
      },
      parents: parsed.parents.map((parent) => ({ sha: parent })),
    });
    for (let i = parsed.parents.length - 1; i >= 0; i -= 1) {
      stack.push(parsed.parents[i] as string);
    }
  }
  return rows;
}

/**
 * Resolve the commits list's ?sha=: a full ref name, a branch name, or a
 * commit oid. Null when nothing matches (the caller answers an empty list).
 */
function resolveCommitsTip(repo: Repo, shaParam: string | undefined): string | null {
  if (shaParam === undefined || shaParam === '') {
    return repo.refs.get(`refs/heads/${repo.default_branch}`) ?? null;
  }
  const direct = repo.refs.get(shaParam);
  if (direct !== undefined) return direct;
  const asBranch = repo.refs.get(`refs/heads/${shaParam}`);
  if (asBranch !== undefined) return asBranch;
  const object = repo.objects.get(shaParam);
  if (object !== undefined && object.type === 'commit') return shaParam;
  return null;
}

/** A branch name as the full ref the store keys on (accepting either form). */
function branchRef(branch: string): string {
  return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
}

// ---------------------------------------------------------------------------
// The handler.

let commentCounter = 0;

/** Handle one REST request; every path ends in exactly one reply. */
export function handleRest(ctx: RestContext): void {
  const { forge, method, segments: route, url, body, host } = ctx;
  const send = ctx.send;
  const notFound = (): void => {
    send(404, { message: 'Not Found' });
  };
  const unprocessable = (message: string): void => {
    send(422, { message });
  };

  /** Send a paginated list: slice the page, map the view, add Link when needed. */
  const sendList = <T>(items: readonly T[], view: (item: T) => unknown): void => {
    const { page, perPage } = pageParams(url);
    const { slice, pages } = slicePage(items, page, perPage);
    const extra: Record<string, string> = {};
    const links = pageLinks(host, url, page, perPage, pages);
    if (links !== '') extra.Link = links;
    send(200, slice.map(view), extra);
  };

  /** The repository named by /repos/{owner}/{repo}, or null (404, never 403). */
  const repoAt = (owner: string, name: string): Repo | null => forge.getRepo(owner, name) ?? null;

  // ------------------------------------------------------------ GET /api/v3/
  if (route.length === 0) {
    if (method !== 'GET') {
      notFound();
      return;
    }
    send(
      200,
      { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' },
      { 'X-OAuth-Scopes': 'repo, read:org' },
    );
    return;
  }

  // ------------------------------------------------------------ GET /api/v3/meta
  if (route.length === 1 && route[0] === 'meta') {
    if (method !== 'GET') {
      notFound();
      return;
    }
    send(200, { installed_version: '1.0.0', verifiable_password_authentication: true, gitHubServices: true });
    return;
  }

  // ------------------------------------------------------------ GET /api/v3/user
  if (route.length === 1 && route[0] === 'user') {
    if (method !== 'GET') {
      notFound();
      return;
    }
    send(200, {
      login: VIEWER_LOGIN,
      id: 1000,
      name: VIEWER_LOGIN,
      email: `${VIEWER_LOGIN}@example.invalid`,
      type: 'User',
    });
    return;
  }

  // ------------------------------------------------------------ /api/v3/user/repos
  if (route.length === 2 && route[0] === 'user' && route[1] === 'repos') {
    if (method === 'GET') {
      sendList(forge.listRepos(), (repo) => repoView(repo));
      return;
    }
    if (method === 'POST') {
      const name = asString(body.name) ?? '';
      if (name === '' || !isRepoName(name)) {
        unprocessable('invalid repository name');
        return;
      }
      const repo = forge.createRepo(name, body.private === true, asString(body.description) ?? '');
      if (repo === null) {
        unprocessable('repository already exists');
        return;
      }
      send(201, repoView(repo));
      return;
    }
    notFound();
    return;
  }

  // ------------------------------------------------------------ /api/v3/repos/{owner}/{repo}/...
  if (route.length >= 3 && route[0] === 'repos') {
    const owner = route[1] as string;
    const repoName = route[2] as string;
    const repo = repoAt(owner, repoName);
    if (repo === null) {
      send(404, { message: 'Not Found' });
      return;
    }
    const sub = route.slice(3);

    // GET / PATCH / DELETE /repos/{owner}/{repo}
    if (sub.length === 0) {
      if (method === 'GET') {
        send(200, repoView(repo));
        return;
      }
      if (method === 'PATCH') {
        const description = asString(body.description);
        if (description !== undefined) repo.description = description;
        const branch = asString(body.default_branch);
        if (branch !== undefined && repo.refs.has(`refs/heads/${branch}`)) {
          repo.default_branch = branch;
        }
        send(200, repoView(repo));
        return;
      }
      if (method === 'DELETE') {
        forge.deleteRepo(repo.owner, repo.name);
        ctx.sendBare(204);
        return;
      }
      notFound();
      return;
    }

    // -------------------------------------------------------- branches
    if (sub[0] === 'branches') {
      if (sub.length === 1 && method === 'GET') {
        const branches: JsonObj[] = [];
        for (const [ref, sha] of repo.refs) {
          if (!ref.startsWith('refs/heads/')) continue;
          branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
        }
        branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        send(200, branches);
        return;
      }
      if (sub.length === 2 && method === 'GET') {
        const tip = repo.refs.get(`refs/heads/${sub[1] as string}`);
        if (tip === undefined) {
          send(404, { message: 'branch not found' });
          return;
        }
        send(200, { name: sub[1], commit: { sha: tip }, protected: false });
        return;
      }
      notFound();
      return;
    }

    // -------------------------------------------------------- git refs
    if (sub[0] === 'git' && sub[1] === 'refs') {
      if (sub.length === 2 && method === 'POST') {
        const ref = asString(body.ref) ?? '';
        const sha = asString(body.sha) ?? '';
        if (!ref.startsWith('refs/') || sha === '') {
          unprocessable('invalid ref');
          return;
        }
        if (repo.refs.has(ref)) {
          unprocessable('reference already exists');
          return;
        }
        const object = repo.objects.get(sha);
        if (object === undefined) {
          unprocessable('object not found');
          return;
        }
        repo.refs.set(ref, sha);
        send(201, { ref, object: { sha, type: object.type } });
        return;
      }
      if (sub.length === 2 && method === 'GET') {
        const refs: JsonObj[] = [];
        for (const [ref, sha] of repo.refs) {
          const object = repo.objects.get(sha);
          refs.push({ ref, object: { sha, type: object?.type ?? 'commit' } });
        }
        send(200, refs);
        return;
      }
      if (sub.length === 4 && sub[2] === 'heads' && method === 'GET') {
        const tip = repo.refs.get(`refs/heads/${sub[3] as string}`);
        if (tip === undefined) {
          send(404, { message: 'reference not found' });
          return;
        }
        const object = repo.objects.get(tip);
        send(200, { ref: `refs/heads/${sub[3]}`, object: { sha: tip, type: object?.type ?? 'commit' } });
        return;
      }
      notFound();
      return;
    }

    // -------------------------------------------------------- commits
    if (sub.length === 1 && sub[0] === 'commits' && method === 'GET') {
      const tip = resolveCommitsTip(repo, url.searchParams.get('sha') ?? undefined);
      if (tip === null) {
        send(200, []);
        return;
      }
      send(200, walkCommits(repo, tip));
      return;
    }

    // -------------------------------------------------------- contents
    if (sub[0] === 'contents') {
      const contentPath = sub.slice(1).join('/');
      const branch = asString(body.branch) ?? url.searchParams.get('ref') ?? repo.default_branch;
      const ref = branchRef(branch);
      const baseName = contentPath.split('/').pop() ?? '';

      if (method === 'PUT') {
        if (contentPath === '') {
          notFound();
          return;
        }
        const message = asString(body.message);
        if (message === undefined || message === '') {
          unprocessable('message is required');
          return;
        }
        const contentB64 = asString(body.content);
        if (contentB64 === undefined) {
          unprocessable('content is required');
          return;
        }
        const stripped = contentB64.replace(/[\r\n]/g, '');
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(stripped) || stripped.length % 4 !== 0) {
          unprocessable('content is not valid base64');
          return;
        }
        const content = Buffer.from(contentB64, 'base64');
        const existing = forge.fileAt(repo, ref, contentPath);
        const sha = asString(body.sha);
        if (existing !== null && sha !== undefined && sha !== existing.blobSha) {
          send(409, { message: 'sha does not match the current blob' });
          return;
        }
        const isUpdate = existing !== null;
        const { commitSha, blobSha } = forge.commitFile(repo, branch, contentPath, content, message);
        send(isUpdate ? 200 : 201, {
          content: { name: baseName, path: contentPath, sha: blobSha, size: content.length, content: contentB64, encoding: 'base64' },
          commit: { sha: commitSha, message },
        });
        return;
      }

      if (method === 'GET') {
        const file = contentPath === '' ? null : forge.fileAt(repo, ref, contentPath);
        if (file !== null) {
          send(200, {
            name: baseName,
            path: contentPath,
            sha: file.blobSha,
            size: file.content.length,
            content: file.content.toString('base64'),
            encoding: 'base64',
            type: 'file',
          });
          return;
        }
        const dir = forge.dirAt(repo, ref, contentPath);
        if (dir !== null) {
          send(
            200,
            dir.map((entry) => ({
              ...entry,
              size: entry.type === 'file' ? (forge.fileAt(repo, ref, entry.path)?.content.length ?? 0) : 0,
            })),
          );
          return;
        }
        send(404, { message: 'Not Found' });
        return;
      }

      if (method === 'DELETE') {
        if (contentPath === '') {
          notFound();
          return;
        }
        const sha = asString(body.sha);
        const existing = forge.fileAt(repo, ref, contentPath);
        if (existing === null) {
          send(404, { message: 'Not Found' });
          return;
        }
        if (sha !== undefined && sha !== existing.blobSha) {
          send(409, { message: 'sha does not match the current blob' });
          return;
        }
        const message = asString(body.message) ?? 'delete file';
        const commitSha = forge.deleteFile(repo, branch, contentPath, message);
        if (commitSha === null) {
          send(404, { message: 'Not Found' });
          return;
        }
        send(200, { commit: { sha: commitSha, message } });
        return;
      }

      notFound();
      return;
    }

    // -------------------------------------------------------- labels
    if (sub.length === 1 && sub[0] === 'labels') {
      if (method === 'GET') {
        send(
          200,
          [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })),
        );
        return;
      }
      if (method === 'POST') {
        const name = asString(body.name) ?? '';
        if (name === '') {
          unprocessable('invalid label name');
          return;
        }
        const color = asString(body.color) ?? 'ededed';
        const existing = repo.labels.get(name);
        if (existing !== undefined) {
          send(201, { name: existing.name, color: existing.color });
          return;
        }
        repo.labels.set(name, { name, color });
        send(201, { name, color });
        return;
      }
      notFound();
      return;
    }

    // -------------------------------------------------------- issues
    if (sub[0] === 'issues') {
      if (sub.length === 1) {
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const sort = url.searchParams.get('sort') ?? 'created';
          const direction = url.searchParams.get('direction') ?? 'asc';
          let issues = [...repo.issues.values()];
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          if (sort === 'created') {
            issues.sort((a, b) => (direction === 'desc' ? b.number - a.number : a.number - b.number));
          }
          sendList(issues, (issue) => issueView(repo, issue));
          return;
        }
        if (method === 'POST') {
          const title = asString(body.title) ?? '';
          if (title === '') {
            unprocessable('title is required');
            return;
          }
          const bodyText = asString(body.body) ?? '';
          const labelNames: string[] = [];
          if (Array.isArray(body.labels)) {
            for (const entry of body.labels) {
              if (typeof entry === 'string') labelNames.push(entry);
              else if (isObject(entry) && typeof entry.name === 'string') labelNames.push(entry.name);
            }
          }
          const created = forge.createIssue(repo, title, bodyText, labelNames);
          if ('error' in created) {
            unprocessable(created.error);
            return;
          }
          send(201, issueView(repo, created));
          return;
        }
        notFound();
        return;
      }

      const issueNumber = Number(sub[1]);
      // The read workload hammers this path: one Map get, no scan.
      const issue: Issue | undefined = Number.isInteger(issueNumber) ? repo.issues.get(issueNumber) : undefined;

      if (sub.length === 2) {
        if (issue === undefined) {
          send(404, { message: 'issue not found' });
          return;
        }
        if (method === 'GET') {
          send(200, issueView(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          const title = asString(body.title);
          if (title !== undefined) issue.title = title;
          const bodyText = asString(body.body);
          if (bodyText !== undefined) issue.body = bodyText;
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          issue.updated_at = new Date().toISOString();
          send(200, issueView(repo, issue));
          return;
        }
        notFound();
        return;
      }

      if (sub.length === 3 && sub[2] === 'comments') {
        if (issue === undefined) {
          send(404, { message: 'issue not found' });
          return;
        }
        if (method === 'GET') {
          send(200, issue.comments);
          return;
        }
        if (method === 'POST') {
          const bodyText = asString(body.body) ?? '';
          const now = new Date().toISOString();
          commentCounter += 1;
          const comment = {
            id: commentCounter,
            body: bodyText,
            user: { login: VIEWER_LOGIN },
            created_at: now,
            updated_at: now,
          };
          issue.comments.push(comment);
          send(201, comment);
          return;
        }
        notFound();
        return;
      }

      notFound();
      return;
    }

    // -------------------------------------------------------- pull requests
    if (sub[0] === 'pulls') {
      if (sub.length === 1) {
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          let pulls = [...repo.pulls.values()];
          if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
          pulls.sort((a, b) => a.number - b.number);
          sendList(pulls, (pull) => pullView(repo, pull));
          return;
        }
        if (method === 'POST') {
          const title = asString(body.title) ?? '';
          const head = asString(body.head) ?? '';
          const base = asString(body.base) ?? '';
          const bodyText = asString(body.body) ?? '';
          const created = forge.createPull(repo, title, bodyText, head, base);
          if ('error' in created) {
            unprocessable(created.error);
            return;
          }
          send(201, pullView(repo, created));
          return;
        }
        notFound();
        return;
      }

      const pullNumber = Number(sub[1]);
      const pull: Pull | undefined = Number.isInteger(pullNumber) ? repo.pulls.get(pullNumber) : undefined;

      if (sub.length === 2) {
        if (pull === undefined) {
          send(404, { message: 'pull request not found' });
          return;
        }
        if (method === 'GET') {
          send(200, pullView(repo, pull));
          return;
        }
        notFound();
        return;
      }

      if (sub.length === 3 && sub[2] === 'files' && method === 'GET') {
        if (pull === undefined) {
          send(404, { message: 'pull request not found' });
          return;
        }
        send(200, forge.pullFiles(repo, pull));
        return;
      }

      if (sub.length === 3 && sub[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) {
          send(404, { message: 'pull request not found' });
          return;
        }
        const mergeMethod = asString(body.merge_method) ?? 'squash';
        const merged = forge.mergePull(repo, pull, mergeMethod);
        if ('error' in merged) {
          send(merged.status, { message: merged.error });
          return;
        }
        send(200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
        return;
      }

      notFound();
      return;
    }

    notFound();
    return;
  }

  notFound();
}
