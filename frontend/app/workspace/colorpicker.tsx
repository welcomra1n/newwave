// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Color picker for session / block title colors. The context menus can only list presets,
// so anything outside that list needed a code edit — this adds the full picker (swatches,
// the OS color area, and a hex field) behind one menu entry.

import { globalStore } from "@/app/store/jotaiStore";
import clsx from "clsx";
import { atom, useAtom, type PrimitiveAtom } from "jotai";
import { memo, useEffect, useState } from "react";

export type ColorPickerRequest = {
    title: string;
    current: string | null;
    apply: (color: string | null) => void;
};

const colorPickerRequestAtom = atom(null) as PrimitiveAtom<ColorPickerRequest | null>;

export function openColorPicker(req: ColorPickerRequest) {
    globalStore.set(colorPickerRequestAtom, req);
}

// Swatches worth one click. Anything else goes through the color area or the hex field.
const SWATCHES = [
    "#e11d1d",
    "#ff6a00",
    "#f5b400",
    "#16a34a",
    "#33ff33",
    "#0891b2",
    "#2563eb",
    "#9333ea",
    "#e11d74",
    "#4b5563",
    "#111827",
    "#f5f5f5",
];

const HEX_RE = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function normalizeHex(value: string): string | null {
    const m = value.trim().match(HEX_RE);
    if (!m) return null;
    const body = m[1];
    const full = body.length === 3 ? body.replace(/./g, (c) => c + c) : body;
    return "#" + full.toLowerCase();
}

export const ColorPickerModal = memo(() => {
    const [req, setReq] = useAtom(colorPickerRequestAtom);
    const [draft, setDraft] = useState("#33ff33");
    const [hexText, setHexText] = useState("#33ff33");

    useEffect(() => {
        if (!req) return;
        const start = normalizeHex(req.current ?? "") ?? "#33ff33";
        setDraft(start);
        setHexText(start);
    }, [req]);

    if (!req) return null;

    const close = () => setReq(null);
    const commit = (color: string | null) => {
        req.apply(color);
        close();
    };
    const pick = (color: string) => {
        setDraft(color);
        setHexText(color);
    };

    return (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40" onMouseDown={close}>
            <div
                className="w-[300px] rounded-lg border border-border bg-modalbg shadow-2xl p-3"
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="text-xs font-semibold text-white/80 mb-2" style={{ whiteSpace: "nowrap" }}>
                    {req.title}
                </div>
                <div className="grid grid-cols-6 gap-1.5 mb-2.5">
                    {SWATCHES.map((c) => (
                        <button
                            key={c}
                            type="button"
                            title={c}
                            onClick={() => pick(c)}
                            className={clsx(
                                "h-6 rounded-sm cursor-pointer border",
                                draft === c ? "border-accent" : "border-white/10 hover:border-white/40"
                            )}
                            style={{ background: c }}
                        />
                    ))}
                </div>
                <div className="flex items-center gap-2 mb-3">
                    <input
                        type="color"
                        value={draft}
                        onChange={(e) => pick(e.target.value)}
                        className="w-9 h-8 bg-transparent border border-border rounded-sm cursor-pointer p-0"
                    />
                    <input
                        value={hexText}
                        onChange={(e) => {
                            setHexText(e.target.value);
                            const hex = normalizeHex(e.target.value);
                            if (hex) setDraft(hex);
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") commit(normalizeHex(hexText) ?? draft);
                            else if (e.key === "Escape") close();
                        }}
                        spellCheck={false}
                        className={clsx(
                            "flex-1 min-w-0 text-xs bg-black/40 text-white rounded-sm px-2 py-1 outline-none border",
                            normalizeHex(hexText) ? "border-border focus:border-accent" : "border-red-500"
                        )}
                    />
                    <span className="w-8 h-8 rounded-sm border border-white/10 shrink-0" style={{ background: draft }} />
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        className="text-[11px] text-secondary hover:text-white cursor-pointer"
                        onClick={() => commit(null)}
                        style={{ whiteSpace: "nowrap" }}
                    >
                        없음
                    </button>
                    <button
                        type="button"
                        className="ml-auto text-[11px] text-secondary hover:text-white cursor-pointer"
                        onClick={close}
                        style={{ whiteSpace: "nowrap" }}
                    >
                        취소
                    </button>
                    <button
                        type="button"
                        className="text-[11px] bg-accent text-black font-semibold rounded-sm px-2.5 py-1 cursor-pointer hover:brightness-110"
                        onClick={() => commit(normalizeHex(hexText) ?? draft)}
                        style={{ whiteSpace: "nowrap" }}
                    >
                        적용
                    </button>
                </div>
            </div>
        </div>
    );
});

ColorPickerModal.displayName = "ColorPickerModal";
