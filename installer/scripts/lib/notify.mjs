import { execFileSync, spawn } from 'node:child_process';

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
  const script = toastScript(title, message);

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

/**
 * The same notification, raised WITHOUT blocking the caller.
 *
 * `toast` above is synchronous and waits up to twenty seconds for PowerShell.
 * That is fine in the exporter, which is a short-lived script that has finished
 * its work. It is not fine in the MCP server: that process must stay responsive,
 * and a twenty-second stall in its event loop would freeze every answer Claude
 * is waiting on.
 *
 * So this spawns and walks away — detached and unref'd, stdio discarded, so the
 * child cannot hold the server open or write a byte anywhere near stdout, which
 * is the protocol channel.
 *
 * @param {string} title
 * @param {string} message
 */
export function toastDetached(title, message) {
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', toastScript(title, message)],
      { stdio: 'ignore', detached: true, windowsHide: true }
    );
    child.unref();
    // A spawn that fails asynchronously would otherwise reach the process as an
    // unhandled error event and take the server down with it.
    child.on('error', () => {});
  } catch {
    // Same as above: a notification is never worth failing over.
  }
}

/** The PowerShell that raises one toast. One definition, two ways of running it. */
function toastScript(title, message) {
  return [
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
}

/** Single-quote for PowerShell, where the escape for a quote is doubling it. */
export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
