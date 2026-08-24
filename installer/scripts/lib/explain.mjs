/**
 * Turning a probe result into something an accountant can act on.
 *
 * The rule here, from docs/next-steps.md: no error codes, no jargon, and every
 * problem paired with the fix. "ECONNREFUSED" tells the user nothing;
 * "TallyPrime is not running — open it, then run this again" tells them
 * everything. The keystrokes for Tally's port setting are spelled out because
 * most accountants have never opened that screen, and it is expected to be the
 * single largest source of support questions.
 */

export const TALLY_PORT_INSTRUCTIONS = [
  'How to switch on TallyPrime\'s connection setting (a one-time step):',
  '',
  '   1. Open TallyPrime.',
  '   2. From the Gateway of Tally, press  F1  and choose  Settings.',
  '   3. Choose  Connectivity.',
  '   4. Choose  Client/Server configuration.',
  '   5. Set  TallyPrime acts as  to  Both  (or  Server ).',
  '   6. Check that  Port  is  9000.',
  '   7. Press  Ctrl+A  to save.',
  '',
  '   You only ever have to do this once on this computer.',
];

/**
 * Say, for a loopback name, that BOTH kinds of local address were tried.
 *
 * Worth the words: "nothing answered at localhost:9000" invites the reply "but
 * Tally is right there on 9000", and this closes that off — if both families
 * were refused, the port genuinely has nothing on it. It is also the sentence
 * that would have saved a day on 2026-08-24, when only one family was tried and
 * the message blamed the user's settings.
 */
function loopbackNote(host) {
  return String(host ?? '').trim().toLowerCase() === 'localhost'
    ? '  (this computer, tried both kinds of local address)'
    : '';
}

/**
 * @param {import('./probe.mjs').ProbeResult} probe
 * @param {{host: string, port: number}} endpoint
 * @returns {{ ok: boolean, headline: string, lines: string[] }}
 */
export function explainProbe(probe, endpoint) {
  switch (probe.status) {
    case 'ok':
      return {
        ok: true,
        headline: 'TallyPrime is connected and ready.',
        lines: [
          probe.companies.length === 1
            ? `Company open in Tally:  ${probe.companies[0]}`
            : `Companies open in Tally:  ${probe.companies.join(', ')}`,
          '',
          'Tally answers questions about whichever company is open. If you want a',
          'different company, open it in TallyPrime first.',
        ],
      };

    case 'no-company':
      return {
        ok: false,
        headline: 'TallyPrime is running, but no company is open.',
        lines: [
          'Claude can reach Tally, but Tally has no books loaded, so there is',
          'nothing to read yet.',
          '',
          'What to do:  in TallyPrime, open the company you want to ask about',
          '(Gateway of Tally, then  Open Company ). Then run this check again.',
        ],
      };

    /*
     * WHY THIS SAYS WHAT WAS TRIED, AND WHY IT NO LONGER SAYS "ALMOST ALWAYS".
     *
     * This message used to open by naming two causes and calling the second —
     * Tally's connection setting being off — "the most common cause". On
     * 2026-08-24 it said exactly that to somebody whose TallyPrime was open,
     * configured correctly, and answering perfectly: it was listening on IPv6
     * and we were dialling the IPv4 literal. The message sent them to a
     * settings screen that was already right, and there was no way to tell from
     * it that the fault was ours.
     *
     * So it now states the address it tried, and offers the causes without
     * ranking one as near-certain. A confident wrong diagnosis costs more than
     * an honest list: it sends somebody to change a setting that was correct,
     * and if they "fix" it they have broken a working install.
     */
    case 'no-listener':
      return {
        ok: false,
        headline: 'Cannot reach TallyPrime.',
        lines: [
          `Nothing answered at  ${endpoint.host}:${endpoint.port}${loopbackNote(endpoint.host)}`,
          '',
          'Any of these would explain it:',
          '',
          '   A. TallyPrime is not open. Start it, then run this check again.',
          '',
          '   B. TallyPrime is open, but its connection setting is switched off.',
          '      It is off by default, so on a new machine this is worth checking',
          '      first.',
          '',
          '   C. Tally is set to a different port than the one above, or this',
          '      software has been pointed at the wrong address. If TallyPrime',
          '      itself looks correctly set up, suspect this one — and send',
          '      whoever set this up the address line above, which says exactly',
          '      what was asked.',
          '',
          ...TALLY_PORT_INSTRUCTIONS,
        ],
      };

    case 'timeout':
      return {
        ok: false,
        headline: 'TallyPrime is not answering.',
        lines: [
          'Something is listening, but it did not reply in time.',
          '',
          'What to do:  check whether TallyPrime is showing a dialog box or is busy',
          'with another task — it can only answer one request at a time. Close any',
          'open dialog in Tally, then run this check again.',
        ],
      };

    case 'incomplete-install':
      return {
        ok: false,
        headline: 'This copy is missing some of its program files.',
        lines: [
          'The part that talks to Tally could not be loaded, so there is nothing',
          'to test yet.',
          '',
          'What to do:  delete this folder, download the zip again, and this time',
          'right-click the zip and choose  Extract All  before opening anything',
          'inside it. Opening the zip and dragging one file out is the usual cause.',
        ],
      };

    default:
      return {
        ok: false,
        headline: 'Could not check TallyPrime.',
        lines: [
          'Something unexpected got in the way.',
          '',
          'What to do:  make sure TallyPrime is open with your company loaded, then',
          'run this check again. If it keeps failing, send the technical detail',
          'below to whoever set this up for you.',
          '',
          `Technical detail:  ${probe.detail ?? 'none'}`,
        ],
      };
  }
}
