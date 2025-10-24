# Chromebook Deployment Guide

This guide describes how to package the ChromeOS Graylog Agent extension and
load it onto a Chromebook for pre-production testing. It focuses on the
sideloading workflow that administrators typically use before rolling the
extension out via the Google Admin console.

## Prerequisites

- Python 3.8 or later available on your workstation.
- Access to the Graylog endpoint(s) that will receive logs for testing.
- A Chromebook in Developer Mode **or** an Admin console OU where testing is
  permitted.

## 1. Package the extension

Use the packaging utility to create a zip archive with the correct
`host_permissions` for your Graylog instance. The script writes the archive to
`dist/chromeos-graylog-agent.zip` by default:

```bash
python tools/package_extension.py \
  --host logs.example.com \
  --output dist/graylog-agent-test.zip
```

The `--host` flag can be repeated for multiple destinations. If you need to
allow HTTP for an isolated lab environment, append `--allow-http` (be sure to
remove this for production builds). The script rewrites `manifest.json` inside
the archive so the sideloaded extension precisely matches the allow-listed
hosts that policy will enforce.

Use `--dry-run` to preview the manifest changes without creating an archive:

```bash
python tools/package_extension.py --host logs.example.com --dry-run
```

Dry-run mode prints the derived version and `host_permissions` so you can
confirm the manifest matches your expectations before generating a package.

## 2. Load the package on a Chromebook

1. Copy the generated `.zip` file to the Chromebook.
2. Navigate to `chrome://extensions`, enable **Developer mode**, and choose
   **Load unpacked**.
3. Extract the archive into a temporary directory and select the extracted
   folder when prompted. Chrome will register the extension and surface the
   options page.
4. Open the extension details page and click **Extension options** to access the
   administrative controls. Use **Export Diagnostics** to verify connectivity
   and policy evaluation results.

> **Tip:** During testing you can also keep the folder on removable storage to
> avoid leaving artifacts on the device. Remove the directory after testing to
> clean up.

## 3. Configure the Graylog policy payload

For managed testing, push a temporary policy via the Admin console or
`chrome.enterprise.platformKeys` tooling. A minimal payload looks like:

```json
{
  "graylogConfig": {
    "host": "logs.example.com",
    "port": 443,
    "protocol": "https",
    "allowedHosts": ["logs.example.com"],
    "pollIntervalMinutes": 5
  }
}
```

When sideloading without policy support, open the extension options page and
use the administrative actions to verify diagnostics while the default
configuration forwards data to the host embedded in the manifest.

## 4. Verify diagnostics

- Use the **Export Diagnostics** action on the options page to view policy
  validation results, retry queue status, and any delivery errors.
- Confirm that the Graylog instance receives GELF payloads at the expected
  cadence. The diagnostics log records each successful delivery.
- Consider using a dedicated Graylog stream or dashboard to isolate test
  payloads before production rollout.

After testing is complete, remove the unpacked folder and disable Developer
Mode to return the device to its managed state.
