"""Pinned Niquests compatibility for the SDK's response-cookie snapshots."""

from __future__ import annotations

from collections.abc import Sequence
from typing import cast

from niquests.cookies import RequestsCookieJar
from niquests.models import Response
from qqmusic_api.core.transport import BatchOutcome, NiquestsTransport, PreparedRequest


class _SdkResponseCookies(RequestsCookieJar):
    def __getitem__(self, name: str) -> str:
        try:
            return cast("str", super().__getitem__(name))  # type: ignore[no-untyped-call]
        except KeyError:
            # Niquests treats a present cookie with an empty value as missing.
            # QQ's check_sig response includes such cookies, and the SDK indexes
            # every cookie while making its raw-response snapshot. Preserve the
            # empty value without hiding missing or ambiguous cookie names.
            matches = [cookie for cookie in self if cookie.name == name]
            if len(matches) == 1 and matches[0].value == "":
                return ""
            raise


class QQMusicTransport(NiquestsTransport):
    async def request_many(
        self, requests: Sequence[PreparedRequest], *, return_exceptions: bool = True,
    ) -> list[BatchOutcome]:
        outcomes = await super().request_many(requests, return_exceptions=return_exceptions)
        for outcome in outcomes:
            if isinstance(outcome, Response) and any(
                cookie.value == "" for cookie in outcome.cookies
            ):
                cookies = _SdkResponseCookies()
                cookies.update(outcome.cookies)  # type: ignore[no-untyped-call]
                outcome.cookies = cookies
        return outcomes
