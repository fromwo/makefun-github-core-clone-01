// graphql.ts — a small GraphQL executor for the documents gh and
// github-mcp-server send: queries and mutations, variables, aliases,
// inline and named fragments, input objects, enums and batched arrays.
// Deterministic, no dependencies, Node 22 standard library only.

import { decodeGlobalId, globalId } from './store.ts';
import type { Forge, Issue, Pull, Repo } from './store.ts';
import { VIEWER_LOGIN } from './store.ts';

// --------------------------------------------------------------------------- lexer

type TokenKind = 'name' | 'string' | 'number' | 'punct' | 'var' | 'spread';

interface Token {
  kind: TokenKind;
  text: string;
}

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
const PUNCT_CHARS = new Set(['{', '}', '(', ')', ':', '[', ']', '!', '=', '|', '&', '@']);

/** Split a GraphQL document into tokens; comments and commas are skipped. */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < n && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let out = '';
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const c = input[j] as string;
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\\' && j + 1 < n) {
          const esc = input[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
          continue;
        }
        out += c;
        j += 1;
      }
      tokens.push({ kind: 'string', text: out });
      i = closed ? j + 1 : j;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < n && NAME_CHAR.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'var', text: input.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', text: '...' });
      i += 3;
      continue;
    }
    if (PUNCT_CHARS.has(ch)) {
      tokens.push({ kind: 'punct', text: ch });
      i += 1;
      continue;
    }
    if (NAME_START.test(ch)) {
      let j = i;
      while (j < n && NAME_CHAR.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', text: input.slice(i, j) });
      i = j;
      continue;
    }
    if (DIGIT.test(ch) || (ch === '-' && i + 1 < n && DIGIT.test(input[i + 1] as string))) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < n && DIGIT.test(input[j] as string)) j += 1;
      if (j < n && input[j] === '.' && j + 1 < n && DIGIT.test(input[j + 1] as string)) {
        j += 1;
        while (j < n && DIGIT.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: 'number', text: input.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

// --------------------------------------------------------------------------- parser

type Value =
  | string
  | number
  | boolean
  | null
  | Value[]
  | { [key: string]: Value }
  | { __var: string }
  | { __enum: string };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  children: FieldNode[];
  fragmentType: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, Value>;
  varDefs: Record<string, Value>;
  fields: FieldNode[];
}

/** Recursive-descent parser over the token stream. */
class DocumentParser {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly fragments = new Map<string, FieldNode[]>();

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private take(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    if (token === undefined) throw new Error('unexpected end of document');
    return token;
  }

  private expect(text: string): void {
    const token = this.take();
    if (token.kind !== 'punct' || token.text !== text) throw new Error(`expected ${text}, got ${token.text}`);
  }

  private atPunct(text: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.text === text;
  }

  /** Skip `@directive` and `@directive(args)` occurrences. */
  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.take();
      this.take(); // directive name
      if (this.atPunct('(')) this.parseArguments();
    }
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'name' && token.text === 'fragment') {
        this.take();
        const name = this.take().text;
        this.take(); // 'on'
        this.take(); // type name
        this.skipDirectives();
        this.fragments.set(name, this.parseSelectionSet());
        continue;
      }
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek() as Token;
    if (token.kind === 'name' && (token.text === 'query' || token.text === 'mutation')) {
      kind = token.text;
      this.take();
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName.kind === 'name') name = this.take().text;
    }
    const varDefs: Record<string, Value> = {};
    if (this.atPunct('(')) {
      this.take();
      while (!this.atPunct(')')) {
        const varToken = this.take();
        if (varToken.kind !== 'var') throw new Error('expected a variable in the definition list');
        this.expect(':');
        this.parseTypeRef();
        if (this.atPunct('=')) {
          this.take();
          varDefs[varToken.text] = this.parseValue();
        }
        if (this.atPunct(',')) this.take();
      }
      this.expect(')');
    }
    this.skipDirectives();
    const fields = this.parseSelectionSet();
    return { kind, name, variables: {}, varDefs, fields };
  }

  /** Consume a type reference such as `[IssueState!]`; only its shape matters. */
  private parseTypeRef(): void {
    if (this.atPunct('[')) {
      this.take();
      this.parseTypeRef();
      this.expect(']');
    } else {
      this.take();
    }
    if (this.atPunct('!')) this.take();
  }

  private parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (!this.atPunct('}')) {
      const token = this.peek() as Token;
      if (token.kind === 'spread') {
        this.take();
        const next = this.peek();
        if (next !== undefined && next.kind === 'name' && next.text === 'on') {
          this.take();
          const typeName = this.take().text;
          this.skipDirectives();
          const children = this.parseSelectionSet();
          fields.push({ alias: null, name: '', args: {}, children, fragmentType: typeName });
        } else if (next !== undefined && next.kind === 'name') {
          const fragName = this.take().text;
          this.skipDirectives();
          fields.push(...(this.fragments.get(fragName) ?? []));
        } else {
          throw new Error('unsupported fragment spread');
        }
        continue;
      }
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  private parseField(): FieldNode {
    let alias: string | null = null;
    let name = this.take().text;
    if (this.atPunct(':')) {
      this.take();
      alias = name;
      name = this.take().text;
    }
    let args: Record<string, Value> = {};
    if (this.atPunct('(')) args = this.parseArguments();
    this.skipDirectives();
    let children: FieldNode[] = [];
    if (this.atPunct('{')) children = this.parseSelectionSet();
    return { alias, name, args, children, fragmentType: null };
  }

  private parseArguments(): Record<string, Value> {
    this.expect('(');
    const args: Record<string, Value> = {};
    while (!this.atPunct(')')) {
      const key = this.take().text;
      this.expect(':');
      args[key] = this.parseValue();
      if (this.atPunct(',')) this.take();
    }
    this.expect(')');
    return args;
  }

  private parseValue(): Value {
    const token = this.take();
    if (token.kind === 'var') return { __var: token.text };
    if (token.kind === 'string') return token.text;
    if (token.kind === 'number') return Number(token.text);
    if (token.kind === 'name') {
      if (token.text === 'true') return true;
      if (token.text === 'false') return false;
      if (token.text === 'null') return null;
      return { __enum: token.text };
    }
    if (token.kind === 'punct' && token.text === '[') {
      const items: Value[] = [];
      while (!this.atPunct(']')) {
        items.push(this.parseValue());
        if (this.atPunct(',')) this.take();
      }
      this.expect(']');
      return items;
    }
    if (token.kind === 'punct' && token.text === '{') {
      const obj: { [key: string]: Value } = {};
      while (!this.atPunct('}')) {
        const key = this.take().text;
        this.expect(':');
        obj[key] = this.parseValue();
        if (this.atPunct(',')) this.take();
      }
      this.expect('}');
      return obj;
    }
    throw new Error(`unexpected value token ${token.text}`);
  }
}

