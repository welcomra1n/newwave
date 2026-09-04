// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Left sidebar listing past Claude/Codex CLI sessions. Click to resume a
// session in a new terminal block. Because the block command is
// `claude --resume <id>`, the session auto-restores when the app restarts.
// Right-click for rename / pin / delete.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { uxCloseBlock } from "@/app/store/keymodel";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { atoms, createBlock, getBlockMetaKeyAtom, refocusNode, WOS } from "@/store/global";
import { fireAndForget } from "@/util/util";
import clsx from "clsx";
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { openColorPicker } from "./colorpicker";
import { ConnManagerModal, connManagerOpenAtom } from "./connmanager";
import {
    clearSessionAttention,
    clearSessionWorking,
    markSessionAttention,
    markSessionWorking,
    parseResumeId,
    sessionAttentionAtom,
    sessionInfoAtom,
    sessionSidebarCollapsedAtom,
    sessionSidebarVisibleAtom,
    sessionSidebarWidthAtom,
    sessionSortAtom,
    sessionStatusFilterAtom,
    sessionWorkingAtom,
    type SessionSort,
    type SessionStatusFilter,
} from "./sidebaratoms";
import "./sessionsidebar.css";

// re-export so existing importers (workspace, termwrap, etc.) keep working
export {
    clearSessionAttention,
    clearSessionWorking,
    markSessionAttention,
    markSessionWorking,
    sessionAttentionAtom,
    sessionSidebarCollapsedAtom,
    sessionSidebarVisibleAtom,
    sessionSidebarWidthAtom,
    sessionWorkingAtom,
};

const SIDEBAR_MIN_W = 170;
const SIDEBAR_MAX_W = 460;

// Bump to make the sidebar reload its session list (e.g. after a rename made
// from the block header). Cross-component refresh signal.
export const sessionListVersionAtom = atom(0);
export function bumpSessionList() {
    globalStore.set(sessionListVersionAtom, (v) => v + 1);
}

// Short two-note "done" chime via Web Audio (no asset needed).
// One shared AudioContext, reused across calls (creating one per call leaks contexts
// and browsers cap how many can exist).
let sharedAudioCtx: AudioContext | null = null;
export function playDoneSound(sessionId?: string) {
    try {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!sharedAudioCtx) sharedAudioCtx = new Ctx();
        const ctx = sharedAudioCtx;
        if (ctx.state === "suspended") void ctx.resume();
        const play = (freq: number, start: number, dur: number) => {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.connect(g);
            g.connect(ctx.destination);
            o.type = "sine";
            o.frequency.value = freq;
            g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
            g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + start + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
            o.start(ctx.currentTime + start);
            o.stop(ctx.currentTime + start + dur + 0.02);
        };
        // Each session gets its own note so four terminals don't all sound identical —
        // pentatonic steps, which stay pleasant no matter which two land together.
        const scale = [523.25, 587.33, 659.25, 783.99, 880.0]; // C5 D5 E5 G5 A5
        let hash = 0;
        for (const ch of sessionId ?? "") hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
        const root = scale[hash % scale.length];
        play(root, 0, 0.15);
        play(root * 1.5, 0.13, 0.22); // a fifth above
    } catch {
        // audio best-effort
    }
}

type AgentFilter = "all" | "claude" | "codex";

const SORT_LABELS: Record<SessionSort, string> = {
    recent: "최근순",
    name: "이름순",
    status: "상태순",
};

const STATUS_LABELS: Record<SessionStatusFilter, string> = {
    all: "전체 상태",
    waiting: "응답 대기",
    working: "작업 중",
    open: "열린 세션",
    live: "실행 중",
};

function sessionLabel(s: CliSessionEntry): string {
    return s.alias || s.title || "";
}

// Session ids currently open as blocks in the active tab (reactive).
const activeSessionIdsAtom = atom((get): Set<string> => {
    const ids = new Set<string>();
    try {
        get(atoms.staticTabId); // re-eval on tab switch
        const lm = getLayoutModelForStaticTab();
        if (!lm) return ids;
        const leafs = get(lm.leafs);
        for (const leaf of leafs) {
            const blockId = leaf?.data?.blockId;
            if (!blockId) continue;
            const cmd = get(getBlockMetaKeyAtom(blockId, "cmd")) as string | undefined;
            const id = parseResumeId(cmd);
            if (id) ids.add(id);
        }
    } catch {
        // layout not ready yet — no active markers this pass
    }
    return ids;
});

function relTime(ms: number): string {
    if (!ms) return "";
    const diff = Date.now() - ms;
    const min = Math.floor(diff / 60000);
    if (min < 1) return "방금";
    if (min < 60) return `${min}분`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}시간`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day}일`;
    const mon = Math.floor(day / 30);
    if (mon < 12) return `${mon}달`;
    return `${Math.floor(mon / 12)}년`;
}

// Time bucket for section headers (오늘 / 어제 / 이번 주 / 이전).
function timeBucket(ms: number): string {
    if (!ms) return "이전";
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ms >= startToday) return "오늘";
    if (ms >= startToday - 86400000) return "어제";
    if (ms >= startToday - 6 * 86400000) return "이번 주";
    return "이전";
}

// Find the open block (if any) that is running this session's resume command.
function findOpenBlockId(sessionid: string): string | null {
    try {
        const lm = getLayoutModelForStaticTab();
        if (!lm) return null;
        const leafs = globalStore.get(lm.leafs);
        for (const leaf of leafs) {
            const blockId = leaf?.data?.blockId;
            if (!blockId) continue;
            const cmd = globalStore.get(getBlockMetaKeyAtom(blockId, "cmd")) as string | undefined;
            if (parseResumeId(cmd) === sessionid) return blockId;
        }
    } catch {
        // layout not ready
    }
    return null;
}

// Last working dir a session was opened in — reused as the default cwd for "새 세션".
let lastSessionCwd: string | undefined;

export function openSession(s: CliSessionEntry) {
    clearSessionAttention(s.sessionid); // opening = acknowledged
    if (s.cwd) lastSessionCwd = s.cwd;
    // already open -> just focus it, don't spawn a duplicate block
    const existing = findOpenBlockId(s.sessionid);
    if (existing) {
        refocusNode(existing);
        return;
    }
    const isClaude = s.agent === "claude";
    // cmd:shell defaults true -> the full command string runs through the user's
    // shell (resolves the npm `claude`/`codex` shim on Windows). cmd:args is
    // ignored in shell mode, so the whole invocation goes in `cmd`.
    const cmd = isClaude ? `claude --resume ${s.sessionid}` : `codex resume ${s.sessionid}`;
    const blockDef: BlockDef = {
        meta: {
            view: "term",
            controller: "cmd",
            cmd: cmd,
            "cmd:cwd": s.cwd || undefined,
            // carry the custom name + color into the block header
            ...(s.alias ? { "frame:text": s.alias } : {}),
            ...(s.color
                ? {
                      "frame:text:bg": s.color,
                      "frame:bordercolor": s.color,
                      "frame:activebordercolor": s.color,
                  }
                : {}),
        },
    };
    fireAndForget(() => createBlock(blockDef));
}

