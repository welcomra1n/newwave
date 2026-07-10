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
import { atom, useAtom, useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import "./sessionsidebar.css";

// persisted-ish toggle (module-level; resets on full reload, fine for v1)
export const sessionSidebarVisibleAtom = atom(true);
export const sessionSidebarWidthAtom = atom(240);
export const sessionSidebarCollapsedAtom = atom(false);

const SIDEBAR_MIN_W = 170;
const SIDEBAR_MAX_W = 460;

// Bump to make the sidebar reload its session list (e.g. after a rename made
// from the block header). Cross-component refresh signal.
export const sessionListVersionAtom = atom(0);
export function bumpSessionList() {
    globalStore.set(sessionListVersionAtom, (v) => v + 1);
}

// Session ids whose agent finished a turn (terminal bell) and want attention.
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

// Short two-note "done" chime via Web Audio (no asset needed).
export function playDoneSound() {
    try {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new Ctx();
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
        play(784, 0, 0.15); // G5
        play(1047, 0.13, 0.22); // C6
        setTimeout(() => ctx.close(), 600);
    } catch {
        // audio best-effort
    }
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
    clearSessionAttention(s.sessionid); // opening = acknowledged
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

async function assignProject(sessionid: string, project: string) {
    await RpcApi.SetCliSessionMetaCommand(TabRpcClient, { sessionid, project });
}

async function saveProjects(list: string[]) {
    await RpcApi.SetCliProjectsCommand(TabRpcClient, list);
}

const UNGROUPED = "__ungrouped__";

const SessionItem = memo(
    ({
        session,
        active,
        done,
        working,
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
                // close the open block for this session (if any), then remove the file
                const blockId = findOpenBlockId(session.sessionid);
                await deleteSession(session.filepath);
                if (blockId) uxCloseBlock(blockId);
                onChanged();
            });
        }, [session.filepath, session.sessionid, onChanged]);

        const setProject = useCallback(
            (p: string) => {
                fireAndForget(async () => {
                    await assignProject(session.sessionid, p);
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
                const menu: ContextMenuItem[] = [
                    { label: "이름 변경", click: startRename },
                    { label: session.pinned ? "고정 해제" : "상단 고정", click: togglePin },
                    { label: "폴더로 이동", submenu: projectMenu },
                    { type: "separator" },
                    { label: "삭제 (휴지통)", click: doDelete },
                ];
                ContextMenuModel.getInstance().showContextMenu(menu, e);
            },
            [session.pinned, session.project, projects, startRename, togglePin, doDelete, setProject]
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
                    "flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer group overflow-hidden bg-white/[0.035] hover:bg-white/[0.08]",
                    active ? "border-2 session-active-radar" : "border border-white/10 hover:border-white/20",
                    selected && "ring-2 ring-accent ring-inset"
                )}
                style={
                    active
                        ? ({
                              borderColor: session.color || "var(--color-accent)",
                              boxShadow: `0 0 7px -1px ${session.color || "var(--color-accent)"}`,
                              "--sweep-color": `color-mix(in srgb, ${session.color || "var(--color-accent)"} 32%, transparent)`,
                          } as React.CSSProperties)
                        : undefined
                }
                onClick={(e) => {
                    if (editing) return;
                    if (e.ctrlKey || e.metaKey) {
                        onToggleSelect(session.sessionid);
                        return;
                    }
                    openSession(session);
                }}
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
                {working ? (
                    <i className="fa fa-solid fa-spinner fa-spin text-[10px] text-accent shrink-0" title="작업 중" />
                ) : done ? (
                    <span
                        className="text-accent font-bold text-sm leading-none shrink-0 animate-pulse"
                        title="답변 필요"
                    >
                        *
                    </span>
                ) : null}
                <span className="text-[10px] text-muted shrink-0">{relTime(session.mtime)}</span>
            </div>
        );
    }
);
SessionItem.displayName = "SessionItem";

const SessionSidebar = memo(() => {
    const [sessions, setSessions] = useState<CliSessionEntry[]>([]);
    const [projects, setProjects] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<AgentFilter>("all");
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

    const shown = sessions.filter((s) => filter === "all" || s.agent === filter);
    const showPanel = !collapsed || hovering;
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
    const renderItems = (items: CliSessionEntry[]) =>
        items.map((s) => (
            <SessionItem
                key={`${s.agent}:${s.filepath}`}
                session={s}
                active={activeIds.has(s.sessionid)}
                done={attention.has(s.sessionid)}
                working={working.has(s.sessionid)}
                projects={projects}
                selected={selected.has(s.sessionid)}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                onChanged={load}
            />
        ));

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
                    title={collapsed ? "고정 펼치기" : "접기"}
                    onClick={() => {
                        setCollapsed(!collapsed);
                        setHovering(false);
                    }}
                >
                    <i className={clsx("fa fa-solid", collapsed ? "fa-angles-right" : "fa-angles-left")} />
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
                        {f === "all" ? "전체" : f} <span className="opacity-60">{counts[f]}</span>
                    </button>
                ))}
            </div>
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
                        className="text-[11px] text-secondary hover:text-white cursor-pointer"
                        onClick={() => setSelected(new Set())}
                    >
                        해제
                    </button>
                </div>
            )}
            <div className="flex-grow overflow-y-auto overflow-x-hidden px-1.5 py-1.5">
                {loading ? (
                    <div className="flex justify-center py-4 text-muted">
                        <i className="fa fa-solid fa-spinner fa-spin" />
                    </div>
                ) : shown.length === 0 && projects.length === 0 ? (
                    <div className="text-xs text-muted text-center py-4 px-2">세션 없음</div>
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
        </div>
    );

    return (
        <div
            className="relative h-full shrink-0 select-none"
            style={{ width: showPanel ? width : 6 }}
            onMouseLeave={() => setHovering(false)}
        >
            {collapsed && !hovering ? (
                <div
                    className="h-full w-1.5 bg-modalbg border-r border-border hover:bg-accent/40 cursor-pointer transition-colors"
                    title="세션 — 마우스를 올리면 펼쳐집니다"
                    onMouseEnter={() => setHovering(true)}
                />
            ) : (
                <div
                    className={clsx("relative h-full border-r border-border", collapsed && "absolute left-0 top-0 z-50 shadow-2xl")}
                    style={{ width }}
                    onMouseEnter={() => collapsed && setHovering(true)}
                >
                    {panel}
                    {/* resize handle — sits above everything on the right edge */}
                    <div
                        className="absolute top-0 right-0 h-full w-2 cursor-ew-resize hover:bg-accent/60 z-[60]"
                        onMouseDown={startResize}
                    />
                </div>
            )}
        </div>
    );
});
SessionSidebar.displayName = "SessionSidebar";

export { SessionSidebar };
