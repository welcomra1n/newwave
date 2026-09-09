// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Draws the conversation as two kinds of boxes: the user's own turns and the agent's
// answers. Without it a session is one undifferentiated wall of text and you cannot see
// where one exchange ends and the next begins.
//
// Each speaker's block gets a filled background, a rounded top on its first row and a
// rounded bottom on its last. Blank rows stay outside the boxes, which reads as the gap
// between messages — real padding is impossible here, because xterm's rows are fixed-height
// boxes whose geometry the terminal itself depends on.
//
// DOM-renderer only: it tags the row elements xterm renders per viewport line. NewWave
// defaults to the DOM renderer (term:disablewebgl), so this is on by default; with the
// webgl renderer there are no per-line elements and the styling is simply absent.

import type { IDisposable, Terminal } from "@xterm/xterm";

const USER_CLASS = "nw-usermsg";
const AGENT_CLASS = "nw-agentmsg";
const BLOCK_START = "nw-blk-start";
const BLOCK_END = "nw-blk-end";

// "> text" (claude), "› " / "❯ " / "» " (codex + prompt variants). A small left indent is
// allowed, but the marker must be followed by real content so bare ">" prompts and
// box-drawn input frames don't match.
const USER_PREFIX_RE = /^ {0,3}(?:>|›|❯|»)\s+\S/;
// Claude/Codex open an assistant turn with a bullet at the left edge.
const AGENT_PREFIX_RE = /^ {0,2}[●⏺◉•]\s+\S/;
// Continuation of whatever block is open: indented text, or the tool-result gutter.
const CONTINUATION_RE = /^ {2,}\S/;

type Speaker = "user" | "agent" | null;

// Which speaker each viewport row belongs to. Exported for tests: the block boundaries are
// the whole point, and they are easier to get wrong than they look.
export function classifyRows(rows: { text: string; isWrapped: boolean }[]): Speaker[] {
    let current: Speaker = null;
    return rows.map(({ text, isWrapped }) => {
        if (text.trim() === "") {
            current = null; // a blank line closes the block and becomes the gap
            return null;
        }
        if (isWrapped && current != null) {
            return current; // the terminal wrapped this row; it is still the same message
        }
        if (USER_PREFIX_RE.test(text)) {
            current = "user";
        } else if (AGENT_PREFIX_RE.test(text)) {
            current = "agent";
        } else if (current != null && CONTINUATION_RE.test(text)) {
            // indented follow-on line of the open block
        } else {
            current = null;
        }
        return current;
    });
}

export function attachUserMsgHighlight(terminal: Terminal): IDisposable {
    const apply = () => {
        const rowsEl = terminal.element?.querySelector(".xterm-rows");
        if (!rowsEl) return;
        const buf = terminal.buffer.active;
        const rowEls = rowsEl.children;
        const lines: { text: string; isWrapped: boolean }[] = [];
        for (let i = 0; i < rowEls.length; i++) {
            const line = buf.getLine(buf.viewportY + i);
            lines.push({ text: line?.translateToString(true) ?? "", isWrapped: line?.isWrapped ?? false });
        }
        const speakers = classifyRows(lines);
        for (let i = 0; i < rowEls.length; i++) {
            const el = rowEls[i] as HTMLElement;
            const who = speakers[i];
            el.classList.toggle(USER_CLASS, who === "user");
            el.classList.toggle(AGENT_CLASS, who === "agent");
            el.classList.toggle(BLOCK_START, who != null && speakers[i - 1] !== who);
            el.classList.toggle(BLOCK_END, who != null && speakers[i + 1] !== who);
        }
    };

    const disposables = [terminal.onRender(apply), terminal.onScroll(apply)];
    apply();
    return {
        dispose: () => {
            for (const d of disposables) d.dispose();
        },
    };
}
