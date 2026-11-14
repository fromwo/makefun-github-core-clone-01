// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0).
// Speaks both eras the rules accept: the modern 2026-07-28 `server/discover`
// (no handshake, no session) and the legacy `initialize` handshake fallback.
// Deterministic, no dependencies, Node 22 standard library only.

import { issueView, pullView, repoView } from './store.ts';
import type { Forge } from './store.ts';

export const MCP_SERVER_NAME = 'gh-forge';
export const MCP_SERVER_VERSION = '0.1.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

// One frozen definition: tools/list must be byte-identical across calls.
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];
Object.freeze(TOOLS);

/** Tool lookup by canonical name: any `prefix__name` collapses to `name`, case-insensitively. */
const TOOLS_BY_NAME = new Map<string, ToolDef>(TOOLS.map((tool) => [tool.name.toLowerCase(), tool]));

function canonicalToolName(raw: string): string {
  const cut = raw.lastIndexOf('__');
  const bare = cut >= 0 ? raw.slice(cut + 2) : raw;
  return bare.toLowerCase();
}

function serverInfo(): { name: string; version: string } {
  return { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
}

function capabilities(): { tools: Record<string, never> } {
  return { tools: {} };
}

export interface McpOutcome {
  /** HTTP status to send. */
  status: number;
  /** JSON body to send, or null for an empty body (notifications). */
  body: unknown;
}

/** Execute one JSON-RPC request object against the forge. */
export function handleMcpRequest(forge: Forge, request: unknown): McpOutcome {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { status: 200, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } } };
  }
  const req = request as Record<string, unknown>;
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params !== null && typeof req.params === 'object' && !Array.isArray(req.params) ? req.params : {}) as Record<string, unknown>;

  const result = (value: unknown): McpOutcome => ({ status: 200, body: { jsonrpc: '2.0', id, result: value } });
  const error = (code: number, message: string): McpOutcome => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });

  if (method.startsWith('notifications/')) {
    // Notifications carry no id and get no reply body.
    return { status: 202, body: null };
  }

  if (method === 'server/discover') {
    return result({
      serverInfo: serverInfo(),
      capabilities: capabilities(),
      supportedVersions: [...MCP_SUPPORTED_VERSIONS],
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    });
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = (MCP_SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : MCP_SUPPORTED_VERSIONS[0]!;
    return result({
      protocolVersion: negotiated,
      serverInfo: serverInfo(),
      capabilities: capabilities(),
    });
  }

  if (method === 'ping') return result({});

  if (method === 'resources/list') return result({ resources: [] });

  if (method === 'prompts/list') return result({ prompts: [] });

  if (method === 'tools/list') {
    return result({ tools: TOOLS });
  }

  if (method === 'tools/call') {
    const rawName = typeof params.name === 'string' ? params.name : '';
    const tool = TOOLS_BY_NAME.get(canonicalToolName(rawName));
    if (tool === undefined) {
      return error(-32602, `unknown tool: ${rawName}`);
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
      return result({ content: [{ type: 'text', text: `missing required arguments: ${missing.join(', ')}` }], isError: true });
    }
    const outcome = callTool(forge, tool.name, resolved);
    if ('error' in outcome) {
      return result({ content: [{ type: 'text', text: outcome.error }], isError: true });
    }
    const text = JSON.stringify(outcome.value);
    return result({ content: [{ type: 'text', text }], structuredContent: outcome.value });
  }

  return error(-32601, `method not found: ${method}`);
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** First non-missing value under any of the given keys. */
function firstPresent(args: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = args[key];
    if (!isMissing(value)) return value;
  }
  return undefined;
}

/**
 * Normalise the arguments a client sends onto the schema's property names:
 * `repository` counts as `repo`, `pullNumber`/`number` as `pull_number`, and a
 * `full_name` of `owner/repo` fills in whichever of owner/repo is absent.
 */
function resolveArgs(args: Record<string, unknown>): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...args };
  const owner = firstPresent(args, 'owner');
  const repo = firstPresent(args, 'repo', 'repository', 'repo_name');
  const fullName = firstPresent(args, 'full_name', 'fullName');
  let finalOwner = owner;
  let finalRepo = repo;
  if ((finalOwner === undefined || finalRepo === undefined) && typeof fullName === 'string') {
    const slash = fullName.indexOf('/');
    if (slash > 0) {
      if (finalOwner === undefined) finalOwner = fullName.slice(0, slash);
      if (finalRepo === undefined) finalRepo = fullName.slice(slash + 1);
    }
  }
  if (finalOwner !== undefined) resolved.owner = finalOwner;
  if (finalRepo !== undefined) resolved.repo = finalRepo;
  const pullNumber = firstPresent(args, 'pull_number', 'pullNumber', 'number');
  if (pullNumber !== undefined) resolved.pull_number = pullNumber;
  return resolved;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): { value: unknown } | { error: string } {
  const owner = String(args.owner ?? '');
  const repoName = String(args.repo ?? '');

  if (name === 'create_repo') {
    const repo = forge.createRepo(String(args.name ?? ''), args.private === true, typeof args.description === 'string' ? args.description : '');
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
    const pull = forge.createPull(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', String(args.head ?? ''), String(args.base ?? ''));
    if ('error' in pull) return { error: pull.error };
    return { value: pullView(repo, pull) };
  }

  if (name === 'merge_pull_request') {
    const repo = forge.getRepo(owner, repoName);
    if (repo === undefined) return { error: `repository ${owner}/${repoName} not found` };
    const number = Number(args.pull_number);
    const pull = repo.pulls.get(number);
    if (pull === undefined) return { error: `pull request #${number} not found` };
    const merged = forge.mergePull(repo, pull, 'squash');
    if ('error' in merged) return { error: merged.error };
    return { value: pullView(repo, pull) };
  }

  return { error: `unknown tool: ${name}` };
}
