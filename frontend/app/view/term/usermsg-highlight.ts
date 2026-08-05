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
        for (let i = 0; i < rows.length; i++) {
            const el = rows[i] as HTMLElement;
            const line = buf.getLine(buf.viewportY + i);
            if (!line) {
                el.classList.remove(USERMSG_CLASS);
                inUserMsg = false;
                continue;
            }
            // a wrapped row continues whatever the previous row was; otherwise re-test
            if (!line.isWrapped) {
                inUserMsg = USER_PREFIX_RE.test(line.translateToString(true));
            }
            el.classList.toggle(USERMSG_CLASS, inUserMsg);
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
