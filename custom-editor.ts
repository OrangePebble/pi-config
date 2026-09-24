// Slop made by asking AI to copy pi-omp-theme and change it

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
} from "@earendil-works/pi-tui";

function fitWidth(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function isBorder(line: string): boolean {
  const plain = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  return /^─{2,}$/.test(plain) || /^─── [↑↓] \d+ more /.test(plain);
}

function stripLeadingVisibleChars(line: string, count: number): string {
  let output = "";
  let stripped = 0;
  let index = 0;

  while (index < line.length) {
    const character = line[index] ?? "";
    if (character === "\x1b") {
      const start = index++;
      const introducer = line[index];
      if (introducer === "[") {
        index++;
        while (index < line.length) {
          const byte = line[index++] ?? "";
          if (byte >= "@" && byte <= "~") break;
        }
      } else if (introducer === "]" || introducer === "_" || introducer === "^" || introducer === "P") {
        index++;
        while (index < line.length) {
          const byte = line[index++] ?? "";
          if (byte === "\x1b" && line[index] === "\\") {
            index++;
            break;
          }
          if (byte === "\x07") break;
        }
      } else if (introducer !== undefined) {
        index++;
      }
      output += line.slice(start, index);
      continue;
    }
    if (stripped < count) {
      stripped++;
      index++;
      continue;
    }
    output += character;
    index++;
  }
  return output;
}

class OmpPromptEditor extends CustomEditor {
  accent = (text: string) => text;
  private renderedInputLineCount = 0;

  override render(width: number): string[] {
    // This matches pi-omp-theme's `dock` + `claude` editor layout. Narrow
    // terminals use Pi's native editor, just as OMP did.
    if (width < 20) return super.render(width);

    const bashHidden = this.bashHiddenCount();
    const bangCount = this.leadingBangCount();
    const prompt = bangCount > 0 ? "\uf12a" : "❯";
    const padding = width < 50 ? 0 : 1;
    const promptWidth = visibleWidth(prompt) + 1;
    const innerWidth = Math.max(1, width - promptWidth - padding * 2);
    const nativeLines = super.render(innerWidth);
    const bottomBorderIndex = nativeLines.slice(1).findIndex(isBorder) + 1;
    if (bottomBorderIndex <= 0) return nativeLines;

    const prefix = `${" ".repeat(padding)}${prompt} `;
    const continuation = " ".repeat(padding + promptWidth);
    const body = nativeLines.slice(1, bottomBorderIndex);
    this.renderedInputLineCount = body.length;
    const dropdown = nativeLines.slice(bottomBorderIndex + 1);
    const inputLines = body.map((line, index) => {
      const text = index === 0 && bashHidden > 0 ? stripLeadingVisibleChars(line, bashHidden) : line;
      return fitWidth(`${index === 0 ? prefix : continuation}${text}`, width);
    });

    const border = bangCount >= 2 ? this.accent : this.borderColor;
    return [
      border("─".repeat(width)),
      ...inputLines,
      border("─".repeat(width)),
      ...dropdown.map((line) => fitWidth(line, width)),
    ];
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.width < 20) return super.handleMouse(event);

    // `super.render()` renders the editable text into `innerWidth`, but the
    // custom layout prepends the prompt to each input row. Translate pointer
    // coordinates back into the superclass' coordinate system before it maps
    // them to a text column. Dropdown rows are not indented, so leave those
    // coordinates unchanged.
    const padding = event.width < 50 ? 0 : 1;
    const promptWidth = visibleWidth(this.leadingBangCount() > 0 ? "\uf12a" : "❯") + 1;
    const prefixWidth = padding + promptWidth;
    const innerWidth = Math.max(1, event.width - promptWidth - padding * 2);
    const isInputRow = event.y > 0 && event.y <= this.renderedInputLineCount;

    return super.handleMouse(
      isInputRow
        ? { ...event, x: event.x - prefixWidth, width: innerWidth }
        : event,
    );
  }

  private leadingBangCount(): number {
    const text = this.getText();
    let index = 0;
    while (text[index] === " " || text[index] === "\t") index++;
    const start = index;
    while (text[index] === "!") index++;
    return index - start;
  }

  private bashHiddenCount(): number {
    const text = this.getText();
    let start = 0;
    while (text[start] === " " || text[start] === "\t") start++;

    const cursor = this.getCursor();
    const cursorColumn = cursor.line === 0 ? cursor.col : Number.POSITIVE_INFINITY;
    return Math.min(this.leadingBangCount(), 2, Math.max(0, cursorColumn - start));
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new OmpPromptEditor(tui, theme, keybindings);
      editor.accent = (text) => ctx.ui.theme.fg("accent", text);
      return editor;
    });
  });
}
