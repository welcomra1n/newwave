// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Tints the *user's own* messages inside an agent session so they stay findable when
// several small terminals are tiled. Claude/Codex echo past user turns as lines that
// start with a "> " marker; those rows (and their wrapped continuations) get a class
// that term.scss styles with an accent wash + left bar.
//
// DOM-renderer only: it tags the row elements xterm renders per viewport line. NewWave
// defaults to the DOM renderer (term:disablewebgl), so this is on by default; with the
// webgl renderer there are no per-line elements and the highlight is simply absent.

import type { IDisposable, Terminal } from "@xterm/xterm";

const USERMSG_CLASS = "nw-usermsg";
// first/last row of a user block: only those get the rounded corners, so a multi-line
// message reads as one bubble instead of a stack of separate stripes
const USERMSG_START = "nw-usermsg-start";
const USERMSG_END = "nw-usermsg-end";
// the row where the agent starts answering — draws the divider between turns
const TURN_START = "nw-turnstart";

// Claude/Codex open an assistant turn with a bullet at the left edge.
const AGENT_TURN_RE = /^ {0,2}[●⏺◉•]\s+\S/;

// "> text" (claude), "› " / "❯ " / "» " (codex + prompt variants). A small left indent
// is allowed, but the marker must be followed by real content so bare ">" prompts and
// box-drawn input frames don't match.
const USER_PREFIX_RE = /^ {0,3}(?:>|›|❯|»)\s+\S/;

export function attachUserMsgHighlight(terminal: Terminal): IDisposable {
    const apply = () => {
        const rowsEl = terminal.element?.querySelector(".xterm-rows");
        if (!rowsEl) return;
        const buf = terminal.buffer.active;
        const rows = rowsEl.children;
        let inUserMsg = false;
        const flags: { user: boolean; turn: boolean }[] = [];
        for (let i = 0; i < rows.length; i++) {
            const line = buf.getLine(buf.viewportY + i);
            if (!line) {
                inUserMsg = false;
                flags.push({ user: false, turn: false });
                continue;
            }
            const text = line.translateToString(true);
            // a wrapped row continues whatever the previous row was; otherwise re-test
            if (!line.isWrapped) {
                inUserMsg = USER_PREFIX_RE.test(text);
            }
            flags.push({ user: inUserMsg, turn: !inUserMsg && AGENT_TURN_RE.test(text) });
        }
        for (let i = 0; i < rows.length; i++) {
            const el = rows[i] as HTMLElement;
            const f = flags[i];
            el.classList.toggle(USERMSG_CLASS, f.user);
            el.classList.toggle(USERMSG_START, f.user && !flags[i - 1]?.user);
            el.classList.toggle(USERMSG_END, f.user && !flags[i + 1]?.user);
            el.classList.toggle(TURN_START, f.turn);
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
