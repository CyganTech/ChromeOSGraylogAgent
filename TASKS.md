# Outstanding Tasks

These action items stem from the October 2025 audit and reflect the remaining
work needed before production rollout.

## High Priority
- [ ] Restrict `extension/manifest.json` host permissions to the specific
      Graylog domains approved by policy, or build tooling that rewrites the
      manifest during packaging to honor allow-lists.
- [ ] Introduce safeguards in `extension/service_worker.js` to keep the retry
      queue below the Chrome `chrome.storage.local` quota (e.g., lower the queue
      length, trim payloads pre-persistence, or detect and drop entries when a
      `QUOTA_BYTES` error surfaces).

## Medium Priority
- [ ] Emit explicit diagnostics when storage operations fail so administrators
      can see quota or runtime errors in `graylogDiagnostics`.
- [ ] Provide an administrator-facing surface (options page or CLI tooling) to
      review diagnostics and manually flush the retry queue during incidents.
- [ ] Add automated tests that cover configuration merging, payload pruning,
      retry exhaustion, and offline handling.

## Nice to Have
- [ ] Explore authenticated delivery to Graylog inputs (mTLS, OAuth, or signed
      payloads).
- [ ] Evaluate compression of GELF payloads once the receiving endpoint supports
      it to reduce bandwidth usage.
