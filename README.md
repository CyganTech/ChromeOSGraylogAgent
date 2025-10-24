# ChromeOS Graylog Agent

The ChromeOS Graylog Agent is a managed Chrome extension that forwards
ChromeOS device logs to a centralized Graylog deployment. This repository
contains the extension source, documentation, and deployment tooling.

## Repository Structure

```
├── docs/                  # Architecture and design documentation
├── extension/             # Chrome extension source code
│   ├── assets/            # Extension icons and static assets
│   ├── logging/           # Log ingestion helpers (planned)
│   ├── utils/             # Shared utility modules (planned)
│   └── service_worker.js  # Background service worker
└── README.md
```

## Getting Started

1. Update `extension/manifest.json` with your organization's extension details
   and Graylog permissions requirements.
2. Implement log collectors under `extension/logging/` to gather the desired
   ChromeOS diagnostics using `chrome.logPrivate` and related APIs.
3. Build and package the extension using `chrome://extensions` in Developer
   Mode or via the Chrome Web Store publishing workflow.
4. Configure a Graylog input (HTTP GELF recommended) to receive device log
   payloads.
5. Deploy the extension to managed ChromeOS devices using your enterprise
   management console and enforce the necessary policies.

## Roadmap

- [ ] Implement log collection adapters for key ChromeOS subsystems.
- [ ] Support configurable batching and retry logic for log delivery.
- [ ] Integrate with Chrome enterprise policies for dynamic configuration.
- [ ] Add automated tests and CI workflows.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file
for details.
