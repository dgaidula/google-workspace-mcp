# google-workspace-mcp

> A minimal MCP stdio server that exposes the Google Workspace write operations
> that [gog](https://gogcli.sh)'s own MCP server intentionally omits.

Zero npm dependencies. One file. Raw JSON-RPC 2.0 over stdio.

---

## The problem

Most Google Workspace MCP solutions fail at the edges of real agentic workflows in one of two ways:

**Too chatty.** Managed connectors like Composio route every API call through their servers. For bulk operations — triaging 140+ job descriptions across Drive folders, updating a tracker spreadsheet, filing applications — that's hundreds of round-trips through a third-party service. The latency is real, the privacy surface is real, and the API call overhead is real.

**Read-only.** gog's own `gog mcp` server is deliberately lean: eight typed, allowlisted read tools. That's a sound design decision for an MCP surface that handles untrusted callers. But it means the write operations that matter for automation — moving files between folders, creating calendar events with Meet links, sending invite notifications — exist only in the CLI.

The gap: gog has a 700-command CLI surface covering every Google Workspace API, already authenticated via your local keychain, already tested. Its MCP server exposes eight of those commands. Everything else is reachable by shelling out to the CLI.

## The architecture

```
Claude Desktop / Claude Code
        │  JSON-RPC 2.0 over stdio
        ▼
  google-workspace-mcp (this repo)
        │  async spawn — args array, no shell
        ▼
  /opt/homebrew/bin/gog
        │  OAuth via macOS Keychain
        ▼
  Google APIs
```

Each MCP tool maps to a single `gog` CLI call. Args are passed as an array to `spawn` — no string interpolation, no shell, no injection surface. Auth is inherited from gog's existing keychain setup; no new OAuth client, no new GCP project, no new credentials to manage.

Subprocess calls are **asynchronous** (`child_process.spawn` wrapped in a Promise), not `spawnSync`. A blocking call would freeze the stdio event loop for the entire duration of a `gog` request — multi-second on large Drive/Docs/Gmail operations — so the server couldn't read new requests or write responses, and MCP clients would hit timeouts. With async spawn the reader keeps draining and concurrent `tools/call`s run in parallel; each response carries its JSON-RPC `id`, so out-of-order completion is fine.

The server itself is raw JSON-RPC 2.0 over stdio, per the MCP spec. No SDK, no npm packages. Node's built-in `child_process`, `fs`, `os`, and `path` modules are the only dependencies.

## Tools

| Tool | gog command | Purpose |
|---|---|---|
| `drive_mv` | `gog drive move` | Move a file to a different folder |
| `drive_trash` | `gog drive delete --force` | Move a file to trash (recoverable) |
| `drive_rename` | `gog drive rename` | Rename a file/folder, preserving its ID |
| `drive_permissions` | `gog drive permissions` | List who has access to a file and at what role |
| `drive_list` | `gog drive ls` | List a folder with stable cursor pagination |
| `drive_read` | `gog docs get` | Read a Google Doc's text content |
| `drive_write` | `gog docs write` | Write/append to a Google Doc (Markdown, typography) |
| `drive_file_read` | `gog drive download` | Download and return any raw Drive file's text |
| `drive_file_update` | `gog drive upload --replace` | Overwrite a raw Drive file in place |
| `drive_file_create` | `gog drive upload` | Create a new raw file in a folder (no Doc conversion) |
| `calendar_update` | `gog calendar update` | Update an event: add Meet link, add attendees, send notifications |
| `calendar_create` | `gog calendar create` | Create an event with optional Meet link and invites |
| `gmail_send` | `gog gmail send` | Send mail, behind a two-step confirmation gate |

### Why these tools

**Drive triage.** `drive_mv` is the core operation in any Drive-based triage workflow — without it, an agent can find and read files but can't act on them. `drive_trash` is its cleanup complement, `drive_rename` adjusts names without breaking the file ID, `drive_permissions` surfaces sharing visibility that gog's MCP doesn't expose, and `drive_list` gives stable cursor-based pagination for walking a folder (no duplicates, clean page tokens — more reliable than search for triage).

### A known gap: no native "recent files"

gog's `drive ls` doesn't expose an `orderBy`/sort flag, so there's no clean equivalent to "list my most recently modified files across Drive" — the kind of query the Google Drive connector's `list_recent_files` answers natively via the API's `orderBy=modifiedTime desc` parameter. A workaround exists (pull a larger page with `--all --max 100` and sort the JSON client-side) but it's a real compromise: more data pulled than needed, and sorting logic that belongs in the API now lives in application code. For a CLI built around automation, this is a surprising omission. If you need this, the built-in Google Drive connector remains the better tool for that specific query — see "What this bridge doesn't replace" below.

**Google Docs.** `drive_read` returns a Doc's plain text; `drive_write` writes or appends content with optional Markdown conversion and typography. Content goes over stdin, so large documents and special characters are safe.

**Raw Drive files.** `drive_file_read`, `drive_file_update`, and `drive_file_create` handle non-Doc files (`.md`, `.txt`, etc.). Because `gog`'s download/upload work on files on disk, these three bridge through a temp file. `drive_file_update` overwrites in place — preserving the file ID, permissions, and shared links — and `drive_file_create` keeps raw files raw rather than converting them to Google Docs.

**Calendar.** `calendar_update` is the tool that actually replaced Composio for this project. The workflow was: existing event, add a Meet link, add an attendee, send the invite — all in one prompt. gog's `calendar update` supports `--with-meet`, `--add-attendee`, and `--send-updates` in a single call. `calendar_create` rounds out the surface for new events with the same capabilities.

### Safety gates

`gmail_send` is gated behind an explicit two-step confirmation flow. The first call always returns a preflight preview — to, subject, body, threading context — without sending. Only a second call with `confirmed: true` actually sends. This prevents accidental sends from a single model decision and makes the intent visible to the user before anything leaves the outbox. If you want to disable email sending entirely, remove `gmail_send` from the tool registry.

Drive permanent delete (`gog drive delete --permanent`) is omitted for the same reason — `drive_trash` is recoverable from Drive's trash; permanent deletion is not.

### What this bridge doesn't replace

Keep your platform's native Google Drive connector (or equivalent) connected alongside this bridge. Two things it does natively that this bridge deliberately doesn't replicate:

- **Recent files, sorted by modification time.** See the gap noted above — gog's CLI has no `orderBy` flag for this.
- **Permission editing.** This bridge exposes `drive_permissions` for *reading* sharing state, but changing access (adding/removing collaborators, transferring ownership) is a higher-stakes action better left to a dedicated, well-tested connector rather than a thin CLI shim.

Running both side by side costs nothing — they don't conflict, and the model picks whichever tool fits the task.

## Prerequisites

- [gog](https://gogcli.sh) installed via Homebrew: `brew install openclaw/tap/gogcli`
- gog authenticated: `gog login` (or `gog auth add`)
- Node.js (managed via `n` or any version manager)

## Platform support

This is a **desktop-only** tool. It runs as a local stdio MCP server — spawning the `gog` binary as a subprocess and reading/writing temp files on disk — so it only works in Claude Desktop and Claude Code, both of which support local MCP servers. Per Anthropic's own documentation, [desktop extensions and local MCP servers are not available in Claude's web or mobile clients](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors), since there's no local process to spawn.

If you need Drive/Calendar/Gmail actions from mobile, you have two options: hold write operations until you're back at a desktop session, or wire up a remote MCP connector (e.g., Composio) for the specific mobile use case — remote connectors run in the cloud rather than spawning a local process, so they work everywhere. Reads via your platform's built-in Google Drive connector, and Calendar/Meet via Composio, are unaffected by this limitation since those are remote connectors, not local servers.

**The pattern used in this repo's own setup:** built-in Google Drive connector for reads and new-file creation on mobile (it already supports `create_file` + `copy_file`, enough to cover the old root-then-copy pattern), Composio for Calendar/Meet on any platform, and moves/renames/deletes on existing Drive files held until the next desktop session. This avoids adding a remote Drive connector at all — Composio's Drive tools route through a generic search-then-execute pattern (schema lookup, then execute), which adds per-call overhead even for a single mobile action, not just at bulk volume. If your mobile Drive-write needs are frequent enough to justify that overhead, wiring up Composio for Drive is a reasonable call — it just wasn't the right tradeoff here.

Verify your setup before wiring up the MCP client:

```bash
gog --account you@example.com auth doctor --check
gog --account you@example.com drive ls --max 5
```

## Installation

```bash
git clone https://github.com/yourusername/google-workspace-mcp.git
cd google-workspace-mcp
chmod +x index.js
```

Update the two constants at the top of `index.js`:

```js
const GOG     = '/opt/homebrew/bin/gog';   // confirm with: which gog
const ACCOUNT = 'you@example.com';          // your gog-authenticated account
```

## Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gog": {
      "command": "/opt/homebrew/bin/gog",
      "args": [
        "--account", "you@example.com",
        "mcp",
        "--allow-write",
        "--allow-tool", "all"
      ]
    },
    "google-workspace-mcp": {
      "command": "/path/to/google-workspace-mcp/index.js"
    }
  }
}
```

### Claude Code

Add to `~/.claude.json` under `mcpServers`:

```json
"gog": {
  "type": "stdio",
  "command": "/opt/homebrew/bin/gog",
  "args": [
    "--account", "you@example.com",
    "mcp",
    "--allow-write",
    "--allow-tool", "all"
  ]
},
"google-workspace-mcp": {
  "type": "stdio",
  "command": "/path/to/google-workspace-mcp/index.js"
}
```

Both configs run gog's own MCP server alongside this bridge. gog handles reads (Drive search, Docs, Sheets, Gmail, Calendar events). This bridge handles writes.

## A note on editing this file

The shim requires the execute bit (`chmod +x index.js`). Most editors (BBEdit, VS Code, vim) preserve it on save since they write in-place. Tools that replace the file entirely — including some deployment scripts and AI coding assistants — will reset permissions to `644` and the server will fail with `Permission denied`. If the shim stops working after an edit, `chmod +x index.js` is always the first thing to check.

## Smoke test

From a terminal, test the MCP handshake directly:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \
  | ./index.js
```

Expected output:
```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"google-workspace-mcp","version":"1.0.0"}}}
```

## A note on the design

gog's decision to keep its MCP surface read-only is correct. A generic "run any gog command" MCP tool would expose the full 700-command CLI surface to every model call — that's not a permission surface, it's a permission void.

This bridge takes the opposite approach: explicit tool definitions, fixed schemas, args-array subprocess calls, no shell passthrough. The MCP surface is exactly as wide as the tools described above and nothing more. When gog ships Drive write tools in a future release, this bridge shrinks or disappears.

## License

MIT