// Open a *forked copy* of a session. Works even when the original is still live as a
// background agent (plain --resume refuses to double-attach; fork branches a new thread).
function openSessionFork(s: CliSessionEntry) {
    const isClaude = s.agent === "claude";
    const cmd = isClaude ? `claude --resume ${s.sessionid} --fork-session` : `codex fork ${s.sessionid}`;
    const blockDef: BlockDef = {
        meta: {
            view: "term",
            controller: "cmd",
            cmd: cmd,
            "cmd:cwd": s.cwd || undefined,
        },
    };
    fireAndForget(() => createBlock(blockDef));
}

// Start a fresh session in a new terminal block. For claude we pre-assign the session id
// (`--session-id <uuid>`) so the block is linkable to its sidebar entry from the start —
// otherwise a bare `claude` block has no id and can't be matched (rename/find/active break).
function newSession(agent: "claude" | "codex") {
    const cmd = agent === "claude" ? `claude --session-id ${crypto.randomUUID()}` : "codex";
    const blockDef: BlockDef = {
        meta: {
            view: "term",
            controller: "cmd",
            cmd,
            // start in the last folder a session was opened from (falls back to app default)
            "cmd:cwd": lastSessionCwd || undefined,
        },
    };
    fireAndForget(() => createBlock(blockDef));
}

// --- agent icons (real marks, not text labels) ---

