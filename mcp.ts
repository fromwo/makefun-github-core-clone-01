// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0).
//
// Speaks both eras the rules accept: the modern 2026-07-28 `server/discover`
// (no handshake, no session) and the legacy `initialize` handshake. Every
// request is answered from the Forge passed in; this module keeps no state
// between requests, so two concurrent tools/call answers can never trade
// ids or arguments. Node 22 standard library only, no dependencies.

import { issueView, pullView, repoView } from './forge.ts';
import type { Forge } from './forge.ts';

export const MCP_SERVER_NAME = 'gh-forge';
export const MCP_SERVER_VERSION = '0.1.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** What the HTTP layer sends for one MCP request. A `body` of null means
 *  "send an empty body" — that is the answer to a notification, which the
 *  HTTP layer sends as a bare 202. */
export interface McpOutcome {
  status: number;
  body: unknown;
  contentType?: string;
}

// ---------------------------------------------------------------------------
// Tool catalogue — one frozen list, so tools/list is byte-identical every time
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, { type: string; description: string }>,
  required: string[],
): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

const TOOLS: readonly ToolDef[] = [
  toolDef('create_repo', 'Create a new repository owned by the viewer.', {
    name: { type: 'string', description: 'Name of the repository to create.' },
    description: { type: 'string', description: 'A short description of the repository.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  toolDef('get_repo', 'Read one repository by owner and name.', {
    owner: { type: 'string', description: 'Login of the repository owner.' },
    repo: { type: 'string', description: 'Name of the repository.' },
  }, ['owner', 'repo']),
  toolDef('create_issue', 'Open a new issue in a repository.', {
    owner: { type: 'string', description: 'Login of the repository owner.' },
    repo: { type: 'string', description: 'Name of the repository.' },
    title: { type: 'string', description: 'Title of the issue.' },
    body: { type: 'string', description: 'Body text of the issue.' },
  }, ['owner', 'repo', 'title']),
  toolDef('list_issues', 'List the issues of a repository, optionally filtered by state.', {
    owner: { type: 'string', description: 'Login of the repository owner.' },
    repo: { type: 'string', description: 'Name of the repository.' },
    state: { type: 'string', description: 'Issue state to keep: open, closed or all.' },
  }, ['owner', 'repo']),
  toolDef('create_pull_request', 'Open a pull request from a head branch into a base branch.', {
    owner: { type: 'string', description: 'Login of the repository owner.' },
    repo: { type: 'string', description: 'Name of the repository.' },
    title: { type: 'string', description: 'Title of the pull request.' },
    body: { type: 'string', description: 'Body text of the pull request.' },
    head: { type: 'string', description: 'Name of the head branch.' },
    base: { type: 'string', description: 'Name of the base branch.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  toolDef('merge_pull_request', 'Squash-merge a pull request.', {
    owner: { type: 'string', description: 'Login of the repository owner.' },
    repo: { type: 'string', description: 'Name of the repository.' },
    pull_number: { type: 'number', description: 'Number of the pull request to merge.' },
  }, ['owner', 'repo', 'pull_number']),
];
Object.freeze(TOOLS);

/** Obvious aliases a client may use instead of a canonical tool name. */
const TOOL_ALIASES: Record<string, readonly string[]> = {
  create_repo: ['create_repository', 'repo_create', 'repos_create', 'repository_create'],
  get_repo: ['get_repository', 'repo_get', 'repos_get', 'repository_get'],
  create_issue: ['issue_create', 'issues_create'],
  list_issues: ['issues_list', 'issue_list'],
  create_pull_request: ['pull_request_create', 'pulls_create', 'create_pr', 'pr_create'],
  merge_pull_request: ['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge'],
};

/** Lowercase, punctuation-free form of a name, for matching. */
function squashed(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Find a tool by the name the client sent: exact, aliased, or carrying a
 *  server prefix such as `github__create_issue` (suffix match). */
function findTool(rawName: string): ToolDef | undefined {
  const wanted = squashed(rawName);
  if (wanted === '') return undefined;
  for (const tool of TOOLS) {
    if (wanted === squashed(tool.name)) return tool;
    if (wanted.endsWith(squashed(tool.name)) && wanted.length > squashed(tool.name).length) return tool;
    for (const alias of TOOL_ALIASES[tool.name] ?? []) {
      if (wanted === squashed(alias)) return tool;
      if (wanted.endsWith(squashed(alias)) && wanted.length > squashed(alias).length) return tool;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// JSON-RPC envelope helpers
// ---------------------------------------------------------------------------

function serverInfo(): { name: string; version: string } {
  return { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
}

function capabilities(): { tools: Record<string, never> } {
  return { tools: {} };
}

function ok(id: unknown, result: unknown): McpOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id, result }, contentType: 'application/json' };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpOutcome {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } }, contentType: 'application/json' };
}

function toolResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---------------------------------------------------------------------------
// Argument normalisation
// ---------------------------------------------------------------------------

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** First present value under any of the given keys. */
function pickFrom(args: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = args[key];
    if (!isMissing(value)) return value;
  }
  return undefined;
}

/**
 * Map whatever argument spellings a client sends onto the canonical keys
 * the tools use. Clients map each documented argument onto the nearest
 * schema property and also fill `full_name` with `owner/repo`, so every
 * key below is read from several spellings and `full_name` fills whichever
 * of owner/repo is still missing.
 */
function resolveArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const owner = pickFrom(args, 'owner', 'owner_login', 'owner_name', 'org', 'organization', 'login', 'user', 'user_login');
  if (owner !== undefined) out.owner = owner;
  const repo = pickFrom(args, 'repo', 'repository', 'repository_name', 'repo_name', 'project', 'project_name');
  if (repo !== undefined) out.repo = repo;
  const name = pickFrom(args, 'name', 'repo', 'repository', 'repository_name', 'repo_name');
  if (name !== undefined) out.name = name;
  const fullName = pickFrom(args, 'full_name', 'fullName', 'repo_full_name', 'repository_full_name');
  if ((out.owner === undefined || out.repo === undefined) && typeof fullName === 'string') {
    const slash = fullName.indexOf('/');
    if (slash > 0) {
      if (out.owner === undefined) out.owner = fullName.slice(0, slash);
      if (out.repo === undefined) out.repo = fullName.slice(slash + 1);
    }
  }
  const title = pickFrom(args, 'title', 'issue_title', 'pr_title', 'pull_request_title', 'subject');
  if (title !== undefined) out.title = title;
  const body = pickFrom(args, 'body', 'issue_body', 'description', 'content', 'text');
  if (body !== undefined) out.body = body;
  const description = pickFrom(args, 'description', 'about', 'summary');
  if (description !== undefined) out.description = description;
  const isPrivate = pickFrom(args, 'private', 'is_private');
  if (isPrivate !== undefined) out.private = isPrivate;
  const state = pickFrom(args, 'state', 'status');
  if (state !== undefined) out.state = state;
  const head = pickFrom(args, 'head', 'head_ref', 'head_branch', 'source_branch', 'source', 'source_ref', 'from_branch', 'from', 'branch');
  if (head !== undefined) out.head = head;
  const base = pickFrom(args, 'base', 'base_ref', 'base_branch', 'target_branch', 'target', 'target_ref', 'into_branch', 'into');
  if (base !== undefined) out.base = base;
  const pullNumber = pickFrom(args, 'pull_number', 'pullNumber', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index');
  if (pullNumber !== undefined) out.pull_number = pullNumber;
  return out;
}

// ---------------------------------------------------------------------------
// Tool execution — every tool reads and writes the same Forge as REST
// ---------------------------------------------------------------------------

type ToolOutcome = { value: unknown } | { error: string };

function runTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome {
  const owner = String(args.owner ?? '');
  const repoName = String(args.repo ?? '');

  if (name === 'create_repo') {
    const repo = forge.createRepo(
      String(args.name ?? ''),
      args.private === true,
      typeof args.description === 'string' ? args.description : '',
    );
    if (repo === null) return { error: `repository ${String(args.name ?? '')} already exists` };
    return { value: repoView(repo) };
  }

  if (name === 'get_repo') {
    const repo = forge.getRepo(owner, repoName);
    if (repo === undefined) return { error: `repository ${owner}/${repoName} not found` };
    return { value: repoView(repo) };
  }

  if (name === 'create_issue') {
    const repo = forge.getRepo(owner, repoName);
    if (repo === undefined) return { error: `repository ${owner}/${repoName} not found` };
    const issue = forge.createIssueDirect(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '');
    return { value: issueView(repo, issue) };
  }

  if (name === 'list_issues') {
    const repo = forge.getRepo(owner, repoName);
    if (repo === undefined) return { error: `repository ${owner}/${repoName} not found` };
    const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
    const issues = [...repo.issues.values()]
      .filter((issue) => state === 'all' || issue.state === state)
      .sort((a, b) => a.number - b.number)
      .map((issue) => issueView(repo, issue));
    return { value: issues };
  }

  if (name === 'create_pull_request') {
    const repo = forge.getRepo(owner, repoName);
    if (repo === undefined) return { error: `repository ${owner}/${repoName} not found` };
    const pull = forge.createPull(
      repo,
      String(args.title ?? ''),
      typeof args.body === 'string' ? args.body : '',
      String(args.head ?? ''),
      String(args.base ?? ''),
    );
    if ('error' in pull) return { error: pull.error };
    return { value: pullView(repo, pull) };
  }

  if (name === 'merge_pull_request') {
    const repo = forge.getRepo(owner, repoName);
    if (repo === undefined) return { error: `repository ${owner}/${repoName} not found` };
    const number = Number(args.pull_number);
    if (!Number.isInteger(number)) return { error: `pull request number "${String(args.pull_number ?? '')}" is not a number` };
    const pull = repo.pulls.get(number);
    if (pull === undefined) return { error: `pull request #${number} not found` };
    const merged = forge.mergePull(repo, pull, 'squash');
    if ('error' in merged) return { error: merged.error };
    return { value: pullView(repo, pull) };
  }

  return { error: `unknown tool: ${name}` };
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

/** Execute one JSON-RPC request object against the forge. Authentication
 *  is the HTTP layer's job: by the time this runs, the request is already
 *  authenticated, and a body that failed to parse arrives here as a raw
 *  string, which answers 400 with -32700. */
export function handleMcpRequest(forge: Forge, request: unknown): McpOutcome {
  // A body that is not JSON reaches here unparsed, as its raw text.
  if (typeof request === 'string') {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (request === null || typeof request !== 'object') {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (Array.isArray(request)) {
    return rpcError(null, -32600, 'Invalid Request: batch requests are not supported');
  }
  const req = request as Record<string, unknown>;
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params !== null && typeof req.params === 'object' && !Array.isArray(req.params)
    ? req.params
    : {}) as Record<string, unknown>;

  // Notifications carry no id and get no reply: the HTTP layer answers
  // them with a bare 202 and an empty body.
  if (method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }

  if (method === 'server/discover' || method === 'discovery' || method === 'server/discovery') {
    return ok(id, {
      protocolVersion: MCP_SUPPORTED_VERSIONS[0],
      serverInfo: serverInfo(),
      capabilities: capabilities(),
      supportedVersions: [...MCP_SUPPORTED_VERSIONS],
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    });
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = (MCP_SUPPORTED_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : MCP_SUPPORTED_VERSIONS[0] as string;
    return ok(id, { protocolVersion: negotiated, capabilities: capabilities(), serverInfo: serverInfo() });
  }

  if (method === 'ping') return ok(id, {});

  if (method === 'resources/list') return ok(id, { resources: [] });
  if (method === 'resources/templates/list') return ok(id, { resourceTemplates: [] });
  if (method === 'prompts/list') return ok(id, { prompts: [] });

  if (method === 'tools/list') {
    return ok(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const rawName = typeof params.name === 'string' ? params.name : '';
    const tool = findTool(rawName);
    if (tool === undefined) {
      return rpcError(id, -32602, `unknown tool: ${rawName}`);
    }
    const rawArgs = params.arguments;
    let args: Record<string, unknown> = {};
    if (typeof rawArgs === 'string') {
      try {
        const parsed = JSON.parse(rawArgs) as unknown;
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
      } catch {
        args = {};
      }
    } else if (rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
      args = rawArgs as Record<string, unknown>;
    }
    const resolved = resolveArgs(args);
    const missing = tool.inputSchema.required.filter((key) => isMissing(resolved[key]));
    if (missing.length > 0) {
      return ok(id, toolError(`missing required arguments: ${missing.join(', ')}`));
    }
    const outcome = runTool(forge, tool.name, resolved);
    if ('error' in outcome) {
      return ok(id, toolError(outcome.error));
    }
    return ok(id, toolResult(outcome.value));
  }

  return rpcError(id, -32601, `method not found: ${method}`);
}
