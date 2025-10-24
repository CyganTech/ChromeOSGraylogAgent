# ChromeOS Graylog Agent Architecture

## Overview
The ChromeOS Graylog Agent is a managed Chrome extension designed to collect
ChromeOS device telemetry and system logs in managed environments. The agent
aggregates diagnostics data and forwards it to a centralized Graylog cluster
for long-term retention and analysis.

## Components

### Extension Service Worker
- **File**: `extension/service_worker.js`
- **Responsibilities**:
  - Initialize alarms and storage defaults during installation/startup.
  - Merge managed (`chrome.storage.managed`) policy with local configuration
    and validate Graylog endpoints/allow-lists.
  - Retrieve device metadata using enterprise APIs and build the telemetry
    payload.
  - Enforce payload size limits, redact empty sections, and forward GELF
    payloads to Graylog.
  - Persist delivery retries with exponential backoff and emit diagnostics into
    `chrome.storage.local`.
  - Detect offline states, throttle concurrent harvests, and guard against
    long-running collection cycles.

### Options Page
- **Files**: `extension/options.html`, `extension/options.js`, `extension/options.css`
- **Responsibilities**:
  - Render a minimal administrative surface for exporting diagnostics and
    managing the retry queue.
  - Relay button actions to the service worker via `chrome.runtime.sendMessage`
    and surface success/failure feedback for the operator.
  - Respect the user's color scheme preference when styling the page.

### Manifest
- **File**: `extension/manifest.json`
- **Responsibilities**:
  - Declare the reduced permission set (`storage`, `alarms`, `system.*`,
    `logPrivate`, `enterprise.deviceAttributes`).
  - Scope `host_permissions` to HTTPS (and optional HTTP testing) endpoints so
    policy-driven allow-lists remain enforceable. Hosts that are not declared in
    the manifest are automatically ignored and produce diagnostics so
    administrators can reconcile mismatches.
  - Surface the background service worker entry point and register the options
    UI for administrators.

## Data Flow
1. The service worker merges managed policy with local defaults and validates
   the resulting Graylog endpoint plus allowed host list.
2. Using Chrome enterprise APIs, the extension collects device identifiers and
   diagnostics payloads.
3. Payloads are pruned, size-limited, and enqueued for delivery. Exponential
   backoff with jitter ensures retries do not overload Graylog and respects a
   retry limit of five attempts per payload.
4. Delivery outcomes and policy validation errors are persisted in
   `graylogDiagnostics` for administrator review. Diagnostics deduplicate
   consecutive identical events to reduce noise.

## Storage Model
- **Managed policy**: `chrome.storage.managed.graylogConfig` supplies the
  canonical endpoint definition and collection cadence controls.
- **Local storage**: `chrome.storage.local` holds the merged configuration,
  delivery retry queue (`graylogDeliveryQueue`), and diagnostic events
  (`graylogDiagnostics`). The queue is capped at six entries and aggressively
  trimmed to remain under a 4 MiB storage budget. Trimming events are surfaced
  through diagnostics to highlight quota pressure.

## Administrative Interface

Incident response tooling can communicate with the service worker using
`chrome.runtime.sendMessage`:

- `graylog:exportDiagnostics` – returns the merged set of persisted and
  transient diagnostics so on-call teams can export state for offline analysis.
- `graylog:clearRetryQueue` – purges the delivery queue, cancels any retry
  alarms, and records that the queue was cleared manually.
- `graylog:flushRetryQueue` – forces an immediate retry attempt and reports the
  remaining queue length.
- `graylog:clearDiagnostics` – wipes both persisted and in-memory diagnostics to
  start fresh after an incident.

## Security Considerations
- Leverage Chrome enterprise policies to restrict deployment to managed
  devices only.
- Transport logs using HTTPS by default; HTTP is only honored when policy
  explicitly enables testing mode.
- Enforce strict schema validation to avoid leaking unintended data, and trim
  oversized payloads before dispatching.
- Provide clear retention and redaction controls to satisfy compliance needs.
- Restrict host permissions in the manifest to only the sanctioned Graylog
  domains.

### Packaging Utility
- **File**: `tools/package_extension.py`
- **Responsibilities**:
  - Copy the `extension/` directory, rewrite the manifest with the provided
    `host_permissions`, and optionally override the version string.
  - Support dry-run previews so operators can confirm derived metadata before
    generating an archive.
  - Produce deterministic zip archives suitable for Chromebook sideloading or
    Admin console upload.

## Open Questions / Next Steps
- Evaluate authenticated delivery (mTLS, OAuth, or signed payloads) for Graylog
  inputs.
- Add automated tests around configuration merging, queue rollover, and payload
  truncation logic.
