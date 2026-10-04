from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]


def test_module_entrypoint_uses_utf8_stdout_on_windows() -> None:
    payload = (
        b'{"v":1,"id":"hello-1","method":"system.handshake","params":{"protocolVersion":1}}\n'
        b'{"v":1,"id":"ping-1","method":"system.ping","params":{}}\n'
    )

    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "qqmusic_provider",
            "--device-path",
            str(Path(tempfile.gettempdir()) / "qqmusic-provider-entrypoint-device.json"),
        ],
        cwd=_ROOT,
        input=payload,
        capture_output=True,
        check=False,
    )

    stdout = completed.stdout.decode("utf-8", errors="strict")
    stderr = completed.stderr.decode("utf-8", errors="strict")
    frames = [json.loads(line) for line in stdout.splitlines()]
    assert completed.returncode == 0
    assert frames[0]["result"]["provider"]["mode"] == "live"
    assert frames[1]["result"] == {"pong": True}
    assert "provider_started" not in stdout
    assert "provider_started" in stderr


def test_module_entrypoint_reserves_wire_stdout_from_dependency_prints() -> None:
    payload = (
        b'{"v":1,"id":"hello-1","method":"system.handshake","params":{"protocolVersion":1}}\n'
        b'{"v":1,"id":"ping-1","method":"system.ping","params":{}}\n'
    )
    probe = """
import builtins
from qqmusic_provider import __main__ as entrypoint

original_import = builtins.__import__

def noisy_import(name, globals=None, locals=None, fromlist=(), level=0):
    module = original_import(name, globals, locals, fromlist, level)
    if name == "runtime" and level == 1:
        print("DEPENDENCY_STDOUT_SENTINEL")
    return module

builtins.__import__ = noisy_import
entrypoint.main()
"""

    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            probe,
            "--device-path",
            str(Path(tempfile.gettempdir()) / "qqmusic-provider-noisy-device.json"),
        ],
        cwd=_ROOT,
        input=payload,
        capture_output=True,
        check=False,
    )

    stdout = completed.stdout.decode("utf-8", errors="strict")
    stderr = completed.stderr.decode("utf-8", errors="strict")
    frames = [json.loads(line) for line in stdout.splitlines()]
    assert completed.returncode == 0
    assert len(frames) == 2
    assert "DEPENDENCY_STDOUT_SENTINEL" not in stdout
    assert "DEPENDENCY_STDOUT_SENTINEL" in stderr
    assert "redirected_stdout" in stderr


def test_module_entrypoint_requires_an_absolute_device_path() -> None:
    for arguments in ([], ["--device-path", "relative-device.json"]):
        completed = subprocess.run(
            [sys.executable, "-m", "qqmusic_provider", *arguments],
            cwd=_ROOT,
            input=b"",
            capture_output=True,
            check=False,
        )

        assert completed.returncode == 2
        assert completed.stdout == b""
        assert b"--device-path" in completed.stderr
