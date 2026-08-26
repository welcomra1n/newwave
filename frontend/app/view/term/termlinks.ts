// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Terminal URL detection that survives a URL split across two rows.
//
// The stock web-links addon only joins rows the terminal itself wrapped
// (`line.isWrapped`). Agent TUIs (claude/codex) lay out their own text and emit a real
// newline at the wrap point, so a long URL becomes two independent rows and only the
// first half is clickable — which is exactly the case this replaces.
//
// Rows are joined when the earlier row runs to the last column and the next row starts
// with a non-space: that is what a broken-mid-token URL looks like, and normal prose
// (which ends with a space or short of the edge) is left alone.

import type { IBufferLine, IDisposable, ILink, Terminal } from "@xterm/xterm";

// Matches http(s)/file URLs. Wrapping quotes/brackets are excluded up front and any
// trailing sentence punctuation is trimmed afterwards.
const URL_RE = /(?:https?:\/\/|file:\/\/)[^\s"'`<>()[\]{}]+/g;

const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

export type TermLinkHandlers = {
    activate: (event: MouseEvent, uri: string) => void;
    hover?: (event: MouseEvent, uri: string) => void;
    leave?: () => void;
};

type RowText = { absLine: number; text: string };

function rowText(line: IBufferLine | undefined): string {
    return line ? line.translateToString(true) : "";
}

// A URL that reaches the end of the row it started on.
const URL_TAIL_RE = /(?:https?:\/\/|file:\/\/)[^\s"'`<>]*$/;
// A row that is nothing but URL characters — the tail half of a split link. Requiring the
// whole row to be space-free keeps ordinary prose after a URL from being swallowed.
const URL_CONT_RE = /^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;

// True when `text` continues a URL that `prevText` left unfinished. Content-based on
// purpose: agent TUIs wrap at their own width, so "did the row fill the terminal" is false
// for them and their split links never got joined.
export function continuesUrl(prevText: string, text: string): boolean {
    if (!prevText || !text) return false;
    if (!URL_TAIL_RE.test(prevText)) return false;
    return URL_CONT_RE.test(text);
}

// True when `absLine` continues the text of the row above it.
function continuesPrevRow(term: Terminal, absLine: number): boolean {
    const line = term.buffer.active.getLine(absLine);
    const prev = term.buffer.active.getLine(absLine - 1);
    if (!line || !prev) return false;
    if (line.isWrapped) return true;
    return continuesUrl(prev.translateToString(true), line.translateToString(true));
}

// Collect the full logical line containing `absLine`, walking both directions.
function collectRows(term: Terminal, absLine: number): RowText[] {
    const buf = term.buffer.active;
    let first = absLine;
    // cap the walk so a screen of full-width rows can't turn into an unbounded scan
    for (let i = 0; i < 8 && continuesPrevRow(term, first); i++) first--;
    let last = absLine;
    for (let i = 0; i < 8 && continuesPrevRow(term, last + 1); i++) last++;
    const rows: RowText[] = [];
    for (let ln = first; ln <= last; ln++) {
        rows.push({ absLine: ln, text: rowText(buf.getLine(ln)) });
    }
    return rows;
}

// Map an index in the joined string back to its row and 0-based column.
function mapIndex(rows: RowText[], idx: number): { absLine: number; col: number } | null {
    let remaining = idx;
    for (const row of rows) {
        if (remaining < row.text.length) {
            return { absLine: row.absLine, col: remaining };
        }
        remaining -= row.text.length;
    }
    return null;
}

// One provider per terminal. A block that gets re-created (remount, renderer swap) used to
// stack providers, and every extra one reported the same link again — which is how a single
// click ended up launching two browsers.
const registeredTerminals = new WeakSet<Terminal>();

export function registerTermLinkProvider(term: Terminal, handlers: TermLinkHandlers): IDisposable {
    if (registeredTerminals.has(term)) {
        return { dispose: () => {} };
    }
    registeredTerminals.add(term);
    return term.registerLinkProvider({
        provideLinks(y: number, callback: (links: ILink[] | undefined) => void) {
            const viewportY = term.buffer.active.viewportY;
            const absLine = viewportY + y - 1;
            const rows = collectRows(term, absLine);
            if (rows.length === 0) {
                callback(undefined);
                return;
            }
            const joined = rows.map((r) => r.text).join("");
            const links: ILink[] = [];
            URL_RE.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = URL_RE.exec(joined)) != null) {
                const uri = m[0].replace(TRAILING_PUNCT_RE, "");
                if (uri.length < 8) continue;
                const start = mapIndex(rows, m.index);
                const end = mapIndex(rows, m.index + uri.length - 1);
                if (!start || !end) continue;
                // only hand back links that actually touch the row xterm asked about
                if (absLine < start.absLine || absLine > end.absLine) continue;
                links.push({
                    text: uri,
                    range: {
                        start: { x: start.col + 1, y: start.absLine - viewportY + 1 },
                        end: { x: end.col + 1, y: end.absLine - viewportY + 1 },
                    },
                    activate: (event) => handlers.activate(event, uri),
                    hover: (event) => handlers.hover?.(event, uri),
                    leave: () => handlers.leave?.(),
                });
            }
            callback(links.length > 0 ? links : undefined);
        },
    });
}