const ClaudeIcon = memo(({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" className="shrink-0" aria-label="claude">
        {Array.from({ length: 12 }).map((_, i) => {
            const a = ((i * 30) * Math.PI) / 180;
            const x1 = 12 + 3.2 * Math.cos(a);
            const y1 = 12 + 3.2 * Math.sin(a);
            const x2 = 12 + 10 * Math.cos(a);
            const y2 = 12 + 10 * Math.sin(a);
            return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#D97757" strokeWidth="1.7" strokeLinecap="round" />;
        })}
    </svg>
));
ClaudeIcon.displayName = "ClaudeIcon";

const CodexIcon = memo(({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#10A37F" className="shrink-0" aria-label="codex">
        <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.1419.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
));
CodexIcon.displayName = "CodexIcon";

export const AgentIcon = memo(({ agent }: { agent: string }) => (agent === "claude" ? <ClaudeIcon /> : <CodexIcon />));
AgentIcon.displayName = "AgentIcon";

// --- session mutations ---

async function setSessionMeta(sessionid: string, patch: { alias?: string; pinned?: boolean }) {
    await RpcApi.SetCliSessionMetaCommand(TabRpcClient, { sessionid, ...patch });
}

async function deleteSession(filepath: string) {
    await RpcApi.DeleteCliSessionCommand(TabRpcClient, filepath);
}

// A transcript that an agent still has open can't be moved to trash yet — the process needs
// a moment to exit after its block closes. Retry a few times before giving up.
async function deleteSessionWithRetry(filepath: string, hadOpenBlock: boolean) {
    const attempts = hadOpenBlock ? 5 : 2;
    for (let i = 0; i < attempts; i++) {
        try {
            await deleteSession(filepath);
            return;
        } catch (e) {
            if (i === attempts - 1) throw e;
            await new Promise((resolve) => setTimeout(resolve, 400));
        }
    }
}

async function assignProject(sessionid: string, project: string) {
    await RpcApi.SetCliSessionMetaCommand(TabRpcClient, { sessionid, project });
}

async function saveProjects(list: string[]) {
    await RpcApi.SetCliProjectsCommand(TabRpcClient, list);
}

const UNGROUPED = "__ungrouped__";

const SESSION_COLORS: { label: string; value: string }[] = [
    { label: "빨강", value: "#e11d1d" },
    { label: "주황", value: "#ff6a00" },
    { label: "노랑", value: "#f5b400" },
    { label: "초록", value: "#16a34a" },
    { label: "파랑", value: "#2563eb" },
    { label: "보라", value: "#9333ea" },
    { label: "청록", value: "#0891b2" },
    { label: "회색", value: "#4b5563" },
];

// Session status shown as a fixed-width capsule. Color encodes STATE (green=open,
// blue=working, amber=waiting/running-elsewhere, grey=closed) — separate from the
// session's own identity color (shown as the left bar).
const StatusCapsule = memo(
    ({
        active,
        working,
        done,
        live,
        liveHost,
        compact,
    }: {
        active: boolean;
        working: boolean;
        done: boolean;
        live: boolean;
        liveHost?: LiveSessionEntry;
        compact?: boolean;
    }) => {
        if (active && working)
            return (
                <span className={clsx("baw-cap cap-work", compact && "cap-compact")} title="작업 중">
                    <i className="fa fa-solid fa-spinner fa-spin" />
                    {!compact && "작업"}
                </span>
            );
        if (active && done)
            return (
                <span className={clsx("baw-cap cap-wait", compact && "cap-compact")} title="응답 대기">
                    <i className="fa fa-solid fa-pause" />
                    {!compact && "대기"}
                </span>
            );
        if (active)
            return (
                <span className={clsx("baw-cap cap-open", compact && "cap-compact")} title="열림">
                    <span className="dot" />
                    {!compact && "열림"}
                </span>
            );
        if (live) {
            // which app owns the agent process — a session started in an outside PowerShell
            // looks identical otherwise, so show the owner as an icon + tooltip
            const host = liveHost?.host || "확인 불가";
            const inApp = liveHost?.isself ?? false;
            const isBg = liveHost?.kind === "background";
            const statusText = liveHost?.status ? ` · ${liveHost.status}` : "";
            const icon = isBg ? "fa-robot" : inApp ? "fa-window-maximize" : "fa-arrow-up-right-from-square";
            return (
                <span
                    className={clsx("baw-cap cap-run", compact && "cap-compact")}
                    title={`실행 중 · ${host}${inApp || isBg ? "" : " (이 앱 밖)"}${statusText}`}
                >
                    <i className={clsx("fa fa-solid", icon)} />
                    {!compact && "실행중"}
                </span>
            );
        }
        return compact ? null : (
            <span className="baw-cap cap-closed" title="닫힘">
                닫힘
            </span>
        );
    }
);
StatusCapsule.displayName = "StatusCapsule";

const SessionItem = memo(
    ({
        session,
        active,
        done,
        working,
        highlighted,
        searchSnippet,
        live,
        liveHost,
        compact,
        onLiveClick,
        projects,
        selected,
        selectedIds,
        onToggleSelect,
        onChanged,
    }: {
        session: CliSessionEntry;
        active: boolean;
        done: boolean;
        working: boolean;
        highlighted: boolean;
        searchSnippet?: string;
        live: boolean;
        liveHost?: LiveSessionEntry;
        compact: boolean;
        onLiveClick: (s: CliSessionEntry) => void;
        projects: string[];
        selected: boolean;
        selectedIds: string[];
        onToggleSelect: (sessionid: string) => void;
        onChanged: () => void;
    }) => {
        const [editing, setEditing] = useState(false);
        const [draft, setDraft] = useState("");
        const inputRef = useRef<HTMLInputElement>(null);
        const displayName = session.alias || session.title;

        const startRename = useCallback(() => {
            setDraft(session.alias || session.title);
            setEditing(true);
            setTimeout(() => inputRef.current?.select(), 0);
        }, [session.alias, session.title]);

        const commitRename = useCallback(() => {
            setEditing(false);
            const next = draft.trim();
            if (next === (session.alias || "")) return;
            fireAndForget(async () => {
                await setSessionMeta(session.sessionid, { alias: next });
                // if the session is open, update its block header title too
                const blockId = findOpenBlockId(session.sessionid);
                if (blockId) {
                    await RpcApi.SetMetaCommand(TabRpcClient, {
                        oref: WOS.makeORef("block", blockId),
                        meta: { "frame:text": next || null },
                    });
                }
                onChanged();
            });
        }, [draft, session.alias, session.sessionid, onChanged]);

        const togglePin = useCallback(() => {
            fireAndForget(async () => {
                await setSessionMeta(session.sessionid, { pinned: !session.pinned });
                onChanged();
            });
        }, [session.pinned, session.sessionid, onChanged]);

        const doDelete = useCallback(() => {
            fireAndForget(async () => {
                // close the block first so the agent releases the transcript, then remove it
                const blockId = findOpenBlockId(session.sessionid);
                if (blockId) uxCloseBlock(blockId);
                try {
                    await deleteSessionWithRetry(session.filepath, blockId != null);
                } catch (e) {
                    console.error("delete session failed", session.filepath, e);
                }
                onChanged();
            });
        }, [session.filepath, session.sessionid, onChanged]);

        // stop a stale/running background agent for this session (clears "실행중")
        const doKill = useCallback(() => {
            fireAndForget(async () => {
                try {
                    await RpcApi.KillLiveSessionCommand(TabRpcClient, session.sessionid);
                } catch (e) {
                    console.error("KillLiveSession failed", e);
                }
                bumpSessionList();
            });
        }, [session.sessionid]);

        const setProject = useCallback(
            (p: string) => {
                fireAndForget(async () => {
                    await assignProject(session.sessionid, p);
                    onChanged();
                });
            },
            [session.sessionid, onChanged]
        );

        const setColor = useCallback(
            (c: string) => {
                fireAndForget(async () => {
                    await RpcApi.SetCliSessionMetaCommand(TabRpcClient, { sessionid: session.sessionid, color: c });
                    // push it onto the open block right away, including the frame outline;
                    // an empty color clears all three so "없음" really goes back to default
                    const blockId = findOpenBlockId(session.sessionid);
                    if (blockId) {
                        const value = c || null;
                        await RpcApi.SetMetaCommand(TabRpcClient, {
                            oref: WOS.makeORef("block", blockId),
                            meta: {
                                "frame:text:bg": value,
                                "frame:bordercolor": value,
                                "frame:activebordercolor": value,
                            },
                        });
                    }
                    onChanged();
                });
            },
            [session.sessionid, onChanged]
        );

        const onContextMenu = useCallback(
            (e: React.MouseEvent) => {
                e.preventDefault();
                const projectMenu: ContextMenuItem[] = [
                    { label: (session.project ? "" : "✓ ") + "미분류", click: () => setProject("") },
                    ...(projects.length ? [{ type: "separator" as const }] : []),
                    ...projects.map((p) => ({
                        label: (session.project === p ? "✓ " : "") + p,
                        click: () => setProject(p),
                    })),
                ];
                const colorMenu: ContextMenuItem[] = [
                    {
                        label: "직접 고르기…",
                        click: () =>
                            openColorPicker({
                                title: "세션 색상",
                                current: session.color || null,
                                apply: (c) => setColor(c ?? ""),
                            }),
                    },
                    { type: "separator" },
                    { label: (session.color ? "" : "✓ ") + "없음", click: () => setColor("") },
                    { type: "separator" },
                    ...SESSION_COLORS.map((c) => ({
                        label: (session.color === c.value ? "✓ " : "") + c.label,
                        click: () => setColor(c.value),
                    })),
                ];
                const menu: ContextMenuItem[] = [
                    { label: "복사본으로 열기 (fork)", click: () => openSessionFork(session) },
                    { label: "이름 변경", click: startRename },
                    { label: session.pinned ? "고정 해제" : "상단 고정", click: togglePin },
                    { label: "색상", submenu: colorMenu },
                    { label: "폴더로 이동", submenu: projectMenu },
                    { type: "separator" },
                    ...(live ? [{ label: "세션 종료 (실행 중지)", click: doKill }] : []),
                    { label: "삭제 (휴지통)", click: doDelete },
                ];
                ContextMenuModel.getInstance().showContextMenu(menu, e);
            },
            [
                session.pinned,
                session.project,
                session.color,
                projects,
                startRename,
                togglePin,
                doDelete,
                doKill,
                live,
                setProject,
                setColor,
            ]
        );

        return (
            <div
                draggable={!editing}
                onDragStart={(e) => {
                    const ids = selected && selectedIds.length ? selectedIds : [session.sessionid];
                    e.dataTransfer.setData("application/x-session-ids", JSON.stringify(ids));
                    e.dataTransfer.effectAllowed = "move";
                }}
                className={clsx(
                    "relative flex items-center gap-1.5 pl-2.5 pr-2 py-1 rounded-md cursor-pointer group overflow-hidden bg-white/[0.035] hover:bg-white/[0.08] transition-colors duration-150",
                    active ? "border border-white/15" : "border border-white/10 hover:border-white/20",
                    selected && "ring-2 ring-accent ring-inset",
                    highlighted && !selected && "ring-1 ring-accent/70 ring-inset bg-accent/10",
                    active && done && "session-wait-row"
                )}
                onClick={(e) => {
                    if (editing) return;
                    if (e.ctrlKey || e.metaKey) {
                        onToggleSelect(session.sessionid);
                        return;
                    }
                    // running elsewhere (live agent) and not open here -> notify instead of
                    // spawning a resume that would be refused.
                    if (live && !active) {
                        onLiveClick(session);
                        return;
                    }
                    openSession(session);
                }}
                onContextMenu={onContextMenu}
                title={[
                    session.cwd,
                    session.model ? `모델: ${session.model}` : "",
                    session.lastmsg ? `${session.lastrole === "user" ? "나" : "AI"}: ${session.lastmsg}` : "",
                    session.sessionid,
                    active ? "(열림)" : "",
                ]
                    .filter(Boolean)
                    .join("\n")}
            >
                {/* left bar = session identity color (only when the user assigned one) */}
                {session.color && (
                    <span
                        className="absolute left-0 top-0 bottom-0 w-[3px]"
                        style={{ background: session.color }}
                    />
                )}
                {session.pinned && <i className="fa fa-solid fa-thumbtack text-[9px] text-accent shrink-0" />}
                <AgentIcon agent={session.agent} />
                {editing ? (
                    <input
                        ref={inputRef}
                        className="text-xs bg-black/40 text-white rounded-sm px-1 py-0.5 flex-1 min-w-0 outline-none border border-accent"
                        value={draft}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename();
                            else if (e.key === "Escape") setEditing(false);
                        }}
                        onBlur={commitRename}
                    />
                ) : (
                    <div className="flex-1 min-w-0">
                        <div
                            className={clsx(
                                "text-xs truncate group-hover:text-white",
                                active ? "text-white font-medium" : "text-white/90"
                            )}
                        >
                            {displayName}
                        </div>
                        {/* one line per session: the second line only appears while searching,
                            where the matched text is the reason the row is on screen at all.
                            Last message and folder stay in the row tooltip. */}
                        {searchSnippet && (
                            <div className="text-[10px] text-accent/80 truncate leading-tight" title={searchSnippet}>
                                <i className="fa fa-solid fa-magnifying-glass text-[8px] mr-1 opacity-70" />
                                {searchSnippet}
                            </div>
                        )}
                    </div>
                )}
                {/* fixed-width status column so the row never shifts as the state changes.
                    A narrow sidebar drops to icon-only (and hides the age) so the title keeps its room. */}
                <div className={clsx("shrink-0 flex justify-start", compact ? "w-[16px]" : "w-[54px]")}>
                    <StatusCapsule
                        active={active}
                        working={working}
                        done={done}
                        live={live}
                        liveHost={liveHost}
                        compact={compact}
                    />
                </div>
                {!compact && (
                    <span className="w-[34px] shrink-0 text-right text-[10px] text-muted">
                        {relTime(session.mtime)}
                    </span>
                )}
                {/* hover quick actions — absolute overlay so it doesn't reflow the columns */}
                <div className="hidden group-hover:flex items-center gap-2.5 absolute right-1.5 top-1/2 -translate-y-1/2 bg-black/75 px-2 py-1 rounded-md">
                    <button
                        type="button"
                        title="열기"
                        className="text-accent hover:brightness-125 cursor-pointer"
                        onClick={(e) => {
                            e.stopPropagation();
                            openSession(session);
                        }}
                    >
                        <i className="fa fa-solid fa-arrow-right-to-bracket text-[11px]" />
                    </button>
                    <button
                        type="button"
                        title="복사본으로 열기 (fork)"
                        className="text-accent hover:brightness-125 cursor-pointer"
                        onClick={(e) => {
                            e.stopPropagation();
                            openSessionFork(session);
                        }}
                    >
                        <i className="fa fa-solid fa-code-branch text-[11px]" />
                    </button>
                </div>
            </div>
        );
    }
);
SessionItem.displayName = "SessionItem";

