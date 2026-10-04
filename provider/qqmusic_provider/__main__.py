"""Module entry point for ``python -m qqmusic_provider``."""

from __future__ import annotations

import io
import sys
from argparse import ArgumentParser
from pathlib import Path


def main() -> None:
    """Run the provider until stdin closes or a fatal protocol fault occurs."""

    parser = ArgumentParser(prog="qqmusic-provider")
    parser.add_argument("--device-path", required=True, type=Path)
    args = parser.parse_args()
    if not args.device_path.is_absolute():
        parser.error("--device-path must be absolute")

    wire_stdout = sys.stdout
    # Windows' redirected console streams may inherit a legacy code page. The wire
    # contract is UTF-8 regardless of the user's locale.
    if isinstance(wire_stdout, io.TextIOWrapper):
        wire_stdout.reconfigure(
            encoding="utf-8", errors="strict", newline="\n", write_through=True
        )
    if isinstance(sys.stderr, io.TextIOWrapper):
        sys.stderr.reconfigure(
            encoding="utf-8", errors="replace", newline="\n", write_through=True
        )

    # Reserve the captured handle for NDJSON before importing the runtime or any
    # upstream adapter. Ordinary print() output is converted to redacted stderr.
    sys.stdout = sys.stderr
    from .logging import RedactingStdout

    sys.stdout = RedactingStdout(sys.stderr)
    from .runtime import run

    raise SystemExit(
        run(sys.stdin.buffer, wire_stdout, sys.stderr, device_path=args.device_path.resolve())
    )


if __name__ == "__main__":
    main()
