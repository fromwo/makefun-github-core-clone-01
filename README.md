# makefun-github-core-clone-01

A standalone GitHub-compatible git forge, built for the
[make.fun bounty](https://make.fun/bounty/github-core-clone-01): one Node 22 process
serving git smart HTTP, the REST v3 API, GraphQL v4 and MCP from its own in-memory
store. No UI, no dependencies, no outside service, no `git` binary.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own; the flag is harmless there and makes an older local
Node work too. There is nothing to install: the program imports `node:http` and
its own modules only.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in
`MAKEFUN_ENV_URL` (`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one.
   Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port>}`.
   The first register wins; a later one is answered `409`.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers `{"done":false}` while
   the suite runs and `{"done":true}` once its export is written. Poll with a
   short backoff; never exit before it says `true`.
4. **Exit 0** when it does.

If `MAKEFUN_ENV_URL` is unset there is nothing to talk to, so `main.ts` exits 1
at once. A register answered 400 or 405 is a contract error and ends the
program; any other failure is retried with exponential backoff, since the env
may still be starting.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-OAuth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2 and v0), `git-receive-pack` (v0) |
| anything else | 404 `{"message":"Not Found"}` |

Every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a missing or
wrong token is 401. A repository belongs to the login the token names, so the
same repository name under another owner is 404, never 403. Every reply is
`application/json` and carries a non-empty `X-GitHub-Request-Id`.

## The store (store.ts)

The forge keeps everything in one in-memory `Forge`: repositories in a keyed
map, git objects in per-repo maps, and issues, pull requests and labels beside
them. There is no disk and no clock read anywhere in the store: a logical
counter hands out one timestamp per event from a fixed epoch, so two runs of
the same requests produce the same bytes.

What the store does for the rest of the server:

- **Repositories** — create / get / delete / list, all scoped to the single
  viewer login; a name under any other owner is simply not found.
- **Git objects** — content-addressed put and lookup by SHA-1, ref tips with
  annotated-tag peeling, branch lists, and tip-first commit walks.
- **Contents commits** — commit one file or delete one file on a branch (a
  missing branch is seeded from the default branch tip), plus file and
  directory reads out of a ref's tree.
- **Issues** — creation with label validation (an unknown label is an error),
  sharing the repo's issue/PR number sequence.
- **Pull requests** — creation with head/base existence checks and a
  duplicate-open-PR guard, per-file diffs with line counts, a three-way
  mergeability check, and squash-merge onto the base branch.
- **Views** — `repoView`, `issueView` and `pullView` shape the REST v3 JSON,
  and `globalId` / `decodeGlobalId` encode the GraphQL node ids.

## Layout

- `main.ts`: the lifecycle above.
- `app.ts`: the HTTP server and the REST v3 routes.
- `store.ts`: the in-memory forge: repositories, git objects, issues, pull
  requests, labels, comments. A logical clock supplies timestamps, so two runs
  of the same requests produce the same bytes.
- `gitcore.ts`: the git object model: SHA-1 hashing, tree/commit/tag
  parse and build, reachability, packfile read and write (v2/v3, OFS and REF
  deltas), pkt-line framing.
- `gitproto.ts`: smart HTTP: v0/v2 advertisements, `ls-refs`, `fetch`
  (want/have/shallow/deepen), `receive-pack` with per-ref fast-forward checks.
- `graphql.ts`: a small GraphQL parser and executor for the queries and
  mutations `gh` and `github-mcp-server` send, including variables, aliases,
  inline fragments and batched operation arrays.
- `mcp.ts`: the MCP endpoint: `server/discover`, the legacy `initialize`
  handshake, and six tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`).
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and
  licence.

## Rules and limits

Node 22 only, no dependencies at run time, no internet and no `git` binary in
the trial; the repository is mounted read-only at `/bot` and the program may
write under `/tmp` only. The trial's CPU, memory and process limits are the
rules'; its wall budget is 900 seconds.
