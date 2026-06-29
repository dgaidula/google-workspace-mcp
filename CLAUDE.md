# gog-mcp-bridge

A single-file MCP stdio server (`index.js`, zero npm dependencies) that exposes
the Google Workspace **write** operations that `gog`'s own `gog mcp` server
intentionally omits. See `README.md` for user-facing setup and config snippets;
this file is the working-context guide for editing the code.

## Architecture

```
Claude Desktop / Claude Code
        │  JSON-RPC 2.0 over stdio (newline-delimited)
        ▼
  index.js  (this bridge)
        │  async spawn — args array, no shell
        ▼
  /opt/homebrew/bin/gog
        │  OAuth via macOS Keychain
        ▼
  Google APIs
```

- **Raw JSON-RPC 2.0 over stdio.** No MCP SDK. `process.stdin` accumulates into
  `buf`; the data handler splits on `\n`, `JSON.parse`s each line, and dispatches
  via `handle()`. Responses are written with `send()` as one JSON object + `\n`.
  **This stdio framing is intentionally untouched by the async refactor** — only
  the subprocess execution underneath changed.
- **`handle()` is the MCP dispatcher.** It answers `initialize`, `tools/list`
  (returns the `TOOLS` registry), and `tools/call` (runs `runTool`, wraps the
  `{ ok, stdout, stderr }` result into MCP `content`). Notifications (no `id`)
  are acknowledged silently.
- **`TOOLS`** is the static tool registry (name, description, JSON `inputSchema`).
  **`runTool(name, args)`** is the big `switch` mapping each tool to one `gog`
  call. Each tool maps to a single CLI invocation — no chaining, no shell.

## Async, not spawnSync — the reason this code exists in its current form

The bridge originally called `spawnSync`. That **blocks the Node event loop** for
the entire duration of the `gog` subprocess. During a long Drive/Docs/Gmail API
call (multi-second), the process could not read new stdin or write responses, so
MCP clients hit request timeouts.

The fix: **`spawnGog()` wraps `child_process.spawn` in a Promise.** It streams
`stdout`/`stderr` chunks, resolves `{ stdout, stderr, ok }` on `close`, and
rejects only on spawn failure (e.g. `ENOENT`). Because the call is non-blocking,
the stdio reader keeps draining and concurrent `tools/call`s are dispatched in
parallel — responses carry their `id`, so out-of-order completion is fine.

Consequences that must be preserved when editing:

- `gog()` (adds `--json`) and `gogPlain()` (raw output, used by `drive_read`)
  both return **Promises** — always `await` them.
- `runTool` is `async`; `handle` is `async` and `await`s `runTool`.
- The stdin data handler wraps the dispatch in
  `Promise.resolve(handle(msg)).catch(() => {})` so a rejected call can't crash
  the process. Per-request errors are already converted to JSON-RPC error
  results inside `handle`.
- There is **no `maxBuffer`** with `spawn` (unlike `spawnSync`); output is
  accumulated by the chunk handlers, so large Drive responses are fine.
- A 60s `timeout` + `SIGKILL` kills a hung child rather than hanging forever.
- `child.stdin.on('error', () => {})` swallows EPIPE if the child exits before we
  finish writing stdin input.

## Temp-file pattern (`drive_file_read`, `drive_file_update`, `drive_file_create`)

`gog`'s `drive download` / `drive upload` operate on **files on disk**, not
stdin/stdout, so these three tools bridge through a temp file via
`makeTempFile(ext)` (a unique path in `os.tmpdir()`):

- **`drive_file_read`** — `gog drive download <id> --out <tmp> --overwrite`, then
  `readFileSync(tmp)` and return the text. The temp file is `unlinkSync`'d in
  both the success and error paths.
- **`drive_file_update`** — `writeFileSync(tmp, content)`, then
  `gog drive upload <tmp> --replace <file_id>`, then unlink. Updates in place,
  preserving the Drive file ID, permissions, and shared links.
- **`drive_file_create`** — `writeFileSync(tmp, content)` with the temp file
  given the **same extension as `title`** (so `gog` infers the MIME type
  correctly), then `gog drive upload <tmp> --name <title> --parent <parent_id>`,
  then unlink. No `--convert`: raw `.md`/`.txt` stay raw, not Google Docs.

The `fs` calls are intentionally **synchronous** — they touch only the fast local
temp file. The blocking concern was always the `gog`/network subprocess, which is
now async; keeping the local fs ops sync keeps the cleanup logic simple. All
unlinks are wrapped in `try/catch` so cleanup failures never mask the result.

## `gmail_send` confirmed gate

`gmail_send` is gated behind a two-step confirmation so a single model decision
can never send mail by accident:

- The schema marks `confirmed` **required**, and the handler checks
  `confirmed !== true`. If it isn't explicitly `true`, the tool returns a
  **preflight preview** (to/cc/bcc/subject/threading + body) and sends nothing.
- Only a second call with `confirmed: true` runs `gog gmail send` (body piped via
  stdin with `--body-file -`).

The tool description instructs callers to show the preview to the user and get
confirmation before setting `confirmed: true`. If you ever want to disable email
sending entirely, remove `gmail_send` from `TOOLS`.

## Per-user constants (top of `index.js`)

Two constants must be set for each user/machine:

```js
const GOG     = '/opt/homebrew/bin/gog';   // path to gog — confirm with: which gog
const ACCOUNT = 'dan@gaidula.com';          // the gog-authenticated account
```

`GOG` is the Homebrew path — **`/opt/homebrew/bin` on Apple Silicon,
`/usr/local/bin` on Intel Macs**. `ACCOUNT` is passed as `--account <ACCOUNT>` on
every `gog` call. Note the `drive_mv` tool description also hard-codes
career-ops folder IDs that are specific to this user's Drive.

## chmod +x requirement

The MCP client launches `index.js` directly (the config `command` is the file
path), so it **must keep its execute bit** and the `#!/usr/bin/env node`
shebang. Editors that save in place (vim, VS Code, BBEdit) preserve the bit, but
**any tool that replaces the file wholesale — including AI coding assistants and
the Write tool — recreates it with default `644` permissions, dropping `+x`.**
The server then fails to launch with `Permission denied`.

After any edit that rewrites the file, run:

```bash
chmod +x index.js
```

If the bridge stops working after an edit, this is the first thing to check.

## Smoke test

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node index.js
```

Expect a single JSON-RPC response listing all tools (`drive_mv`, `drive_trash`,
`calendar_update`, `calendar_create`, `drive_rename`, `drive_read`,
`drive_write`, `drive_file_read`, `drive_file_update`, `drive_file_create`,
`drive_list`, `gmail_send`). The process exits when stdin closes.

To exercise the async `tools/call` path without touching the network, hit the
`gmail_send` preflight gate (returns a preview, sends nothing):

```bash
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"gmail_send","arguments":{"to":"x@y.com","subject":"Hi","body":"Test"}}}' | node index.js
```
