// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Sidebar/session state atoms in their own dep-free module so the sidebar component,
// keymodel (Cmd+B) and blockframe (awaiting-response glow) can all import them
// without circular references.
import { globalStore } from "@/app/store/jotaiStore";
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

// --- layout (persisted across launches via localStorage) ---
export const sessionSidebarVisibleAtom = atomWithStorage("newwave:sidebar:visible", true);
export const sessionSidebarWidthAtom = atomWithStorage("newwave:sidebar:width", 240);
export const sessionSidebarCollapsedAtom = atomWithStorage("newwave:sidebar:collapsed", false);

// --- session activity ---

// Session ids whose agent finished a turn and is waiting on the user.
export const sessionAttentionAtom = atom<Set<string>>(new Set<string>());
export function markSessionAttention(sessionid: string) {
    const cur = globalStore.get(sessionAttentionAtom);
    if (!sessionid || cur.has(sessionid)) return;
    const next = new Set(cur);
    next.add(sessionid);
    globalStore.set(sessionAttentionAtom, next);
}
export function clearSessionAttention(sessionid: string) {
    const cur = globalStore.get(sessionAttentionAtom);
    if (!cur.has(sessionid)) return;
    const next = new Set(cur);
    next.delete(sessionid);
    globalStore.set(sessionAttentionAtom, next);
}

// Session ids whose agent is actively producing output (working right now).
export const sessionWorkingAtom = atom<Set<string>>(new Set<string>());
export function markSessionWorking(sessionid: string) {
    const cur = globalStore.get(sessionWorkingAtom);
    if (!sessionid || cur.has(sessionid)) return;
    const next = new Set(cur);
    next.add(sessionid);
    globalStore.set(sessionWorkingAtom, next);
}
export function clearSessionWorking(sessionid: string) {
    const cur = globalStore.get(sessionWorkingAtom);
    if (!cur.has(sessionid)) return;
    const next = new Set(cur);
    next.delete(sessionid);
    globalStore.set(sessionWorkingAtom, next);
}

// sessionid -> lightweight info, published by the sidebar so blocks can label
// their awaiting-response overlay with what the session was about.
export type SessionBrief = { title: string; alias: string; cwd: string; mtime: number };
export const sessionInfoAtom = atom<Map<string, SessionBrief>>(new Map<string, SessionBrief>());

// Pull the resume session id out of a block's cmd, e.g. "claude --resume <id>".
export function parseResumeId(cmd: string | undefined): string | null {
    if (!cmd) return null;
    const m = cmd.match(/(?:--resume|resume)\s+(\S+)/);
    return m ? m[1] : null;
}
