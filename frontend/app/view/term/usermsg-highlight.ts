// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Draws the conversation as chat bubbles: one rounded shape per turn, behind the text.
// Without it a session is one undifferentiated wall of text and you cannot see where one
// exchange ends and the next begins.
//
// The bubbles live on their own layer behind the text, not on the row elements. Two earlier
// attempts failed there: painting each row separately read as a stack of colored strips
// (the seams gave it away), and a pseudo-element on the first row stretched over the rows
// below got clipped to that row, because xterm sets overflow:hidden on every row. A
// separate layer has neither problem, and it leaves the row elements untouched.
//
// Nothing here touches the terminal's geometry, which is the hard constraint: xterm's rows
// are fixed-height boxes it measures its own coordinates against, so borders, padding and
// margins are out. The layer is absolutely positioned over the screen, which lets a bubble
// overhang the blank rows above and below for vertical breathing room and stop short of the
// pane's right edge, so a turn is only as wide as what was actually said.
//
// DOM-renderer only: it tags the row elements xterm renders per viewport line. NewWave
// defaults to the DOM renderer (term:disablewebgl), so this is on by default; with the
// webgl renderer there are no per-line elements and the styling is simply absent.

import type { IDisposable, Terminal } from "@xterm/xterm";

const USER_CLASS = "nw-usermsg";
const AGENT_CLASS = "nw-agentmsg";
const BLOCK_START = "nw-blk-start";
const BLOCK_END = "nw-blk-end";
const LAYER_CLASS = "nw-bubbles";
const BUBBLE_CLASS = "nw-bubble";
// vertical overhang into the blank rows around a turn
const PAD = 4;
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
export function blockPadding(speakers: Speaker[], block: Block): { top: number; bottom: number } {
    return {
        top: block.start > 0 && speakers[block.start - 1] == null ? PAD : 0,
        bottom: block.end < speakers.length - 1 && speakers[block.end + 1] == null ? PAD : 0,
    };
}

// The layer the bubbles are drawn on: a sibling of the row container inside the screen, so
// it shares the screen's coordinates and is not subject to the rows' clipping. Inserted
// first, which puts it behind the text without any z-index juggling.
function ensureLayer(screenEl: HTMLElement): HTMLElement {
    const existing = screenEl.querySelector(`:scope > .${LAYER_CLASS}`) as HTMLElement | null;
    if (existing) return existing;
    const layer = document.createElement("div");
    layer.className = LAYER_CLASS;
    screenEl.insertBefore(layer, screenEl.firstChild);
    return layer;
}

export function attachUserMsgHighlight(terminal: Terminal): IDisposable {
    const apply = () => {
        const screenEl = terminal.element?.querySelector(".xterm-screen") as HTMLElement | null;
        const rowsEl = terminal.element?.querySelector(".xterm-rows") as HTMLElement | null;
        if (!screenEl || !rowsEl) return;
        const buf = terminal.buffer.active;
        const rowEls = rowsEl.children;
        const firstRow = rowEls[0] as HTMLElement | undefined;
        if (firstRow == null) return;
        // measured, not assumed: row height and cell width move with the font and zoom
        const rowH = firstRow.offsetHeight;
        const cellW = terminal.cols > 0 ? screenEl.clientWidth / terminal.cols : 0;

        const lines: { text: string; isWrapped: boolean }[] = [];
        for (let i = 0; i < rowEls.length; i++) {
            const line = buf.getLine(buf.viewportY + i);
            lines.push({ text: line?.translateToString(true) ?? "", isWrapped: line?.isWrapped ?? false });
        }
        const speakers = classifyRows(lines);

        // the row classes stay: term:usermsgcolor recolors the user's text through them
        for (let i = 0; i < rowEls.length; i++) {
            const el = rowEls[i] as HTMLElement;
            const who = speakers[i];
            el.classList.toggle(USER_CLASS, who === "user");
            el.classList.toggle(AGENT_CLASS, who === "agent");
            el.classList.toggle(BLOCK_START, who != null && speakers[i - 1] !== who);
            el.classList.toggle(BLOCK_END, who != null && speakers[i + 1] !== who);
        }

        const layer = ensureLayer(screenEl);
        const blocks = computeBlocks(speakers);
        // the layer's children are reused rather than rebuilt, so a render that changes
        // nothing does not churn the DOM on every frame the terminal draws
        while (layer.children.length > blocks.length) layer.lastChild!.remove();
        while (layer.children.length < blocks.length) layer.appendChild(document.createElement("div"));
        blocks.forEach((block, i) => {
            let cols = MIN_COLS;
            for (let r = block.start; r <= block.end; r++) {
                cols = Math.max(cols, cellWidth(lines[r].text.trimEnd()));
            }
            const pad = blockPadding(speakers, block);
            const el = layer.children[i] as HTMLElement;
            el.className = `${BUBBLE_CLASS} ${BUBBLE_CLASS}-${block.who}`;
            el.style.top = `${block.start * rowH - pad.top}px`;
            el.style.height = `${(block.end - block.start + 1) * rowH + pad.top + pad.bottom}px`;
            el.style.width = `${Math.min(cols + 1, terminal.cols) * cellW + 12}px`;
        });
    };

    const disposables = [terminal.onRender(apply), terminal.onScroll(apply)];
    apply();
    return {
        dispose: () => {
            for (const d of disposables) d.dispose();
            terminal.element?.querySelector(`.${LAYER_CLASS}`)?.remove();
        },
    };
}
