import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, MouseRegion, Text } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SCREENSHOT_DIR = "/tmp/pi/donsetch-screenshots";

async function saveScreenshot(
  content: readonly { type: string; data?: string; mimeType?: string }[],
): Promise<{ path: string; bytes: number } | undefined> {
  const image = content.find(
    (block) => block.type === "image" && block.mimeType === "image/png" && typeof block.data === "string",
  );
  if (!image?.data) return undefined;

  await mkdir(SCREENSHOT_DIR, { recursive: true, mode: 0o700 });
  const filename = `${Date.now()}-${randomUUID()}.png`;
  const path = join(SCREENSHOT_DIR, filename);
  const png = Buffer.from(image.data, "base64");
  await writeFile(path, png, { mode: 0o600 });
  return { path, bytes: png.byteLength };
}

/** Stop only Pi's direct DonSeTch MCP supervisor child, never a standalone CLI.
 * The original DonSeTch extension notices the exit and starts a new MCP process
 * lazily on the next web_fetch call. */
async function restartPiDonsetchMcp(): Promise<void> {
  const entries = await readdir("/proc", { withFileTypes: true });
  const children = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        try {
          const [stat, cmdline] = await Promise.all([
            readFile(`/proc/${entry.name}/stat`, "utf8"),
            readFile(`/proc/${entry.name}/cmdline`, "utf8"),
          ]);
          // `comm` may contain spaces/parentheses: parse fields after its final `)`.
          const fields = stat
            .slice(stat.lastIndexOf(")") + 1)
            .trim()
            .split(/\s+/);
          return {
            pid: Number(entry.name),
            parentPid: Number(fields[1]), // state is field 0; PPID is field 1
            cmdline,
          };
        } catch {
          return undefined; // Process exited while enumerating.
        }
      }),
  );

  let stopped = false;
  for (const child of children) {
    if (
      child?.parentPid === process.pid &&
      child.cmdline.includes("/donsetch/binaries/donsetch\0mcp\0--supervised")
    ) {
      try {
        process.kill(child.pid, "SIGTERM");
        stopped = true;
      } catch {
        // The process may have exited between discovery and signalling.
      }
    }
  }
  // Give the original extension's child-process exit handler time to clear its
  // `proc` reference before the original web_fetch execute() starts.
  if (stopped) await sleep(350);
}

/**
 * The external tool adapter serializes omitted optional string fields as "".
 * DonSeTch treats their presence as intentional (`focus: ""`, for example),
 * which makes an otherwise valid browser-action fetch produce no selected
 * content. Restore MCP's optional-field semantics before DonSeTch receives
 * the call.
 *
 * Browser-action calls also get a fresh session-owned MCP/Ghost process. This
 * avoids reusing a wedged Ghost after a DevTools startup timeout, without
 * reloading Pi or changing the installed DonSeTch package.
 */
