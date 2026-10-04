"""Safe compatibility probe for pinned and candidate qqmusic-api releases.

The default offline mode validates the experiment/result contract without importing
qqmusic_api or touching the network. Live mode performs anonymous read-only probes and
prints only bounded, non-sensitive categories.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from contextlib import suppress
from importlib import metadata
from pathlib import Path
from typing import Any

SUPPORTED_VERSIONS = ("0.6.9", "0.7.1")
RESULT_FORMAT_VERSION = 1
_VERSION = re.compile(r"^\d+\.\d+\.\d+$")


def _check(name: str, status: str, detail: str) -> dict[str, str]:
    if status not in {"passed", "failed", "blocked", "not-run"}:
        raise ValueError("invalid_status")
    return {"name": name, "status": status, "detail": detail}


def offline_result(target_version: str) -> dict[str, object]:
    return {
        "formatVersion": RESULT_FORMAT_VERSION,
        "mode": "offline",
        "targetVersion": target_version,
        "overall": "not-run",
        "checks": [
            _check("version-allowlist", "passed", "target version is allowlisted"),
            _check("isolated-environment", "passed", "live runner requires a temporary venv"),
            _check("account-safety", "passed", "live probe contains read-only anonymous calls"),
            _check("transport-compatibility", "not-run", "requires explicit live mode"),
            _check("anonymous-catalog", "not-run", "requires explicit live mode"),
            _check("anonymous-playback", "not-run", "requires explicit live mode"),
        ],
    }


def _stable_error(error: BaseException) -> str:
    name = type(error).__name__.casefold()
    text = str(error).casefold()
    if "timeout" in name or "timeout" in text:
        return "timeout"
    if any(marker in text for marker in ("network", "connect", "dns", "proxy")):
        return "network-unavailable"
    if any(marker in text for marker in ("credential", "login", "auth")):
        return "authentication-required"
    if "multiplexed" in text:
        return "transport-incompatible"
    return "compatibility-error"


async def live_result(target_version: str, device_path: Path) -> dict[str, object]:
    checks: list[dict[str, str]] = []
    installed = metadata.version("qqmusic-api-python")
    checks.append(
        _check(
            "installed-version",
            "passed" if installed == target_version else "failed",
            (
                "installed version matches target"
                if installed == target_version
                else "version mismatch"
            ),
        )
    )
    if installed != target_version:
        return _result(target_version, "failed", checks)

    try:
        from qqmusic_api import Client  # type: ignore[import-untyped]

        client: Any = Client(device_path=str(device_path), connect_retries=2)
    except Exception as error:
        checks.append(_check("client-construction", "blocked", _stable_error(error)))
        return _result(target_version, "blocked", checks)

    try:
        transport = getattr(client, "_session", None)
        if transport is None or not hasattr(transport, "multiplexed"):
            checks.append(
                _check("transport-compatibility", "failed", "multiplexed control missing")
            )
            return _result(target_version, "failed", checks)
        transport.multiplexed = False
        if transport.multiplexed is not False:
            checks.append(_check("transport-compatibility", "failed", "multiplexed disable failed"))
            return _result(target_version, "failed", checks)
        checks.append(_check("transport-compatibility", "passed", "multiplexing disabled"))

        device_store = getattr(client, "_device_store", None)
        get_device = getattr(device_store, "get_device", None)
        if not callable(get_device):
            checks.append(_check("device-store", "failed", "device store API missing"))
            return _result(target_version, "failed", checks)
        await get_device()
        checks.append(_check("device-store", "passed", "anonymous device initialized"))

        try:
            from qqmusic_api.modules.search import SearchType  # type: ignore[import-untyped]

            raw = await client.search.search("晴天", SearchType.SONG, num=1, page=1)
            payload = raw.model_dump() if hasattr(raw, "model_dump") else raw
            has_shape = isinstance(payload, dict)
            checks.append(
                _check(
                    "anonymous-catalog",
                    "passed" if has_shape else "failed",
                    (
                        "bounded search returned a mapping"
                        if has_shape
                        else "search shape incompatible"
                    ),
                )
            )
        except Exception as error:
            category = _stable_error(error)
            status = "blocked" if category in {"timeout", "network-unavailable"} else "failed"
            checks.append(_check("anonymous-catalog", status, category))

        # Playback resolution requires a song identifier. This probe deliberately does not
        # print or persist one; catalog adapter integration is evaluated by the application
        # soak test after a compatible catalog result is confirmed.
        checks.append(
            _check(
                "anonymous-playback",
                "not-run",
                "requires an in-memory normalized catalog item; no identifier is recorded",
            )
        )
    finally:
        with suppress(Exception):
            await client.close()

    overall = "failed" if any(item["status"] == "failed" for item in checks) else "passed"
    if overall == "passed" and any(item["status"] == "blocked" for item in checks):
        overall = "blocked"
    return _result(target_version, overall, checks)


def _result(target_version: str, overall: str, checks: list[dict[str, str]]) -> dict[str, object]:
    return {
        "formatVersion": RESULT_FORMAT_VERSION,
        "mode": "live",
        "targetVersion": target_version,
        "overall": overall,
        "checks": checks,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("offline", "live"), default="offline")
    parser.add_argument("--target-version", choices=SUPPORTED_VERSIONS, required=True)
    parser.add_argument("--device-path", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not _VERSION.fullmatch(args.target_version):
        raise SystemExit("invalid target version")
    if args.mode == "offline":
        result = offline_result(args.target_version)
    else:
        if args.device_path is None or not args.device_path.is_absolute():
            raise SystemExit("live mode requires an absolute --device-path")
        result = asyncio.run(live_result(args.target_version, args.device_path))
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
    return 1 if result["overall"] == "failed" else 0


if __name__ == "__main__":
    sys.exit(main())
