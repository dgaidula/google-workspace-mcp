#!/usr/bin/env node
// gog-mcp-bridge — MCP stdio server exposing gog write tools
//
// gog's own MCP server (gog mcp) exposes eight read-only tools.
// The write operations that matter for agentic workflows live in the CLI
// but are intentionally omitted from the MCP surface. This bridge shims
// the specific ones we need: Drive moves, Drive trash, and Calendar
// create/update with Meet and attendee notification.
//
// Architecture: raw JSON-RPC 2.0 over stdio. Zero npm dependencies.
// Each tool maps to a single gog CLI call via async spawn with an args
// array (no shell, no injection surface). Calls are non-blocking so a
// long Drive API request never stalls the MCP event loop.
//
// Usage: make executable (chmod +x index.js), then reference this file
// as the MCP server command in claude_desktop_config.json or .claude.json.
//
// See README.md for full setup and config snippets.

'use strict';

const { spawn }                            = require('child_process');
const { writeFileSync, readFileSync, unlinkSync } = require('fs');
const { tmpdir }                            = require('os');
const { join, extname }                     = require('path');

const GOG     = '/opt/homebrew/bin/gog';
const ACCOUNT = 'dan@gaidula.com';

// ── stdio framing ─────────────────────────────────────────────────────────────

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) {
      let msg;
      try { msg = JSON.parse(line); }
      catch (_) { continue; /* malformed JSON — drop */ }
      // handle() is async; swallow rejections so one bad call can't crash
      // the process. Per-request errors are already turned into JSON-RPC
      // error responses inside handle().
      Promise.resolve(handle(msg)).catch(() => {});
    }
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ── gog subprocess ────────────────────────────────────────────────────────────
// All calls go through here. Async spawn (not spawnSync) so a long-running
// gog/Drive call never blocks the MCP event loop and stalls the stdio reader.
// Args are an array so the shell never touches them — no injection surface.
// Returns a Promise<{ stdout, stderr, ok }>; rejects only if the process
// fails to spawn (ENOENT etc.).

function spawnGog(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(GOG, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,       // 60s — kill rather than hang indefinitely
      killSignal: 'SIGKILL',
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    // Swallow EPIPE if the child exits before we finish writing stdin.
    child.stdin.on('error', () => {});

    child.on('error', err => reject(err));
    child.on('close', code => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        ok: code === 0,
      });
    });

    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

// --json ensures parseable stdout. Args are passed through verbatim.
function gog(args, input) {
  return spawnGog(['--account', ACCOUNT, '--json', ...args], input);
}

// Plain-text variant — omits --json, used when we want raw document content.
function gogPlain(args, input) {
  return spawnGog(['--account', ACCOUNT, ...args], input);
}

function gogErr(msg) {
  return { ok: false, stdout: '', stderr: msg };
}

