// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Draws the conversation as chat bubbles: one rounded shape per turn, behind the text.
// Without it a session is one undifferentiated wall of text and you cannot see where one
// exchange ends and the next begins.
//
// The shape is a single pseudo-element on the turn's first row, stretched over the rows
// below it. Painting each row separately was tried first and read as a stack of colored
// strips rather than a bubble — the seams between rows are what gave it away.
//
// Nothing here touches the terminal's geometry, which is the hard constraint: xterm's rows
// are fixed-height boxes it measures its own coordinates against, so borders, padding and
// margins are out. The bubble is absolutely positioned instead, which lets it overhang the
// blank rows above and below for vertical breathing room and stop short of the pane's right
// edge, so a turn is only as wide as what was actually said.
//
// DOM-renderer only: it tags the row elements xterm renders per viewport line. NewWave
// defaults to the DOM renderer (term:disablewebgl), so this is on by default; with the
// webgl renderer there are no per-line elements and the styling is simply absent.

import type { IDisposable, Terminal } from "@xterm/xterm";

const USER_CLASS = "nw-usermsg";
const AGENT_CLASS = "nw-agentmsg";
const BLOCK_START = "nw-blk-start";
const BLOCK_END = "nw-blk-end";
const PAD = "4px";
const NO_PAD = "0px";
// a turn narrower than this reads as a smudge rather than a bubble
const MIN_COLS = 10;

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

// Terminal columns a string occupies. Korean, CJK and emoji take two cells each, and the
// bubble is sized in cells, so counting characters would cut a Korean turn in half.
export function cellWidth(text: string): number {
    let width = 0;
    for (const ch of text) {
        const cp = ch.codePointAt(0) ?? 0;
        const wide =
            (cp >= 0x1100 && cp <= 0x115f) || // hangul jamo
            (cp >= 0x2e80 && cp <= 0xa4cf) || // cjk radicals .. yi
            (cp >= 0xac00 && cp <= 0xd7a3) || // hangul syllables
            (cp >= 0xf900 && cp <= 0xfaff) || // cjk compatibility ideographs
            (cp >= 0xfe30 && cp <= 0xfe6f) || // cjk compatibility forms
            (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
            (cp >= 0xffe0 && cp <= 0xffe6) ||
            (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
            (cp >= 0x1f900 && cp <= 0x1f9ff);
        width += wide ? 2 : 1;
    }
    return width;
}

export type Block = { start: number; end: number; who: "user" | "agent" };

// The runs of consecutive rows belonging to one speaker — one bubble each.
export function computeBlocks(speakers: Speaker[]): Block[] {
    const blocks: Block[] = [];
    for (let i = 0; i < speakers.length; i++) {
        const who = speakers[i];
        if (who == null) continue;
        if (i > 0 && speakers[i - 1] === who) continue;
        let end = i;
        while (end + 1 < speakers.length && speakers[end + 1] === who) end++;
        blocks.push({ start: i, end, who });
    }
    return blocks;
}

// How far the bubble may overhang above and below. It may only grow into a blank row, so
// two turns that follow each other without a gap never overlap; at the viewport edge the
// turn probably continues off-screen, so it stays flush.
export function blockPadding(speakers: Speaker[], block: Block): { top: string; bottom: string } {
    return {
        top: block.start > 0 && speakers[block.start - 1] == null ? PAD : NO_PAD,
        bottom: block.end < speakers.length - 1 && speakers[block.end + 1] == null ? PAD : NO_PAD,
    };
}

export function attachUserMsgHighlight(terminal: Terminal): IDisposable {
    const apply = () => {
        const rowsEl = terminal.element?.querySelector(".xterm-rows") as HTMLElement | null;
        if (!rowsEl) return;
        const buf = terminal.buffer.active;
        const rowEls = rowsEl.children;

        // The bubble's width is expressed in cells, so it needs the real measured cell
        // width — 1ch is close, but drifts by a few pixels over a long line.
        const screenEl = terminal.element?.querySelector(".xterm-screen") as HTMLElement | null;
        if (screenEl && terminal.cols > 0) {
            rowsEl.style.setProperty("--nw-cell-w", `${screenEl.clientWidth / terminal.cols}px`);
        }

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
            // rows are recycled as the viewport scrolls, so a row that no longer starts a
            // turn has to give up the shape it was drawing
            el.style.removeProperty("--nw-blk-rows");
            el.style.removeProperty("--nw-blk-cols");
            el.style.removeProperty("--nw-pad-top");
            el.style.removeProperty("--nw-pad-bot");
        }
        for (const block of computeBlocks(speakers)) {
            const el = rowEls[block.start] as HTMLElement;
            if (el == null) continue;
            let cols = MIN_COLS;
            for (let i = block.start; i <= block.end; i++) {
                cols = Math.max(cols, cellWidth(lines[i].text.trimEnd()));
            }
            const pad = blockPadding(speakers, block);
            el.style.setProperty("--nw-blk-rows", String(block.end - block.start + 1));
            el.style.setProperty("--nw-blk-cols", String(Math.min(cols + 1, terminal.cols)));
            el.style.setProperty("--nw-pad-top", pad.top);
            el.style.setProperty("--nw-pad-bot", pad.bottom);
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
