#!/usr/bin/env python3
"""Upload a Crossfadio Personal DJ Context payload with a Bridge Token."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def main() -> int:
    parser = argparse.ArgumentParser(description="Upload Crossfadio Personal DJ Context JSON.")
    parser.add_argument("--file", required=True, help="Generated Personal DJ Context JSON file.")
    parser.add_argument(
        "--base-url",
        default=os.environ.get("CROSSFADIO_BASE_URL", "http://127.0.0.1:4318"),
        help="Crossfadio base URL. Defaults to CROSSFADIO_BASE_URL or local dev.",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("CROSSFADIO_PERSONAL_DJ_CONTEXT_TOKEN"),
        help="Bridge Token. Defaults to CROSSFADIO_PERSONAL_DJ_CONTEXT_TOKEN.",
    )
    parser.add_argument("--timeout", type=float, default=20.0, help="HTTP timeout seconds.")
    args = parser.parse_args()

    if not args.token:
        print("missing Bridge Token: set CROSSFADIO_PERSONAL_DJ_CONTEXT_TOKEN", file=sys.stderr)
        return 2

    payload = read_json(Path(args.file).expanduser())
    response = upload_payload(args.base_url, args.token, payload, args.timeout)

    source = payload.get("source") if isinstance(payload.get("source"), dict) else {}
    slice_refs = source.get("sliceRefs") if isinstance(source, dict) else []
    slice_count = len(slice_refs) if isinstance(slice_refs, list) else 0
    print(
        "uploaded Personal DJ Context: "
        f"contextId={response.get('contextId', 'unknown')} "
        f"uploadedAt={response.get('uploadedAt', 'unknown')} "
        f"retainedHistoryCount={response.get('retainedHistoryCount', 'unknown')} "
        f"sliceCount={slice_count}"
    )
    print("retention: latest upload stays current; older records expire after 24h")
    return 0


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"Expected JSON object in {path}")
    return data


def upload_payload(
    base_url: str,
    token: str,
    payload: dict[str, Any],
    timeout: float,
) -> dict[str, Any]:
    endpoint = base_url.rstrip("/") + "/api/personal-dj-context"
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response_body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        print(f"upload failed: status={exc.code} body={detail[:500]}", file=sys.stderr)
        return {}
    except urllib.error.URLError as exc:
        print(f"upload failed: {exc.reason}", file=sys.stderr)
        return {}

    parsed = json.loads(response_body)
    if not isinstance(parsed, dict) or not parsed.get("ok"):
        print(f"upload failed: unexpected response {response_body[:500]}", file=sys.stderr)
        return {}
    return parsed


if __name__ == "__main__":
    raise SystemExit(main())