export default function (pi: ExtensionAPI) {
  // DonSeTch supplies custom renderResult() functions that only emit compact
  // summaries and ignore Pi's `expanded` option. Pi does not expose another
  // extension's tool definition for renderer replacement, so attach
  // transcript-only companion entries instead. They remain out of model
  // context, show the full URL/query, and render their Markdown on demand.
  const registerContentCard = (entryType: string, title: string) => {
    pi.registerEntryRenderer(entryType, (entry, { expanded }, theme) => {
      const data = entry.data as { subject: string; content: string };
      const card = new Box(1, 1, (text) => theme.bg("toolSuccessBg", text));
      const charCount = `${data.content.length.toLocaleString()} chars`;
      let entryExpanded = expanded;

      const rebuild = () => {
        card.clear();
        card.addChild(new Text(theme.fg("toolTitle", theme.bold(title)), 0, 0));
        card.addChild(new Text(theme.fg("mdLinkUrl", data.subject), 0, 0));
        card.addChild(
          new Text(
            theme.fg(
              "muted",
              entryExpanded
                ? `${charCount} · click or Ctrl+O to collapse`
                : `${charCount} · click or Ctrl+O to show content`,
            ),
            0,
            0,
          ),
        );

        if (entryExpanded) {
          card.addChild(new Markdown(data.content, 0, 1, getMarkdownTheme()));
        }
      };

      rebuild();
      return new MouseRegion(card, (event) => {
        if (event.type !== "click" || event.button !== "left") return undefined;
        entryExpanded = !entryExpanded;
        rebuild();
        return { handled: true, render: true };
      });
    });
  };

  registerContentCard("donsetch-full-fetch", "🌐 web_fetch content");
  registerContentCard("donsetch-full-search", "🔎 web_search content");
  registerContentCard("donsetch-full-crawl", "🕷️ web_crawl content");
  pi.registerEntryRenderer("donsetch-saved-screenshot", (entry, _options, theme) => {
    const data = entry.data as { url: string; path: string; bytes: number };
    const card = new Box(1, 1, (text) => theme.bg("toolSuccessBg", text));
    card.addChild(new Text(theme.fg("toolTitle", theme.bold("📸 web_screenshot saved")), 0, 0));
    card.addChild(new Text(theme.fg("mdLinkUrl", data.url), 0, 0));
    card.addChild(new Text(theme.fg("muted", `${data.bytes.toLocaleString()} bytes`), 0, 0));
    card.addChild(new Text(theme.fg("toolOutput", data.path), 0, 0));
    return card;
  });
  pi.registerEntryRenderer("donsetch-screenshot-save-error", (entry, _options, theme) => {
    const data = entry.data as { url: string; error: string };
    const card = new Box(1, 1, (text) => theme.bg("toolErrorBg", text));
    card.addChild(new Text(theme.fg("toolTitle", theme.bold("📸 web_screenshot was not saved")), 0, 0));
    card.addChild(new Text(theme.fg("mdLinkUrl", data.url), 0, 0));
    card.addChild(new Text(theme.fg("error", data.error), 0, 0));
    return card;
  });

  pi.on("tool_call", async (event) => {
    const input = event.input as Record<string, unknown>;

    if (event.toolName === "web_crawl") {
      // Like web_fetch's optional strings, the tool adapter emits an empty
      // resume token rather than omitting it. DonSeTch correctly interprets
      // any supplied token as a resume request, so remove the empty value.
      if (typeof input.resume === "string" && input.resume.trim() === "") {
        delete input.resume;
      }
      return;
    }

    if (event.toolName !== "web_fetch") return;
    for (const key of [
      "focus",
      "section",
      "selector",
      "must_contain",
      "shot",
    ]) {
      if (typeof input[key] === "string" && input[key].trim() === "") {
        delete input[key];
      }
    }

    if (Array.isArray(input.actions) && input.actions.length > 0) {
      await restartPiDonsetchMcp();
    }
  });

  // A normal fetch may still escalate to Ghost and time out. Reset immediately
  // after that failure so the following request gets a clean daemon as well.
  pi.on("tool_result", async (event) => {
    if (event.toolName === "web_screenshot" && !event.isError) {
      try {
        const screenshot = await saveScreenshot(event.content);
        if (screenshot) {
          pi.appendEntry("donsetch-saved-screenshot", {
            url: typeof event.input.url === "string" ? event.input.url : "(unknown URL)",
            ...screenshot,
          });
        }
      } catch (error) {
        // Screenshot persistence is an optional local convenience; never turn
        // an otherwise successful DonSeTch result into an error, but expose
        // the local failure instead of silently discarding its diagnosis.
        pi.appendEntry("donsetch-screenshot-save-error", {
          url: typeof event.input.url === "string" ? event.input.url : "(unknown URL)",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    const cards = {
      web_fetch: {
        entryType: "donsetch-full-fetch",
        subject: typeof event.input.url === "string" ? event.input.url : "(unknown URL)",
      },
      web_search: {
        entryType: "donsetch-full-search",
        subject: typeof event.input.query === "string" ? `“${event.input.query}”` : "(unknown query)",
      },
      web_crawl: {
        entryType: "donsetch-full-crawl",
        subject: typeof event.input.url === "string" ? event.input.url : "(unknown URL)",
      },
    } as const;
    const card = cards[event.toolName as keyof typeof cards];
    if (!card) return;

    const text = event.content
      .map((block: any) => (block.type === "text" ? block.text : ""))
      .join("");

    if (!event.isError && text) {
      pi.appendEntry(card.entryType, { subject: card.subject, content: text });
    }

    if (event.toolName === "web_fetch" && /ghost:\s*devtools ws timeout/i.test(text)) {
      await restartPiDonsetchMcp();
    }
  });
}
