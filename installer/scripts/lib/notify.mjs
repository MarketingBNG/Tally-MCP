import { execFileSync } from 'node:child_process';

/**
 * The Windows notification the scheduled export raises when something changes.
 *
 * ## Why this is its own module now
 *
 * It used to be a private function inside export.mjs. Once the task started
 * running HIDDEN — no console, nothing on screen — this notification became the
 * only thing that surfaces a failure while somebody is at the machine. A signal
 * that important has to be testable, and a private function is not.
 *
 * It is also the exact mistake lib/probe.mjs warns about, one layer up: testing
 * a hand-copied approximation of the real command proves nothing about the real
 * command. So the real one lives here and the test calls it.
 *
 * ## Best effort, always
 *
 * A machine with PowerShell locked down, or notifications disabled by policy,
 * must still export correctly. Every failure here is swallowed and reported as
 * `false` — the caller carries on. The `LAST RUN FAILED - ...` filename and
 * run-log.txt do not depend on anything being installed, and remain the durable
 * record.
 */

/**
 * Raise a toast. Returns true only if PowerShell reported success.
 *
 * @param {string} title
 * @param {string} message
 * @param {{timeoutMs?: number}} [options]
 * @returns {boolean}
 */
export function toast(title, message, options = {}) {
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    '$nodes = $template.GetElementsByTagName(\'text\')',
    `$nodes.Item(0).AppendChild($template.CreateTextNode(${psQuote(title)})) | Out-Null`,
    `$nodes.Item(1).AppendChild($template.CreateTextNode(${psQuote(message)})) | Out-Null`,
    // The AppUserModelID has to be one Windows recognises or the toast is
    // silently dropped. PowerShell's own is always present, which is why it is
    // used rather than a name of our own that nothing has registered.
    "$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe')",
    '$notifier.Show([Windows.UI.Notifications.ToastNotification]::new($template))',
  ].join('; ');

  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { stdio: 'pipe', timeout: options.timeoutMs ?? 20_000 }
    );
    return true;
  } catch {
    // No PowerShell, no notification service, or a policy in the way. The
    // status file and the log carry the same news and do not depend on it.
    return false;
  }
}

/** Single-quote for PowerShell, where the escape for a quote is doubling it. */
export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
