// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Left sidebar listing past Claude/Codex CLI sessions. Click to resume a
// session in a new terminal block. Because the block command is
// `claude --resume <id>`, the session auto-restores when the app restarts.
// Right-click for rename / pin / delete.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { atoms, createBlock, getBlockMetaKeyAtom, refocusNode, WOS } from "@/store/global";
import { fireAndForget } from "@/util/util";
import clsx from "clsx";
import { atom, useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import "./sessionsidebar.css";

// persisted-ish toggle (module-level; resets on full reload, fine for v1)
export const sessionSidebarVisibleAtom = atom(true);

// Bump to make the sidebar reload its session list (e.g. after a rename made
// from the block header). Cross-component refresh signal.
export const sessionListVersionAtom = atom(0);
export function bumpSessionList() {
    globalStore.set(sessionListVersionAtom, (v) => v + 1);
}

type AgentFilter = "all" | "claude" | "codex";

// Pull the resume session id out of a block's cmd, e.g. "claude --resume <id>".
function parseResumeId(cmd: string | undefined): string | null {
    if (!cmd) return null;
    const m = cmd.match(/(?:--resume|resume)\s+(\S+)/);
    return m ? m[1] : null;
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

function openSession(s: CliSessionEntry) {
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
            ...(s.color ? { "frame:text:bg": s.color } : {}),
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

const AgentIcon = memo(({ agent }: { agent: string }) => (agent === "claude" ? <ClaudeIcon /> : <CodexIcon />));
AgentIcon.displayName = "AgentIcon";

// --- session mutations ---

async function setSessionMeta(sessionid: string, patch: { alias?: string; pinned?: boolean }) {
    await RpcApi.SetCliSessionMetaCommand(TabRpcClient, { sessionid, ...patch });
}

async function deleteSession(filepath: string) {
    await RpcApi.DeleteCliSessionCommand(TabRpcClient, filepath);
}

const SessionItem = memo(
    ({ session, active, onChanged }: { session: CliSessionEntry; active: boolean; onChanged: () => void }) => {
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
                await deleteSession(session.filepath);
                onChanged();
            });
        }, [session.filepath, onChanged]);

        const onContextMenu = useCallback(
            (e: React.MouseEvent) => {
                e.preventDefault();
                const menu: ContextMenuItem[] = [
                    { label: "이름 변경", click: startRename },
                    { label: session.pinned ? "고정 해제" : "상단 고정", click: togglePin },
                    { type: "separator" },
                    { label: "삭제 (휴지통)", click: doDelete },
                ];
                ContextMenuModel.getInstance().showContextMenu(menu, e);
            },
            [session.pinned, startRename, togglePin, doDelete]
        );

        return (
            <div
                className={clsx(
                    "flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer group overflow-hidden border border-white/10 bg-white/[0.035] hover:bg-white/[0.08] hover:border-white/20",
                    active && "session-active-radar"
                )}
                style={
                    {
                        "--sweep-color": `color-mix(in srgb, ${session.color || "var(--color-accent)"} 34%, transparent)`,
                    } as React.CSSProperties
                }
                onClick={() => !editing && openSession(session)}
                onContextMenu={onContextMenu}
                title={`${session.cwd}\n${session.sessionid}${active ? "\n(열림)" : ""}`}
            >
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
                    <div
                        className={clsx(
                            "text-xs truncate flex-1 min-w-0 group-hover:text-white",
                            active ? "text-white font-medium" : "text-white/90"
                        )}
                    >
                        {displayName}
                    </div>
                )}
                <span className="text-[10px] text-muted shrink-0">{relTime(session.mtime)}</span>
            </div>
        );
    }
);
SessionItem.displayName = "SessionItem";

const SessionSidebar = memo(() => {
    const [sessions, setSessions] = useState<CliSessionEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<AgentFilter>("all");
    const activeIds = useAtomValue(activeSessionIdsAtom);
    const listVersion = useAtomValue(sessionListVersionAtom);

    const load = useCallback(() => {
        setLoading(true);
        fireAndForget(async () => {
            try {
                const list = await RpcApi.GetCliSessionsCommand(TabRpcClient);
                setSessions(list ?? []);
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

    const shown = sessions.filter((s) => filter === "all" || s.agent === filter);

    return (
        <div className="flex flex-col w-[240px] shrink-0 h-full border-r border-border bg-modalbg select-none overflow-hidden">
            <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border">
                <span className="text-xs font-semibold text-white/80">세션</span>
                <button
                    type="button"
                    className="ml-auto text-secondary hover:text-white text-xs cursor-pointer px-1"
                    title="새로고침"
                    onClick={load}
                >
                    <i className="fa fa-solid fa-rotate-right" />
                </button>
            </div>
            <div className="flex gap-0.5 px-1.5 py-1 border-b border-border">
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
                        {f === "all" ? "전체" : f}
                    </button>
                ))}
            </div>
            <div className="flex-grow overflow-y-auto overflow-x-hidden px-1.5 py-1.5 space-y-1">
                {loading ? (
                    <div className="flex justify-center py-4 text-muted">
                        <i className="fa fa-solid fa-spinner fa-spin" />
                    </div>
                ) : shown.length === 0 ? (
                    <div className="text-xs text-muted text-center py-4 px-2">세션 없음</div>
                ) : (
                    shown.map((s) => (
                        <SessionItem
                            key={`${s.agent}:${s.filepath}`}
                            session={s}
                            active={activeIds.has(s.sessionid)}
                            onChanged={load}
                        />
                    ))
                )}
            </div>
        </div>
    );
});
SessionSidebar.displayName = "SessionSidebar";

export { SessionSidebar };
