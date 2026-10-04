# Provider v1 fixtures

- `valid-requests.ndjson`: complete offline handshake/ping/search input.
- `out-of-order-responses.ndjson`: two valid terminal responses in reverse request order.
- `duplicate-response.ndjson`: the same request ID receives two terminal responses; the host must
  reject the second.
- `unknown-response.ndjson`: a terminal response has no pending request; the host must reject it.
- `timeout.json`: host fake-clock recipe; no response is emitted before the deadline.
- `invalid-utf8.hex`: invalid input bytes represented as hexadecimal text.
- `oversized-line.json`: recipe for a payload one byte over the protocol limit.
- `version-mismatch.ndjson`: unsupported top-level protocol version.
- `index.json`: machine-readable catalogue used by contract tests; `schema` describes whether
  each NDJSON frame must pass or fail protocol-v1 Schema validation.

All music metadata is synthetic/offline and contains no credentials or playback URLs.
