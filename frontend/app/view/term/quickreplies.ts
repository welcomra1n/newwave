// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Learns the short answers you keep typing at agents ("ㅇㅇ 진행해") and offers them as
// buttons. Everything stays local: counts live in localStorage, nothing is sent anywhere.

import { atom } from "jotai";
import { globalStore } from "@/app/store/jotaiStore";

const STORAGE_KEY = "newwave:quickreplies:learned";
const MAX_TRACKED = 200; // entries kept in the store
export const MAX_LEARNED_SHOWN = 6;
const MIN_LEN = 2;
const MAX_LEN = 40;
const MIN_COUNT = 3; // repeat it a few times before it earns a button

type Counts = Record<string, number>;

function read(): Counts {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? (JSON.parse(raw) as Counts) : {};
    } catch {
        return {};
    }
}

function write(counts: Counts) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(counts));
    } catch {
        // storage full / disabled — learning is a convenience, never fail the terminal
    }
}

// bumped whenever the counts change so the button bar re-reads them
export const learnedRepliesVersionAtom = atom(0);

// A line worth remembering: short, self-contained, not a path/URL/command and not a slash
// command (those already have their own completion in the agent).
function isLearnable(line: string): boolean {
    const t = line.trim();
    if (t.length < MIN_LEN || t.length > MAX_LEN) return false;
    if (t.startsWith("/") || t.startsWith("!") || t.startsWith("#")) return false;
    if (/[\\/]{1,}/.test(t) && /\.[a-z0-9]{1,5}\b/i.test(t)) return false; // looks like a path
    if (/https?:\/\//i.test(t)) return false;
    return true;
}

export function recordSentLine(line: string) {
    if (!isLearnable(line)) return;
    const key = line.trim();
    const counts = read();
    counts[key] = (counts[key] ?? 0) + 1;
    const keys = Object.keys(counts);
    if (keys.length > MAX_TRACKED) {
        // drop the rarest entries so the store can't grow without bound
        const keep = keys.sort((a, b) => counts[b] - counts[a]).slice(0, MAX_TRACKED);
        const trimmed: Counts = {};
        for (const k of keep) trimmed[k] = counts[k];
        write(trimmed);
    } else {
        write(counts);
    }
    globalStore.set(learnedRepliesVersionAtom, (v) => v + 1);
}

export function getLearnedReplies(limit = MAX_LEARNED_SHOWN): string[] {
    const counts = read();
    return Object.entries(counts)
        .filter(([, n]) => n >= MIN_COUNT)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([text]) => text);
}

export function forgetLearnedReply(text: string) {
    const counts = read();
    if (counts[text] == null) return;
    delete counts[text];
    write(counts);
    globalStore.set(learnedRepliesVersionAtom, (v) => v + 1);
}

// Best previously-sent line that starts with what is being typed. Used for the → completion:
// the most-repeated match wins, and an exact match suggests nothing (already typed it all).
export function suggestCompletion(prefix: string): string | null {
    const p = prefix.trim();
    if (p.length < 2) return null;
    const counts = read();
    let best: string | null = null;
    let bestCount = 0;
    for (const [text, n] of Object.entries(counts)) {
        if (text === p || !text.startsWith(p)) continue;
        if (n > bestCount) {
            best = text;
            bestCount = n;
        }
    }
    return best;
}
