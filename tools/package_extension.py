#!/usr/bin/env python3
"""Package the ChromeOS Graylog Agent extension for deployment.

This utility copies the contents of the `extension/` directory, optionally
rewrites the manifest's host permissions and version, and generates a zip
archive that can be sideloaded on a Chromebook.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import sys
import tempfile
import zipfile

REPO_ROOT = Path(__file__).resolve().parents[1]
EXTENSION_DIR = REPO_ROOT / "extension"
DEFAULT_OUTPUT = REPO_ROOT / "dist" / "chromeos-graylog-agent.zip"

HOST_PATTERN_TEMPLATE = "{scheme}://{host}/*"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Package the ChromeOS Graylog Agent extension")
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="Path to the generated zip archive (default: %(default)s)",
    )
    parser.add_argument(
        "--host",
        "--allowed-host",
        dest="hosts",
        action="append",
        default=[],
        help=(
            "Host or URL pattern that should be written to host_permissions. "
            "Repeat for multiple hosts. Plain host names automatically expand to "
            "https://HOST/* and http://HOST/* when --allow-http is supplied."
        ),
    )
    parser.add_argument(
        "--allow-http",
        action="store_true",
        help="Include http:// host permissions for each provided host (useful for testing only)",
    )
    parser.add_argument(
        "--version",
        help="Override the manifest version string",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show the derived manifest metadata without writing files",
    )
    return parser.parse_args()


def validate_environment() -> None:
    if not EXTENSION_DIR.exists():
        raise SystemExit(f"Extension directory not found: {EXTENSION_DIR}")


def normalize_host_patterns(hosts: list[str], allow_http: bool) -> list[str]:
    patterns: set[str] = set()

    for raw in hosts:
        if not raw:
            continue

        candidate = raw.strip()
        if not candidate:
            continue

        lower = candidate.lower()
        if lower.startswith("http://") or lower.startswith("https://"):
            pattern = ensure_trailing_wildcard(candidate)
            patterns.add(pattern)
            continue

        patterns.add(HOST_PATTERN_TEMPLATE.format(scheme="https", host=candidate))
        if allow_http:
            patterns.add(HOST_PATTERN_TEMPLATE.format(scheme="http", host=candidate))

    return sorted(patterns)


def ensure_trailing_wildcard(pattern: str) -> str:
    if pattern.endswith("/*"):
        return pattern
    if pattern.endswith("/"):
        return f"{pattern}*"
    return f"{pattern}/*"


def load_manifest(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_manifest(path: Path, manifest: dict) -> None:
    with path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")


def create_archive(source_dir: Path, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file_path in sorted(source_dir.rglob("*")):
            if file_path.is_dir():
                continue
            arcname = file_path.relative_to(source_dir)
            archive.write(file_path, arcname.as_posix())


def main() -> int:
    args = parse_args()
    validate_environment()

    if args.dry_run:
        print("Running in dry-run mode; no files will be written.")

    host_patterns = normalize_host_patterns(args.hosts, args.allow_http)

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_dir_path = Path(tmpdir)
        working_dir = tmp_dir_path / "extension"
        shutil.copytree(EXTENSION_DIR, working_dir)

        manifest_path = working_dir / "manifest.json"
        manifest = load_manifest(manifest_path)

        if args.version:
            manifest["version"] = args.version

        if host_patterns:
            manifest["host_permissions"] = host_patterns

        if args.dry_run:
            print("Manifest preview:")
            print(json.dumps({
                "version": manifest.get("version"),
                "host_permissions": manifest.get("host_permissions", []),
            }, indent=2))
            return 0

        write_manifest(manifest_path, manifest)
        create_archive(working_dir, args.output)
        print(f"Created package: {args.output}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
