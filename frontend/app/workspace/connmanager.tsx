// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// SSH connection manager: a friendly form to add / list / remove SSH hosts,
// persisted to ~/.ssh/config (via wsh RPC). Clicking a host opens a remote
// terminal block on that connection.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { createBlock } from "@/store/global";
import { fireAndForget } from "@/util/util";
import clsx from "clsx";
import { atom, useAtom } from "jotai";
import { memo, useCallback, useEffect, useState } from "react";

export const connManagerOpenAtom = atom(false);

const EMPTY = { alias: "", hostname: "", user: "", port: "22", identityfile: "" };

function connectTo(alias: string) {
    const blockDef: BlockDef = {
        meta: {
            view: "term",
            connection: alias,
        },
    };
    fireAndForget(() => createBlock(blockDef));
}

export const ConnManagerModal = memo(() => {
    const [open, setOpen] = useAtom(connManagerOpenAtom);
    const [hosts, setHosts] = useState<SshHostEntry[]>([]);
    const [form, setForm] = useState({ ...EMPTY });
    const [err, setErr] = useState("");

    const load = useCallback(() => {
        fireAndForget(async () => {
            try {
                const list = await RpcApi.GetSshHostsCommand(TabRpcClient);
                setHosts(list ?? []);
            } catch (e) {
                console.error("GetSshHosts failed", e);
                setHosts([]);
            }
        });
    }, []);

    useEffect(() => {
        if (open) {
            load();
            setForm({ ...EMPTY });
            setErr("");
        }
    }, [open, load]);

    if (!open) return null;

    const save = () => {
        if (!form.alias.trim() || !form.hostname.trim()) {
            setErr("이름과 호스트/IP는 필수");
            return;
        }
        fireAndForget(async () => {
            try {
                await RpcApi.SetSshHostCommand(TabRpcClient, {
                    alias: form.alias.trim(),
                    hostname: form.hostname.trim(),
                    user: form.user.trim(),
                    port: form.port.trim(),
                    identityfile: form.identityfile.trim(),
                    managed: true,
                });
                setForm({ ...EMPTY });
                setErr("");
                load();
            } catch (e) {
                setErr(String(e));
            }
        });
    };

    const del = (alias: string) => {
        fireAndForget(async () => {
            try {
                await RpcApi.DeleteSshHostCommand(TabRpcClient, alias);
                load();
            } catch (e) {
                console.error("DeleteSshHost failed", e);
            }
        });
    };

    const field = (key: keyof typeof EMPTY, label: string, placeholder: string) => (
        <div className="flex-1 min-w-0">
            <label className="block text-[10px] text-muted mb-1">{label}</label>
            <input
                className="w-full text-xs bg-black/40 text-white rounded-sm px-2 py-1.5 outline-none border border-border focus:border-accent"
                placeholder={placeholder}
                value={form[key]}
                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                onKeyDown={(e) => {
                    if (e.key === "Enter") save();
                    else if (e.key === "Escape") setOpen(false);
                }}
            />
        </div>
    );

    return (
        <div
            className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50"
            onClick={() => setOpen(false)}
        >
            <div
                className="w-[480px] max-w-[92vw] max-h-[84vh] flex flex-col bg-modalbg border border-border rounded-lg shadow-2xl overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
                    <i className="fa fa-solid fa-network-wired text-accent text-xs" />
                    <span className="text-sm font-semibold text-white">SSH 커넥션</span>
                    <button
                        type="button"
                        className="ml-auto text-secondary hover:text-white cursor-pointer"
                        onClick={() => setOpen(false)}
                    >
                        <i className="fa fa-solid fa-xmark" />
                    </button>
                </div>

                {/* form */}
                <div className="px-4 py-3 border-b border-border">
                    <div className="flex gap-2">
                        {field("alias", "이름 (별칭)", "집 윈도우")}
                    </div>
                    <div className="flex gap-2 mt-2">
                        {field("hostname", "호스트 / IP", "192.168.0.30")}
                        <div className="w-20 shrink-0">
                            <label className="block text-[10px] text-muted mb-1">포트</label>
                            <input
                                className="w-full text-xs bg-black/40 text-white rounded-sm px-2 py-1.5 outline-none border border-border focus:border-accent"
                                value={form.port}
                                onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))}
                            />
                        </div>
                    </div>
                    <div className="flex gap-2 mt-2">
                        {field("user", "사용자", "kkpd04")}
                        {field("identityfile", "키 파일 (선택)", "~/.ssh/id_ed25519")}
                    </div>
                    {err && <div className="text-[11px] text-red-400 mt-2">{err}</div>}
                    <button
                        type="button"
                        className="mt-3 w-full text-xs font-semibold bg-accent text-black rounded-sm py-1.5 cursor-pointer hover:brightness-110 transition-colors"
                        onClick={save}
                    >
                        ＋ 커넥션 저장
                    </button>
                </div>

                {/* saved list */}
                <div className="flex-1 overflow-y-auto session-scroll px-3 py-2">
                    <div className="text-[10px] text-muted uppercase tracking-wide px-1 mb-1.5">저장된 커넥션</div>
                    {hosts.length === 0 ? (
                        <div className="text-xs text-muted text-center py-4">없음 — 위에서 추가</div>
                    ) : (
                        hosts.map((h) => (
                            <div
                                key={h.alias}
                                className="flex items-center gap-2 px-2 py-2 rounded-md border border-white/10 bg-white/[0.035] hover:bg-white/[0.08] mb-1.5 transition-colors"
                            >
                                <i className="fa fa-solid fa-server text-[11px] text-secondary shrink-0" />
                                <div className="min-w-0 flex-1">
                                    <div className="text-xs text-white truncate">{h.alias}</div>
                                    <div className="text-[10px] text-muted truncate">
                                        {h.user ? `${h.user}@` : ""}
                                        {h.hostname}
                                        {h.port && h.port !== "22" ? `:${h.port}` : ""}
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    className="text-[11px] text-accent hover:underline cursor-pointer shrink-0"
                                    onClick={() => {
                                        connectTo(h.alias);
                                        setOpen(false);
                                    }}
                                >
                                    접속
                                </button>
                                {h.managed && (
                                    <button
                                        type="button"
                                        className={clsx(
                                            "text-[11px] text-secondary hover:text-red-400 cursor-pointer shrink-0"
                                        )}
                                        title="삭제"
                                        onClick={() => del(h.alias)}
                                    >
                                        <i className="fa fa-solid fa-trash" />
                                    </button>
                                )}
                            </div>
                        ))
                    )}
                    <div className="text-[10px] text-muted mt-2 px-1 leading-relaxed">
                        저장 = <span className="text-accent">~/.ssh/config</span>. 손으로 쓴 항목도 목록에 뜨지만 삭제는
                        NewWave가 추가한 것만 가능.
                    </div>
                </div>
            </div>
        </div>
    );
});
ConnManagerModal.displayName = "ConnManagerModal";
