// main.ts — the entry <-> env lifecycle.
//
// The harness starts an env server beside this process and hands its origin
// over in MAKEFUN_ENV_URL. This file does only that handshake, then waits:
//
//   1. Without MAKEFUN_ENV_URL there is no env to talk to: exit 1 at once.
//   2. Build the server (from app.ts) and listen(0) so the kernel picks a
//      free port. Never bind 8080 — the env owns that port.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records where the
//      request came from plus N as this entry's base URL. The first register
//      wins; a 409 means another entry already registered, and this process
//      simply carries on waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until it answers {"done": true}. The env
//      answers immediately ({"done": false} while the suite runs), so this
//      is a poll with a short backoff, not a long-held request. A failed or
//      slow poll is retried; the process never exits before done is true.
//   5. Close the server and exit 0. The harness then stops the env, which
//      writes the export the scorer reads.
//
// main.ts imports its own server and nothing else: no package, no Node
// built-in, no model call.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** One register or done request may take this long before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** First wait between retries, and the longest wait. */
const RETRY_FIRST_MS = 250;
const RETRY_CEILING_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait after `failures` failed requests: exponential from RETRY_FIRST_MS, capped. */
function backoffMs(failures: number): number {
  return Math.min(RETRY_CEILING_MS, RETRY_FIRST_MS * 2 ** Math.min(failures, 8));
}

function isFatalRegisterError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('register answered HTTP ');
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer;
 * 409 means a first register already won, which is not this process's to
 * fix. 400 and 405 are contract errors and end the program; a network
 * error or any other status is retried, since the env may still be starting.
 */
async function register(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (isFatalRegisterError(err)) throw err;
    }
    await sleep(backoffMs(failures));
    failures += 1;
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitForDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(backoffMs(failures));
    failures += 1;
  }
}

/** Bind the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