// --------------------------------------------------------------------------- schema

/** Fields a client may ask for on each object type. */
const QUERYABLE_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path'],
  Ref: ['name'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  __Type: ['name', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
  Node: ['id'],
};

/** What introspection reports for each type (fields) and enum (values). */
const INTROSPECT_FIELDS: Record<string, readonly string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'createdAt', 'updatedAt', 'author', 'headRefOid', 'baseRefOid'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt'],
  SearchType: [],
};

const INTROSPECT_ENUMS: Record<string, readonly string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

/** The object type a field's selection set belongs to, for validation. */
const CHILD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest' },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
  PullRequest: { files: 'PullRequestChangedFileConnection' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
};

// --------------------------------------------------------------------------- execution

type AnyRecord = Record<string, unknown>;

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
}

interface TypedValue {
  __type: string;
  value: unknown;
}

function typeNameOf(value: TypedValue | null): string {
  return value === null ? 'Query' : value.__type;
}

function resolveValue(value: Value, ctx: ExecContext): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if ('__var' in value) {
      const name = (value as { __var: string }).__var;
      return name in ctx.variables ? (ctx.variables[name] ?? null) : null;
    }
    if ('__enum' in value) return (value as { __enum: string }).__enum;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, Value>)) out[key] = resolveValue(child, ctx);
    return out;
  }
  if (Array.isArray(value)) return value.map((child) => resolveValue(child, ctx));
  return value;
}