// preload electron api (getApi in global.ts is not exported)
function updApi(): any {
    return (window as any).api;
}

// Footer button: manual "check for updates" + one-click install when a build is ready.
// The app also auto-checks every 10 min; this gives an always-visible manual control.
const UpdateFooter = memo(({ status }: { status: string }) => {
    const busy = status === "checking" || status === "downloading" || status === "installing";
    const ready = status === "ready";
    const [version, setVersion] = useState("");
    useEffect(() => {
        try {
            setVersion(updApi().getAboutModalDetails?.()?.version ?? "");
        } catch {
            // best-effort
        }
    }, []);
    let label: string;
    let icon: string;
    if (ready) {
        label = "업데이트 재시작";
        icon = "fa-circle-down";
    } else if (status === "checking") {
        label = "업데이트 확인 중…";
        icon = "fa-spinner fa-spin";
    } else if (status === "downloading") {
        label = "내려받는 중…";
        icon = "fa-spinner fa-spin";
    } else if (status === "installing") {
        label = "설치 중…";
        icon = "fa-spinner fa-spin";
    } else {
        label = "업데이트 확인";
        icon = "fa-rotate";
    }
    const onClick = () => {
        if (busy) return;
        if (ready) updApi().installAppUpdate();
        else updApi().checkForUpdates?.();
    };
    return (
        <div className="border-t border-border px-1.5 py-1.5">
            <button
                type="button"
                disabled={busy}
                onClick={onClick}
                title={ready ? "새 버전 설치하고 재시작" : "업데이트 확인"}
                className={clsx(
                    "flex items-center justify-center gap-1.5 w-full text-[11px] rounded-sm px-2 py-1 transition-colors",
                    ready
                        ? "bg-accent text-black font-semibold hover:brightness-110 cursor-pointer"
                        : busy
                          ? "text-secondary opacity-60 cursor-default"
                          : "text-secondary hover:text-white hover:bg-hoverbg cursor-pointer"
                )}
            >
                <i className={clsx("fa fa-solid", icon)} />
                <span style={{ whiteSpace: "nowrap" }}>{label}</span>
            </button>
            {version && (
                <div className="text-[10px] text-muted text-center mt-1" style={{ whiteSpace: "nowrap" }}>
                    NewWave v{version}
                    {status === "up-to-date" ? " · 최신" : ""}
                </div>
            )}
        </div>
    );
});
UpdateFooter.displayName = "UpdateFooter";