function makeTempFile(ext = '.tmp') {
  return join(tmpdir(), `gog-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}

// ── tool registry ─────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'drive_mv',
    description: [
      'Move a Google Drive file to a different parent folder.',
      'Does not copy — changes parent only. Use for workflow triage.',
      '',
      'Career-ops folder IDs:',
      '  to-evaluate  → 1QEtGexC99kO9nE9ebQQWKA4RydWjLkCA',
      '  to-apply     → 18bmgZpGJJDCXL2cX_KVueIjTKC7DMpki',
      '  applied      → 1Z7BRx8pCLhugVCZ8auDsKXyKX_P5-CgT',
      '  not-pursuing → 1fH8cWE_YYFuh-KskkxxtOBJVYf0Jdw5G',
      '  anthropic    → 1aqh2THbXZFO1b3G5_neoIT0ewRYAOiPf',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        file_id:   { type: 'string', description: 'Drive file ID to move.' },
        parent_id: { type: 'string', description: 'Destination folder ID.' },
      },
      required: ['file_id', 'parent_id'],
    },
  },

  {
    name: 'drive_trash',
    description: 'Move a Google Drive file to trash. Recoverable from Drive trash. Does not permanently delete.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'Drive file ID to move to trash.' },
      },
      required: ['file_id'],
    },
  },

  {
    name: 'calendar_update',
    description: [
      'Update an existing Google Calendar event.',
      'Can attach a Google Meet link, add attendees, and send invite',
      'notifications in a single call — the core "add Meet to this meeting" workflow.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id:  { type: 'string',  description: 'Calendar ID. Usually "primary".' },
        event_id:     { type: 'string',  description: 'Event ID to update.' },
        with_meet:    { type: 'boolean', description: 'Create and attach a Google Meet link to the event.' },
        add_attendee: { type: 'string',  description: 'Comma-separated emails to add (preserves existing attendees).' },
        send_updates: { type: 'string',  description: 'Notification mode: all | externalOnly | none. Defaults to all.' },
        summary:      { type: 'string',  description: 'New event title.' },
        description:  { type: 'string',  description: 'New event description.' },
        location:     { type: 'string',  description: 'New event location.' },
        from:         { type: 'string',  description: 'New start time (RFC3339).' },
        to:           { type: 'string',  description: 'New end time (RFC3339).' },
      },
      required: ['calendar_id', 'event_id'],
    },
  },

  {
    name: 'calendar_create',
    description: [
      'Create a new Google Calendar event.',
      'Can include a Meet link and send invites to attendees immediately.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id:  { type: 'string',  description: 'Calendar ID. Defaults to "primary".' },
        summary:      { type: 'string',  description: 'Event title.' },
        from:         { type: 'string',  description: 'Start time (RFC3339).' },
        to:           { type: 'string',  description: 'End time (RFC3339).' },
        with_meet:    { type: 'boolean', description: 'Create and attach a Google Meet link.' },
        attendees:    { type: 'string',  description: 'Comma-separated attendee emails.' },
        send_updates: { type: 'string',  description: 'Notification mode: all | externalOnly | none. Defaults to all.' },
        description:  { type: 'string',  description: 'Event description.' },
        location:     { type: 'string',  description: 'Event location.' },
      },
      required: ['summary', 'from', 'to'],
    },
  },

  {
    name: 'drive_permissions',
    description: 'List sharing permissions on a Drive file or folder — who has access and at what role (owner, editor, commenter, viewer).',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'Drive file or folder ID.' },
      },
      required: ['file_id'],
    },
  },

  {
    name: 'drive_rename',
    description: 'Rename a Drive file or folder without moving it. Preserves file ID and all downstream references.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id:  { type: 'string', description: 'Drive file or folder ID to rename.' },
        new_name: { type: 'string', description: 'New filename including extension, e.g. "01-jd-airtable-design-technologist.md".' },
      },
      required: ['file_id', 'new_name'],
    },
  },

  {
    name: 'drive_read',
    description: 'Read the full text content of a Google Doc by ID. Returns plain text.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: 'Google Doc ID.' },
        tab:    { type: 'string', description: 'Target a specific tab by title or ID (multi-tab docs only).' },
      },
      required: ['doc_id'],
    },
  },

  {
    name: 'drive_write',
    description: [
      'Write content to a Google Doc.',
      'Supports Markdown conversion, append vs replace, and typography options.',
      'Content is passed via stdin — safe for large documents and special characters.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        doc_id:        { type: 'string',  description: 'Google Doc ID.' },
        content:       { type: 'string',  description: 'Text or Markdown content to write.' },
        mode:          { type: 'string',  description: '"replace" (default) — overwrite entire doc. "append" — add to end.' },
        markdown:      { type: 'boolean', description: 'Convert Markdown to Google Docs formatting. Use with replace or append.' },
        check_orphans: { type: 'boolean', description: 'Block replace when open comment quotes would be lost.' },
        pageless:      { type: 'boolean', description: 'Set document to pageless mode.' },
        font_family:   { type: 'string',  description: 'Font family, e.g. "Arial", "Georgia", "Courier New".' },
        font_size:     { type: 'number',  description: 'Font size in points.' },
        alignment:     { type: 'string',  description: 'Paragraph alignment: left, center, right, justify.' },
        bold:          { type: 'boolean', description: 'Apply bold to written content.' },
        italic:        { type: 'boolean', description: 'Apply italic to written content.' },
        heading_level: { type: 'integer', description: 'Set heading level 1–6 for written content.' },
      },
      required: ['doc_id', 'content'],
    },
  },

  {
    name: 'drive_file_read',
    description: 'Download and return the text content of any Drive file (.md, .txt, etc.) by ID. Use drive_read for Google Docs. Returns plain text — no base64.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'Drive file ID.' },
        format:  { type: 'string', description: 'Export format for Google Workspace files: txt|md|pdf|docx|xlsx|pptx|csv. Inferred from file type if omitted.' },
      },
      required: ['file_id'],
    },
  },

  {
    name: 'drive_file_update',
    description: 'Overwrite the content of an existing Drive file in-place. Preserves file ID, permissions, and shared links — critical for files referenced elsewhere in the workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id:   { type: 'string', description: 'Drive file ID to update.' },
        content:   { type: 'string', description: 'New file content.' },
        mime_type: { type: 'string', description: 'MIME type override, e.g. "text/markdown". Inferred from filename if omitted.' },
      },
      required: ['file_id', 'content'],
    },
  },

  {
    name: 'drive_file_create',
    description: 'Create a new raw file (.md, .txt, etc.) directly in a Drive folder. Does NOT convert to Google Docs format. Eliminates the z_claude_trash_ root-then-copy workaround.',
    inputSchema: {
      type: 'object',
      properties: {
        title:     { type: 'string',  description: 'Filename including extension, e.g. "jd-company-role.md".' },
        content:   { type: 'string',  description: 'File content.' },
        parent_id: { type: 'string',  description: 'Drive folder ID to create the file in.' },
        mime_type: { type: 'string',  description: 'MIME type override. Inferred from extension if omitted.' },
      },
      required: ['title', 'content', 'parent_id'],
    },
  },

  {
    name: 'drive_list',
    description: 'List files in a Drive folder with stable cursor-based pagination. More reliable than drive_search for triage sessions — no duplicates, clean page tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        parent_id:  { type: 'string',  description: 'Folder ID to list.' },
        max:        { type: 'integer', description: 'Max results per page (default 20).' },
        page_token: { type: 'string',  description: 'Pagination cursor from a previous call\'s nextPageToken.' },
      },
      required: ['parent_id'],
    },
  },

  {
    name: 'gmail_send',
    description: [
      'Send an email via Gmail. Body is passed via stdin — safe for long messages.',
      'Supports threading, replies, and signature.',
      'SAFETY: confirmed must be explicitly set to true to send.',
      'If confirmed is false or omitted, returns a preflight preview of the message without sending.',
      'Always show the preview to the user and ask for confirmation before setting confirmed: true.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        to:                  { type: 'string',  description: 'Recipient emails (comma-separated).' },
        subject:             { type: 'string',  description: 'Subject line. Inherited with Re: prefix for replies.' },
        body:                { type: 'string',  description: 'Plain text body.' },
        confirmed:           { type: 'boolean', description: 'Must be true to actually send. If false or omitted, returns a preview without sending.' },
        cc:                  { type: 'string',  description: 'CC recipients (comma-separated).' },
        bcc:                 { type: 'string',  description: 'BCC recipients (comma-separated).' },
        thread_id:           { type: 'string',  description: 'Reply within an existing Gmail thread ID.' },
        reply_to_message_id: { type: 'string',  description: 'Reply to a specific Gmail message ID.' },
        reply_all:           { type: 'boolean', description: 'Auto-populate recipients from original message (requires thread_id or reply_to_message_id).' },
        signature:           { type: 'boolean', description: 'Append the Gmail signature from the active send-as address.' },
      },
      required: ['to', 'body', 'confirmed'],
    },
  },
];

// ── tool handlers ─────────────────────────────────────────────────────────────

async function runTool(name, args) {
  switch (name) {

    case 'drive_mv': {
      const { file_id, parent_id } = args;
      if (!file_id || !parent_id) return gogErr('file_id and parent_id are required.');
      return gog(['drive', 'move', file_id, '--parent', parent_id]);
    }

    case 'drive_trash': {
      const { file_id } = args;
      if (!file_id) return gogErr('file_id is required.');
      return gog(['--force', 'drive', 'delete', file_id]);
    }

    case 'calendar_update': {
      const { calendar_id, event_id, with_meet, add_attendee,
              send_updates, summary, description, location, from, to } = args;
      if (!calendar_id || !event_id) return gogErr('calendar_id and event_id are required.');

      const cmd = ['calendar', 'update', calendar_id, event_id];
      if (with_meet)    cmd.push('--with-meet');
      if (add_attendee) cmd.push('--add-attendee', add_attendee);
      cmd.push('--send-updates', send_updates || 'all');
      if (summary)      cmd.push('--summary', summary);
      if (description)  cmd.push('--description', description);
      if (location)     cmd.push('--location', location);
      if (from)         cmd.push('--from', from);
      if (to)           cmd.push('--to', to);
      return gog(cmd);
    }

    case 'calendar_create': {
      const { calendar_id, summary, from, to, with_meet,
              attendees, send_updates, description, location } = args;
      if (!summary || !from || !to) return gogErr('summary, from, and to are required.');

      // calendar_id is a required positional arg: gog calendar create <calendarId>
      // Default to 'primary' for the authenticated account's main calendar.
      const cmd = ['calendar', 'create', calendar_id || 'primary'];
      cmd.push('--summary', summary, '--from', from, '--to', to);
      if (with_meet)   cmd.push('--with-meet');
      if (attendees)   cmd.push('--attendees', attendees);
      // gog defaults --send-updates to 'none'. We default to 'all' because the
      // primary use case here is sending an invite, not silently creating an event.
      cmd.push('--send-updates', send_updates || 'all');
      if (description) cmd.push('--description', description);
      if (location)    cmd.push('--location', location);
      return gog(cmd);
    }

    case 'drive_permissions': {
      const { file_id } = args;
      if (!file_id) return gogErr('file_id is required.');
      return gog(['drive', 'permissions', file_id]);
    }

    case 'drive_rename': {
      const { file_id, new_name } = args;
      if (!file_id || !new_name) return gogErr('file_id and new_name are required.');
      return gog(['drive', 'rename', file_id, new_name]);
    }

    case 'drive_read': {
      const { doc_id, tab } = args;
      if (!doc_id) return gogErr('doc_id is required.');
      const cmd = ['docs', 'get', doc_id];
      if (tab) cmd.push('--tab', tab);
      return gogPlain(cmd);
    }

    case 'drive_write': {
      const { doc_id, content, mode = 'replace', markdown,
              check_orphans, pageless, font_family, font_size,
              alignment, bold, italic, heading_level } = args;
      if (!doc_id || content === undefined) return gogErr('doc_id and content are required.');

      // Content via stdin (--file -): handles large docs and special chars
      // cleanly without arg-length or escaping concerns.
      const cmd = ['docs', 'write', doc_id, '--file', '-'];
      cmd.push(mode === 'append' ? '--append' : '--replace');
      if (markdown)       cmd.push('--markdown');
      if (check_orphans)  cmd.push('--check-orphans');
      if (pageless)       cmd.push('--pageless');
      if (font_family)    cmd.push('--font-family', font_family);
      if (font_size)      cmd.push('--font-size', String(font_size));
      if (alignment)      cmd.push('--alignment', alignment);
      if (bold)           cmd.push('--bold');
      if (italic)         cmd.push('--italic');
      if (heading_level)  cmd.push('--heading-level', String(heading_level));
      return gog(cmd, content);
    }

    case 'drive_file_read': {
      const { file_id, format } = args;
      if (!file_id) return gogErr('file_id is required.');
      const ext = format ? `.${format}` : '.tmp';
      const tmp = makeTempFile(ext);
      const cmd = ['drive', 'download', file_id, '--out', tmp, '--overwrite'];
      if (format) cmd.push('--format', format);
      const dlResult = await gog(cmd);
      if (!dlResult.ok) return dlResult;
      try {
        const content = readFileSync(tmp, 'utf8');
        try { unlinkSync(tmp); } catch (_) {}
        return { ok: true, stdout: content, stderr: '' };
      } catch (e) {
        try { unlinkSync(tmp); } catch (_) {}
        return gogErr(`Downloaded but could not read temp file: ${e.message}`);
      }
    }

    case 'drive_file_update': {
      const { file_id, content, mime_type } = args;
      if (!file_id || content === undefined) return gogErr('file_id and content are required.');
      const tmp = makeTempFile('.tmp');
      writeFileSync(tmp, content, 'utf8');
      const cmd = ['drive', 'upload', tmp, '--replace', file_id];
      if (mime_type) cmd.push('--mime-type', mime_type);
      const result = await gog(cmd);
      try { unlinkSync(tmp); } catch (_) {}
      return result;
    }

    case 'drive_file_create': {
      const { title, content, parent_id, mime_type } = args;
      if (!title || content === undefined || !parent_id)
        return gogErr('title, content, and parent_id are required.');
      // Temp file gets the same extension as the target so gog infers MIME correctly.
      const ext = extname(title) || '.tmp';
      const tmp = makeTempFile(ext);
      writeFileSync(tmp, content, 'utf8');
      const cmd = ['drive', 'upload', tmp, '--name', title, '--parent', parent_id];
      if (mime_type) cmd.push('--mime-type', mime_type);
      // No --convert: preserve .md/.txt as raw files, not Google Docs.
      const result = await gog(cmd);
      try { unlinkSync(tmp); } catch (_) {}
      return result;
    }

    case 'drive_list': {
      const { parent_id, max, page_token } = args;
      if (!parent_id) return gogErr('parent_id is required.');
      const cmd = ['drive', 'ls', '--parent', parent_id];
      if (max)        cmd.push('--max', String(max));
      if (page_token) cmd.push('--page', page_token);
      return gog(cmd);
    }

    case 'gmail_send': {
      const { to, subject, body, confirmed, cc, bcc,
              thread_id, reply_to_message_id, reply_all, signature } = args;
      if (!to)   return gogErr('to is required.');
      if (!body) return gogErr('body is required.');

      // Safety gate: if confirmed is not explicitly true, return a preflight
      // preview and stop. The caller must make a second call with confirmed: true.
      if (confirmed !== true) {
        const preview = [
          'PREFLIGHT — not sent. Call again with confirmed: true to send.',
          `To:      ${to}`,
          cc      ? `CC:      ${cc}`      : null,
          bcc     ? `BCC:     ${bcc}`     : null,
          subject ? `Subject: ${subject}` : null,
          thread_id           ? `Thread:  ${thread_id}`           : null,
          reply_to_message_id ? `ReplyTo: ${reply_to_message_id}` : null,
          '',
          body,
        ].filter(l => l !== null).join('\n');
        return { ok: true, stdout: preview, stderr: '' };
      }

      // confirmed === true — actually send.
      const cmd = ['gmail', 'send', '--to', to, '--body-file', '-'];
      if (subject)             cmd.push('--subject', subject);
      if (cc)                  cmd.push('--cc', cc);
      if (bcc)                 cmd.push('--bcc', bcc);
      if (thread_id)           cmd.push('--thread-id', thread_id);
      if (reply_to_message_id) cmd.push('--reply-to-message-id', reply_to_message_id);
      if (reply_all)           cmd.push('--reply-all');
      if (signature)           cmd.push('--signature');
      return gog(cmd, body);
    }

    default:
      return gogErr(`Unknown tool: ${name}`);
  }
}

// ── MCP dispatcher ────────────────────────────────────────────────────────────

async function handle(msg) {
  const { id, method, params } = msg;

  // Notifications (no id) — acknowledge silently.
  if (id === undefined) return;

  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'google-workspace-mcp', version: '1.0.0' },
    }});
  }

  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  }

  if (method === 'tools/call') {
    const { name, arguments: toolArgs } = params || {};
    let result;
    try {
      result = await runTool(name, toolArgs || {});
    } catch (e) {
      result = { ok: false, stdout: '', stderr: e.message || String(e) };
    }

    const text = [result.stdout, result.stderr].filter(Boolean).join('\n')
      || (result.ok ? 'Done.' : 'Command failed with no output.');

    return send({ jsonrpc: '2.0', id, result: {
      isError: !result.ok,
      content: [{ type: 'text', text }],
    }});
  }

  return send({ jsonrpc: '2.0', id,
    error: { code: -32601, message: `Unknown method: ${method}` },
  });
}
