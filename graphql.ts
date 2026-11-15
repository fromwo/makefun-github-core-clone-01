// graphql.ts — GraphQL v4 for the forge.
//
// A dependency-free executor for the documents gh and github-mcp-server
// actually send: queries and mutations, variables, aliases, inline and
// named fragments, input objects, enums, cursor paging and batched arrays.
// It is layered as lexer -> parser -> schema catalogue -> resolver, so a
// document is validated against the catalogue before anything runs: an
// unknown field is a 200 with an errors array naming it, never an HTTP
// error. Everything served comes from the Forge passed in; this file
// keeps no state of its own between requests.

import { decodeGlobalId, globalId, VIEWER_LOGIN } from './forge.ts';
import type { Forge } from './forge.ts';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** One entry of a GraphQL `errors` array. */
export interface GraphQLResult {
  data?: unknown;
  errors?: { message: string }[];
}

/** A value as it appears in a document: literal, list, object, variable or enum. */
export type GqlValue =
  | string
  | number
  | boolean
  | null
  | GqlValue[]
  | { [key: string]: GqlValue }
  | { $var: string }
  | { $enum: string };

/** One field inside a selection set. */
export interface FieldSelection {
  kind: 'field';
  /** The response key: the alias when one was written, else the field name. */
  name: string;
  alias: string | null;
  args: Record<string, GqlValue>;
  selections: Selection[];
}

/** An inline fragment (`... on Type { ... }`). Named fragments are inlined
 *  by the parser, so by the time an operation runs only these remain. */
export interface InlineFragment {
  kind: 'fragment';
  typeName: string;
  selections: Selection[];
}

/** A named fragment spread before expansion (parser-internal only). */
export interface SpreadSelection {
  kind: 'spread';
  name: string;
}

/** Anything that can appear in a selection set while parsing. After the
 *  parser's expansion pass, spreads are gone. */
export type Selection = FieldSelection | InlineFragment | SpreadSelection;

/** One parsed operation. `varDefaults` holds the defaults of variables
 *  declared with `= ...` in the operation header. */
export interface Operation {
  operation: 'query' | 'mutation';
  name?: string;
  fields: Selection[];
  varDefaults?: Record<string, GqlValue>;
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'number' | 'punct' | 'var' | 'spread';

interface Token {
  kind: TokenKind;
  text: string;
}

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
const PUNCT = new Set(['{', '}', '(', ')', ':', '[', ']', '!', '=', '|', '&', '@']);

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  '"': '"',
  '\\': '\\',
  '/': '/',
};

/** Split a document into tokens. Comments, commas and insignificant
 *  whitespace are dropped; strings keep their decoded value. */
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
      // A block string (""") runs to the next """, a plain one to the next ".
      if (input.slice(i, i + 3) === '"""') {
        const close = input.indexOf('"""', i + 3);
        const end = close < 0 ? n : close;
        tokens.push({ kind: 'string', text: input.slice(i + 3, end) });
        i = close < 0 ? n : close + 3;
        continue;
      }
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
          if (esc === 'u' && j + 5 < n) {
            const code = Number.parseInt(input.slice(j + 2, j + 6), 16);
            out += Number.isFinite(code) ? String.fromCharCode(code) : '';
            j += 6;
            continue;
          }
          out += ESCAPES[esc] ?? esc;
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
    if (PUNCT.has(ch)) {
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
      if (j < n && (input[j] === 'e' || input[j] === 'E')) {
        let k = j + 1;
        if (input[k] === '+' || input[k] === '-') k += 1;
        if (k < n && DIGIT.test(input[k] as string)) {
          j = k;
          while (j < n && DIGIT.test(input[j] as string)) j += 1;
        }
      }
      tokens.push({ kind: 'number', text: input.slice(i, j) });
      i = j;
      continue;
    }
    // Anything else cannot start a token; skip it rather than dying here —
    // the parser will fail loudly on the missing piece instead.
    i += 1;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface FragmentDef {
  typeName: string;
  selections: Selection[];
}

/** Recursive-descent parser over the token stream. It parses every
 *  top-level definition first, then expands named fragment spreads in a
 *  second pass, so a spread may refer to a fragment defined later in the
 *  document. */