const SessionSidebar = memo(() => {
    const [sessions, setSessions] = useState<CliSessionEntry[]>([]);
    const [projects, setProjects] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<AgentFilter>("all");
    const [sort, setSort] = useAtom(sessionSortAtom);
    const [statusFilter, setStatusFilter] = useAtom(sessionStatusFilterAtom);
    const activeIds = useAtomValue(activeSessionIdsAtom);
    const attention = useAtomValue(sessionAttentionAtom);
    const working = useAtomValue(sessionWorkingAtom);
    const listVersion = useAtomValue(sessionListVersionAtom);
    const [width, setWidth] = useAtom(sessionSidebarWidthAtom);
    const [collapsed, setCollapsed] = useAtom(sessionSidebarCollapsedAtom);
    const [hovering, setHovering] = useState(false);
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState("");
    const [editingProject, setEditingProject] = useState<string | null>(null);
    const [editDraft, setEditDraft] = useState("");
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
    const updaterStatus = useAtomValue(atoms.updaterStatusAtom);
    const setConnOpen = useSetAtom(connManagerOpenAtom);
    const [query, setQuery] = useState("");
    // sessionids whose file *content* matches the query (title/alias match is done client-side for instant feedback)
    // sessionid -> matched content snippet (null = no active content search)
    const [contentMatches, setContentMatches] = useState<Map<string, string> | null>(null);
    // keyboard navigation index into the flat `shown` list (-1 = none)
    const [navIdx, setNavIdx] = useState(-1);
    // sessionids currently live as claude agents (interactive/background)
    const [liveIds, setLiveIds] = useState<Set<string>>(new Set());
    // sessionid -> which app owns the running agent (this app vs an outside terminal)
    const [liveHosts, setLiveHosts] = useState<Map<string, LiveSessionEntry>>(new Map());
    // transient notice banner (e.g. clicking an already-running session)
    const [notice, setNotice] = useState("");

    const toggleSelect = useCallback((sessionid: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(sessionid)) next.delete(sessionid);
            else next.add(sessionid);
            return next;
        });
    }, []);

    const load = useCallback(() => {
        setLoading(true);
        fireAndForget(async () => {
            try {
                const [list, projs] = await Promise.all([
                    RpcApi.GetCliSessionsCommand(TabRpcClient),
                    RpcApi.GetCliProjectsCommand(TabRpcClient),
                ]);
                setSessions(list ?? []);
                setProjects(projs ?? []);
                // publish brief info so blocks can label their awaiting-response overlay
                globalStore.set(
                    sessionInfoAtom,
                    new Map(
                        (list ?? []).map((s) => [
                            s.sessionid,
                            { title: s.title, alias: s.alias, cwd: s.cwd, mtime: s.mtime },
                        ])
                    )
                );
            } catch (e) {
                console.error("GetCliSessions failed", e);
                setSessions([]);
            } finally {
                setLoading(false);
            }
        });
    }, []);

    useEffect(() => {
        load();
    }, [load, listVersion]);

    // Poll which sessions are currently running as claude agents, to mark them "실행 중"
    // and warn before a resume that would be refused.
    useEffect(() => {
        let cancelled = false;
        const poll = () =>
            fireAndForget(async () => {
                try {
                    const entries = (await RpcApi.GetLiveSessionsCommand(TabRpcClient)) ?? [];
                    if (!cancelled) {
                        setLiveIds(new Set(entries.map((e) => e.sessionid)));
                        setLiveHosts(new Map(entries.map((e) => [e.sessionid, e])));
                    }
                } catch {
                    // non-fatal
                }
            });
        poll();
        const t = setInterval(poll, 15000);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, [listVersion]);

    // auto-dismiss the notice banner
    useEffect(() => {
        if (!notice) return;
        const t = setTimeout(() => setNotice(""), 4000);
        return () => clearTimeout(t);
    }, [notice]);

    // Debounced content search: title/alias matching is instant (client-side in `shown`);
    // this fills in sessions that match only by transcript content.
    useEffect(() => {
        const q = query.trim();
        if (!q) {
            setContentMatches(null);
            return;
        }
        let cancelled = false;
        const timer = setTimeout(() => {
            fireAndForget(async () => {
                try {
                    const res = await RpcApi.SearchCliSessionsCommand(TabRpcClient, { query: q });
                    if (!cancelled) setContentMatches(new Map((res ?? []).map((s) => [s.sessionid, s.snippet])));
                } catch (e) {
                    console.error("SearchCliSessions failed", e);
                    if (!cancelled) setContentMatches(new Map());
                }
            });
        }, 200);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [query]);

    // Keep any OPEN block's header (title + color) in sync with the session's
    // alias/color, so a block opened before those were set still matches.
    useEffect(() => {
        for (const s of sessions) {
            if (!s.alias && !s.color) continue;
            const blockId = findOpenBlockId(s.sessionid);
            if (!blockId) continue;
            const meta: MetaType = {};
            const curText = globalStore.get(getBlockMetaKeyAtom(blockId, "frame:text"));
            if (s.alias && curText !== s.alias) meta["frame:text"] = s.alias;
            const curBg = globalStore.get(getBlockMetaKeyAtom(blockId, "frame:text:bg"));
            if (s.color && curBg !== s.color) {
                meta["frame:text:bg"] = s.color;
                meta["frame:bordercolor"] = s.color;
                meta["frame:activebordercolor"] = s.color;
            }
            if (Object.keys(meta).length > 0) {
                fireAndForget(() =>
                    RpcApi.SetMetaCommand(TabRpcClient, { oref: WOS.makeORef("block", blockId), meta })
                );
            }
        }
    }, [sessions, activeIds]);

    // Taskbar badge = how many sessions are waiting on an answer, so the count is visible
    // while working in another app.
    useEffect(() => {
        updApi().setWaitingCount?.(attention.size);
    }, [attention]);

    // Tell the main process which sessions are mid-turn / live so quitting warns first
    // (the agent processes are children of the app and die with it).
    useEffect(() => {
        const names = sessions
            .filter((s) => working.has(s.sessionid) || liveIds.has(s.sessionid))
            .map((s) => sessionLabel(s) || s.sessionid);
        updApi().setRunningSessions?.(names);
    }, [sessions, working, liveIds]);

    // A fresh claude block starts as `claude --session-id <id>` so the sidebar can match it
    // right away. Once claude has written the session file (= it shows up in `sessions`),
    // rewrite the block's cmd to `--resume <id>`: rerunning `--session-id` on an existing
    // session fails ("Session ID ... is already in use"), which would break the block the
    // next time the app restarts and replays its cmd. `cmd` is only read when the controller
    // starts, so swapping it does not disturb the running process.
    useEffect(() => {
        for (const s of sessions) {
            if (s.agent !== "claude") continue;
            const blockId = findOpenBlockId(s.sessionid);
            if (!blockId) continue;
            const cmd = globalStore.get(getBlockMetaKeyAtom(blockId, "cmd")) as string | undefined;
            if (!cmd?.includes("--session-id")) continue;
            fireAndForget(() =>
                RpcApi.SetMetaCommand(TabRpcClient, {
                    oref: WOS.makeORef("block", blockId),
                    meta: { cmd: `claude --resume ${s.sessionid}` },
                })
            );
        }
    }, [sessions]);

    const startResize = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const startX = e.clientX;
            const startW = width;
            const onMove = (ev: MouseEvent) => {
                const w = Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, startW + (ev.clientX - startX)));
                setWidth(w);
            };
            const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
        },
        [width, setWidth]
    );

    const createProject = useCallback(
        (name: string) => {
            setCreating(false);
            setNewName("");
            const n = name.trim();
            if (!n || projects.includes(n)) return;
            fireAndForget(async () => {
                await saveProjects([...projects, n]);
                load();
            });
        },
        [projects, load]
    );

    const renameProject = useCallback(
        (oldName: string, name: string) => {
            setEditingProject(null);
            const n = name.trim();
            if (!n || n === oldName || projects.includes(n)) return;
            fireAndForget(async () => {
                for (const s of sessions.filter((s) => s.project === oldName)) {
                    await assignProject(s.sessionid, n);
                }
                await saveProjects(projects.map((p) => (p === oldName ? n : p)));
                load();
            });
        },
        [projects, sessions, load]
    );

    const deleteProject = useCallback(
        (name: string) => {
            fireAndForget(async () => {
                for (const s of sessions.filter((s) => s.project === name)) {
                    await assignProject(s.sessionid, "");
                }
                await saveProjects(projects.filter((p) => p !== name));
                load();
            });
        },
        [projects, sessions, load]
    );

    const toggleGroup = useCallback((name: string) => {
        setCollapsedGroups((prev) => {
            const next = new Set(prev);
            if (next.has(name)) next.delete(name);
            else next.add(name);
            return next;
        });
    }, []);

    const assignManyToProject = useCallback(
        (ids: string[], project: string) => {
            if (!ids.length) return;
            fireAndForget(async () => {
                await RpcApi.SetCliSessionsProjectCommand(TabRpcClient, { sessionids: ids, project });
                setSelected(new Set());
                load();
            });
        },
        [load]
    );

    // Delete every selected session (files move to trash, not a hard delete) and close any
    // blocks running them. Armed by a first click so a mis-click can't wipe a selection.
    const deleteSelected = useCallback(() => {
        const targets = sessions.filter((s) => selected.has(s.sessionid));
        if (targets.length === 0) return;
        fireAndForget(async () => {
            let ok = 0;
            const failed: string[] = [];
            for (const s of targets) {
                // close the block first: while the agent still holds the transcript open,
                // moving it to trash fails on Windows
                const blockId = findOpenBlockId(s.sessionid);
                if (blockId) uxCloseBlock(blockId);
                try {
                    await deleteSessionWithRetry(s.filepath, blockId != null);
                    ok++;
                } catch (e) {
                    console.error("delete session failed", s.filepath, e);
                    failed.push(sessionLabel(s) || s.sessionid);
                }
            }
            setSelected(new Set());
            if (failed.length === 0) {
                setNotice(`${ok}개 세션을 휴지통으로 옮겼습니다.`);
            } else {
                setNotice(
                    `${ok}개 삭제, ${failed.length}개 실패 — ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? " 외" : ""}. 실행 중인 세션은 종료한 뒤 다시 시도하세요.`
                );
            }
            load();
        });
    }, [selected, sessions, load]);

    // project = "" for the ungrouped group
    const onDropToGroup = useCallback(
        (e: React.DragEvent, project: string) => {
            e.preventDefault();
            setDragOverGroup(null);
            const raw = e.dataTransfer.getData("application/x-session-ids");
            if (!raw) return;
            try {
                const ids = JSON.parse(raw) as string[];
                assignManyToProject(ids, project);
            } catch {
                // ignore malformed payload
            }
        },
        [assignManyToProject]
    );

    const openSortMenu = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            ContextMenuModel.getInstance().showContextMenu(
                (Object.keys(SORT_LABELS) as SessionSort[]).map((m) => ({
                    label: SORT_LABELS[m],
                    type: "checkbox",
                    checked: sort === m,
                    click: () => setSort(m),
                })),
                e
            );
        },
        [sort, setSort]
    );

    const openStatusMenu = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            ContextMenuModel.getInstance().showContextMenu(
                (Object.keys(STATUS_LABELS) as SessionStatusFilter[]).map((m) => ({
                    label: STATUS_LABELS[m],
                    type: "checkbox",
                    checked: statusFilter === m,
                    click: () => setStatusFilter(m),
                })),
                e
            );
        },
        [statusFilter, setStatusFilter]
    );

    const openProjectPickMenu = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            const ids = Array.from(selected);
            const menu: ContextMenuItem[] = [
                { label: "미분류", click: () => assignManyToProject(ids, "") },
                ...(projects.length ? [{ type: "separator" as const }] : []),
                ...projects.map((p) => ({ label: p, click: () => assignManyToProject(ids, p) })),
            ];
            ContextMenuModel.getInstance().showContextMenu(menu, e);
        },
        [selected, projects, assignManyToProject]
    );

    const q = query.trim().toLowerCase();
    // status filter: pinned sessions are exempt so a pinned one never vanishes from the top
    const statusMatch = (s: CliSessionEntry) => {
        switch (statusFilter) {
            case "waiting":
                return attention.has(s.sessionid);
            case "working":
                return working.has(s.sessionid);
            case "open":
                return activeIds.has(s.sessionid);
            case "live":
                return liveIds.has(s.sessionid);
            default:
                return true;
        }
    };
    const shown = sessions.filter((s) => {
        if (filter !== "all" && s.agent !== filter) return false;
        if (statusFilter !== "all" && !s.pinned && !statusMatch(s)) return false;
        if (!q) return true;
        // instant title/alias/cwd match, plus backend content match (fills in after debounce)
        const hay = `${s.alias ?? ""} ${s.title ?? ""} ${s.cwd ?? ""}`.toLowerCase();
        return hay.includes(q) || (contentMatches?.has(s.sessionid) ?? false);
    });
    if (sort !== "recent") {
        // backend already returns pinned-first/recency; re-sort within that pinned split
        const rank = (s: CliSessionEntry) =>
            attention.has(s.sessionid) ? 0 : working.has(s.sessionid) ? 1 : activeIds.has(s.sessionid) ? 2 : 3;
        shown.sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            if (sort === "name") return sessionLabel(a).localeCompare(sessionLabel(b), "ko");
            const r = rank(a) - rank(b);
            return r !== 0 ? r : b.mtime - a.mtime;
        });
    }
    const counts: Record<AgentFilter, number> = {
        all: sessions.length,
        claude: sessions.filter((s) => s.agent === "claude").length,
        codex: sessions.filter((s) => s.agent === "codex").length,
    };

    // group sessions by project (ordered) + ungrouped
    const projectSet = new Set(projects);
    const grouped: Record<string, CliSessionEntry[]> = {};
    for (const s of shown) {
        const g = s.project && projectSet.has(s.project) ? s.project : UNGROUPED;
        (grouped[g] ||= []).push(s);
    }
    const groupOrder = [...projects, UNGROUPED];

    const selectedIds = Array.from(selected);
    // below this width the status label + age squeeze the title into nothing
    const compactRows = width < 250;
    const renderItems = (items: CliSessionEntry[]) => {
        let lastBucket: string | null = null;
        return items.map((s, i) => {
            // dashed divider where pinned sessions end and regular ones begin
            const showDivider = i > 0 && items[i - 1].pinned && !s.pinned;
            // time-bucket header (recency order only — under 이름순/상태순 the buckets would
            // no longer describe the order and just add noise)
            let bucketLabel: string | null = null;
            if (!s.pinned && sort === "recent") {
                const b = timeBucket(s.mtime);
                if (b !== lastBucket) {
                    bucketLabel = b;
                    lastBucket = b;
                }
            }
            return (
                <div key={`${s.agent}:${s.filepath}`}>
                    {showDivider && <div className="border-t border-dashed border-border my-1.5" />}
                    {bucketLabel && (
                        <div className="text-[9px] text-muted uppercase tracking-wide px-1 pt-1.5 pb-1">
                            {bucketLabel}
                        </div>
                    )}
                    <SessionItem
                        session={s}
                        active={activeIds.has(s.sessionid)}
                        done={attention.has(s.sessionid)}
                        working={working.has(s.sessionid)}
                        highlighted={navIdx >= 0 && shown[navIdx]?.sessionid === s.sessionid}
                        searchSnippet={contentMatches?.get(s.sessionid) || undefined}
                        live={liveIds.has(s.sessionid)}
                        liveHost={liveHosts.get(s.sessionid)}
                        compact={compactRows}
                        onLiveClick={(sess) =>
                            setNotice(
                                `"${sess.alias || sess.title || "세션"}"은(는) 이미 실행 중입니다. 우클릭 → 세션 종료로 정리하거나, 복사본으로 열기(fork)로 별도 사본을 열 수 있어요.`
                            )
                        }
                        projects={projects}
                        selected={selected.has(s.sessionid)}
                        selectedIds={selectedIds}
                        onToggleSelect={toggleSelect}
                        onChanged={load}
                    />
                </div>
            );
        });
    };

    const panel = (
        <div className="flex flex-col h-full bg-modalbg overflow-hidden">
            <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border">
                <span className="text-xs font-semibold text-white/80">세션</span>
                <button
                    type="button"
                    className="ml-auto text-secondary hover:text-white text-xs cursor-pointer px-1"
                    title="새 폴더"
                    onClick={() => {
                        setCreating(true);
                        setNewName("");
                    }}
                >
                    <i className="fa fa-solid fa-folder-plus" />
                </button>
                <button
                    type="button"
                    className="text-secondary hover:text-white text-xs cursor-pointer px-1"
                    title="새로고침"
                    onClick={load}
                >
                    <i className="fa fa-solid fa-rotate-right" />
                </button>
                <button
                    type="button"
                    className="text-secondary hover:text-white text-xs cursor-pointer px-1"
                    title="SSH 커넥션"
                    onClick={() => setConnOpen(true)}
                >
                    <i className="fa fa-solid fa-network-wired" />
                </button>
                <button
                    type="button"
                    className="text-secondary hover:text-white text-xs cursor-pointer px-1"
                    title={collapsed ? "고정 펼치기" : "접기"}
                    onClick={() => {
                        setCollapsed(!collapsed);
                        setHovering(false);
                    }}
                >
                    <i className={clsx("fa fa-solid", collapsed ? "fa-angles-right" : "fa-angles-left")} />
                </button>
            </div>
            <div className="flex gap-1 px-1.5 py-1 border-b border-border">
                <button
                    type="button"
                    className="flex-1 flex items-center justify-center gap-1.5 text-[11px] rounded-sm py-1 text-secondary hover:text-white hover:bg-hoverbg cursor-pointer transition-colors duration-150"
                    title="새 Claude 세션 시작"
                    onClick={() => newSession("claude")}
                >
                    <ClaudeIcon size={12} />
                    <span style={{ whiteSpace: "nowrap" }}>새 Claude</span>
                </button>
                <button
                    type="button"
                    className="flex-1 flex items-center justify-center gap-1.5 text-[11px] rounded-sm py-1 text-secondary hover:text-white hover:bg-hoverbg cursor-pointer transition-colors duration-150"
                    title="새 Codex 세션 시작"
                    onClick={() => newSession("codex")}
                >
                    <CodexIcon size={12} />
                    <span style={{ whiteSpace: "nowrap" }}>새 Codex</span>
                </button>
            </div>
            <div className="px-1.5 py-1 border-b border-border">
                <div className="relative">
                    <i className="fa fa-solid fa-magnifying-glass absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-muted pointer-events-none" />
                    <input
                        placeholder="세션 검색 (제목·내용)"
                        className="text-xs bg-black/40 text-white rounded-sm pl-6 pr-6 py-1 w-full outline-none border border-border focus:border-accent"
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setNavIdx(-1);
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Escape") {
                                setQuery("");
                                setNavIdx(-1);
                            } else if (e.key === "ArrowDown") {
                                e.preventDefault();
                                setNavIdx((i) => Math.min(i + 1, shown.length - 1));
                            } else if (e.key === "ArrowUp") {
                                e.preventDefault();
                                setNavIdx((i) => Math.max(i - 1, 0));
                            } else if (e.key === "Enter" && shown.length > 0) {
                                openSession(shown[navIdx >= 0 ? navIdx : 0]);
                            }
                        }}
                    />
                    {query && (
                        <button
                            type="button"
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted hover:text-white text-[10px] cursor-pointer"
                            title="지우기"
                            onClick={() => setQuery("")}
                        >
                            <i className="fa fa-solid fa-xmark" />
                        </button>
                    )}
                </div>
            </div>
            <div className="flex items-center gap-0.5 px-1.5 py-1 border-b border-border">
                {(["all", "claude", "codex"] as AgentFilter[]).map((f) => (
                    <button
                        key={f}
                        type="button"
                        className={clsx(
                            "text-[11px] px-1.5 py-0.5 rounded-sm cursor-pointer",
                            filter === f ? "bg-hoverbg text-white" : "text-secondary hover:text-white"
                        )}
                        onClick={() => setFilter(f)}
                    >
                        {f === "all" ? "전체" : f} <span className="opacity-60">{counts[f]}</span>
                    </button>
                ))}
                <button
                    type="button"
                    className={clsx(
                        "ml-auto text-[10px] px-1 py-0.5 rounded-sm cursor-pointer",
                        statusFilter === "all" ? "text-secondary hover:text-white" : "bg-accent/15 text-accent"
                    )}
                    title={STATUS_LABELS[statusFilter]}
                    onClick={openStatusMenu}
                >
                    <i className="fa fa-solid fa-filter" />
                </button>
                <button
                    type="button"
                    className={clsx(
                        "text-[10px] px-1 py-0.5 rounded-sm cursor-pointer",
                        sort === "recent" ? "text-secondary hover:text-white" : "bg-accent/15 text-accent"
                    )}
                    title={SORT_LABELS[sort]}
                    onClick={openSortMenu}
                >
                    <i className="fa fa-solid fa-arrow-down-short-wide" />
                </button>
            </div>
            {(statusFilter !== "all" || sort !== "recent") && (
                <div className="flex items-center gap-1.5 px-2 py-0.5 border-b border-border text-[10px] text-accent">
                    {statusFilter !== "all" && (
                        <button
                            type="button"
                            className="cursor-pointer hover:underline"
                            onClick={() => setStatusFilter("all")}
                            style={{ whiteSpace: "nowrap" }}
                        >
                            {STATUS_LABELS[statusFilter]} <i className="fa fa-solid fa-xmark opacity-70" />
                        </button>
                    )}
                    {sort !== "recent" && (
                        <button
                            type="button"
                            className="cursor-pointer hover:underline"
                            onClick={() => setSort("recent")}
                            style={{ whiteSpace: "nowrap" }}
                        >
                            {SORT_LABELS[sort]} <i className="fa fa-solid fa-xmark opacity-70" />
                        </button>
                    )}
                </div>
            )}
            {creating && (
                <div className="px-1.5 py-1 border-b border-border">
                    <input
                        autoFocus
                        placeholder="새 폴더 이름"
                        className="text-xs bg-black/40 text-white rounded-sm px-1.5 py-1 w-full outline-none border border-accent"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") createProject(newName);
                            else if (e.key === "Escape") setCreating(false);
                        }}
                        onBlur={() => createProject(newName)}
                    />
                </div>
            )}
            {selected.size > 0 && (
                <div className="flex items-center gap-2 px-2 py-1 border-b border-border bg-accent/10">
                    <span className="text-[11px] text-white">{selected.size}개 선택</span>
                    <button
                        type="button"
                        className="text-[11px] text-accent hover:underline ml-auto cursor-pointer"
                        onClick={openProjectPickMenu}
                    >
                        폴더 배정
                    </button>
                    <button
                        type="button"
                        className="text-[11px] text-red-400 hover:brightness-125 cursor-pointer"
                        title="선택한 세션 삭제 (휴지통으로 이동)"
                        onClick={deleteSelected}
                        style={{ whiteSpace: "nowrap" }}
                    >
                        삭제
                    </button>
                    <button
                        type="button"
                        className="text-[11px] text-secondary hover:text-white cursor-pointer"
                        onClick={() => setSelected(new Set())}
                    >
                        해제
                    </button>
                </div>
            )}
            {notice && (
                <div className="flex items-start gap-2 px-2 py-1.5 border-b border-border bg-amber-400/10 text-[11px] text-amber-200">
                    <i className="fa fa-solid fa-circle-info mt-0.5 shrink-0" />
                    <span className="flex-1">{notice}</span>
                    <button
                        type="button"
                        className="text-amber-200/70 hover:text-white cursor-pointer shrink-0"
                        onClick={() => setNotice("")}
                    >
                        <i className="fa fa-solid fa-xmark" />
                    </button>
                </div>
            )}
            <div className="session-scroll flex-grow overflow-y-auto overflow-x-hidden px-1.5 py-1.5">
                {loading ? (
                    <div className="flex justify-center py-4 text-muted">
                        <i className="fa fa-solid fa-spinner fa-spin" />
                    </div>
                ) : q && shown.length === 0 ? (
                    <div className="text-xs text-muted text-center py-4 px-2">검색 결과 없음</div>
                ) : shown.length === 0 && projects.length === 0 ? (
                    <div className="text-xs text-muted text-center py-6 px-2">
                        <i className="fa fa-solid fa-folder-open text-2xl opacity-40 block mb-2" />
                        세션 없음
                        <button
                            type="button"
                            className="mt-3 mx-auto flex items-center gap-1.5 text-[11px] text-accent border border-accent rounded-sm px-2.5 py-1 cursor-pointer hover:bg-accent/10 transition-colors"
                            onClick={() => newSession("claude")}
                        >
                            <i className="fa fa-solid fa-plus text-[9px]" /> 새 Claude로 시작
                        </button>
                    </div>
                ) : (
                    groupOrder.map((g) => {
                        const items = grouped[g] || [];
                        const isUng = g === UNGROUPED;
                        if (isUng && items.length === 0) return null;
                        const groupCollapsed = collapsedGroups.has(g);
                        return (
                            <div
                                key={g}
                                className={clsx(
                                    "mb-1 rounded-md",
                                    dragOverGroup === g && "ring-1 ring-accent ring-inset bg-accent/10"
                                )}
                                onDragOver={(e) => {
                                    e.preventDefault();
                                    e.dataTransfer.dropEffect = "move";
                                    setDragOverGroup(g);
                                }}
                                onDragLeave={(e) => {
                                    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                                        setDragOverGroup((cur) => (cur === g ? null : cur));
                                    }
                                }}
                                onDrop={(e) => onDropToGroup(e, isUng ? "" : g)}
                            >
                                <div
                                    className="flex items-center gap-1 px-1 py-0.5 rounded-sm hover:bg-white/5 cursor-pointer"
                                    onClick={() => toggleGroup(g)}
                                    onContextMenu={
                                        isUng
                                            ? undefined
                                            : (e) => {
                                                  e.preventDefault();
                                                  e.stopPropagation();
                                                  ContextMenuModel.getInstance().showContextMenu(
                                                      [
                                                          {
                                                              label: "이름 변경",
                                                              click: () => {
                                                                  setEditDraft(g);
                                                                  setEditingProject(g);
                                                              },
                                                          },
                                                          { label: "삭제", click: () => deleteProject(g) },
                                                      ],
                                                      e
                                                  );
                                              }
                                    }
                                >
                                    <i
                                        className={clsx(
                                            "fa fa-solid text-[9px] text-secondary w-2",
                                            groupCollapsed ? "fa-chevron-right" : "fa-chevron-down"
                                        )}
                                    />
                                    {!isUng && <i className="fa fa-solid fa-folder text-[10px] text-accent shrink-0" />}
                                    {editingProject === g ? (
                                        <input
                                            autoFocus
                                            className="text-[11px] bg-black/40 text-white rounded-sm px-1 py-0.5 flex-1 min-w-0 outline-none border border-accent"
                                            value={editDraft}
                                            onClick={(e) => e.stopPropagation()}
                                            onChange={(e) => setEditDraft(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter") renameProject(g, editDraft);
                                                else if (e.key === "Escape") setEditingProject(null);
                                            }}
                                            onBlur={() => renameProject(g, editDraft)}
                                        />
                                    ) : (
                                        <span className="text-[11px] font-semibold text-white/70 truncate">
                                            {isUng ? "미분류" : g}
                                        </span>
                                    )}
                                    <span className="text-[10px] text-muted ml-auto shrink-0">{items.length}</span>
                                </div>
                                {!groupCollapsed && <div className="space-y-1 mt-0.5">{renderItems(items)}</div>}
                            </div>
                        );
                    })
                )}
            </div>
            <UpdateFooter status={updaterStatus} />
        </div>
    );

    return (
        <div
            className="relative h-full shrink-0 select-none"
            // when collapsed the expanded panel floats over the terminal (overlay), so the
            // reserved column stays a thin strip and never pushes the layout.
            style={{ width: collapsed ? 6 : width }}
            onMouseLeave={() => setHovering(false)}
        >
            <ConnManagerModal />
            {!collapsed ? (
                <div className="relative h-full border-r border-border" style={{ width }}>
                    {panel}
                    <div
                        className="absolute top-0 right-0 h-full w-2 cursor-ew-resize hover:bg-accent/60 z-[60]"
                        onMouseDown={startResize}
                    />
                </div>
            ) : (
                <>
                    {/* wide invisible hover-catch (20px) with a thin visible strip */}
                    <div
                        className="absolute left-0 top-0 h-full w-5 z-40 cursor-pointer group/edge"
                        title={
                            attention.size > 0
                                ? `${attention.size}개 세션 답변 필요 — 올려서 펼치기`
                                : "세션 — 마우스를 올리면 펼쳐집니다"
                        }
                        onMouseEnter={() => setHovering(true)}
                    >
                        <div className="h-full w-1.5 bg-modalbg border-r border-border group-hover/edge:bg-accent/40 transition-colors" />
                        {/* attention/working badge so you can tell state without expanding */}
                        {attention.size > 0 ? (
                            <div className="absolute left-0 top-2 flex items-center justify-center w-4 h-4 rounded-full bg-accent text-black text-[9px] font-bold animate-pulse">
                                {attention.size}
                            </div>
                        ) : working.size > 0 ? (
                            <div className="absolute left-0 top-2 flex items-center justify-center w-4 h-4">
                                <i className="fa fa-solid fa-spinner fa-spin text-accent text-[9px]" />
                            </div>
                        ) : null}
                    </div>
                    {/* floating panel — always mounted, slides in AND out via transform transition */}
                    <div
                        className="absolute left-0 top-0 h-full z-50 shadow-2xl border-r border-border bg-modalbg"
                        style={{
                            width,
                            transform: hovering ? "translateX(0)" : "translateX(-100%)",
                            transition: "transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
                            pointerEvents: hovering ? "auto" : "none",
                        }}
                        onMouseEnter={() => setHovering(true)}
                    >
                        {panel}
                        <div
                            className="absolute top-0 right-0 h-full w-2 cursor-ew-resize hover:bg-accent/60 z-[60]"
                            onMouseDown={startResize}
                        />
                    </div>
                </>
            )}
        </div>
    );
});
SessionSidebar.displayName = "SessionSidebar";

export { SessionSidebar };
