/**
 * A small, same-session Unix-socket control protocol for Pi's interactive TUI.
 *
 * This is deliberately not a clone of Pi's --mode rpc protocol: extensions do
 * not receive the TUI's AgentSessionRuntime.  It uses only supported extension
 * APIs to submit prompts and publish lifecycle events from the live TUI.
 *
 * Discovery:
 *   $XDG_RUNTIME_DIR/pi-sockets/*.sock (preferred)
 *   /tmp/pi-<uid>-sockets/*.sock        (fallback)
 *
 * Clients enumerate sockets in the directory, connect to each candidate, and
 * issue get_info to obtain current metadata. The directory and sockets are
 * owner-only.
 *
 * Protocol: UTF-8 JSONL, with LF as the record delimiter.
 *
 * Requests:
 *   {"id":"...","type":"get_info"}
 *   {"id":"...","type":"subscribe"}
 *   {"id":"...","type":"prompt","message":"...", "delivery":"steer"}
 *   {"id":"...","type":"prompt","message":"...", "delivery":"followUp"}
 *   {"id":"...","type":"append_editor_text","message":"..."}
 *
 * Responses:
 *   {"id":"...","type":"response","success":true,"data":...}
 *   {"id":"...","type":"response","success":false,"error":"..."}
 *
 * Subscriber events:
 *   {"type":"event","event":"message_update","data":{...}}
 *
 * Every supported Pi lifecycle event below is forwarded, including events from
 * prompts typed directly into the TUI and prompts submitted via this socket.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

const MAX_RECORD_BYTES = 1024 * 1024;
const SOCKET_DIRECTORY_NAME = "pi-sockets";
const EVENT_NAMES = [
  "agent_start",
  "agent_end",
  "agent_settled",
  "ui_prompt_start",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "session_info_changed",
  "model_select",
  "thinking_level_select",
  "session_compact",
  "session_compact_failed",
] as const;

type Request = {
  id?: string | number;
  type?: unknown;
  message?: unknown;
  delivery?: unknown;
};

function socketDirectory(): string {
  // Keep this short enough for the Unix sun_path limit (108 bytes on Linux).
  // XDG_RUNTIME_DIR is preferred; include the UID in the /tmp fallback so
  // separate users do not share an agent-control directory.
  return process.env.XDG_RUNTIME_DIR
    ? join(process.env.XDG_RUNTIME_DIR, SOCKET_DIRECTORY_NAME)
    : `/tmp/pi-${process.getuid?.() ?? "unknown"}-sockets`;
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function writeJson(socket: Socket, value: unknown): void {
  if (!socket.destroyed) socket.write(jsonLine(value));
}

export default function (pi: ExtensionAPI) {
  let server: Server | undefined;
  let socketFile: string | undefined;
  let context: ExtensionContext | undefined;
  let startedAt: number | undefined;
  const connections = new Set<Socket>();
  const subscribers = new Set<Socket>();

  const metadata = () => ({
    protocol: "pi-socket/1",
    pid: process.pid,
    startedAt,
    socketPath: socketFile,
    sessionId: context?.sessionManager.getSessionId(),
    sessionFile: context?.sessionManager.getSessionFile() ?? null,
    sessionName: pi.getSessionName() ?? null,
    cwd: context?.cwd,
    mode: context?.mode,
    model: context?.model
      ? { provider: context.model.provider, id: context.model.id }
      : null,
    thinkingLevel: pi.getThinkingLevel(),
  });

  const broadcast = (event: string, data: unknown) => {
    const message = { type: "event", event, data };
    for (const subscriber of subscribers) {
      if (subscriber.destroyed || !subscriber.writable) {
        subscribers.delete(subscriber);
        continue;
      }
      try {
        writeJson(subscriber, message);
      } catch {
        subscribers.delete(subscriber);
        subscriber.destroy();
      }
    }
  };

  pi.registerTool({
    name: "open_for_user",
    label: "Open for User",
    description: "Open one or more local files or source locations for the user.",
    promptSnippet: "Open local files or source locations for the user",
    promptGuidelines: [
      "Use open_for_user only when the user explicitly asks to open, jump to, navigate to, show, or view a local file or source location.",
    ],
    parameters: Type.Object({
      locations: Type.Array(
        Type.Object({
          path: Type.String({ description: "Absolute path to the local file to open." }),
          line: Type.Optional(Type.Integer({ minimum: 1, description: "Optional 1-based line number." })),
          column: Type.Optional(Type.Integer({ minimum: 1, description: "Optional 1-based column number." })),
        }),
        { minItems: 1, maxItems: 10, description: "Files or source locations to open for the user." },
      ),
    }),
    async execute(_toolCallId, params) {
      broadcast("open_file", { locations: params.locations });
      return {
        content: [{
          type: "text",
          text: `Requested opening ${params.locations.length} location(s) for the user.`,
        }],
        details: { locations: params.locations },
      };
    },
  });

  const respond = (socket: Socket, id: Request["id"], data?: unknown) =>
    writeJson(socket, { id, type: "response", success: true, ...(data === undefined ? {} : { data }) });
  const fail = (socket: Socket, id: Request["id"], error: string) =>
    writeJson(socket, { id, type: "response", success: false, error });

  const handleRequest = async (request: Request, socket: Socket) => {
    if (!request || typeof request !== "object") {
      fail(socket, undefined, "request must be a JSON object");
      return;
    }
    const id = request.id;
    if (id !== undefined && typeof id !== "string" && typeof id !== "number") {
      fail(socket, undefined, "id must be a string or number");
      return;
    }

    switch (request.type) {
      case "get_info":
        respond(socket, id, { instance: metadata(), idle: context?.isIdle() ?? false });
        return;

      case "subscribe":
        subscribers.add(socket);
        respond(socket, id, { subscribed: true, instance: metadata(), idle: context?.isIdle() ?? false });
        return;

      case "append_editor_text": {
        if (typeof request.message !== "string") {
          fail(socket, id, "append_editor_text.message must be a string");
          return;
        }
        if (!context) {
          fail(socket, id, "Pi session is not ready");
          return;
        }
        context.ui.setEditorText(`${context.ui.getEditorText()}${request.message}`);
        // Pi's setEditorText() updates editor state but does not schedule a
        // TUI redraw. A cleared, extension-owned status key does schedule one
        // without leaving any visible footer entry.
        context.ui.setStatus("pi-socket-editor-refresh", undefined);
        respond(socket, id, { accepted: true });
        return;
      }

      case "prompt": {
        if (typeof request.message !== "string" || request.message.trim().length === 0) {
          fail(socket, id, "prompt.message must be a non-empty string");
          return;
        }
        const delivery = request.delivery ?? "steer";
        if (delivery !== "steer" && delivery !== "followUp") {
          fail(socket, id, 'prompt.delivery must be "steer" or "followUp"');
          return;
        }

        // Preserve text the user already has in Pi's editor: socket-submitted
        // input appends to it, submits the combined prompt, then clears the
        // editor just as an interactive submit would.
        const editorText = context?.ui.getEditorText() ?? "";
        const message = `${editorText}${request.message}`;
        if (editorText && context) {
          context.ui.setEditorText("");
          context.ui.setStatus("pi-socket-editor-refresh", undefined);
        }

        // `steer` also starts a turn immediately when Pi is idle. It is the
        // closest supported equivalent to an RPC prompt while busy.
        pi.sendUserMessage(message, {
          deliverAs: delivery,
          expandPromptTemplates: true,
        });
        respond(socket, id, { accepted: true, delivery, includedEditorText: editorText.length > 0 });
        return;
      }

      default:
        fail(socket, id, `unknown request type: ${JSON.stringify(request.type)}`);
    }
  };

  const acceptConnection = (socket: Socket) => {
    connections.add(socket);
    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_RECORD_BYTES && !buffer.includes(0x0a)) {
        fail(socket, undefined, `request exceeds ${MAX_RECORD_BYTES} byte limit`);
        socket.destroy();
        return;
      }

      while (true) {
        const newline = buffer.indexOf(0x0a);
        if (newline === -1) return;
        const line = buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
        buffer = buffer.subarray(newline + 1);
        if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
          fail(socket, undefined, `request exceeds ${MAX_RECORD_BYTES} byte limit`);
          socket.destroy();
          return;
        }
        if (!line) continue;

        let request: Request;
        try {
          request = JSON.parse(line) as Request;
        } catch (error) {
          fail(socket, undefined, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        void handleRequest(request, socket).catch((error: unknown) => {
          fail(socket, request.id, error instanceof Error ? error.message : String(error));
        });
      }
    });

    const removeConnection = () => {
      connections.delete(socket);
      subscribers.delete(socket);
    };
    socket.on("close", removeConnection);
    socket.on("error", removeConnection);
  };

  // Retain the current context only while its extension runtime is active.
  // Pi replaces extension runtimes around session changes and reloads.
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    context = ctx;
    startedAt = Math.floor(Date.now() / 1000);

    const directory = socketDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);

    const sessionId = ctx.sessionManager.getSessionId();
    socketFile = join(directory, `${sessionId}.sock`);
    await rm(socketFile, { force: true });

    server = createServer(acceptConnection);
    server.on("error", (error) => ctx.ui.notify(`Pi socket server error: ${error.message}`, "error"));
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(socketFile, () => {
        server!.off("error", reject);
        resolve();
      });
    });
    await chmod(socketFile, 0o600);
    ctx.ui.notify(`Pi socket: ${socketFile}`, "info");
  });

  for (const eventName of EVENT_NAMES) {
    pi.on(eventName, async (event, ctx) => {
      context = ctx;
      broadcast(eventName, event);
    });
  }

  // pi-permission-system emits this documented cross-extension event exactly
  // before it presents an ask-permission UI. Forward it when that extension is
  // installed; registering the listener is harmless when it is absent.
  pi.events.on("permissions:ui_prompt", (event) => {
    broadcast("permissions:ui_prompt", event);
  });

  pi.on("session_shutdown", async (event) => {
    broadcast("session_shutdown", event);
    // End gracefully so the queued session_shutdown event is flushed before
    // Pi tears down this extension runtime (for example during /reload).
    for (const connection of connections) connection.end();
    connections.clear();
    subscribers.clear();

    const closingServer = server;
    server = undefined;
    if (closingServer) {
      await new Promise<void>((resolve) => closingServer.close(() => resolve()));
    }
    if (socketFile) await rm(socketFile, { force: true });
    socketFile = undefined;
    context = undefined;
    startedAt = undefined;
  });
}
