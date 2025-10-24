# ChromeOS Graylog Agent

The ChromeOS Graylog Agent is a managed Chrome extension that forwards
ChromeOS device logs to a centralized Graylog deployment. This repository
contains the extension source, documentation, and deployment tooling.

## Repository Structure

```
├── docs/                  # Architecture, audit notes, and design references
├── extension/             # Chrome extension source code
│   ├── assets/            # Extension icons and static assets
│   ├── manifest.json      # Extension manifest (permissions, host policy)
│   └── service_worker.js  # Background service worker and log pipeline
└── README.md
```

## Getting Started

1. Update `extension/manifest.json` with your organization's publisher
   information and tailor the declared `host_permissions` wildcard to match the
   approved Graylog endpoints surfaced by policy. The service worker will ignore
   hosts that are missing from the manifest and record diagnostics when a
   mismatch is detected. The repository ships with a permissive
   `https://*.example.com/*` placeholder so multiple sanctioned hosts can be
   configured via policy without manifest drift.
2. Review `extension/service_worker.js` and update the default policy fallbacks
   (e.g., allow-listed hosts) to align with your environment. Policies pushed
   via `chrome.storage.managed` should provide `graylogConfig` with `host`,
   `port`, optional `allowedHosts`, and cadence overrides.
3. Build and package the extension using `chrome://extensions` in Developer
   Mode or via the Chrome Web Store publishing workflow.
4. Configure a Graylog HTTP(S) GELF input to receive device log payloads.
5. Deploy the extension to managed ChromeOS devices using your enterprise
   management console and enforce the necessary policies.

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
