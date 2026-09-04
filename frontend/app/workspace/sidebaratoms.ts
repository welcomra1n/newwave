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

// --- list controls (persisted) ---

// 최근순 = last activity, 이름순 = alias/title, 상태순 = 대기 > 작업중 > 열림 > 나머지
export type SessionSort = "recent" | "name" | "status";
// 열림/실행중/대기/작업중 만 보기 (핀은 필터와 무관하게 항상 표시)
export type SessionStatusFilter = "all" | "waiting" | "working" | "open" | "live";
export const sessionSortAtom = atomWithStorage<SessionSort>("newwave:sidebar:sort", "recent");
export const sessionStatusFilterAtom = atomWithStorage<SessionStatusFilter>("newwave:sidebar:status", "all");

// Raycast-style jump palette (search + waiting sessions), opened by keybinding.
export const sessionPaletteOpenAtom = atom(false);

// --- session activity ---

// Session ids whose agent finished a turn and is waiting on the user.
export const sessionAttentionAtom = atom<Set<string>>(new Set<string>());
// when each waiting session finished, so a block can show how long it has been sitting there
export const sessionDoneAtAtom = atom<Map<string, number>>(new Map<string, number>());
export function markSessionAttention(sessionid: string) {
    const cur = globalStore.get(sessionAttentionAtom);
    if (!sessionid || cur.has(sessionid)) return;
    const next = new Set(cur);
    next.add(sessionid);
    globalStore.set(sessionAttentionAtom, next);
    const times = new Map(globalStore.get(sessionDoneAtAtom));
    times.set(sessionid, Date.now());
    globalStore.set(sessionDoneAtAtom, times);
}
export function clearSessionAttention(sessionid: string) {
    const cur = globalStore.get(sessionAttentionAtom);
    if (!cur.has(sessionid)) return;
    const next = new Set(cur);
    next.delete(sessionid);
    globalStore.set(sessionAttentionAtom, next);
    const times = new Map(globalStore.get(sessionDoneAtAtom));
    if (times.delete(sessionid)) globalStore.set(sessionDoneAtAtom, times);
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

// Pull the session id out of a block's cmd: "claude --resume <id>",
// "codex resume <id>", or a fresh session started with "claude --session-id <id>".
export function parseResumeId(cmd: string | undefined): string | null {
    if (!cmd) return null;
    const m = cmd.match(/(?:--resume|--session-id|resume)\s+(\S+)/);
    return m ? m[1] : null;
}
