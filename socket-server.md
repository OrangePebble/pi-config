# Pi TUI socket server

`socket-server.ts` is a small Unix-socket protocol for controlling a **running Pi TUI session**. It intentionally uses Pi's public extension API rather than pretending to implement `pi --mode rpc`.

## Discovery

Each TUI session creates one owner-only socket:

```text
$XDG_RUNTIME_DIR/pi-sockets/<session-id>.sock
```

If `XDG_RUNTIME_DIR` is unavailable, the fallback is:

```text
/tmp/pi-<uid>-sockets/<session-id>.sock
```

A client lists `*.sock` files, connects to each candidate, and sends `get_info`. The response contains current metadata: protocol version, process ID, `startedAt` (a Unix timestamp in seconds), socket path, session ID/file/name, working directory, mode, model, and thinking level. This avoids stale metadata after an unclean Pi exit.

The directory is `0700` and each socket is `0600`. The socket is an agent-control interface: do not move it to a shared directory or relax these permissions without adding authentication.

## JSONL protocol

Records are UTF-8 JSON objects delimited by LF (`\n`). A request can include a string or numeric `id`; all replies echo it.

### Inspect a candidate

```json
{"id": 1, "type": "get_info"}
```

```json
{"id": 1,"type":"response","success":true,"data":{"instance":{"sessionId":"...","cwd":"/work","model":{"provider":"...","id":"..."}},"idle":true}}
```

### Subscribe to Pi events

```json
{"id": 2, "type": "subscribe"}
```

The connection remains open and receives events from the whole TUI session, whether a turn was started from the TUI or through the socket:

```json
{"type":"event","event":"agent_start","data":{}}
{"type":"event","event":"message_update","data":{"assistantMessageEvent":{"type":"text_delta","delta":"Hello"}}}
{"type":"event","event":"tool_execution_start","data":{"toolName":"bash","toolCallId":"...","args":{"command":"..."}}}
{"type":"event","event":"agent_settled","data":{}}
```

The `open_for_user` tool broadcasts a generic file-opening request when the user explicitly asks Pi to navigate to a file or source location:

```json
{
  "type": "event",
  "event": "open_file",
  "data": {
    "locations": [
      {"path": "/absolute/path/to/file.lua", "line": 42, "column": 1}
    ]
  }
}
```

Forwarded events are `agent_*`, `turn_*`, `message_*`, `tool_execution_*`, and `ui_prompt_start`, plus model/thinking changes and compaction results. When `@gotgenes/pi-permission-system` is installed, its documented `permissions:ui_prompt` event is forwarded immediately before its permission UI opens. On normal session shutdown the server sends one `session_shutdown` event and closes subscribers.

### Send a prompt

```json
{"id": 3, "type": "prompt", "message": "Run the tests", "delivery": "steer"}
```

`delivery` is optional and defaults to `steer`:

- `steer` begins a turn immediately if idle; otherwise it queues before the next model call.
- `followUp` waits until the current agent run is fully settled.

The prompt is submitted with `pi.sendUserMessage(..., { expandPromptTemplates: true })`, so extension commands, skills, and prompt templates can expand. It is an extension-originated prompt, not the private built-in RPC `prompt` path.

### Append text to Pi's editor without submitting it

```json
{"id": 4, "type": "append_editor_text", "message": "Draft prompt "}
```

This appends `message` to the current Pi TUI editor text without starting an agent turn. The Neovim client uses this request automatically when its input is submitted with a trailing space.

## Minimal shell examples

List candidate instances:

```sh
find "${XDG_RUNTIME_DIR:-/tmp/pi-$(id -u)-sockets}" -maxdepth 1 -name '*.sock' -type s -print
```

For each result, connect and issue `get_info`; a refused connection indicates a stale socket.

Send a prompt with netcat:

```sh
printf '%s\n' '{"id":1,"type":"prompt","message":"Run the tests"}' \
  | nc -U "$XDG_RUNTIME_DIR/pi-sockets/<session-id>.sock"
```

Subscribe (the exact keep-open option varies by netcat implementation):

```sh
nc -U "$XDG_RUNTIME_DIR/pi-sockets/<session-id>.sock"
# Then type: {"type":"subscribe"}
```
