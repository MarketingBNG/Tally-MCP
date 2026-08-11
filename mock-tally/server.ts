import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Mock TallyPrime HTTP server — TEST SUPPORT ONLY.
 *
 * This is never a runtime dependency of the real MCP server. It exists so the
 * client, adapter and tool layers can be exercised without a live Tally.
 *
 * This harness serves only what a caller explicitly registers — it ships no
 * built-in fixtures. Per PROJECT_SPEC.md, response fixtures must be derived
 * from real ground-truth Tally responses rather than invented from
 * documentation, since invented ones would validate this server against the
 * same assumptions it was built on.
 *
 * Redacted real responses now live in `tests/fixtures/` and are what tests
 * should register here. See tests/tools/harness.ts for the usual wiring.
 *
 * Built on node:http rather than a framework — it is a test fixture, and the
 * project's dependency budget does not stretch to a web server for it.
 */

/** How a registered handler answers a request. */
export interface MockResponse {
  status?: number;
  /** Raw body, returned byte-for-byte. Allows deliberately malformed XML. */
  body: string;
  contentType?: string;
  /** Artificial delay in ms, for exercising timeout paths. */
  delayMs?: number;
}

/**
 * Decides whether a handler applies to an incoming request body.
 * Tally is a single-endpoint POST API, so routing is by payload content
 * (the request's TYPE/ID), not by URL path.
 */
export type MockMatcher = (requestBody: string) => boolean;

interface Registration {
  matcher: MockMatcher;
  response: MockResponse | ((requestBody: string) => MockResponse);
  label: string;
}

export interface RecordedRequest {
  body: string;
  headers: Record<string, string | string[] | undefined>;
  method: string;
}

export class MockTallyServer {
  #server: Server | null = null;
  #registrations: Registration[] = [];
  #requests: RecordedRequest[] = [];
  /** When set, the server refuses connections to simulate Tally being down. */
  #closed = false;

  /** Every request received, in order. Lets tests assert on what was sent. */
  get requests(): readonly RecordedRequest[] {
    return this.#requests;
  }

  /**
   * Register a response for requests matching `matcher`.
   * Later registrations take precedence, so a test can override a default.
   */
  on(
    label: string,
    matcher: MockMatcher,
    response: MockResponse | ((requestBody: string) => MockResponse)
  ): this {
    this.#registrations.unshift({ matcher, response, label });
    return this;
  }

  /** Convenience: match when the request body contains `needle`. */
  onBodyContaining(
    needle: string,
    response: MockResponse | ((requestBody: string) => MockResponse)
  ): this {
    return this.on(`contains:${needle}`, (body) => body.includes(needle), response);
  }

  /** Simulate Tally not running: the port stops accepting requests. */
  simulateDown(): void {
    this.#closed = true;
  }

  simulateUp(): void {
    this.#closed = false;
  }

  reset(): void {
    this.#registrations = [];
    this.#requests = [];
    this.#closed = false;
  }

  async start(port = 0): Promise<number> {
    if (this.#server) throw new Error('MockTallyServer is already started.');

    const server = createServer((req, res) => {
      void this.#handle(req, res);
    });
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    return (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);

    this.#requests.push({
      body,
      headers: req.headers,
      method: req.method ?? 'UNKNOWN',
    });

    if (this.#closed) {
      req.socket.destroy();
      return;
    }

    const registration = this.#registrations.find((entry) => entry.matcher(body));

    if (!registration) {
      // Surfacing this loudly beats a silent empty 200: an unmatched request
      // in a test almost always means the request builder changed shape.
      res.writeHead(501, { 'content-type': 'text/plain' });
      res.end(
        `MockTallyServer: no handler registered for this request.\n\n` +
          `Received body:\n${body.slice(0, 2000)}`
      );
      return;
    }

    const resolved =
      typeof registration.response === 'function'
        ? registration.response(body)
        : registration.response;

    if (resolved.delayMs && resolved.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, resolved.delayMs));
    }

    res.writeHead(resolved.status ?? 200, {
      'content-type': resolved.contentType ?? 'text/xml;charset=utf-8',
    });
    res.end(resolved.body);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Run standalone for manual poking: `npm run mock-tally`. */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const server = new MockTallyServer();
  const port = await server.start(9999);
  console.log(`Mock Tally listening on http://127.0.0.1:${String(port)}`);
  console.log('No fixtures are registered — see the note at the top of this file.');
}
