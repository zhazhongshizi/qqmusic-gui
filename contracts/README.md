# Provider protocol v1

The Rust host owns and supervises one private provider child process. The transport is the
child's stdin/stdout; it does not expose a TCP or HTTP listener.

## Framing

- UTF-8 NDJSON, exactly one JSON object per line.
- The byte limit is `1,048,576` bytes after removing LF and an optional preceding CR.
- JSON container nesting, including the root object, is limited to `128` levels.
- A BOM, blank line, invalid UTF-8, duplicate JSON key, non-finite number, malformed JSON,
  excessive nesting, unexpected top-level field, or oversized line is fatal to the provider
  instance.
- Protocol stdout contains frames only. Redacted structured diagnostics go to stderr.

The wire profile requires protocol versions to use a JSON integer token such as `1`, never
`1.0` or `1e0`. JSON Schema treats mathematically integral JSON numbers as integers and cannot
express this lexical distinction, so each decoder additionally enforces native integer-token
parsing. `protocol-v1.constants.json` records this rule as `versionEncoding`.

`protocol-v1.schema.json` describes individual frames. The following stateful rules cannot be
expressed by JSON Schema and are mandatory:

1. The first request is `system.handshake` with `{"protocolVersion":1}`.
2. Every request ID is 1–128 ASCII characters matching `[A-Za-z0-9][A-Za-z0-9._:-]*` and is
   unique for the process lifetime.
3. The host has at most one terminal response for each request. Duplicate or unknown response
   IDs and a protocol-version mismatch are fatal to that provider instance.
4. Responses may arrive out of request order. The host correlates them by ID.
5. Events do not have an ID. A terminal response always has an ID.
6. A successful response always includes `warnings`, even when it is empty.

## Implemented provider methods

| Method | Params | Purpose |
| --- | --- | --- |
| `system.handshake` | `protocolVersion: 1` | Negotiate v1 and return versions/capabilities |
| `system.ping` | empty object | Liveness check |
| `auth.qr.start` | `loginMethod: qq \| wx` | Create one in-memory, expiring QR session |
| `auth.qr.poll` | opaque `sessionId` | Poll scan/confirmation/terminal state; credential is Rust-only |
| `auth.qr.cancel` | opaque `sessionId` | Cancel and erase the active QR session |
| `auth.credential.restore` | exact credential object from Rust secret storage | Restore provider login state after restart |
| `auth.credential.check` | empty object | Check restored credential validity |
| `auth.credential.refresh` | empty object | Refresh and atomically replace credential in Rust |
| `auth.logout` | empty object | Revoke upstream session where possible and sign out locally |
| `playback.resolve` | song MID and `auto \| flac \| 320k \| 128k` | Resolve GetVkey with ordered quality fallback; URL is Rust-only |
| `search.hotkeys`, `search.complete` | empty / `keyword` | Hot words and completion |
| `search.songs`, `search.artists`, `search.albums`, `search.playlists` | `keyword`, optional `page`, `pageSize` | Typed search |
| `recommend.guess`, `recommend.radar`, `recommend.playlists`, `recommend.newSongs` | bounded paging/filter params | Read-only recommendations |
| `charts.list`, `charts.detail` | empty / chart id and paging | Ranking catalogue |
| `song.detail`, `playlist.detail`, `album.detail`, `album.songs` | stable id and optional paging | Track, playlist and album reads |
| `artist.detail`, `artist.songs`, `artist.albums` | stable artist MID and optional paging | Artist reads |
| `lyrics.get` | stable song ID/MID | Requested track ID plus original, translation and romanization LRC; raw upstream numeric song IDs are not returned |

`method_not_found` and `invalid_params` are normal non-retryable responses. Framing/state faults
terminate the process with exit code 2. Normal automation injects a fake `CatalogSource`; it never
contacts QQ. The production provider uses the pinned `qqmusic-api-python` adapter and returns only
normalized DTOs.

Only one QR session may exist at a time. Its upstream identifier never crosses the provider
boundary; the renderer receives an opaque local session ID and a short-lived image. The provider
may return a credential only to the Rust host. Rust removes it before producing the public Tauri
DTO and stores it as one versioned secret blob; the credential is never part of a renderer frame,
SQLite row, ordinary log, diagnostic bundle, or screenshot.

`playback.resolve` uses only the standard unencrypted `music.vkey.GetVkey / UrlGetVkey` request.
The provider requests `flac → 320k → 128k` for auto/FLAC preference and never upgrades a lower
preference. Stable failures distinguish authentication, entitlement, device limit, unavailable
media, network, and schema drift. The result URL crosses only the private provider pipe into Rust;
Rust validates it and removes it before returning the public player snapshot to the renderer.

## Fixture catalogue

`tests/fixtures/provider-v1/index.json` catalogues valid requests and host-side response scenarios
for out-of-order, duplicate, unknown, timeout, malformed encoding, oversized lines, and version
mismatch. Recipes are used where committing a 1 MiB file or invalid UTF-8 directly would be
unfriendly to Git and editors. Python contract tests validate every indexed NDJSON frame; the
Rust supervisor consumes the host scenarios in its stage-1 integration suite.
