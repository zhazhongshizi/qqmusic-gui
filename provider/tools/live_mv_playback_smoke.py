"""Explicit anonymous QQ MV smoke; optional native check is always muted.

Example: python tools/live_mv_playback_smoke.py --song-id 001KxNK72u75Rw
Only public metadata is printed. Media URLs and authorization paths stay in memory.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

from qqmusic_provider.playback import PlaybackFailure, PlaybackService, QQMusicPlaybackSource
from qqmusic_provider.session import QQMusicSession


async def main(song_id: str, native_smoke: Path | None) -> int:
    session = QQMusicSession((Path(__file__).parent / "device-mv-smoke.json").resolve())
    try:
        await session.initialize()
        reply = await PlaybackService(QQMusicPlaybackSource(session)).execute(
            "playback.resolve", {"id": song_id, "preferredQuality": "auto"}
        )
        result = reply.result
        summary = {
            "status": "resolved", "quality": result["quality"],
            "host": urlsplit(str(result["url"])).hostname,
            "durationMs": result.get("durationMs"),
        }
        if native_smoke is not None:
            if result["quality"] != "qq-mv":
                print(json.dumps({"status": "not_mv"}))
                return 2
            process = subprocess.run(
                [str(native_smoke.resolve(strict=True)), "qq-mv-immediate", str(result["url"])],
                capture_output=True, text=True, timeout=35, check=False,
            )
            summary["nativeMutedCheck"] = process.returncode == 0
            if process.returncode != 0:
                print(json.dumps(summary))
                return 2
        print(json.dumps(summary))
        return 0
    except PlaybackFailure as error:
        print(json.dumps({"status": error.code, "retryable": error.retryable}))
        return 2
    except (OSError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"status": "native_check_failed", "errorType": type(error).__name__}))
        return 2
    finally:
        await session.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--song-id", required=True)
    parser.add_argument("--native-smoke", type=Path)
    args = parser.parse_args()
    raise SystemExit(asyncio.run(main(args.song_id, args.native_smoke)))
