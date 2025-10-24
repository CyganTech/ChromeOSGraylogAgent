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

### Manifest
- **File**: `extension/manifest.json`
- **Responsibilities**:
  - Declare the reduced permission set (`storage`, `alarms`, `system.*`,
    `logPrivate`, `enterprise.deviceAttributes`).
  - Scope `host_permissions` to HTTPS (and optional HTTP testing) endpoints so
    policy-driven allow-lists remain enforceable.

## Data Flow
1. The service worker merges managed policy with local defaults and validates
   the resulting Graylog endpoint plus allowed host list.
2. Using Chrome enterprise APIs, the extension collects device identifiers and
   diagnostics payloads.
3. Payloads are pruned, size-limited, and enqueued for delivery. Exponential
   backoff with jitter ensures retries do not overload Graylog.
4. Delivery outcomes and policy validation errors are persisted in
   `graylogDiagnostics` for administrator review.

## Security Considerations
- Leverage Chrome enterprise policies to restrict deployment to managed
  devices only.
- Transport logs using HTTPS by default; HTTP is only honored when policy
  explicitly enables testing mode.
- Enforce strict schema validation to avoid leaking unintended data, and trim
  oversized payloads before dispatching.
- Provide clear retention and redaction controls to satisfy compliance needs.

## Next Steps
- Implement log collectors leveraging `chrome.logPrivate` and
  `chrome.diagnostics`.  
- Add Graylog GELF payload builder with compression support.  
- Integrate with enterprise policy storage for centrally managed settings.  
- Develop integration tests and deployment documentation.
