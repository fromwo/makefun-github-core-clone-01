// app.ts — the HTTP server for the forge: REST v3, GraphQL, MCP and git smart HTTP,
// all served from the single in-memory Forge in store.ts.
//
// This is an independent implementation of the same wire contract. It keeps the
// public surface identical (createApp, same routes, same statuses and bodies) but
// organises the dispatch and helpers its own way.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { parseCommit } from './gitcore.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcpRequest } from './mcp.ts';
import { Forge, VIEWER_EMAIL, VIEWER_LOGIN, VIEWER_NAME, isRepoName, issueView, pullView, repoView } from './store.ts';
import type { Repo } from './store.ts';

/** The bearer token the suite presents; empty means any non-empty token is accepted. */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/** Bodies larger than this are refused outright. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

/** Monotonic, deterministic request ids: gh-forge-00000001, gh-forge-00000002, ... */
function nextRequestId(): string {
  requestCounter += 1;
  return `gh-forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read the whole request body, rejecting when it grows past MAX_BODY_BYTES. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The first value of a header that may repeat. */
function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The bearer token from Authorization, or null when the header is absent/malformed. */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? (match[1] as string) : null;
}

/** True when the request carries a usable bearer token. */
function authorized(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

// --------------------------------------------------------------------------- replies

interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  raw?: Buffer;
  contentType?: string;
}

function okReply(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return { status, headers, body };
}

function errorReply(status: number, message: string): Reply {
  return okReply(status, { message });
}

// --------------------------------------------------------------------------- pagination

interface PageParams {
  page: number;
  perPage: number;
}

function pageParams(url: URL): PageParams {
  const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  const perPage = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
  return {
    page: Number.isFinite(page) && page >= 1 ? page : 1,
    perPage: Number.isFinite(perPage) && perPage >= 1 ? Math.min(perPage, 100) : 30,
  };
}

function slicePage<T>(items: T[], page: number, perPage: number): { pageItems: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { pageItems: items.slice(start, start + perPage), totalPages };
}

/** The RFC 5988 Link header for a paginated list, or '' when there is one page. */
function pageLinks(req: IncomingMessage, url: URL, page: number, perPage: number, totalPages: number): string {
  const origin = `http://${req.headers.host ?? 'localhost'}`;
  const base = `${origin}${url.pathname}`;
  const link = (p: number, rel: string): string => `<${base}?page=${p}&per_page=${perPage}>; rel="${rel}"`;
  const parts: string[] = [];
  if (page < totalPages) parts.push(link(page + 1, 'next'), link(totalPages, 'last'));
  if (page > 1) parts.push(link(page - 1, 'prev'), link(1, 'first'));
  return parts.join(', ');
}

// --------------------------------------------------------------------------- commits

interface CommitEntry {
  sha: string;
  commit: Record<string, unknown>;
  parents: { sha: string }[];
}

/** Parse a "Name <email> timestamp tz" person line into its parts. */
function parsePerson(text: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(text);
  if (!match) return { name: text, email: '', date: '' };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

/** All commits reachable from `tip`, newest first. */
function collectCommits(forge: Forge, repo: Repo, tip: string): CommitEntry[] {
  const defaultTip = forge.refCommit(repo, `refs/heads/${repo.default_branch}`);
  // When the tip is not the default branch's tip, commits the default branch
  // already has are left out.
  const hideBase = defaultTip !== undefined && defaultTip !== tip;
  const hidden = new Set<string>();
  if (hideBase && defaultTip) {
    const stack = [defaultTip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (hidden.has(oid)) continue;
      hidden.add(oid);
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) stack.push(parent);
      }
    }
  }
  const out: CommitEntry[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    if (hideBase && hidden.has(oid)) continue;
    const parsed = parseCommit(object.data);
    const author = parsePerson(parsed.author);
    const committer = parsePerson(parsed.committer);
    out.push({
      sha: oid,
      commit: {
        message: parsed.message,
        author: { name: author.name, email: author.email, date: author.date },
        committer: { name: committer.name, email: committer.email, date: committer.date },
        tree: { sha: parsed.tree },
      },
      parents: parsed.parents.map((parent) => ({ sha: parent })),
    });
    for (let i = parsed.parents.length - 1; i >= 0; i -= 1) stack.push(parsed.parents[i] as string);
  }
  return out;
}