class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly fragments = new Map<string, FragmentDef>();

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

  private atPunct(text: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.text === text;
  }

  private expectPunct(text: string): void {
    const token = this.take();
    if (token.kind !== 'punct' || token.text !== text) {
      throw new Error(`expected "${text}" but found "${token.text}"`);
    }
  }

  private expectName(what: string): string {
    const token = this.take();
    if (token.kind !== 'name') throw new Error(`expected ${what} but found "${token.text}"`);
    return token.text;
  }

  /** Skip `@directive` and `@directive(args)` occurrences. */
  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.take();
      this.expectName('a directive name');
      if (this.atPunct('(')) this.parseArguments();
    }
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'name' && token.text === 'fragment') {
        this.take();
        const name = this.expectName('a fragment name');
        this.expectName('"on"');
        const typeName = this.expectName('a fragment type');
        this.skipDirectives();
        this.fragments.set(name, { typeName, selections: this.parseSelectionSet() });
        continue;
      }
      operations.push(this.parseOperation());
    }
    for (const operation of operations) {
      operation.fields = expandSpreads(operation.fields, this.fragments, new Set());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const token = this.peek() as Token;
    if (token.kind === 'name' && (token.text === 'query' || token.text === 'mutation')) {
      kind = token.text;
      this.take();
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName.kind === 'name') name = this.take().text;
    } else if (token.kind === 'name' && token.text === 'subscription') {
      throw new Error('subscriptions are not supported');
    }
    const varDefaults: Record<string, GqlValue> = {};
    if (this.atPunct('(')) {
      this.take();
      while (!this.atPunct(')')) {
        const varToken = this.take();
        if (varToken.kind !== 'var') throw new Error('expected a variable in the variable list');
        this.expectPunct(':');
        this.parseTypeRef();
        if (this.atPunct('=')) {
          this.take();
          varDefaults[varToken.text] = this.parseValue();
        }
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    // No expansion here: named spreads are expanded once, in
    // parseDocument, after every fragment definition has been read.
    const fields = this.parseSelectionSet();
    const operation: Operation = { operation: kind, fields };
    if (name !== undefined) operation.name = name;
    if (Object.keys(varDefaults).length > 0) operation.varDefaults = varDefaults;
    return operation;
  }

  /** Consume a type reference such as `[IssueState!]`; only its shape matters. */
  private parseTypeRef(): void {
    if (this.atPunct('[')) {
      this.take();
      this.parseTypeRef();
      this.expectPunct(']');
    } else {
      this.take();
    }
    if (this.atPunct('!')) this.take();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const fields: Selection[] = [];
    while (!this.atPunct('}')) {
      if (this.pos >= this.tokens.length) throw new Error('unterminated selection set');
      const token = this.peek() as Token;
      if (token.kind === 'spread') {
        this.take();
        const next = this.peek();
        if (next !== undefined && next.kind === 'name' && next.text === 'on') {
          this.take();
          const typeName = this.expectName('a fragment type');
          this.skipDirectives();
          const children = this.parseSelectionSet();
          fields.push({ kind: 'fragment', typeName, selections: children });
        } else if (next !== undefined && next.kind === 'name') {
          const fragName = this.take().text;
          this.skipDirectives();
          fields.push({ kind: 'spread', name: fragName });
        } else {
          throw new Error('a fragment spread needs a name or "on Type"');
        }
        continue;
      }
      fields.push(this.parseField());
    }
    this.expectPunct('}');
    return fields;
  }

  private parseField(): FieldSelection {
    let name = this.expectName('a field name');
    let alias: string | null = null;
    if (this.atPunct(':')) {
      this.take();
      alias = name;
      name = this.expectName('a field name after the alias');
    }
    let args: Record<string, GqlValue> = {};
    if (this.atPunct('(')) args = this.parseArguments();
    this.skipDirectives();
    let selections: Selection[] = [];
    if (this.atPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Record<string, GqlValue> {
    this.expectPunct('(');
    const args: Record<string, GqlValue> = {};
    while (!this.atPunct(')')) {
      if (this.pos >= this.tokens.length) throw new Error('unterminated argument list');
      const key = this.expectName('an argument name');
      this.expectPunct(':');
      args[key] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): GqlValue {
    const token = this.take();
    if (token.kind === 'var') return { $var: token.text };
    if (token.kind === 'string') return token.text;
    if (token.kind === 'number') return Number(token.text);
    if (token.kind === 'name') {
      if (token.text === 'true') return true;
      if (token.text === 'false') return false;
      if (token.text === 'null') return null;
      return { $enum: token.text };
    }
    if (token.kind === 'punct' && token.text === '[') {
      const items: GqlValue[] = [];
      while (!this.atPunct(']')) {
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return items;
    }
    if (token.kind === 'punct' && token.text === '{') {
      const obj: { [key: string]: GqlValue } = {};
      while (!this.atPunct('}')) {
        const key = this.expectName('an object key');
        this.expectPunct(':');
        obj[key] = this.parseValue();
      }
      this.expectPunct('}');
      return obj;
    }
    throw new Error(`unexpected value token "${token.text}"`);
  }
}

/** Replace named fragment spreads with the fragment's own selections.
 *  A spread seen twice on one path is dropped, so a cyclic fragment
 *  cannot loop forever. */
function expandSpreads(
  selections: Selection[],
  fragments: Map<string, FragmentDef>,
  seen: Set<string>,
): Selection[] {
  const out: Selection[] = [];
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      if (seen.has(sel.name)) continue;
      const def = fragments.get(sel.name);
      if (def === undefined) throw new Error(`unknown fragment "${sel.name}"`);
      const next = new Set(seen);
      next.add(sel.name);
      // Keep the fragment's type condition: its fields only apply to
      // that type (e.g. `... on Repository` inside a `node` read).
      out.push({ kind: 'fragment', typeName: def.typeName, selections: expandSpreads(def.selections, fragments, next) });
      continue;
    }
    if (sel.kind === 'fragment') {
      out.push({ kind: 'fragment', typeName: sel.typeName, selections: expandSpreads(sel.selections, fragments, seen) });
      continue;
    }
    out.push({ kind: 'field', name: sel.name, alias: sel.alias, args: sel.args, selections: expandSpreads(sel.selections, fragments, seen) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schema catalogue — one table drives validation and introspection alike
// ---------------------------------------------------------------------------

interface TypeInfo {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR' | 'INTERFACE';
  fields: readonly string[];
  enums?: readonly string[];
}

const SCHEMA: Record<string, TypeInfo> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  Node: { kind: 'INTERFACE', fields: ['id'] },
  User: { kind: 'OBJECT', fields: ['login', 'id'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'createdAt', 'updatedAt', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'comments', 'createdAt', 'updatedAt', 'author'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'createdAt', 'updatedAt', 'author', 'headRefOid', 'baseRefOid'],
  },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'filename', 'additions', 'deletions', 'changes', 'status'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFileEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  Comment: { kind: 'OBJECT', fields: ['id', 'body', 'createdAt', 'updatedAt', 'author'] },
  CommentConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  CommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  Ref: { kind: 'OBJECT', fields: ['name'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge'] },
  CommentEdgePayload: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  __Schema: { kind: 'OBJECT', fields: ['queryType', 'mutationType', 'subscriptionType', 'types', 'directives', 'description'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description', 'type', 'args', 'isDeprecated', 'deprecationReason'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description', 'isDeprecated', 'deprecationReason'] },
  __InputValue: { kind: 'OBJECT', fields: ['name', 'description', 'type', 'defaultValue'] },
  __Directive: { kind: 'OBJECT', fields: ['name', 'description', 'locations', 'args'] },
  IssueState: { kind: 'ENUM', fields: [], enums: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enums: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enums: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  OrderDirection: { kind: 'ENUM', fields: [], enums: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', fields: [], enums: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  PullRequestMergeMethod: { kind: 'ENUM', fields: [], enums: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', fields: [], enums: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', fields: [], enums: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'] },
  String: { kind: 'SCALAR', fields: [] },
  Int: { kind: 'SCALAR', fields: [] },
  Boolean: { kind: 'SCALAR', fields: [] },
  ID: { kind: 'SCALAR', fields: [] },
};

/** What a field's selection set resolves into, for validation. */
const CHILD_TYPE: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    owner: 'User',
    defaultBranchRef: 'Ref',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  Issue: { comments: 'CommentConnection', author: 'User' },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
  IssueEdge: { node: 'Issue' },
  PullRequest: { files: 'PullRequestChangedFileConnection', author: 'User' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
  PullRequestEdge: { node: 'PullRequest' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', edges: 'PullRequestChangedFileEdge', pageInfo: 'PageInfo' },
  PullRequestChangedFileEdge: { node: 'PullRequestChangedFile' },
  CommentConnection: { nodes: 'Comment', edges: 'CommentEdge', pageInfo: 'PageInfo' },
  CommentEdge: { node: 'Comment' },
  Comment: { author: 'User' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'CommentEdgePayload' },
  CommentEdgePayload: { node: 'Comment' },
  __Schema: { queryType: '__Type', mutationType: '__Type', subscriptionType: '__Type', types: '__Type', directives: '__Directive' },
  __Type: { fields: '__Field', enumValues: '__EnumValue', inputFields: '__InputValue', interfaces: '__Type', possibleTypes: '__Type' },
  __Field: { type: '__Type', args: '__InputValue' },
  __EnumValue: {},
  __InputValue: { type: '__Type' },
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>;

/** The forge's own record types, read off the Forge class so this file
 *  does not depend on forge.ts exporting the interfaces by name. */
type Repo = NonNullable<ReturnType<Forge['getRepo']>>;
type Issue = Repo['issues'] extends Map<number, infer V> ? V : never;
type Pull = Repo['pulls'] extends Map<number, infer V> ? V : never;
type Comment = Issue['comments'] extends Array<infer V> ? V : never;

/** A resolved value together with the GraphQL type it was resolved as.
 *  `data` carries whatever the field resolvers need (the repo, the issue,
 *  a page of items, ...). */
interface Holder {
  kind: string;
  data: AnyRecord;
}

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

type Resolved = string | number | boolean | null | Holder | Holder[] | unknown[];

function holder(kind: string, data: AnyRecord): Holder {
  return { kind, data };
}

function isHolder(value: unknown): value is Holder {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && 'kind' in value && 'data' in value;
}

/** Replace variables and enums in a parsed value with their runtime form. */
function resolveValue(value: GqlValue, ctx: Ctx): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if ('$var' in value) {
      const name = (value as { $var: string }).$var;
      return name in ctx.variables ? (ctx.variables[name] ?? null) : null;
    }
    if ('$enum' in value) return (value as { $enum: string }).$enum;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, GqlValue>)) out[key] = resolveValue(child, ctx);
    return out;
  }
  if (Array.isArray(value)) return value.map((child) => resolveValue(child, ctx));
  return value;
}

function argOf(field: FieldSelection, name: string, ctx: Ctx): unknown {
  const raw = field.args[name];
  if (raw === undefined) return undefined;
  return resolveValue(raw, ctx);
}

/** Opaque cursor: base64url of `pg-<number>`. Only this file reads it. */
function encodeCursor(n: number): string {
  return Buffer.from(`pg-${n}`, 'utf8').toString('base64url');
}

function decodeCursor(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const text = Buffer.from(value, 'base64url').toString('utf8');
    if (!text.startsWith('pg-')) return null;
    const n = Number.parseInt(text.slice(3), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Order issues by the orderBy argument; ties fall back to number, in the
 *  same direction as the sort, so DESC is a strict reverse of ASC. */
function sortIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const obj = (orderBy !== null && typeof orderBy === 'object' && !Array.isArray(orderBy) ? orderBy : {}) as AnyRecord;
  const direction = typeof obj.direction === 'string' ? String(obj.direction).toUpperCase() : 'ASC';
  const fieldName = typeof obj.field === 'string' ? String(obj.field).toUpperCase() : 'CREATED_AT';
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

function repoHolder(repo: Repo): Holder {
  return holder('Repository', { repo });
}

function issueHolder(repo: Repo, issue: Issue): Holder {
  return holder('Issue', { repo, issue });
}

function pullHolder(repo: Repo, pull: Pull): Holder {
  return holder('PullRequest', { repo, pull });
}

function commentHolder(repo: Repo, issue: Issue, comment: Comment): Holder {
  return holder('Comment', { repo, issue, comment });
}

/** Resolve a global id into the node it names, or null. */
function nodeById(forge: Forge, id: string): Holder | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const [owner, name] = decoded.key.split('/');
    const repo = forge.getRepo(owner as string, name as string);
    if (repo === undefined) return null;
    return repoHolder(repo);
  }
  if (decoded.kind === 'User') {
    return holder('User', { login: decoded.key });
  }
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
    const parts = splitNumberedKey(decoded.key);
    if (parts === null) return null;
    const repo = forge.getRepo(parts.owner, parts.name);
    if (repo === undefined) return null;
    if (decoded.kind === 'Issue') {
      const issue = repo.issues.get(parts.number);
      if (issue === undefined) return null;
      return issueHolder(repo, issue);
    }
    const pull = repo.pulls.get(parts.number);
    if (pull === undefined) return null;
    return pullHolder(repo, pull);
  }
  return null;
}

/** Split `owner/name:number` into its parts. */
function splitNumberedKey(key: string): { owner: string; name: string; number: number } | null {
  const colon = key.lastIndexOf(':');
  if (colon < 0) return null;
  const ownerName = key.slice(0, colon);
  const num = Number(key.slice(colon + 1));
  if (!Number.isInteger(num)) return null;
  const slash = ownerName.indexOf('/');
  if (slash < 0) return null;
  return { owner: ownerName.slice(0, slash), name: ownerName.slice(slash + 1), number: num };
}

/** Check a selection set against the catalogue; every unknown field
 *  becomes an error naming it. A connection field also accepts its item
 *  fields written directly (`issues { number }` instead of
 *  `issues { nodes { number } }`): those validate against the item type. */
function validateSelection(selections: Selection[], parentType: string, errors: { message: string }[]): void {
  const info = SCHEMA[parentType];
  const itemType = CHILD_TYPE[parentType]?.nodes;
  for (const sel of selections) {
    if (sel.kind === 'spread') continue; // gone after expansion; skip defensively
    if (sel.kind === 'fragment') {
      if (SCHEMA[sel.typeName] === undefined) {
        errors.push({ message: `Unknown type "${sel.typeName}".` });
        continue;
      }
      validateSelection(sel.selections, sel.typeName, errors);
      continue;
    }
    if (sel.name === '__typename') continue;
    if (info === undefined) continue;
    if (!info.fields.includes(sel.name)) {
      // Direct-list form: the field belongs to the connection's item type.
      if (itemType !== undefined && (SCHEMA[itemType]?.fields.includes(sel.name) ?? false)) {
        const childType = CHILD_TYPE[itemType]?.[sel.name];
        if (childType !== undefined && sel.selections.length > 0) validateSelection(sel.selections, childType, errors);
        continue;
      }
      errors.push({ message: `Cannot query field "${sel.name}" on type "${parentType}".` });
      continue;
    }
    const childType = CHILD_TYPE[parentType]?.[sel.name];
    if (childType !== undefined && sel.selections.length > 0) validateSelection(sel.selections, childType, errors);
  }
}

/** Run a selection set against a holder, honouring fragments and aliases. */
function runFields(node: Holder, selections: Selection[], ctx: Ctx): AnyRecord {
  const out: AnyRecord = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') continue; // gone after expansion; skip defensively
    if (sel.kind === 'fragment') {
      if (sel.typeName === node.kind || sel.typeName === 'Node') {
        Object.assign(out, runFields(node, sel.selections, ctx));
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[key] = node.kind;
      continue;
    }
    out[key] = present(readField(node, sel, ctx), sel, ctx);
  }
  return out;
}

/** Turn a resolver's return into response JSON: a holder runs its own
 *  selection set, a list of holders runs each one, anything else is a
 *  scalar already. */
function present(value: Resolved, field: FieldSelection, ctx: Ctx): unknown {
  if (value === null) return null;
  if (isHolder(value)) {
    if (field.selections.length === 0) return value.data;
    return runFields(value, field.selections, ctx);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (isHolder(entry)) {
        return field.selections.length === 0 ? entry.data : runFields(entry, field.selections, ctx);
      }
      return entry;
    });
  }
  return value;
}

/** One page of a connection: the holders on this page plus the cursors
 *  that describe it. Items are already in display order; paging is by
 *  each item's own number (issue/pull number, comment id, file index). */
interface ConnPage {
  page: Holder[];
  hasNext: boolean;
  hasPrev: boolean;
  endCursor: string | null;
  startCursor: string | null;
}

function pageOf(conn: Holder): ConnPage {
  const items = conn.data.items as Holder[];
  const first = conn.data.first as unknown;
  const after = conn.data.after as unknown;
  const last = conn.data.last as unknown;
  const numbers = items.map((item) => itemNumber(item));
  const afterNum = decodeCursor(after);
  let start = 0;
  if (afterNum !== null) {
    const index = numbers.findIndex((n) => n === afterNum);
    start = index >= 0 ? index + 1 : 0;
  }
  let end = numbers.length;
  if (typeof first === 'number' && Number.isFinite(first)) end = Math.min(end, start + Math.max(0, Math.trunc(first)));
  let page = items.slice(start, end);
  if (typeof last === 'number' && Number.isFinite(last)) {
    const keep = Math.max(0, Math.trunc(last));
    if (page.length > keep) page = page.slice(page.length - keep);
  }
  const pageNumbers = page.map((item) => itemNumber(item));
  return {
    page,
    // `end` is the far edge of the first-window, so anything past it
    // means another page exists even when `last` trimmed this one.
    hasNext: end < numbers.length,
    hasPrev: start > 0,
    endCursor: pageNumbers.length > 0 && pageNumbers[pageNumbers.length - 1] !== null ? encodeCursor(pageNumbers[pageNumbers.length - 1] as number) : null,
    startCursor: pageNumbers.length > 0 && pageNumbers[0] !== null ? encodeCursor(pageNumbers[0] as number) : null,
  };
}

/** Build a connection holder for a page of items, or — when the query
 *  asks for the item fields directly instead of nodes/edges — the plain
 *  list of item holders. The caller decides by the selection set. */
function shapeList(
  field: FieldSelection,
  connectionKind: string,
  items: Holder[],
  first: unknown,
  after: unknown,
  last: unknown,
): Holder | Holder[] {
  const names = field.selections.filter((sel) => sel.kind === 'field').map((sel) => (sel as FieldSelection).name);
  const wantsConnection = names.some((name) => name === 'nodes' || name === 'edges' || name === 'pageInfo' || name === 'totalCount');
  if (!wantsConnection) {
    // A direct list still honours first/last; there is no cursor to resume from.
    let sliced = items;
    if (typeof first === 'number' && Number.isFinite(first)) sliced = sliced.slice(0, Math.max(0, Math.trunc(first)));
    if (typeof last === 'number' && Number.isFinite(last)) {
      const keep = Math.max(0, Math.trunc(last));
      sliced = sliced.slice(Math.max(0, sliced.length - keep));
    }
    return sliced;
  }
  return holder(connectionKind, { items, first, after, last });
}

function itemNumber(item: Holder): number | null {
  const data = item.data;
  if (item.kind === 'Issue' && data.issue !== undefined) return (data.issue as Issue).number;
  if (item.kind === 'PullRequest' && data.pull !== undefined) return (data.pull as Pull).number;
  if (item.kind === 'Comment' && data.comment !== undefined) return (data.comment as Comment).id;
  if (item.kind === 'PullRequestChangedFile' && typeof data.index === 'number') return data.index as number;
  return null;
}

/** Read one field of a holder. Unknown names return null here; the
 *  validator has already reported them. */
function readField(node: Holder, field: FieldSelection, ctx: Ctx): Resolved {
  const data = node.data;
  switch (node.kind) {
    case 'Query': {
      switch (field.name) {
        case 'viewer':
          return holder('User', { login: VIEWER_LOGIN });
        case 'repository': {
          const owner = argOf(field, 'owner', ctx) as string | undefined;
          const name = argOf(field, 'name', ctx) as string | undefined;
          if (typeof owner !== 'string' || typeof name !== 'string') return null;
          const repo = ctx.forge.getRepo(owner, name);
          if (repo === undefined) return null;
          return repoHolder(repo);
        }
        case 'node': {
          const id = argOf(field, 'id', ctx);
          if (typeof id !== 'string') return null;
          return nodeById(ctx.forge, id);
        }
        case '__type': {
          const name = argOf(field, 'name', ctx);
          if (typeof name !== 'string' || SCHEMA[name] === undefined) return null;
          return holder('__Type', { typeName: name });
        }
        case '__schema':
          return holder('__Schema', {});
        default:
          return null;
      }
    }
    case 'Mutation': {
      switch (field.name) {
        case 'createIssue': {
          const input = (argOf(field, 'input', ctx) ?? {}) as AnyRecord;
          const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
          if (decoded === null || decoded.kind !== 'Repository') {
            ctx.errors.push({ message: `createIssue: unknown repository id "${String(input.repositoryId ?? '')}"` });
            return holder('CreateIssuePayload', { issue: null });
          }
          const [owner, name] = decoded.key.split('/');
          const repo = ctx.forge.getRepo(owner as string, name as string);
          if (repo === undefined) {
            ctx.errors.push({ message: `createIssue: repository "${decoded.key}" does not exist` });
            return holder('CreateIssuePayload', { issue: null });
          }
          const issue = ctx.forge.createIssueDirect(repo, String(input.title ?? ''), String(input.body ?? ''));
          return holder('CreateIssuePayload', { repo, issue });
        }
        case 'closeIssue': {
          const input = (argOf(field, 'input', ctx) ?? {}) as AnyRecord;
          const decoded = decodeGlobalId(String(input.issueId ?? ''));
          const parts = decoded !== null && decoded.kind === 'Issue' ? splitNumberedKey(decoded.key) : null;
          if (parts === null) {
            ctx.errors.push({ message: `closeIssue: unknown issue id "${String(input.issueId ?? '')}"` });
            return holder('CloseIssuePayload', { issue: null });
          }
          const repo = ctx.forge.getRepo(parts.owner, parts.name);
          const issue = repo?.issues.get(parts.number);
          if (repo === undefined || issue === undefined) {
            ctx.errors.push({ message: `closeIssue: issue #${parts.number} does not exist` });
            return holder('CloseIssuePayload', { issue: null });
          }
          issue.state = 'closed';
          issue.updated_at = ctx.forge.nowIso();
          return holder('CloseIssuePayload', { repo, issue });
        }
        case 'createPullRequest': {
          const input = (argOf(field, 'input', ctx) ?? {}) as AnyRecord;
          const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
          if (decoded === null || decoded.kind !== 'Repository') {
            ctx.errors.push({ message: `createPullRequest: unknown repository id "${String(input.repositoryId ?? '')}"` });
            return holder('CreatePullRequestPayload', { pullRequest: null });
          }
          const [owner, name] = decoded.key.split('/');
          const repo = ctx.forge.getRepo(owner as string, name as string);
          if (repo === undefined) {
            ctx.errors.push({ message: `createPullRequest: repository "${decoded.key}" does not exist` });
            return holder('CreatePullRequestPayload', { pullRequest: null });
          }
          const pull = ctx.forge.createPull(
            repo,
            String(input.title ?? ''),
            String(input.body ?? ''),
            String(input.headRefName ?? ''),
            String(input.baseRefName ?? ''),
          );
          if ('error' in pull) {
            ctx.errors.push({ message: `createPullRequest: ${pull.error}` });
            return holder('CreatePullRequestPayload', { pullRequest: null });
          }
          return holder('CreatePullRequestPayload', { repo, pull });
        }
        case 'mergePullRequest': {
          const input = (argOf(field, 'input', ctx) ?? {}) as AnyRecord;
          const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
          const parts = decoded !== null && decoded.kind === 'PullRequest' ? splitNumberedKey(decoded.key) : null;
          if (parts === null) {
            ctx.errors.push({ message: `mergePullRequest: unknown pull request id "${String(input.pullRequestId ?? '')}"` });
            return holder('MergePullRequestPayload', { pullRequest: null });
          }
          const repo = ctx.forge.getRepo(parts.owner, parts.name);
          const pull = repo?.pulls.get(parts.number);
          if (repo === undefined || pull === undefined) {
            ctx.errors.push({ message: `mergePullRequest: pull request #${parts.number} does not exist` });
            return holder('MergePullRequestPayload', { pullRequest: null });
          }
          const merged = ctx.forge.mergePull(repo, pull, 'squash');
          if ('error' in merged) {
            ctx.errors.push({ message: `mergePullRequest: ${merged.error}` });
          }
          return holder('MergePullRequestPayload', { repo, pull });
        }
        case 'addComment': {
          const input = (argOf(field, 'input', ctx) ?? {}) as AnyRecord;
          const decoded = decodeGlobalId(String(input.subjectId ?? ''));
          const parts = decoded !== null && decoded.kind === 'Issue' ? splitNumberedKey(decoded.key) : null;
          if (parts === null) {
            ctx.errors.push({ message: `addComment: unknown subject id "${String(input.subjectId ?? '')}"` });
            return holder('AddCommentPayload', { comment: null });
          }
          const repo = ctx.forge.getRepo(parts.owner, parts.name);
          const issue = repo?.issues.get(parts.number);
          if (repo === undefined || issue === undefined) {
            ctx.errors.push({ message: `addComment: issue #${parts.number} does not exist` });
            return holder('AddCommentPayload', { comment: null });
          }
          const now = ctx.forge.nowIso();
          const comment: Comment = {
            id: ctx.forge.nextSeq() + 100000,
            body: String(input.body ?? ''),
            user: { login: VIEWER_LOGIN },
            created_at: now,
            updated_at: now,
          } as Comment;
          issue.comments.push(comment);
          return holder('AddCommentPayload', { repo, issue, comment });
        }
        default:
          return null;
      }
    }
    case 'User': {
      if (field.name === 'login') return String(data.login ?? '');
      if (field.name === 'id') return globalId('User', String(data.login ?? ''));
      return null;
    }
    case 'Repository': {
      const repo = data.repo as Repo;
      switch (field.name) {
        case 'id':
          return globalId('Repository', `${repo.owner}/${repo.name}`);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return holder('User', { login: repo.owner });
        case 'defaultBranchRef':
          return holder('Ref', { name: repo.default_branch });
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'createdAt':
          return repo.created_at;
        case 'updatedAt':
          return repo.updated_at;
        case 'issue': {
          const number = argOf(field, 'number', ctx) as number | undefined;
          if (typeof number !== 'number') return null;
          const issue = repo.issues.get(number);
          if (issue === undefined) return null;
          return issueHolder(repo, issue);
        }
        case 'issues': {
          const states = argOf(field, 'states', ctx) as unknown;
          let issues = [...repo.issues.values()];
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((s) => String(s).toLowerCase()));
            issues = issues.filter((issue) => wanted.has(issue.state));
          }
          issues = sortIssues(issues, argOf(field, 'orderBy', ctx));
          const holders = issues.map((issue) => issueHolder(repo, issue));
          return shapeList(field, 'IssueConnection', holders, argOf(field, 'first', ctx), argOf(field, 'after', ctx), argOf(field, 'last', ctx));
        }
        case 'pullRequests': {
          const pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
          const holders = pulls.map((pull) => pullHolder(repo, pull));
          return shapeList(field, 'PullRequestConnection', holders, argOf(field, 'first', ctx), argOf(field, 'after', ctx), argOf(field, 'last', ctx));
        }
        case 'pullRequest': {
          const number = argOf(field, 'number', ctx) as number | undefined;
          if (typeof number !== 'number') return null;
          const pull = repo.pulls.get(number);
          if (pull === undefined) return null;
          return pullHolder(repo, pull);
        }
        default:
          return null;
      }
    }
    case 'Issue': {
      const issue = data.issue as Issue;
      const repo = data.repo as Repo;
      switch (field.name) {
        case 'id':
          return globalId('Issue', `${repo.owner}/${repo.name}:${issue.number}`);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body':
          return issue.body;
        case 'createdAt':
          return issue.created_at;
        case 'updatedAt':
          return issue.updated_at;
        case 'author':
          return holder('User', { login: issue.user.login });
        case 'comments': {
          const holders = issue.comments.map((comment) => commentHolder(repo, issue, comment));
          return shapeList(field, 'CommentConnection', holders, argOf(field, 'first', ctx), argOf(field, 'after', ctx), argOf(field, 'last', ctx));
        }
        default:
          return null;
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'CommentConnection': {
      switch (field.name) {
        case 'nodes':
          return pageOf(node).page;
        case 'edges': {
          const nodes = pageOf(node).page;
          return nodes.map((item) => {
            const n = itemNumber(item);
            return holder(`${node.kind.replace('Connection', 'Edge')}`, { node: item, cursor: n === null ? null : encodeCursor(n) });
          });
        }
        case 'pageInfo': {
          const page = pageOf(node);
          return holder('PageInfo', {
            hasNextPage: page.hasNext,
            endCursor: page.endCursor,
            hasPreviousPage: page.hasPrev,
            startCursor: page.startCursor,
          });
        }
        case 'totalCount':
          return (node.data.items as Holder[]).length;
        default:
          return null;
      }
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestChangedFileEdge':
    case 'CommentEdge': {
      if (field.name === 'node') return (data.node as Holder) ?? null;
      if (field.name === 'cursor') return (data.cursor as string | null) ?? null;
      return null;
    }
    case 'PullRequest': {
      const pull = data.pull as Pull;
      const repo = data.repo as Repo;
      switch (field.name) {
        case 'id':
          return globalId('PullRequest', `${repo.owner}/${repo.name}:${pull.number}`);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'state':
          return pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.head.ref;
        case 'baseRefName':
          return pull.base.ref;
        case 'headRefOid':
          return pull.head.sha;
        case 'baseRefOid':
          return pull.base.sha;
        case 'mergeable':
          return ctx.forge.mergeable(repo, pull);
        case 'body':
          return pull.body;
        case 'createdAt':
          return pull.created_at;
        case 'updatedAt':
          return pull.updated_at;
        case 'author':
          return holder('User', { login: pull.user.login });
        case 'files': {
          const files = ctx.forge.pullFiles(repo, pull);
          const holders = files.map((file, index) => holder('PullRequestChangedFile', { file, index }));
          return shapeList(field, 'PullRequestChangedFileConnection', holders, argOf(field, 'first', ctx), argOf(field, 'after', ctx), argOf(field, 'last', ctx));
        }
        default:
          return null;
      }
    }
    case 'PullRequestChangedFile': {
      const file = data.file as { filename: string; status: string; additions: number; deletions: number; changes: number };
      switch (field.name) {
        case 'path':
        case 'filename':
          return file.filename;
        case 'status':
          return file.status;
        case 'additions':
          return file.additions;
        case 'deletions':
          return file.deletions;
        case 'changes':
          return file.changes;
        default:
          return null;
      }
    }
    case 'Comment': {
      const comment = data.comment as Comment;
      switch (field.name) {
        case 'id':
          return globalId('Comment', String(comment.id));
        case 'body':
          return comment.body;
        case 'createdAt':
          return comment.created_at;
        case 'updatedAt':
          return comment.updated_at;
        case 'author':
          return holder('User', { login: comment.user.login });
        default:
          return null;
      }
    }
    case 'Ref':
      return field.name === 'name' ? String(data.name ?? '') : null;
    case 'PageInfo': {
      switch (field.name) {
        case 'hasNextPage':
          return (data.hasNextPage as boolean) ?? false;
        case 'endCursor':
          return (data.endCursor as string | null) ?? null;
        case 'hasPreviousPage':
          return (data.hasPreviousPage as boolean) ?? false;
        case 'startCursor':
          return (data.startCursor as string | null) ?? null;
        default:
          return null;
      }
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name !== 'issue') return null;
      const issue = data.issue as Issue | null;
      if (issue === null || issue === undefined) return null;
      return issueHolder(data.repo as Repo, issue);
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name !== 'pullRequest') return null;
      const pull = data.pull as Pull | null;
      if (pull === null || pull === undefined) return null;
      return pullHolder(data.repo as Repo, pull);
    }
    case 'AddCommentPayload': {
      if (field.name !== 'commentEdge') return null;
      const comment = data.comment as Comment | null;
      if (comment === null || comment === undefined) return null;
      return holder('CommentEdgePayload', { repo: data.repo, issue: data.issue, comment });
    }
    case 'CommentEdgePayload': {
      if (field.name === 'node') {
        const comment = data.comment as Comment;
        return commentHolder(data.repo as Repo, data.issue as Issue, comment);
      }
      if (field.name === 'cursor') return null;
      return null;
    }
    case '__Schema': {
      switch (field.name) {
        case 'queryType':
          return holder('__Type', { typeName: 'Query' });
        case 'mutationType':
          return holder('__Type', { typeName: 'Mutation' });
        case 'subscriptionType':
          return null;
        case 'types':
          return Object.keys(SCHEMA)
            .filter((name) => !name.startsWith('__'))
            .map((name) => holder('__Type', { typeName: name }));
        case 'directives':
          return [];
        case 'description':
          return null;
        default:
          return null;
      }
    }
    case '__Type': {
      const typeName = String(data.typeName ?? '');
      const info = SCHEMA[typeName];
      switch (field.name) {
        case 'name':
          return typeName;
        case 'kind':
          return info?.kind ?? null;
        case 'description':
          return null;
        case 'fields':
          return (info?.fields ?? []).map((name) => holder('__Field', { name }));
        case 'enumValues':
          return (info?.enums ?? []).map((name) => holder('__EnumValue', { name }));
        case 'inputFields':
          return [];
        case 'interfaces':
          return [];
        case 'possibleTypes':
          return [];
        default:
          return null;
      }
    }
    case '__Field': {
      switch (field.name) {
        case 'name':
          return String(data.name ?? '');
        case 'description':
          return null;
        case 'type':
          return null;
        case 'args':
          return [];
        case 'isDeprecated':
          return false;
        case 'deprecationReason':
          return null;
        default:
          return null;
      }
    }
    case '__EnumValue': {
      switch (field.name) {
        case 'name':
          return String(data.name ?? '');
        case 'description':
          return null;
        case 'isDeprecated':
          return false;
        case 'deprecationReason':
          return null;
        default:
          return null;
      }
    }
    case '__InputValue': {
      if (field.name === 'name') return String(data.name ?? '');
      if (field.name === 'description') return null;
      if (field.name === 'type') return null;
      if (field.name === 'defaultValue') return null;
      return null;
    }
    case '__Directive': {
      if (field.name === 'name') return String(data.name ?? '');
      if (field.name === 'description') return null;
      if (field.name === 'locations') return [];
      if (field.name === 'args') return [];
      return null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Execute one parsed operation against the forge. */
export function executeOperation(forge: Forge, operation: Operation, variables: Record<string, unknown>): GraphQLResult {
  const ctx: Ctx = { forge, variables: { ...variables }, errors: [] };
  for (const [key, def] of Object.entries(operation.varDefaults ?? {})) {
    if (!(key in ctx.variables)) ctx.variables[key] = resolveValue(def, ctx);
  }
  const validationErrors: { message: string }[] = [];
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  validateSelection(operation.fields, rootType, validationErrors);
  if (validationErrors.length > 0) return { data: null, errors: validationErrors };
  const root = holder(rootType, {});
  const data = runFields(root, operation.fields, ctx);
  return { data, errors: ctx.errors };
}

/** Execute a request body: one operation object, or an array of them
 *  (GitHub's operation batching, answered in order). */
export function executeGraphQL(forge: Forge, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((entry) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return { data: null, errors: [{ message: 'expected a GraphQL operation object' }] };
      }
      return executeOne(forge, entry as AnyRecord);
    });
  }
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) return executeOne(forge, body as AnyRecord);
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
    operations = new Parser(tokenize(query)).parseDocument();
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
