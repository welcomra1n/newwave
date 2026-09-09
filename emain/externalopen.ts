// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The rules that decide whether a link click actually launches a browser. Kept apart from the
// IPC wiring so they can be tested: a click that opens two browsers, or a URL that arrives
// wrapped in quotes and lands on a search page, are both bugs users hit and neither is
// reproducible by hand once shipped.

// One click must never produce two windows; anything repeating the same URL inside this
// window is the same click (slow spawn, double click, a provider registered twice).
export const EXTERNAL_DEDUPE_MS = 4000;

// Strips wrapping quotes/brackets and trailing sentence punctuation. Terminal text often
// carries a URL inside quotes, and passing that through opens a search instead of the page.
export function cleanExternalUrl(url: string): string {
    return url
        .trim()
        .replace(/^["'`<([]+/, "")
        .replace(/["'`>)\].,]+$/, "");
}

export type OpenGate = { url: string; ts: number };

// Returns the next gate state when the request should proceed, or null to ignore it.
export function admitExternalOpen(gate: OpenGate | null, url: string, now: number): OpenGate | null {
    if (gate && gate.url === url && now - gate.ts < EXTERNAL_DEDUPE_MS) {
        return null;
    }
    return { url, ts: now };
}