/**
 * Resolve the ?sha= query parameter of the commits list: a full ref name, a
 * branch name, or a commit oid. Returns null when nothing matches.
 */
function resolveCommitTip(forge: Forge, repo: Repo, shaParam: string | undefined): string | null {
  if (shaParam === undefined || shaParam === '') {
    return forge.refCommit(repo, `refs/heads/${repo.default_branch}`) ?? null;
  }
  if (repo.refs.has(shaParam)) return forge.refCommit(repo, shaParam) ?? null;
  const asBranch = `refs/heads/${shaParam}`;
  if (repo.refs.has(asBranch)) return forge.refCommit(repo, asBranch) ?? null;
  const object = repo.objects.get(shaParam);
  if (object && object.type === 'commit') return shaParam;
  return null;
}

// --------------------------------------------------------------------------- app

export function createApp(): Server {
  const forge = new Forge();

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = nextRequestId();

    /** Send a Reply: JSON by default, raw bytes for git responses. */
    const send = (reply: Reply): void => {
      const headers: Record<string, string> = { 'X-GitHub-Request-Id': requestId, ...(reply.headers ?? {}) };
      if (reply.raw !== undefined) {
        res.writeHead(reply.status, { 'Content-Type': reply.contentType ?? 'application/octet-stream', ...headers });
        res.end(reply.raw);
        return;
      }
      res.writeHead(reply.status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(reply.body ?? null));
    };

    /** Send a bare status with only the request-id header (204s, notifications). */
    const sendBare = (status: number): void => {
      res.writeHead(status, { 'X-GitHub-Request-Id': requestId });
      res.end();
    };

    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = (req.method ?? 'GET').toUpperCase();
      const path = decodeURIComponent(url.pathname);
      const segments = path.split('/').filter((part) => part !== '');

      /** Send a paginated list: slice the page, map the view, add a Link header when needed. */
      const sendList = <T>(items: T[], view: (item: T) => unknown): void => {
        const { page, perPage } = pageParams(url);
        const { pageItems, totalPages } = slicePage(items, page, perPage);
        const headers: Record<string, string> = {};
        const link = pageLinks(req, url, page, perPage, totalPages);
        if (link !== '') headers.Link = link;
        send(okReply(200, pageItems.map(view), headers));
      };

      // ------------------------------------------------------------ health check (no auth)
      if (method === 'GET' && path === '/healthz') {
        send(okReply(200, { ok: true }));
        return;
      }

      // ------------------------------------------------------------ git smart HTTP
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
      if (gitMatch) {
        const owner = gitMatch[1] as string;
        const repoName = gitMatch[2] as string;
        const suffix = gitMatch[3] as string;
        if (!authorized(req)) {
          send(errorReply(401, 'requires authentication'));
          return;
        }
        if (method === 'GET' && suffix === 'info/refs') {
          const result = handleInfoRefs(forge, owner, repoName, url.searchParams.get('service') ?? '', firstHeader(req.headers['git-protocol']));
          send({ status: result.status, contentType: result.contentType, raw: result.body });
          return;
        }
        if (method === 'POST' && suffix === 'git-upload-pack') {
          const body = await readBody(req);
          const result = handleUploadPack(forge, owner, repoName, body, firstHeader(req.headers['git-protocol']));
          send({ status: result.status, contentType: result.contentType, raw: result.body });
          return;
        }
        if (method === 'POST' && suffix === 'git-receive-pack') {
          const body = await readBody(req);
          const result = handleReceivePack(forge, owner, repoName, body);
          send({ status: result.status, contentType: result.contentType, raw: result.body });
          return;
        }
        send(errorReply(404, 'not found'));
        return;
      }

      // ------------------------------------------------------------ GraphQL
      if (method === 'POST' && path === '/api/graphql') {
        if (!authorized(req)) {
          send(errorReply(401, 'requires authentication'));
          return;
        }
        const raw = await readBody(req);
        let body: unknown;
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          send(errorReply(400, 'malformed JSON body'));
          return;
        }
        send(okReply(200, executeGraphQL(forge, body)));
        return;
      }

      // ------------------------------------------------------------ MCP
      if (method === 'POST' && path === '/mcp') {
        if (!authorized(req)) {
          send(errorReply(401, 'requires authentication'));
          return;
        }
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          send(okReply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
          return;
        }
        const outcome = handleMcpRequest(forge, parsed);
        if (outcome.body === null) {
          sendBare(outcome.status);
          return;
        }
        send(okReply(outcome.status, outcome.body));
        return;
      }

      // ------------------------------------------------------------ REST v3
      if (segments[0] === 'api' && segments[1] === 'v3') {
        const route = segments.slice(2);
        if (!authorized(req)) {
          send(errorReply(401, 'requires authentication'));
          return;
        }
        const raw = await readBody(req);
        let data: JsonObject = {};
        if (raw.length > 0) {
          try {
            const parsed = JSON.parse(raw.toString('utf8'));
            if (isJsonObject(parsed)) {
              data = parsed;
            } else if (!Array.isArray(parsed)) {
              send(errorReply(400, 'malformed JSON body'));
              return;
            }
            // A JSON array body parses but carries no fields; treat it as {}.
          } catch {
            send(errorReply(400, 'malformed JSON body'));
            return;
          }
        }

        /** The repository named by /repos/{owner}/{repo}, or null (404, never 403). */
        const repoOf = (): Repo | null => forge.getRepo(route[1] as string, route[2] as string) ?? null;

        // GET /api/v3/
        if (route.length === 0) {
          if (method !== 'GET') {
            send(errorReply(404, 'not found'));
            return;
          }
          send(okReply(200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'X-OAuth-Scopes': 'repo, read:org' }));
          return;
        }

        // GET /api/v3/meta
        if (route.length === 1 && route[0] === 'meta' && method === 'GET') {
          send(okReply(200, { installed_version: '0.1.0', verifiable_password_authentication: true, gitHubServices: true }));
          return;
        }

        // GET /api/v3/user
        if (route.length === 1 && route[0] === 'user' && method === 'GET') {
          send(okReply(200, { login: VIEWER_LOGIN, id: 1000, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' }));
          return;
        }

        // /api/v3/user/repos
        if (route.length === 2 && route[0] === 'user' && route[1] === 'repos') {
          if (method === 'GET') {
            sendList(forge.listRepos(), (repo) => repoView(repo));
            return;
          }
          if (method === 'POST') {
            const name = typeof data.name === 'string' ? data.name : '';
            if (name === '' || !isRepoName(name)) {
              send(errorReply(422, 'invalid repository name'));
              return;
            }
            const repo = forge.createRepo(name, data.private === true, typeof data.description === 'string' ? data.description : '');
            if (repo === null) {
              send(errorReply(422, 'repository already exists'));
              return;
            }
            send(okReply(201, repoView(repo)));
            return;
          }
          send(errorReply(404, 'not found'));
          return;
        }

        // /api/v3/repos/{owner}/{repo}...
        if (route.length >= 3 && route[0] === 'repos') {
          const repo = repoOf();
          if (repo === null) {
            send(errorReply(404, 'not found'));
            return;
          }
          const sub = route.slice(3);

          // GET / PATCH / DELETE /repos/{owner}/{repo}
          if (sub.length === 0) {
            if (method === 'GET') {
              send(okReply(200, repoView(repo)));
              return;
            }
            if (method === 'PATCH') {
              if (typeof data.description === 'string') repo.description = data.description;
              if (typeof data.default_branch === 'string' && repo.refs.has(`refs/heads/${data.default_branch}`)) {
                repo.default_branch = data.default_branch;
              }
              send(okReply(200, repoView(repo)));
              return;
            }
            if (method === 'DELETE') {
              forge.deleteRepo(repo.owner, repo.name);
              sendBare(204);
              return;
            }
            send(errorReply(404, 'not found'));
            return;
          }

          // GET /repos/{owner}/{repo}/branches
          if (sub.length === 1 && sub[0] === 'branches' && method === 'GET') {
            const branches = forge.branchNames(repo).map((name) => ({
              name,
              commit: { sha: forge.refCommit(repo, `refs/heads/${name}`) },
              protected: false,
            }));
            send(okReply(200, branches));
            return;
          }

          // GET /repos/{owner}/{repo}/branches/{branch}
          if (sub.length === 2 && sub[0] === 'branches' && method === 'GET') {
            const branch = sub[1] as string;
            const tip = forge.refCommit(repo, `refs/heads/${branch}`);
            if (!tip) {
              send(errorReply(404, 'branch not found'));
              return;
            }
            send(okReply(200, { name: branch, commit: { sha: tip }, protected: false }));
            return;
          }

          // POST /repos/{owner}/{repo}/git/refs
          if (sub.length === 2 && sub[0] === 'git' && sub[1] === 'refs' && method === 'POST') {
            const ref = typeof data.ref === 'string' ? data.ref : '';
            const sha = typeof data.sha === 'string' ? data.sha : '';
            if (!ref.startsWith('refs/') || sha === '') {
              send(errorReply(422, 'invalid ref'));
              return;
            }
            if (repo.refs.has(ref)) {
              send(errorReply(422, 'reference already exists'));
              return;
            }
            const object = repo.objects.get(sha);
            if (!object) {
              send(errorReply(422, 'object not found'));
              return;
            }
            repo.refs.set(ref, sha);
            send(okReply(201, { ref, object: { sha, type: object.type } }));
            return;
          }

          // GET /repos/{owner}/{repo}/git/refs/heads/{branch}
          if (sub.length === 4 && sub[0] === 'git' && sub[1] === 'refs' && sub[2] === 'heads' && method === 'GET') {
            const branch = sub[3] as string;
            const tip = repo.refs.get(`refs/heads/${branch}`);
            if (!tip) {
              send(errorReply(404, 'reference not found'));
              return;
            }
            const object = repo.objects.get(tip);
            send(okReply(200, { ref: `refs/heads/${branch}`, object: { sha: tip, type: object?.type ?? 'commit' } }));
            return;
          }

          // GET /repos/{owner}/{repo}/commits
          if (sub.length === 1 && sub[0] === 'commits' && method === 'GET') {
            const tip = resolveCommitTip(forge, repo, url.searchParams.get('sha') ?? undefined);
            if (tip === null) {
              send(okReply(200, []));
              return;
            }
            send(okReply(200, collectCommits(forge, repo, tip)));
            return;
          }

          // /repos/{owner}/{repo}/contents/{path...}
          if (sub.length >= 2 && sub[0] === 'contents') {
            const contentPath = sub.slice(1).join('/');
            const branch = typeof data.branch === 'string' ? data.branch : (url.searchParams.get('ref') ?? repo.default_branch);
            if (method === 'PUT') {
              const message = typeof data.message === 'string' ? data.message : 'update file';
              const contentB64 = typeof data.content === 'string' ? data.content : '';
              let content: Buffer;
              try {
                content = Buffer.from(contentB64, 'base64');
              } catch {
                send(errorReply(400, 'invalid base64 content'));
                return;
              }
              const existing = forge.fileAt(repo, `refs/heads/${branch}`, contentPath);
              const sha = typeof data.sha === 'string' ? data.sha : undefined;
              if (existing && sha !== undefined && sha !== existing.blobSha) {
                send(errorReply(409, 'sha does not match the current blob'));
                return;
              }
              const isUpdate = existing !== null;
              const { commitSha, blobSha } = forge.commitFile(repo, branch, contentPath, content, message);
              send(okReply(isUpdate ? 200 : 201, {
                content: { name: contentPath.split('/').pop(), path: contentPath, sha: blobSha, size: content.length, content: contentB64, encoding: 'base64' },
                commit: { sha: commitSha, message },
              }));
              return;
            }
            if (method === 'GET') {
              const file = forge.fileAt(repo, `refs/heads/${branch}`, contentPath);
              if (file) {
                send(okReply(200, {
                  name: contentPath.split('/').pop(),
                  path: contentPath,
                  sha: file.blobSha,
                  size: file.content.length,
                  content: file.content.toString('base64'),
                  encoding: 'base64',
                  type: 'file',
                }));
                return;
              }
              const dir = forge.dirAt(repo, `refs/heads/${branch}`, contentPath);
              if (dir) {
                send(okReply(200, dir.map((entry) => ({
                  ...entry,
                  size: entry.type === 'file' ? (forge.fileAt(repo, `refs/heads/${branch}`, entry.path)?.content.length ?? 0) : 0,
                }))));
                return;
              }
              send(errorReply(404, 'not found'));
              return;
            }
            if (method === 'DELETE') {
              const sha = typeof data.sha === 'string' ? data.sha : undefined;
              const existing = forge.fileAt(repo, `refs/heads/${branch}`, contentPath);
              if (!existing) {
                send(errorReply(404, 'not found'));
                return;
              }
              if (sha !== undefined && sha !== existing.blobSha) {
                send(errorReply(409, 'sha does not match the current blob'));
                return;
              }
              const message = typeof data.message === 'string' ? data.message : 'delete file';
              const commitSha = forge.deleteFile(repo, branch, contentPath, message);
              if (commitSha === null) {
                send(errorReply(404, 'not found'));
                return;
              }
              send(okReply(200, { commit: { sha: commitSha, message } }));
              return;
            }
            send(errorReply(404, 'not found'));
            return;
          }

          // GET / POST /repos/{owner}/{repo}/labels
          if (sub.length === 1 && sub[0] === 'labels') {
            if (method === 'GET') {
              send(okReply(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color }))));
              return;
            }
            if (method === 'POST') {
              const name = typeof data.name === 'string' ? data.name : '';
              const color = typeof data.color === 'string' ? data.color : 'ededed';
              if (name === '') {
                send(errorReply(422, 'invalid label name'));
                return;
              }
              repo.labels.set(name, { name, color });
              send(okReply(201, { name, color }));
              return;
            }
            send(errorReply(404, 'not found'));
            return;
          }

          // /repos/{owner}/{repo}/issues...
          if (sub[0] === 'issues') {
            // GET / POST /repos/{owner}/{repo}/issues
            if (sub.length === 1) {
              if (method === 'GET') {
                const state = url.searchParams.get('state') ?? 'open';
                const sort = url.searchParams.get('sort') ?? 'created';
                const direction = url.searchParams.get('direction') ?? 'asc';
                let issues = [...repo.issues.values()];
                if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
                if (sort === 'created') issues.sort((a, b) => (direction === 'desc' ? b.number - a.number : a.number - b.number));
                sendList(issues, (issue) => issueView(repo, issue));
                return;
              }
              if (method === 'POST') {
                const title = typeof data.title === 'string' ? data.title : '';
                const bodyText = typeof data.body === 'string' ? data.body : '';
                const labelNames = Array.isArray(data.labels)
                  ? data.labels.filter((entry): entry is string => typeof entry === 'string')
                  : [];
                if (title === '') {
                  send(errorReply(422, 'title is required'));
                  return;
                }
                const created = forge.createIssue(repo, title, bodyText, labelNames);
                if ('error' in created) {
                  send(errorReply(422, created.error));
                  return;
                }
                send(okReply(201, issueView(repo, created)));
                return;
              }
              send(errorReply(404, 'not found'));
              return;
            }

            // /repos/{owner}/{repo}/issues/{n} and /issues/{n}/comments
            const issueNumber = Number(sub[1]);
            const issue = Number.isInteger(issueNumber) ? repo.issues.get(issueNumber) : undefined;
            if (sub.length === 2) {
              if (!issue) {
                send(errorReply(404, 'issue not found'));
                return;
              }
              if (method === 'GET') {
                send(okReply(200, issueView(repo, issue)));
                return;
              }
              if (method === 'PATCH') {
                if (typeof data.title === 'string') issue.title = data.title;
                if (typeof data.body === 'string') issue.body = data.body;
                if (data.state === 'open' || data.state === 'closed') issue.state = data.state;
                issue.updated_at = forge.nowIso();
                send(okReply(200, issueView(repo, issue)));
                return;
              }
              send(errorReply(404, 'not found'));
              return;
            }
            if (sub.length === 3 && sub[2] === 'comments') {
              if (!issue) {
                send(errorReply(404, 'issue not found'));
                return;
              }
              if (method === 'GET') {
                send(okReply(200, issue.comments));
                return;
              }
              if (method === 'POST') {
                const bodyText = typeof data.body === 'string' ? data.body : '';
                const now = forge.nowIso();
                const comment = {
                  id: forge.nextSeq() + 100000,
                  body: bodyText,
                  user: { login: VIEWER_LOGIN },
                  created_at: now,
                  updated_at: now,
                };
                issue.comments.push(comment);
                send(okReply(201, comment));
                return;
              }
              send(errorReply(404, 'not found'));
              return;
            }
            send(errorReply(404, 'not found'));
            return;
          }

          // /repos/{owner}/{repo}/pulls...
          if (sub[0] === 'pulls') {
            // GET / POST /repos/{owner}/{repo}/pulls
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
                const title = typeof data.title === 'string' ? data.title : '';
                const head = typeof data.head === 'string' ? data.head : '';
                const base = typeof data.base === 'string' ? data.base : '';
                const bodyText = typeof data.body === 'string' ? data.body : '';
                const created = forge.createPull(repo, title, bodyText, head, base);
                if ('error' in created) {
                  send(errorReply(422, created.error));
                  return;
                }
                send(okReply(201, pullView(repo, created)));
                return;
              }
              send(errorReply(404, 'not found'));
              return;
            }

            const pullNumber = Number(sub[1]);
            const pull = Number.isInteger(pullNumber) ? repo.pulls.get(pullNumber) : undefined;
            // GET /repos/{owner}/{repo}/pulls/{n}
            if (sub.length === 2) {
              if (!pull) {
                send(errorReply(404, 'pull request not found'));
                return;
              }
              if (method === 'GET') {
                send(okReply(200, pullView(repo, pull)));
                return;
              }
              send(errorReply(404, 'not found'));
              return;
            }
            // GET /repos/{owner}/{repo}/pulls/{n}/files
            if (sub.length === 3 && sub[2] === 'files' && method === 'GET') {
              if (!pull) {
                send(errorReply(404, 'pull request not found'));
                return;
              }
              send(okReply(200, forge.pullFiles(repo, pull)));
              return;
            }
            // PUT /repos/{owner}/{repo}/pulls/{n}/merge
            if (sub.length === 3 && sub[2] === 'merge' && method === 'PUT') {
              if (!pull) {
                send(errorReply(404, 'pull request not found'));
                return;
              }
              const mergeMethod = typeof data.merge_method === 'string' ? data.merge_method : 'squash';
              const merged = forge.mergePull(repo, pull, mergeMethod);
              if ('error' in merged) {
                send(errorReply(merged.status, merged.error));
                return;
              }
              send(okReply(200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' }));
              return;
            }
            send(errorReply(404, 'not found'));
            return;
          }

          send(errorReply(404, 'not found'));
          return;
        }

        send(errorReply(404, 'not found'));
        return;
      }

      send(errorReply(404, 'not found'));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': requestId });
        res.end(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
      } else {
        res.end();
      }
    }
  };

  return createServer(handler);
}
