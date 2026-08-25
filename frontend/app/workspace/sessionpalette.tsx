// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Jump palette: one keystroke away from the session that finished while you were elsewhere.
// Opens centered with the search field focused; the list starts on sessions waiting for an
// answer and widens to every session as soon as you type (or flip the scope chip).

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import clsx from "clsx";
import { useAtom, useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentIcon, openSession } from "./sessionsidebar";
import { clearSessionAttention, sessionAttentionAtom, sessionPaletteOpenAtom, sessionWorkingAtom } from "./sidebaratoms";

type Scope = "waiting" | "all";

function label(s: CliSessionEntry): string {
    return s.alias || s.title || s.sessionid;
}

function shortCwd(cwd: string): string {
    if (!cwd) return "";
    const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.length <= 2 ? cwd.replace(/\\/g, "/") : "…/" + parts.slice(-2).join("/");
}

export const SessionPalette = memo(() => {
    const [open, setOpen] = useAtom(sessionPaletteOpenAtom);
    const attention = useAtomValue(sessionAttentionAtom);
    const working = useAtomValue(sessionWorkingAtom);
    const [sessions, setSessions] = useState<CliSessionEntry[]>([]);
    const [query, setQuery] = useState("");
    const [scope, setScope] = useState<Scope>("waiting");
    const [idx, setIdx] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        setQuery("");
        setIdx(0);
        setScope("waiting");
        fireAndForget(async () => {
            try {
                setSessions((await RpcApi.GetCliSessionsCommand(TabRpcClient)) ?? []);
            } catch (e) {
                console.error("palette: could not load sessions", e);
            }
        });
        // the input mounts with the palette, so focus on the next frame
        requestAnimationFrame(() => inputRef.current?.focus());
    }, [open]);

    const q = query.trim().toLowerCase();
    const shown = useMemo(() => {
        // typing always searches everything — a waiting-only list you can't escape is a trap
        const wantAll = scope === "all" || q.length > 0;
        const list = sessions.filter((s) => {
            if (!wantAll && !attention.has(s.sessionid)) return false;
            if (!q) return true;
            return `${s.alias ?? ""} ${s.title ?? ""} ${s.cwd ?? ""}`.toLowerCase().includes(q);
        });
        // waiting first, then most recent
        return list
            .sort((a, b) => {
                const aw = attention.has(a.sessionid) ? 0 : 1;
                const bw = attention.has(b.sessionid) ? 0 : 1;
                return aw !== bw ? aw - bw : b.mtime - a.mtime;
            })
            .slice(0, 50);
    }, [sessions, attention, q, scope]);

    const waitingCount = useMemo(
        () => sessions.filter((s) => attention.has(s.sessionid)).length,
        [sessions, attention]
    );

    const choose = useCallback(
        (s: CliSessionEntry | undefined) => {
            if (!s) return;
            clearSessionAttention(s.sessionid);
            openSession(s);
            setOpen(false);
        },
        [setOpen]
    );

    // keep the highlighted row in view while arrowing through a long list
    useEffect(() => {
        const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${idx}"]`);
        el?.scrollIntoView({ block: "nearest" });
    }, [idx]);

    if (!open) return null;

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setIdx((i) => Math.min(i + 1, shown.length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIdx((i) => Math.max(i - 1, 0));
        } else if (e.key === "Enter") {
            e.preventDefault();
            choose(shown[idx]);
        } else if (e.key === "Tab") {
            e.preventDefault();
            setScope((s) => (s === "waiting" ? "all" : "waiting"));
            setIdx(0);
        }
    };

    return (
        <div
            className="fixed inset-0 z-[1000] flex items-start justify-center bg-black/40 pt-[12vh]"
            onMouseDown={() => setOpen(false)}
        >
            <div
                className="w-[560px] max-w-[90vw] rounded-lg border border-border bg-modalbg shadow-2xl overflow-hidden"
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
                    <i className="fa fa-solid fa-bolt text-accent text-[11px]" />
                    <input
                        ref={inputRef}
                        value={query}
                        placeholder="세션 검색"
                        className="flex-1 bg-transparent text-sm text-white outline-none"
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setIdx(0);
                        }}
                        onKeyDown={onKeyDown}
                    />
                    <div className="flex gap-0.5 shrink-0">
                        {(["waiting", "all"] as Scope[]).map((s) => (
                            <button
                                key={s}
                                type="button"
                                className={clsx(
                                    "text-[11px] px-1.5 py-0.5 rounded-sm cursor-pointer",
                                    scope === s ? "bg-hoverbg text-white" : "text-secondary hover:text-white"
                                )}
                                onClick={() => {
                                    setScope(s);
                                    setIdx(0);
                                    inputRef.current?.focus();
                                }}
                                style={{ whiteSpace: "nowrap" }}
                            >
                                {s === "waiting" ? `대기 ${waitingCount}` : "전체"}
                            </button>
                        ))}
                    </div>
                </div>
                <div ref={listRef} className="max-h-[45vh] overflow-y-auto py-1">
                    {shown.length === 0 ? (
                        <div className="px-3 py-6 text-center text-xs text-muted">
                            {q ? "검색 결과 없음" : "대기 중인 세션 없음"}
                        </div>
                    ) : (
                        shown.map((s, i) => (
                            <div
                                key={s.sessionid}
                                data-idx={i}
                                className={clsx(
                                    "flex items-center gap-2 px-3 py-1.5 cursor-pointer",
                                    i === idx ? "bg-accent/15" : "hover:bg-hoverbg"
                                )}
                                onMouseEnter={() => setIdx(i)}
                                onClick={() => choose(s)}
                            >
                                {attention.has(s.sessionid) ? (
                                    <i className="fa fa-solid fa-circle text-accent text-[7px] shrink-0" />
                                ) : working.has(s.sessionid) ? (
                                    <i className="fa fa-solid fa-spinner fa-spin text-secondary text-[9px] shrink-0" />
                                ) : (
                                    <i className="fa fa-solid fa-circle text-white/15 text-[7px] shrink-0" />
                                )}
                                <AgentIcon agent={s.agent} />
                                <div className="min-w-0 flex-1">
                                    <div className="text-xs text-white truncate">{label(s)}</div>
                                    {s.lastmsg && (
                                        <div className="text-[10px] text-muted truncate leading-tight">
                                            {s.lastrole === "user" ? "나 " : "AI "}
                                            {s.lastmsg}
                                        </div>
                                    )}
                                </div>
                                <span className="text-[10px] text-muted shrink-0" style={{ whiteSpace: "nowrap" }}>
                                    {shortCwd(s.cwd)}
                                </span>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
});

SessionPalette.displayName = "SessionPalette";
