Run `pnpm benchmark` from the repository root. The offline Full Alpha fixture
reports six successful HTTP MCP calls under `mcp.presentation`: project.inspect,
project.resume, file.search, github.wait, run.inspect, and run.compare.

Each row reports UTF-8 structured JSON bytes, unescaped text bytes, serialized
client-visible CallToolResult presentation bytes, and presentation bytes / 4
as a token proxy (not exact tokens). Presentation includes JSON escaping and
content block overhead but excludes JSON-RPC IDs/envelopes and transport framing.
`duplicatedJsonPresentationBytes` reconstructs the old full-JSON text copy using
the same result, providing a paired comparison without depending on fixture IDs
or timestamps. This is not a remeasurement of the historical main baseline.

The adapter records the same measurements as metadata on `mcp.presented`
events, correlated by run/trace/span. The event names the proxy
`presentationByteQuarterProxy` to preserve the default redaction of token-named
fields; `proxyMethod` documents its meaning. These describe prepared output, not delivery
confirmation. No payload is recorded and provider rawOutputBytes and
returnedOutputBytes retain their original meanings. SDK validation/protocol
errors generated before the operation callback are outside this event scope.
