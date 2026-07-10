// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Left sidebar listing past Claude/Codex CLI sessions. Click to resume a
// session in a new terminal block. Because the block command is
// `claude --resume <id>`, the session auto-restores when the app restarts.

import { getLayoutModelForStaticTab } from "@/layout/index";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atoms, createBlock, getBlockMetaKeyAtom } from "@/store/global";
import { fireAndForget } from "@/util/util";
import clsx from "clsx";
import { atom, useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useState } from "react";

// persisted-ish toggle (module-level; resets on full reload, fine for v1)
export const sessionSidebarVisibleAtom = atom(true);

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

function baseName(p: string): string {
    if (!p) return "";
    const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
    return parts[parts.length - 1] || p;
}

function openSession(s: CliSessionEntry) {
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
        },
    };
    fireAndForget(() => createBlock(blockDef));
}

const AgentBadge = memo(({ agent }: { agent: string }) => {
    const isClaude = agent === "claude";
    return (
        <span
            className={clsx(
                "text-[10px] font-semibold px-1 rounded-sm shrink-0 leading-tight",
                isClaude ? "text-orange-400" : "text-emerald-400"
            )}
        >
            {agent}
        </span>
    );
});
AgentBadge.displayName = "AgentBadge";

const SessionItem = memo(({ session, active }: { session: CliSessionEntry; active: boolean }) => {
    return (
        <div
            className={clsx(
                "flex flex-col gap-0.5 px-2 py-1.5 rounded-sm cursor-pointer hover:bg-hoverbg group border-l-2",
                active ? "bg-hoverbg/40 border-accent" : "border-transparent"
            )}
            onClick={() => openSession(session)}
            title={`${session.cwd}\n${session.sessionid}${active ? "\n(열림)" : ""}`}
        >
            <div className="flex items-center gap-1.5 overflow-hidden">
                {active && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
                <div
                    className={clsx(
                        "text-xs truncate group-hover:text-white",
                        active ? "text-white font-medium" : "text-white/90"
                    )}
                >
                    {session.title}
                </div>
            </div>
            <div className="flex items-center gap-1.5 overflow-hidden">
                <AgentBadge agent={session.agent} />
                <span className="text-[10px] text-secondary truncate">{baseName(session.cwd) || "미분류"}</span>
                <span className="text-[10px] text-muted ml-auto shrink-0">{relTime(session.mtime)}</span>
            </div>
        </div>
    );
});
SessionItem.displayName = "SessionItem";

const SessionSidebar = memo(() => {
    const [sessions, setSessions] = useState<CliSessionEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<AgentFilter>("all");
    const activeIds = useAtomValue(activeSessionIdsAtom);

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
    }, [load]);

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
            <div className="flex-grow overflow-y-auto overflow-x-hidden py-1">
                {loading ? (
                    <div className="flex justify-center py-4 text-muted">
                        <i className="fa fa-solid fa-spinner fa-spin" />
                    </div>
                ) : shown.length === 0 ? (
                    <div className="text-xs text-muted text-center py-4 px-2">세션 없음</div>
                ) : (
                    shown.map((s) => (
                        <SessionItem key={`${s.agent}:${s.filepath}`} session={s} active={activeIds.has(s.sessionid)} />
                    ))
                )}
            </div>
        </div>
    );
});
SessionSidebar.displayName = "SessionSidebar";

export { SessionSidebar };
