"""Explicit manual smoke for QR creation; prints no image or credential material."""

from __future__ import annotations

import argparse
import asyncio
import base64
from pathlib import Path

from qqmusic_provider.auth import AuthService, QQMusicAuthSource


async def main(login_method: str) -> None:
    source = QQMusicAuthSource(device_path=(Path(__file__).parent / ".device.json").resolve())
    await source._session.initialize()
    service = AuthService(source)
    try:
        started = await service.execute("auth.qr.start", {"loginMethod": login_method})
        session_id = str(started["sessionId"])
        image_bytes = base64.b64decode(str(started["imageBase64"]), validate=True)
        await service.execute("auth.qr.cancel", {"sessionId": session_id})
        print(
            "live_auth_qr_smoke_ok "
            f"method={login_method} mime={started['mimeType']} image_bytes={len(image_bytes)} "
            "cancelled=true"
        )
    finally:
        await service.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--method", choices=("qq", "wx"), required=True)
    args = parser.parse_args()
    asyncio.run(main(args.method))
