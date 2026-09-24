// Slop made by asking AI to copy pi-omp-theme and change it

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${tokens}`;
}

function totalCost(entries: readonly SessionEntry[]): number {
  let cost = 0;

  for (const entry of entries) {
    if (entry.type === "message") {
      if (entry.message.role !== "assistant" && entry.message.role !== "toolResult") continue;
      if ("usage" in entry.message && entry.message.usage) cost += entry.message.usage.cost.total;
    } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      cost += entry.usage.cost.total;
    }
  }

  return cost;
}

function thinkingLabel(level: ThinkingLevel): string {
  const glyphs: Record<ThinkingLevel, string> = {
    off: "󰝦",
    minimal: "󰪞",
    low: "󰪟",
    medium: "󰪡",
    high: "󰪣",
    xhigh: "󰪤",
    max: "󰪥",
  };
  const label = level === "minimal" ? "min" : level === "medium" ? "med" : level;
  return `${glyphs[level]} ${label}`;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          // pi-omp-theme's `model_effort` segment: model plus its thinking level.
          const model = `󰍛 ${ctx.model?.id ?? "no model"}`;
          const thinking = ctx.thinkingLevel ?? "off";
          const effort = ctx.model?.reasoning ? thinkingLabel(thinking) : "";
          const modelEffort = [model, effort].filter(Boolean).join(" · ");

          // Its `path` segment deliberately retains the full checkout path.
          const path = ` ${ctx.cwd}`;
          const left = `${modelEffort} | ${path}`;

          // Its `claude_context` segment, without the progress gauge.
          const context = ctx.getContextUsage();
          const contextText = context && context.tokens !== null
            ? `${formatTokens(context.tokens)}/${formatTokens(context.contextWindow)} (${Math.round(context.percent ?? 0)}%)`
            : "context unavailable";
          const right = theme.fg(
            "muted",
            `${contextText} | \uf155${totalCost(ctx.sessionManager.getEntries()).toFixed(3)}`,
          );

          const separator = theme.fg("muted", " | ");
          const separatorWidth = visibleWidth(separator);
          const leftWidth = visibleWidth(left);
          const rightWidth = visibleWidth(right);
          const availableRight = width - leftWidth - separatorWidth;
          const gapWithSeparator = width - leftWidth - separatorWidth - rightWidth;
          const primary =
            gapWithSeparator >= 0
              ? gapWithSeparator <= 2
                ? `${left}${separator}${" ".repeat(gapWithSeparator)}${right}`
                : `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`
              : availableRight > 0
                ? `${left}${separator}${truncateToWidth(right, availableRight, theme.fg("muted", "..."))}`
                : truncateToWidth(left, width);

          // pi-omp-theme's `extension_statuses` secondary segment.
          const statuses = Array.from(footerData.getExtensionStatuses().entries())
            .sort(([first], [second]) => first.localeCompare(second))
            .map(([, status]) => status.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
            .filter(Boolean)
            .join(" ");

          const lines = [truncateToWidth(theme.fg("muted", primary), width, theme.fg("muted", "..."))];
          if (statuses) {
            lines.push(truncateToWidth(theme.fg("muted", statuses), width, theme.fg("muted", "...")));
          }
          return lines;
        },
      };
    });
  });
}