function readArg(field: FieldNode, name: string, ctx: ExecContext): unknown {
  const raw = field.args[name];
  if (raw === undefined) return undefined;
  return resolveValue(raw, ctx);
}

function toCursor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function fromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Sort issues by the requested orderBy field; ties fall back to number. */
function sortIssues(issues: Issue[], orderBy: AnyRecord | undefined): Issue[] {
  const direction = typeof orderBy?.direction === 'string' ? String(orderBy.direction).toUpperCase() : 'ASC';
  const fieldName = typeof orderBy?.field === 'string' ? String(orderBy.field).toUpperCase() : 'CREATED_AT';
  const desc = direction === 'DESC';
  const keyOf = (issue: Issue): string | number => {
    if (fieldName === 'UPDATED_AT') return issue.updated_at;
    if (fieldName === 'COMMENTS') return issue.comments.length;
    return issue.created_at;
  };
  return [...issues].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka < kb) return desc ? 1 : -1;
    if (ka > kb) return desc ? -1 : 1;
    return desc ? b.number - a.number : a.number - b.number;
  });
}

/** Resolve a global id into the node it names, or null when it names nothing. */
function nodeById(forge: Forge, id: string): TypedValue | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const [owner, name] = decoded.key.split('/');
    const repo = forge.getRepo(owner as string, name as string);
    if (repo === undefined) return null;
    return { __type: 'Repository', value: { __repo: repo } };
  }
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
    const [ownerName, num] = decoded.key.split(':');
    const [owner, name] = (ownerName as string).split('/');
    const repo = forge.getRepo(owner as string, name as string);
    if (repo === undefined) return null;
    if (decoded.kind === 'Issue') {
      const issue = repo.issues.get(Number(num));
      if (issue === undefined) return null;
      return { __type: 'Issue', value: { __repo: repo, __issue: issue } };
    }
    const pull = repo.pulls.get(Number(num));
    if (pull === undefined) return null;
    return { __type: 'PullRequest', value: { __repo: repo, __pull: pull } };
  }
  return null;
}

/** Split `owner/name:number` into its parts for issue/pull-request ids. */
function splitNumberedKey(key: string): { owner: string; name: string; number: number } | null {
  const [ownerName, num] = key.split(':');
  if (ownerName === undefined || num === undefined) return null;
  const [owner, name] = ownerName.split('/');
  if (owner === undefined || name === undefined) return null;
  return { owner, name, number: Number(num) };
}

function validateSelection(fields: FieldNode[], parentType: string, errors: { message: string }[]): void {
  const allowed = QUERYABLE_FIELDS[parentType];
  for (const field of fields) {
    if (field.fragmentType !== null) {
      validateSelection(field.children, field.fragmentType, errors);
      continue;
    }
    if (field.name === '__typename') continue;
    if (allowed === undefined) continue;
    if (!allowed.includes(field.name)) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
      continue;
    }
    const childType = CHILD_TYPES[parentType]?.[field.name];
    if (childType !== undefined && field.children.length > 0) validateSelection(field.children, childType, errors);
  }
}

/** Run a selection set against a typed value, honouring fragments and aliases. */
function runSelection(fields: FieldNode[], source: TypedValue, ctx: ExecContext): AnyRecord {
  const out: AnyRecord = {};
  for (const field of fields) {
    if (field.fragmentType !== null) {
      const applies = field.fragmentType === typeNameOf(source) || field.fragmentType === 'Node';
      if (!applies) continue;
      Object.assign(out, runSelection(field.children, source, ctx));
      continue;
    }
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeNameOf(source);
      continue;
    }
    out[key] = resolveField(source, field, ctx);
  }
  return out;
}

