// http.ts — the forge's HTTP wiring: one server, body reading, bearer auth,
// and dispatch to REST v3, GraphQL, MCP and git smart HTTP.
//
// This file owns the transport only. Route logic lives in api.ts (REST),
// graphql.ts, mcp.ts and smart-http.ts; each gets the same Forge instance
// created here, so all four surfaces read and write one store.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { handleRest } from './api.ts';
import { Forge } from './forge.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcpRequest } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './smart-http.ts';

/** The bearer token the suite presents; '' means the trial did not set one. */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/** Bodies larger than this are refused outright. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

/** Monotonic request ids: req-00000001, req-00000002, ... (unique per request). */
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read the whole request body, rejecting when it grows past the cap. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
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
  return match ? (match[1] as string).trim() : null;
}

/**
 * True when the request carries a usable bearer token. When the trial set a
 * token it must match exactly; when none was configured any non-empty token
 * is accepted (local runs without MAKEFUN_SHOP_TOKEN).
 */
function authorized(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

export function createApp(): Server {
  const forge = new Forge();

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = nextRequestId();

    /** Send a JSON reply (the default for every surface except git pack data). */
    const send = (status: number, payload: unknown, extra: Record<string, string> = {}): void => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'X-GitHub-Request-Id': requestId,
        ...extra,
      });
      res.end(JSON.stringify(payload ?? null));
    };

    /** Send a bare status with only the request-id header (204s, notifications). */
    const sendBare = (status: number): void => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'X-GitHub-Request-Id': requestId,
      });
      res.end();
    };

    /** Send raw bytes (git smart-HTTP replies) with their own content type. */
    const sendRaw = (status: number, raw: Buffer, contentType: string): void => {
      res.writeHead(status, {
        'Content-Type': contentType,
        'X-GitHub-Request-Id': requestId,
      });
      res.end(raw);
    };

    const unauthenticated = (): void => {
      send(401, { message: 'requires authentication' });
    };

    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = (req.method ?? 'GET').toUpperCase();
      let path: string;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        send(400, { message: 'malformed request path' });
        return;
      }
      const segments = path.split('/').filter((part) => part !== '');

      // ---------------------------------------------------------- health check (no auth)
      if (method === 'GET' && path === '/healthz') {
        send(200, { ok: true });
        return;
      }

      // ---------------------------------------------------------- git smart HTTP
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
      if (gitMatch) {
        const owner = gitMatch[1] as string;
        const repoName = gitMatch[2] as string;
        const tail = gitMatch[3] as string;
        if (!authorized(req)) {
          unauthenticated();
          return;
        }
        if (method === 'GET' && tail === 'info/refs') {
          const out = handleInfoRefs(
            forge,
            owner,
            repoName,
            url.searchParams.get('service') ?? '',
            firstHeader(req.headers['git-protocol']),
          );
          sendRaw(out.status, out.body, out.contentType);
          return;
        }
        if (method === 'POST' && tail === 'git-upload-pack') {
          const raw = await readBody(req);
          const out = handleUploadPack(forge, owner, repoName, raw, firstHeader(req.headers['git-protocol']));
          sendRaw(out.status, out.body, out.contentType);
          return;
        }
        if (method === 'POST' && tail === 'git-receive-pack') {
          const raw = await readBody(req);
          const out = handleReceivePack(forge, owner, repoName, raw);
          sendRaw(out.status, out.body, out.contentType);
          return;
        }
        send(404, { message: 'Not Found' });
        return;
      }

      // ---------------------------------------------------------- GraphQL
      if (method === 'POST' && path === '/api/graphql') {
        if (!authorized(req)) {
          unauthenticated();
          return;
        }
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          send(400, { message: 'malformed JSON body' });
          return;
        }
        send(200, executeGraphQL(forge, parsed));
        return;
      }

      // ---------------------------------------------------------- MCP
      if (method === 'POST' && path === '/mcp') {
        if (!authorized(req)) {
          unauthenticated();
          return;
        }
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
          return;
        }
        const outcome = handleMcpRequest(forge, parsed);
        if (outcome.body === null) {
          sendBare(outcome.status);
          return;
        }
        send(outcome.status, outcome.body);
        return;
      }

      // ---------------------------------------------------------- REST v3
      if (segments[0] === 'api' && segments[1] === 'v3') {
        if (!authorized(req)) {
          unauthenticated();
          return;
        }
        const raw = await readBody(req);
        let body: Record<string, unknown> = {};
        if (raw.length > 0) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            send(400, { message: 'malformed JSON body' });
            return;
          }
          if (isPlainObject(parsed)) {
            body = parsed;
          } else if (Array.isArray(parsed)) {
            body = {};
          } else {
            send(400, { message: 'malformed JSON body' });
            return;
          }
        }
        handleRest({
          forge,
          method,
          segments: segments.slice(2),
          url,
          body,
          host: req.headers.host ?? 'localhost',
          send,
          sendBare,
        });
        return;
      }

      // ---------------------------------------------------------- anything else
      if (!authorized(req)) {
        unauthenticated();
        return;
      }
      send(404, { message: 'Not Found' });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, {
          'Content-Type': 'application/json',
          'X-GitHub-Request-Id': requestId,
        });
        res.end(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
      } else {
        res.end();
      }
    }
  };

  return createServer(handler);
}
