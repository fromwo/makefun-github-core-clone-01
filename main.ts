// main.ts — the entry <-> env lifecycle.
//
// The harness starts an env server beside this process and hands its
// origin over in MAKEFUN_ENV_URL. This file only runs that handshake,
// then waits for the trial to end:
//
//   1. Without MAKEFUN_ENV_URL there is no env to talk to: exit 1 at once.
//   2. Build the server (from http.ts) and listen(0) so the kernel picks
//      a free port. Never bind 8080 — the env owns that port.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the
//      address the request came from plus N as this entry's base URL and
//      dials it from then on. The first register wins; a 409 means some
//      other entry already registered, and this process simply carries
//      on waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until it answers {"done": true}. The env
//      answers at once ({"done": false} while the suite runs), so this is
//      a poll with a short backoff, not a long-held request. A failed or
//      slow poll is retried; the process never exits before done is true.
//   5. Close the server and exit 0. The harness then stops the env,
//      which writes the export the scorer reads.
//
// main.ts imports its own server — createApp from http.ts — and nothing
// else: no package, no Node built-in, no model call.

import { createApp } from './http.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** One register or done request may take this long before it is abandoned and retried. */
const SINGLE_REQUEST_MS = 30_000;
/** First pause between retries, and the longest pause. */
const RETRY_START_MS = 250;
const RETRY_LIMIT_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pause after `failures` failed requests: exponential from RETRY_START_MS, capped. */
function waitAfterFailures(failures: number): number {
  return Math.min(RETRY_LIMIT_MS, RETRY_START_MS * 2 ** Math.min(failures, 8));
}

function isFatalRegisterFailure(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('register answered HTTP ');
}

/**
 * POST the bound port until the env accepts it. 200 is the normal
 * answer; 409 means a first register already won, which is not this
 * process's to fix. 400 and 405 are contract errors and end the
 * program; a network error or any other status is retried, since the
 * env may still be starting.
 */
async function registerPort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(SINGLE_REQUEST_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (isFatalRegisterFailure(err)) throw err;
    }
    await pause(waitAfterFailures(failures));
    failures += 1;
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitUntilDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(SINGLE_REQUEST_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await pause(waitAfterFailures(failures));
    failures += 1;
  }
}

/** Bind the port, register it, then wait for the env: the whole life of the process. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await registerPort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
