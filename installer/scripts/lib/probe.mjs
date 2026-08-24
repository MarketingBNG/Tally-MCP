import http from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageRootFor } from './paths.mjs';

/**
 * Standalone reachability probe for TallyPrime, used by setup and by the
 * doctor window.
 *
 * SAFETY, and why this imports rather than reimplements: the request is taken
 * from the built server's own buildConnectionProbeRequest() — the read-only
 * `List of Companies` export already verified against a live install. An earlier
 * version of this file hand-copied that XML and got it wrong twice (a
 * charset=utf-16 header, which Tally rejects outright as "Unknown Request", and
 * a missing STATICVARIABLES block, which made Tally answer with an unrelated
 * CMPINFO payload). Both produced a confident, wrong "no company is open".
 *
 * Hand-copying Tally request XML is not worth the risk: this script runs on
 * machines with real books open, and a malformed request is the one thing that
 * can take TallyPrime down with someone's unsaved work in it. Import the proven
 * builder; never inline a new request here.
 */

const PACKAGE_ROOT = packageRootFor(import.meta.url);

/** Loads the server's own request builder. Null when this copy is incomplete. */
async function loadProbeRequest() {
  try {
    const modulePath = join(PACKAGE_ROOT, 'dist', 'tally', 'requests.js');
    const module = await import(pathToFileURL(modulePath).href);
    return module.buildConnectionProbeRequest();
  } catch {
    return null;
  }
}

/**
 * @typedef {object} ProbeResult
 * @property {'ok'|'no-listener'|'no-company'|'timeout'|'error'|'incomplete-install'} status
 * @property {string[]} companies Company names found, when any.
 * @property {string} [detail] Raw diagnostic detail, for the log line only.
 */

/**
 * @param {{host: string, port: number, timeoutMs?: number}} options
 * @returns {Promise<ProbeResult>}
 */
/**
 * Ways of writing "this machine" that pin one IP family. See loopbackSafeHost.
 */
const LOOPBACK_LITERALS = new Set(['127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * Turn a loopback literal into `localhost`.
 *
 * MEASURED, 2026-08-24, with TallyPrime running and a company loaded: its HTTP
 * server was listening on `::` -- every IPv6 address and no IPv4 one. So
 * `127.0.0.1:9000` was REFUSED while `[::1]:9000` and `localhost:9000` both
 * answered HTTP 200. Dialling the IPv4 literal made a perfectly healthy Tally
 * report as "not open", which is the worst kind of wrong answer: confident, and
 * contradicted by what the user can see on their own screen.
 *
 * `localhost` resolves to both families and Node tries them in turn, so it
 * reaches Tally whichever way it chose to listen. Kept in step with
 * LOOPBACK_LITERALS in src/config/config.ts, which does the same for the server.
 */
export function loopbackSafeHost(host) {
  return LOOPBACK_LITERALS.has(String(host ?? '').trim().toLowerCase()) ? 'localhost' : host;
}

export async function probeTally({ host, port, timeoutMs = 15_000 }) {
  const body = await loadProbeRequest();
  if (body === null) {
    return {
      status: 'incomplete-install',
      companies: [],
      detail: 'dist/tally/requests.js could not be loaded',
    };
  }

  return new Promise((resolvePromise) => {
    const request = http.request(
      {
        // Never the raw literal: a loopback IPv4 address is refused outright by
        // a Tally listening only on IPv6. See loopbackSafeHost.
        host: loopbackSafeHost(host),
        port,
        method: 'POST',
        path: '/',
        headers: {
          // Must match TallyClient. A charset=utf-16 declaration here makes
          // Tally reject the request as "Unknown Request, cannot be processed".
          'Content-Type': 'text/xml;charset=utf-8',
          'Content-Length': Buffer.byteLength(body, 'utf8'),
        },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = decode(Buffer.concat(chunks));
          const companies = extractCompanies(text);
          resolvePromise({
            status: companies.length > 0 ? 'ok' : 'no-company',
            companies,
            detail: `HTTP ${response.statusCode}, ${text.length} chars`,
          });
        });
      }
    );

    request.on('timeout', () => {
      request.destroy();
      resolvePromise({ status: 'timeout', companies: [] });
    });

    request.on('error', (error) => {
      // ECONNREFUSED is the ordinary "Tally is closed, or its port is off"
      // case, not something to show a user a stack trace for.
      const refused = error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH';
      resolvePromise({
        status: refused ? 'no-listener' : 'error',
        companies: [],
        detail: `${error.code ?? 'ERR'}: ${error.message}`,
      });
    });

    request.end(body);
  });
}

/**
 * Tally replies in UTF-8 on some builds and UTF-16LE on others, and its declared
 * charset is often wrong — so sniff the bytes, the same conclusion TallyClient
 * reached independently.
 */
function decode(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le', 2);
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.toString('utf8', 3);
  }
  // Interleaved NULs are the signature of UTF-16LE without a BOM.
  if (buffer.length >= 2 && buffer[1] === 0x00) {
    return buffer.toString('utf16le');
  }
  return buffer.toString('utf8');
}

/**
 * Pull company names out without an XML parser — no dependencies are available
 * here, and the only question is "did Tally name at least one company?".
 *
 * The response shape this has to survive, from a live TallyPrime:
 *
 *   <BODY>
 *     <DESC><CMPINFO><COMPANY>0</COMPANY>...</CMPINFO></DESC>   <-- counts, not data
 *     <DATA><COLLECTION>
 *       <COMPANY NAME="ACME LTD" RESERVEDNAME="">
 *         <NAME TYPE="String">ACME LTD</NAME>
 *       </COMPANY>
 *     </COLLECTION></DATA>
 *   </BODY>
 *
 * Two traps in there, both of which produced a confident "no company is open"
 * against a Tally that had one open:
 *
 *   - `<CMPINFO>` contains a `<COMPANY>0</COMPANY>` element that is a COUNT.
 *     Reading the whole body would find it and conclude nothing is loaded, so
 *     only the <DATA> section is searched.
 *   - Real tags carry attributes — `<NAME TYPE="String">`, not `<NAME>` — so a
 *     regex anchored on the bare tag never matches anything.
 */
export function extractCompanies(text) {
  // Only <DATA> holds records; <DESC>/<CMPINFO> holds counts that look like them.
  const data = /<DATA\b[^>]*>([\s\S]*)<\/DATA>/i.exec(text)?.[1] ?? '';
  if (data === '') return [];

  const names = [];
  const add = (value) => {
    const name = decodeEntities(value).trim();
    if (name.length > 0 && !names.includes(name)) names.push(name);
  };

  // The NAME attribute on the COMPANY element is the most reliable source.
  for (const match of data.matchAll(/<COMPANY\b[^>]*\bNAME="([^"]*)"/gi)) {
    add(match[1]);
  }

  // Fall back to the child element, which carries a TYPE attribute.
  if (names.length === 0) {
    for (const match of data.matchAll(/<NAME\b[^>]*>([\s\S]*?)<\/NAME>/gi)) {
      add(match[1]);
    }
  }

  return names;
}

function decodeEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Ampersand last, so &amp;lt; does not become a tag.
    .replace(/&amp;/g, '&');
}
