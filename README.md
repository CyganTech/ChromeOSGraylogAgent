# ChromeOS Graylog Agent

The ChromeOS Graylog Agent is a managed Chrome extension that forwards
ChromeOS device logs to a centralized Graylog deployment. This repository
contains the extension source, documentation, and deployment tooling.

## Repository Structure

```
├── docs/                  # Architecture details and deployment runbooks
├── extension/             # Chrome extension source code
│   ├── assets/            # Extension icons and static assets
│   ├── manifest.json      # Extension manifest (permissions, host policy)
│   └── service_worker.js  # Background service worker and log pipeline
├── tools/                 # Packaging utilities
└── README.md
```

## Key Features

- **Policy-aware log forwarding** – The background service worker merges
  `chrome.storage.managed` policy with local defaults, enforces host
  allow-lists, trims oversized payloads, and batches delivery retries with
  exponential backoff.
- **Administrative diagnostics** – The options page exposes one-click controls
  to export diagnostics, flush or clear the retry queue, and reset stored
  events for incident response.
- **Manifest-aware packaging** – `tools/package_extension.py` rewrites
  `host_permissions`, optionally bumps the version, and produces a signed zip
  suitable for sideloading or upload to the Admin console.
- **Operational safeguards** – Storage quotas, payload sizes, and retry counts
  are capped to avoid exceeding Chrome extension limits while retaining rich
  observability signals.

## Quick Start

1. Review `extension/manifest.json` and update publisher metadata if required.
   The default `https://*.example.com/*` host permission is a placeholder that
   is replaced during packaging.
2. Inspect `extension/service_worker.js` to understand the default policy
   fallbacks (poll cadence, guard window, and HTTP testing flag). Managed
   deployments should push a `graylogConfig` payload via
   `chrome.storage.managed`.
3. Build a test package with the packaging utility:

   ```bash
   python tools/package_extension.py \
     --host logs.example.com \
     --output dist/graylog-agent-test.zip
   ```

   Use `--host` multiple times for additional destinations. Append
   `--allow-http` only for controlled lab testing; HTTPS remains the default.
4. Run `python tools/package_extension.py --dry-run --host logs.example.com` to
   verify the manifest changes before producing an archive. Dry-run mode prints
   the derived version and `host_permissions`.
5. Configure a Graylog HTTP(S) GELF input to receive device log payloads.
6. Deploy the extension to managed ChromeOS devices via your enterprise
   management console or sideload it on a test Chromebook (see
   [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).

## Operational Considerations

- The background alarm introduces a concurrency guard to prevent overlapping
  collection cycles if a previous run is still in flight. Policy can adjust the
  poll cadence and guard duration per OU.
- Harvested payloads are compacted and size-limited before transmission so
  empty or null sections are dropped and oversized log blobs are truncated
  safely.
- Delivery attempts use exponential backoff with jitter and a persisted retry
  queue to avoid losing telemetry during transient outages. The queue is capped
  at six payloads and aggressively trimmed to stay within a 4 MiB storage
  budget. Diagnostics are emitted whenever entries are pruned for quota or
  length reasons.
- Structured diagnostics are captured in `chrome.storage.local` under
  `graylogDiagnostics` so administrators can inspect configuration or delivery
  failures. Diagnostics include policy validation failures, retry exhaustion,
  and API invocation errors.

## Administrative Workflow

The extension exposes administrative controls through the bundled options page
(`chrome://extensions` → ChromeOS Graylog Agent → **Details** → **Extension
options**) and the background messaging interface. Both surfaces can be used for
incident response tooling or manual inspection.

Available actions include:

- `type: "graylog:exportDiagnostics"` – returns a merged snapshot of persisted
  and in-memory diagnostics.
- `type: "graylog:clearRetryQueue"` – empties the retry queue, clears pending
  alarms, and records a diagnostic noting the manual intervention.
- `type: "graylog:flushRetryQueue"` – forces an immediate delivery attempt and
  responds with the number of entries remaining.
- `type: "graylog:clearDiagnostics"` – wipes persisted diagnostics and the
  in-memory buffer, providing a clean slate for subsequent incidents.

All responses include a `success` boolean so tooling can surface failures.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for step-by-step packaging and
Chromebook sideloading instructions tailored for test deployments.

## Additional Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) – Component breakdown and
  telemetry flow across the service worker, manifest, and administrative
  surface.
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) – Packaging workflow and Chromebook
  sideloading checklist.
- [TASKS.md](TASKS.md) – Open items captured during the latest audit.

## Configuration and Policy

Managed deployments should provide a `graylogConfig` policy payload similar to
the following:

```json
{
  "graylogConfig": {
    "host": "logs.example.com",
    "port": 443,
    "protocol": "https",
    "allowedHosts": ["logs.example.com"],
    "pollIntervalMinutes": 5,
    "guardThresholdMinutes": 10,
    "allowHttpForTesting": false
  }
}
```

If no managed policy exists, the service worker falls back to locally stored
settings. HTTP is only honored when a policy explicitly enables
`allowHttpForTesting`.

## Diagnostics Review

Administrators can inspect the `graylogDiagnostics` collection via the options
page, the `chrome://extensions` debugging tools, or by wiring a configuration
surface that reads from `chrome.storage.local`. Each entry contains a `code`,
structured `details`, and an ISO timestamp so on-call responders can correlate
failures to Graylog availability or policy rollouts. Diagnostics older than 30
days are pruned automatically to honor retention expectations while retaining at
most 100 recent entries.

## Roadmap

- [ ] Add automated tests and CI workflows.
- [ ] Integrate authenticated delivery (mTLS or OAuth) for Graylog inputs.

## Governance and Compliance

- Document data retention expectations for the collected payloads and review
  them against regional privacy requirements (e.g., GDPR, SOC 2, FERPA).
- Consider masking or excluding sensitive identifiers within
  `logPrivate.getSystemLogs` before the payload is forwarded.
- Maintain an approval process for host allow-lists to ensure only sanctioned
  Graylog clusters receive device telemetry.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file
for details.
