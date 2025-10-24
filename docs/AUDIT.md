# ChromeOS Graylog Agent Audit

_Last updated: 2025-10-24_

## Scope
The audit reviewed the extension manifest, background service worker, and
supporting documentation to evaluate Chrome extension best practices, runtime
stability, and functional coverage. Findings are organized into strengths and
areas that require follow-up work.

## Highlights
- Runtime safeguards prevent overlapping harvest cycles and capture transient
  failures via diagnostics.
- Payload handling enforces strict size limits, truncates verbose logs, and
  prunes empty sections before dispatch.
- Managed and local configuration sources are merged cautiously with explicit
  validation of hosts, ports, and protocol selections.

## Best Practices Review
- **Manifest host scope is overly broad** – `host_permissions` currently allow
  HTTP(S) access to every domain. This violates least-privilege guidance and
  should be narrowed to the sanctioned Graylog domains surfaced by policy.
- **Storage quota pressure** – The retry queue retains up to ten payloads with a
  512 KiB ceiling each. In aggregate this can exceed Chrome's 5 MiB
  `chrome.storage.local` quota once JSON overhead is included, leading to silent
  persistence failures.
- **Diagnostics visibility** – Failures are logged locally but there is no
  surfaced tooling or documentation describing how administrators should collect
  or export these diagnostics during incidents.

## Stability Review
- Guard timers, offline detection, and exponential backoff prevent runaway
  harvesting and mitigate transient Graylog outages.
- API invocations are wrapped in `safeInvoke`, which emits diagnostics and
  returns defaults when enterprise APIs are unavailable.
- Retry alarms are rescheduled after every queue mutation to ensure delivery
  resumes once connectivity is restored.
- Remaining risk: quota-related write failures to `chrome.storage.local` will
  only emit a warning via `chrome.runtime.lastError` and do not currently trigger
  diagnostics or queue compaction.

## Functionality Review
- The agent collects enterprise device attributes, system diagnostics, and
  recent log events through `chrome.logPrivate`.
- Policy changes automatically invalidate the cached configuration, rebuild the
  harvest cadence, and flush the retry queue.
- Payloads missing actionable content are skipped rather than enqueueing empty
  deliveries.
- Missing feature: there is no administrative surface (options page, telemetry
  export) to review `graylogDiagnostics` or manually flush the retry queue.

## Recommended Actions
1. Restrict manifest host permissions to the approved Graylog domains and add
   automation to reconcile policy allow-lists with the manifest configuration.
2. Reduce retry queue pressure by lowering the maximum payload count or by
   estimating payload size prior to persistence and trimming when necessary.
3. Emit diagnostics when `chrome.storage.local.set` or `chrome.storage.local.get`
   fails due to quota or runtime errors so administrators can react.
4. Document and, if possible, implement an administrative workflow for exporting
   diagnostics and clearing the retry queue during incident response.
5. Build automated tests that exercise configuration merging, payload pruning,
   retry exhaustion, and offline handling to guard against regressions.
