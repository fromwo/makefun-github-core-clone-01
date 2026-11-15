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
Node work too. There is nothing to install: the program imports `node:http`,
`node:crypto`, `node:zlib` and its own modules only.

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
4. **Exit 0.** Close the server and exit. The harness then stops the env,
   which writes the export the scorer reads.

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | The entry ↔ env lifecycle above, nothing else. |
| `http.ts` | HTTP wiring: one server, body reading, bearer auth, dispatch. |
| `api.ts` | REST v3: repositories, contents, labels, issues, pull requests. |
| `forge.ts` | The in-memory store: repos, refs, issues, pulls, three-way merge. |
| `objects.ts` | Git object model: SHA-1 ids, tree/commit/tag codec, packfiles, pkt-line. |
| `smart-http.ts` | Git smart HTTP: info/refs, upload-pack v2/v0, receive-pack v0. |
| `graphql.ts` | GraphQL v4: a hand-written parser, introspection, queries, mutations. |
| `mcp.ts` | MCP over Streamable HTTP: initialize, server/discover, tools/list, tools/call. |

All four surfaces read and write the same `Forge` instance, so a repository
created over MCP reads back over REST with the same ids, and a branch pushed
over git is the branch a pull request opens from.

## The store (forge.ts)

One `Forge` holds every repository: its refs (`Map<ref, oid>`), its git
objects (`Map<oid, {type, data}>`), labels, issues and pull requests. Nothing
touches disk and nothing reads a clock: a logical counter hands out
timestamps (one second per event from a fixed epoch), so replaying the same
requests always produces the same bytes. Issue and pull-request numbers share
one counter per repository; ids are global and monotonic.

Repositories belong to the login the trial token names (`adaiversen` unless
`MAKEFUN_VIEWER_LOGIN` says otherwise). The same repository name under any
other owner is a 404, never a 403.

## Git (objects.ts, smart-http.ts)

The object model is implemented from scratch on `node:crypto` (SHA-1) and
`node:zlib` (inflate/deflate): loose objects in memory, packfiles with plain,
OFS-delta and REF-delta entries, delta application, reachability, merge-base
and fast-forward checks. There is no `git` binary anywhere in the path.

- **upload-pack** speaks protocol v2 when the client asks with
  `Git-Protocol: version=2` (capability advertisement, `ls-refs`, `fetch`
  with shallow/deepen) and falls back to v0 otherwise.
- **receive-pack** is v0 only and advertises `report-status`, `side-band-64k`
  and `delete-refs`. Every update must fast-forward: a non-fast-forward push
  is refused per ref with `ng <ref> non-fast-forward` and the ref does not
  move; a push carrying one good ref and one refused ref applies the good one
  and reports one line each.
- Pack bytes are a pure function of the packed objects and are cached by the
  sorted oid list, so fifty concurrent shallow clones of one tip deflate once.

## REST v3 (api.ts)

Every reply is `application/json` with a non-empty `X-GitHub-Request-Id`.
Errors carry `{"message": string}`; unknown routes are 404 JSON; malformed
JSON bodies are 400. A request without the trial bearer token is 401.

- `GET /api/v3/` (200, `X-OAuth-Scopes`), `GET /api/v3/meta` (200,
  `installed_version`), `GET /api/v3/user/repos` (paginated, `Link: rel="next"`)
- Repositories: create (201), read, patch description, delete (204).
- Contents: create (201) / update (200) / stale sha (409), delete (200).
- Labels must be created before an issue may carry one; an unknown label on
  issue creation is 422.
- Issues and pull requests: create (201), read, list, close, merge. Merging
  squash-merges onto the base branch; a conflicted pull is 405.

## GraphQL v4 (graphql.ts)

A hand-written parser (lexer, two-pass parser, inline and named fragments)
drives one schema catalogue that serves both execution and introspection, so
`__type(name: "Issue")`, `__type(name: "PullRequest")`,
`__type(name: "Repository")` and `SearchType` describe exactly the fields the
resolvers answer. `repository.issues` with `orderBy: {field: CREATED_AT,
direction: DESC}` returns numbers descending, ties by number; `states: [OPEN]`
omits closed issues. `createPullRequest` takes a repository global id and a
head branch pushed over git. Two operation documents in one body answer two
results in order; an unknown field is HTTP 200 with an `errors` array naming
it; an unknown repository is `data.repository = null` with no errors.

## MCP (mcp.ts)

JSON-RPC 2.0 over Streamable HTTP. It speaks revision `2026-07-28`
(`server/discover` answers `supportedVersions`) and the handshake revisions
through `initialize` / `notifications/initialized`. `tools/list` offers
`create_repo`, `get_repo`, `create_issue`, `list_issues`,
`create_pull_request` and `merge_pull_request`, each with a description and an
`inputSchema` of type object; two `tools/list` calls answer byte for byte the
same list. Tool arguments are matched leniently (suffix, case-insensitive,
`full_name` split into owner/repo). An unknown tool is `-32602`/`-32601`,
never HTTP 500; a missing required argument is `isError: true` or `-32602`;
a non-JSON body is HTTP 400 with `-32700`; a call with no `Authorization`
header is 401.

## Determinism

No `Date.now()`, no `Math.random()`, no wall clock anywhere in served data.
Timestamps come from the store's logical clock; pack bytes, orderings and ids
are pure functions of the request history. Two runs of the same trial leave
the same state export, byte for byte.

## Local grading

The kit's `grade-local` is blocked by the kit's own inconsistency
(`competition.yaml`'s final phase starts at 06:10 while `rules/instance.yaml`
draws the scored round at 06:40), so grade by hand with the kit's own env and
scorer: start `program/env/server.mjs` with `MAKEFUN_STATE_DIR` and
`MAKEFUN_SHOP_TOKEN`, run this program against it, then score the export in
`<state>/export` with `program/scorer/score.mjs`. Practice trial-0 scores
990/1000 on the first run (120/120 checks: feature 600 + agent 200 +
perf 190) and 979/1000 on the second, with byte-identical `state.json`.