/** Select into a child object: null stays null, a bare field returns the raw value. */
function pick(child: TypedValue | null, field: FieldNode, ctx: ExecContext): unknown {
  if (child === null) return null;
  if (field.children.length === 0) return child.value;
  return runSelection(field.children, child, ctx);
}

type Resolver = (source: TypedValue, field: FieldNode, ctx: ExecContext) => unknown;

function issueTyped(repo: Repo, issue: Issue): TypedValue {
  return { __type: 'Issue', value: { __repo: repo, __issue: issue } };
}

function pullTyped(repo: Repo, pull: Pull): TypedValue {
  return { __type: 'PullRequest', value: { __repo: repo, __pull: pull } };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_source, field, ctx) => pick({ __type: 'User', value: { login: VIEWER_LOGIN } }, field, ctx),
    repository: (_source, field, ctx) => {
      const owner = readArg(field, 'owner', ctx) as string;
      const name = readArg(field, 'name', ctx) as string;
      const repo = ctx.forge.getRepo(owner, name);
      if (repo === undefined) return null;
      return pick({ __type: 'Repository', value: { __repo: repo } }, field, ctx);
    },
    node: (_source, field, ctx) => {
      const id = readArg(field, 'id', ctx) as string;
      return pick(nodeById(ctx.forge, id), field, ctx);
    },
    __type: (_source, field, ctx) => {
      const name = readArg(field, 'name', ctx) as string;
      return pick({ __type: '__Type', value: { __typeName: name } }, field, ctx);
    },
  },

  Mutation: {
    createIssue: (_source, field, ctx) => {
      const input = (readArg(field, 'input', ctx) ?? {}) as AnyRecord;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const payload = { __type: 'CreateIssuePayload', value: { issue: null } as AnyRecord };
      if (decoded === null || decoded.kind !== 'Repository') return pick(payload, field, ctx);
      const [owner, name] = decoded.key.split('/');
      const repo = ctx.forge.getRepo(owner as string, name as string);
      if (repo === undefined) return pick(payload, field, ctx);
      const issue = ctx.forge.createIssueDirect(repo, String(input.title ?? ''), String(input.body ?? ''));
      return pick({ __type: 'CreateIssuePayload', value: { __repo: repo, __issue: issue } }, field, ctx);
    },
    closeIssue: (_source, field, ctx) => {
      const input = (readArg(field, 'input', ctx) ?? {}) as AnyRecord;
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      const payload = { __type: 'CloseIssuePayload', value: { issue: null } as AnyRecord };
      if (decoded === null || decoded.kind !== 'Issue') return pick(payload, field, ctx);
      const parts = splitNumberedKey(decoded.key);
      if (parts === null) return pick(payload, field, ctx);
      const repo = ctx.forge.getRepo(parts.owner, parts.name);
      const issue = repo?.issues.get(parts.number);
      if (repo === undefined || issue === undefined) return pick(payload, field, ctx);
      issue.state = 'closed';
      issue.updated_at = ctx.forge.nowIso();
      return pick({ __type: 'CloseIssuePayload', value: { __repo: repo, __issue: issue } }, field, ctx);
    },
    createPullRequest: (_source, field, ctx) => {
      const input = (readArg(field, 'input', ctx) ?? {}) as AnyRecord;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const payload = { __type: 'CreatePullRequestPayload', value: { pullRequest: null } as AnyRecord };
      if (decoded === null || decoded.kind !== 'Repository') return pick(payload, field, ctx);
      const [owner, name] = decoded.key.split('/');
      const repo = ctx.forge.getRepo(owner as string, name as string);
      if (repo === undefined) return pick(payload, field, ctx);
      const pull = ctx.forge.createPull(repo, String(input.title ?? ''), '', String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      if ('error' in pull) return pick(payload, field, ctx);
      return pick({ __type: 'CreatePullRequestPayload', value: { __repo: repo, __pull: pull } }, field, ctx);
    },
    mergePullRequest: (_source, field, ctx) => {
      const input = (readArg(field, 'input', ctx) ?? {}) as AnyRecord;
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      const payload = { __type: 'MergePullRequestPayload', value: { pullRequest: null } as AnyRecord };
      if (decoded === null || decoded.kind !== 'PullRequest') return pick(payload, field, ctx);
      const parts = splitNumberedKey(decoded.key);
      if (parts === null) return pick(payload, field, ctx);
      const repo = ctx.forge.getRepo(parts.owner, parts.name);
      const pull = repo?.pulls.get(parts.number);
      if (repo === undefined || pull === undefined) return pick(payload, field, ctx);
      ctx.forge.mergePull(repo, pull, 'squash');
      return pick({ __type: 'MergePullRequestPayload', value: { __repo: repo, __pull: pull } }, field, ctx);
    },
    addComment: (_source, field, ctx) => {
      const input = (readArg(field, 'input', ctx) ?? {}) as AnyRecord;
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      const payload = { __type: 'AddCommentPayload', value: { commentEdge: null } as AnyRecord };
      if (decoded === null || decoded.kind !== 'Issue') return pick(payload, field, ctx);
      const parts = splitNumberedKey(decoded.key);
      if (parts === null) return pick(payload, field, ctx);
      const repo = ctx.forge.getRepo(parts.owner, parts.name);
      const issue = repo?.issues.get(parts.number);
      if (repo === undefined || issue === undefined) return pick(payload, field, ctx);
      const now = ctx.forge.nowIso();
      const comment = {
        id: ctx.forge.nextSeq() + 100000,
        body: String(input.body ?? ''),
        user: { login: VIEWER_LOGIN },
        created_at: now,
        updated_at: now,
      };
      issue.comments.push(comment);
      return pick({ __type: 'AddCommentPayload', value: { __comment: comment, __repo: repo, __issue: issue } }, field, ctx);
    },
  },

  User: {
    login: (source) => (source.value as AnyRecord).login,
    id: (source) => globalId('User', String((source.value as AnyRecord).login ?? '')),
  },

  Repository: {
    id: (source) => {
      const repo = (source.value as AnyRecord).__repo as Repo;
      return globalId('Repository', `${repo.owner}/${repo.name}`);
    },
    databaseId: (source) => ((source.value as AnyRecord).__repo as Repo).id,
    name: (source) => ((source.value as AnyRecord).__repo as Repo).name,
    nameWithOwner: (source) => {
      const repo = (source.value as AnyRecord).__repo as Repo;
      return `${repo.owner}/${repo.name}`;
    },
    owner: (source, field, ctx) => {
      const repo = (source.value as AnyRecord).__repo as Repo;
      return pick({ __type: 'User', value: { login: repo.owner } }, field, ctx);
    },
    defaultBranchRef: (source, field, ctx) => {
      const repo = (source.value as AnyRecord).__repo as Repo;
      return pick({ __type: 'Ref', value: { name: repo.default_branch } }, field, ctx);
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (source) => ((source.value as AnyRecord).__repo as Repo).description,
    createdAt: (source) => ((source.value as AnyRecord).__repo as Repo).created_at,
    updatedAt: (source) => ((source.value as AnyRecord).__repo as Repo).updated_at,
    issue: (source, field, ctx) => {
      const repo = (source.value as AnyRecord).__repo as Repo;
      const number = readArg(field, 'number', ctx) as number;
      const issue = repo.issues.get(number);
      if (issue === undefined) return null;
      return pick(issueTyped(repo, issue), field, ctx);
    },
    issues: (source, field, ctx) => {
      const repo = (source.value as AnyRecord).__repo as Repo;
      const first = readArg(field, 'first', ctx) as number | undefined;
      const after = readArg(field, 'after', ctx);
      const states = readArg(field, 'states', ctx) as string[] | undefined;
      const orderBy = readArg(field, 'orderBy', ctx) as AnyRecord | undefined;
      let issues = [...repo.issues.values()];
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      issues = sortIssues(issues, orderBy);
      return pick({ __type: 'IssueConnection', value: { __repo: repo, __issues: issues, __first: first, __after: after } }, field, ctx);
    },
    pullRequests: (source, field, ctx) => {
      const repo = (source.value as AnyRecord).__repo as Repo;
      const first = readArg(field, 'first', ctx) as number | undefined;
      const pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
      return pick({ __type: 'PullRequestConnection', value: { __repo: repo, __pulls: pulls, __first: first } }, field, ctx);
    },
    pullRequest: (source, field, ctx) => {
      const repo = (source.value as AnyRecord).__repo as Repo;
      const number = readArg(field, 'number', ctx) as number;
      const pull = repo.pulls.get(number);
      if (pull === undefined) return null;
      return pick(pullTyped(repo, pull), field, ctx);
    },
  },

  Issue: {
    id: (source) => {
      const value = source.value as AnyRecord;
      const repo = value.__repo as Repo;
      const issue = value.__issue as Issue;
      return globalId('Issue', `${repo.owner}/${repo.name}:${issue.number}`);
    },
    number: (source) => ((source.value as AnyRecord).__issue as Issue).number,
    title: (source) => ((source.value as AnyRecord).__issue as Issue).title,
    state: (source) => (((source.value as AnyRecord).__issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (source) => ((source.value as AnyRecord).__issue as Issue).body,
  },

  IssueConnection: {
    nodes: (source, field, ctx) => {
      const value = source.value as AnyRecord;
      const issues = value.__issues as Issue[];
      const repo = value.__repo as Repo;
      const first = (value.__first as number | undefined) ?? issues.length;
      const afterNum = fromCursor(value.__after);
      let start = 0;
      if (afterNum !== null) {
        const index = issues.findIndex((issue) => issue.number === afterNum);
        start = index >= 0 ? index + 1 : 0;
      }
      const page = issues.slice(start, start + first);
      if (field.children.length === 0) return page.map(() => null);
      return page.map((issue) => runSelection(field.children, issueTyped(repo, issue), ctx));
    },
    pageInfo: (source, field, ctx) => {
      const value = source.value as AnyRecord;
      const issues = value.__issues as Issue[];
      const first = (value.__first as number | undefined) ?? issues.length;
      const afterNum = fromCursor(value.__after);
      let start = 0;
      if (afterNum !== null) {
        const index = issues.findIndex((issue) => issue.number === afterNum);
        start = index >= 0 ? index + 1 : 0;
      }
      const page = issues.slice(start, start + first);
      const hasNextPage = start + page.length < issues.length;
      const endCursor = page.length > 0 ? toCursor(page[page.length - 1]!.number) : null;
      return pick({ __type: 'PageInfo', value: { hasNextPage, endCursor } }, field, ctx);
    },
    totalCount: (source) => ((source.value as AnyRecord).__issues as Issue[]).length,
  },

  PullRequest: {
    id: (source) => {
      const value = source.value as AnyRecord;
      const repo = value.__repo as Repo;
      const pull = value.__pull as Pull;
      return globalId('PullRequest', `${repo.owner}/${repo.name}:${pull.number}`);
    },
    number: (source) => ((source.value as AnyRecord).__pull as Pull).number,
    title: (source) => ((source.value as AnyRecord).__pull as Pull).title,
    state: (source) => {
      const pull = (source.value as AnyRecord).__pull as Pull;
      return pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED';
    },
    merged: (source) => ((source.value as AnyRecord).__pull as Pull).merged,
    headRefName: (source) => ((source.value as AnyRecord).__pull as Pull).head.ref,
    baseRefName: (source) => ((source.value as AnyRecord).__pull as Pull).base.ref,
    mergeable: (source, _field, ctx) => {
      const value = source.value as AnyRecord;
      return ctx.forge.mergeable(value.__repo as Repo, value.__pull as Pull);
    },
    body: (source) => ((source.value as AnyRecord).__pull as Pull).body,
    files: (source, field, ctx) => {
      const value = source.value as AnyRecord;
      const repo = value.__repo as Repo;
      const pull = value.__pull as Pull;
      const first = readArg(field, 'first', ctx) as number | undefined;
      const files = ctx.forge.pullFiles(repo, pull);
      return pick({ __type: 'PullRequestChangedFileConnection', value: { __files: files, __first: first } }, field, ctx);
    },
  },

  PullRequestConnection: {
    nodes: (source, field, ctx) => {
      const value = source.value as AnyRecord;
      const pulls = value.__pulls as Pull[];
      const repo = value.__repo as Repo;
      const first = (value.__first as number | undefined) ?? pulls.length;
      const page = pulls.slice(0, first);
      return page.map((pull) => runSelection(field.children, pullTyped(repo, pull), ctx));
    },
    pageInfo: (source, field, ctx) => {
      const value = source.value as AnyRecord;
      const pulls = value.__pulls as Pull[];
      const first = (value.__first as number | undefined) ?? pulls.length;
      const endCursor = pulls.length > 0 ? toCursor(pulls[Math.min(first, pulls.length) - 1]!.number) : null;
      return pick({ __type: 'PageInfo', value: { hasNextPage: pulls.length > first, endCursor } }, field, ctx);
    },
    totalCount: (source) => ((source.value as AnyRecord).__pulls as Pull[]).length,
  },

  PullRequestChangedFileConnection: {
    nodes: (source, field, ctx) => {
      const value = source.value as AnyRecord;
      const files = value.__files as { filename: string }[];
      const first = (value.__first as number | undefined) ?? files.length;
      const page = files.slice(0, first);
      return page.map((file) => runSelection(field.children, { __type: 'PullRequestChangedFile', value: { __file: file } }, ctx));
    },
    pageInfo: (_source, field, ctx) => pick({ __type: 'PageInfo', value: { hasNextPage: false, endCursor: null } }, field, ctx),
  },

  PullRequestChangedFile: {
    path: (source) => ((source.value as AnyRecord).__file as { filename: string }).filename,
  },

  Ref: {
    name: (source) => (source.value as AnyRecord).name,
  },

  PageInfo: {
    hasNextPage: (source) => (source.value as AnyRecord).hasNextPage ?? false,
    endCursor: (source) => (source.value as AnyRecord).endCursor ?? null,
    hasPreviousPage: () => false,
    startCursor: () => null,
  },

  __Type: {
    name: (source) => (source.value as AnyRecord).__typeName,
    fields: (source, field, ctx) => {
      const typeName = (source.value as AnyRecord).__typeName as string;
      const names = INTROSPECT_FIELDS[typeName] ?? [];
      return names.map((name) => runSelection(field.children, { __type: '__Field', value: { name } }, ctx));
    },
    enumValues: (source, field, ctx) => {
      const typeName = (source.value as AnyRecord).__typeName as string;
      const names = INTROSPECT_ENUMS[typeName] ?? [];
      return names.map((name) => runSelection(field.children, { __type: '__EnumValue', value: { name } }, ctx));
    },
  },

  __Field: {
    name: (source) => (source.value as AnyRecord).name,
  },

  __EnumValue: {
    name: (source) => (source.value as AnyRecord).name,
  },

  Comment: {
    id: (source) => globalId('Comment', String(((source.value as AnyRecord).__comment as { id: number }).id)),
    body: (source) => ((source.value as AnyRecord).__comment as { body: string }).body,
  },
};

/** Mutation payloads carry the created object under __issue/__pull/__comment. */
function payloadResolver(kind: 'issue' | 'pullRequest' | 'commentEdge'): Resolver {
  return (source, field, ctx) => {
    const value = source.value as AnyRecord;
    if (kind === 'issue' && value.__issue !== undefined && value.__issue !== null) {
      const child = issueTyped(value.__repo as Repo, value.__issue as Issue);
      return field.children.length === 0 ? child.value : runSelection(field.children, child, ctx);
    }
    if (kind === 'pullRequest' && value.__pull !== undefined && value.__pull !== null) {
      const child = pullTyped(value.__repo as Repo, value.__pull as Pull);
      return field.children.length === 0 ? child.value : runSelection(field.children, child, ctx);
    }
    if (kind === 'commentEdge' && value.__comment !== undefined && value.__comment !== null) {
      if (field.children.length === 0) return { node: null };
      const out: AnyRecord = {};
      for (const childField of field.children) {
        if (childField.name === 'node') {
          out.node = runSelection(childField.children, { __type: 'Comment', value: { __comment: value.__comment } }, ctx);
        }
      }
      return out;
    }
    return null;
  };
}

RESOLVERS['CreateIssuePayload'] = { issue: payloadResolver('issue') };
RESOLVERS['CloseIssuePayload'] = { issue: payloadResolver('issue') };
RESOLVERS['CreatePullRequestPayload'] = { pullRequest: payloadResolver('pullRequest') };
RESOLVERS['MergePullRequestPayload'] = { pullRequest: payloadResolver('pullRequest') };
RESOLVERS['AddCommentPayload'] = { commentEdge: payloadResolver('commentEdge') };

function resolveField(source: TypedValue, field: FieldNode, ctx: ExecContext): unknown {
  const table = RESOLVERS[typeNameOf(source)];
  const fn = table?.[field.name];
  if (fn === undefined) return null;
  return fn(source, field, ctx);
}

export interface GraphQLResult {
  data: unknown;
  errors: { message: string }[];
}

/** Execute one parsed operation. */
export function executeOperation(forge: Forge, operation: Operation, variables: Record<string, unknown>): GraphQLResult {
  const ctx: ExecContext = { forge, variables: { ...variables } };
  // Fill in variable defaults for variables the caller did not supply.
  for (const [key, def] of Object.entries(operation.varDefs)) {
    if (!(key in ctx.variables)) ctx.variables[key] = resolveValue(def, ctx);
  }
  const errors: { message: string }[] = [];
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  validateSelection(operation.fields, rootType, errors);
  if (errors.length > 0) return { data: null, errors };
  const root: TypedValue = { __type: rootType, value: {} };
  return { data: runSelection(operation.fields, root, ctx), errors: [] };
}

/** Execute a request body (one operation object, or an array of them for batching). */
export function executeGraphQL(forge: Forge, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((entry) => {
      if (entry === null || typeof entry !== 'object') return { data: null, errors: [{ message: 'expected a GraphQL operation object' }] };
      return executeOne(forge, entry as AnyRecord);
    });
  }
  if (body !== null && typeof body === 'object') return executeOne(forge, body as AnyRecord);
  return { data: null, errors: [{ message: 'expected a GraphQL operation object' }] };
}

/** Variables arrive as an object, or occasionally as a JSON string of one. */
function parseVariables(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
    return {};
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

function executeOne(forge: Forge, body: AnyRecord): GraphQLResult {
  const query = body.query;
  if (typeof query !== 'string' || query === '') {
    return { data: null, errors: [{ message: 'the request carries no query string' }] };
  }
  const variables = parseVariables(body.variables);
  let operations: Operation[];
  try {
    operations = new DocumentParser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (operations.length === 0) return { data: null, errors: [{ message: 'the document holds no operation' }] };
  let operation = operations[0] as Operation;
  const operationName = body.operationName;
  if (typeof operationName === 'string' && operationName !== '') {
    const named = operations.find((op) => op.name === operationName);
    if (named !== undefined) operation = named;
  }
  return executeOperation(forge, operation, variables);
}
