// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Color picker for session / block title colors. The context menus can only list presets,
// so anything outside that list needed a code edit — this adds the full picker (swatches,
// the OS color area, and a hex field) behind one menu entry.

import { globalStore } from "@/app/store/jotaiStore";
import clsx from "clsx";
import { atom, useAtom, type PrimitiveAtom } from "jotai";
import { memo, useEffect, useRef, useState } from "react";

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

// --- HSV <-> hex, for the saturation/value square and the hue rail ---

type Hsv = { h: number; s: number; v: number };

function hexToHsv(hex: string): Hsv {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hsvToHex({ h, s, v }: Hsv): string {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    const seg = Math.floor(h / 60) % 6;
    const [r, g, b] = [
        [c, x, 0],
        [x, c, 0],
        [0, c, x],
        [0, x, c],
        [x, 0, c],
        [c, 0, x],
    ][seg];
    const to255 = (val: number) =>
        Math.round((val + m) * 255)
            .toString(16)
            .padStart(2, "0");
    return `#${to255(r)}${to255(g)}${to255(b)}`;
}

// pointer position -> 0..1 within an element, clamped
function ratioFromEvent(e: React.PointerEvent | PointerEvent, el: HTMLElement): { x: number; y: number } {
    const rect = el.getBoundingClientRect();
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    return { x: clamp((e.clientX - rect.left) / rect.width), y: clamp((e.clientY - rect.top) / rect.height) };
}

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
    // hue is kept separately: a fully black/white color has no hue of its own, and reading it
    // back from the hex would snap the rail to red every time you drag to a corner
    const [hsv, setHsv] = useState<Hsv>(() => hexToHsv("#33ff33"));
    const svRef = useRef<HTMLDivElement>(null);
    const hueRef = useRef<HTMLDivElement>(null);
    const eyedropperSupported = typeof (window as any).EyeDropper === "function";

    useEffect(() => {
        if (!req) return;
        const start = normalizeHex(req.current ?? "") ?? "#33ff33";
        setDraft(start);
        setHexText(start);
        setHsv(hexToHsv(start));
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
        setHsv(hexToHsv(color));
    };
    const applyHsv = (next: Hsv) => {
        setHsv(next);
        const hex = hsvToHex(next);
        setDraft(hex);
        setHexText(hex);
    };
    const dragSv = (e: React.PointerEvent) => {
        if (!svRef.current) return;
        const { x, y } = ratioFromEvent(e, svRef.current);
        applyHsv({ h: hsv.h, s: x, v: 1 - y });
    };
    const dragHue = (e: React.PointerEvent) => {
        if (!hueRef.current) return;
        const { x } = ratioFromEvent(e, hueRef.current);
        applyHsv({ ...hsv, h: x * 360 });
    };
    const pickFromScreen = () => {
        const Dropper = (window as any).EyeDropper;
        if (!Dropper) return;
        new Dropper()
            .open()
            .then((res: { sRGBHex: string }) => {
                const hex = normalizeHex(res.sRGBHex);
                if (hex) pick(hex);
            })
            .catch(() => {
                // user cancelled
            });
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
                {/* saturation / value square — drag anywhere, like the Photoshop picker */}
                <div
                    ref={svRef}
                    className="relative h-[120px] rounded-sm mb-2 cursor-crosshair select-none"
                    style={{
                        background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`,
                    }}
                    onPointerDown={(e) => {
                        e.currentTarget.setPointerCapture(e.pointerId);
                        dragSv(e);
                    }}
                    onPointerMove={(e) => e.buttons === 1 && dragSv(e)}
                >
                    <span
                        className="absolute w-3 h-3 -ml-1.5 -mt-1.5 rounded-full border-2 border-white pointer-events-none"
                        style={{
                            left: `${hsv.s * 100}%`,
                            top: `${(1 - hsv.v) * 100}%`,
                            boxShadow: "0 0 0 1px rgba(0,0,0,0.6)",
                        }}
                    />
                </div>
                {/* hue rail */}
                <div
                    ref={hueRef}
                    className="relative h-3 rounded-sm mb-2.5 cursor-ew-resize select-none"
                    style={{
                        background:
                            "linear-gradient(to right, #f00, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00)",
                    }}
                    onPointerDown={(e) => {
                        e.currentTarget.setPointerCapture(e.pointerId);
                        dragHue(e);
                    }}
                    onPointerMove={(e) => e.buttons === 1 && dragHue(e)}
                >
                    <span
                        className="absolute top-1/2 w-3 h-3 -ml-1.5 -mt-1.5 rounded-full border-2 border-white pointer-events-none"
                        style={{ left: `${(hsv.h / 360) * 100}%`, boxShadow: "0 0 0 1px rgba(0,0,0,0.6)" }}
                    />
                </div>
                <div className="flex items-center gap-2 mb-3">
                    {eyedropperSupported && (
                        <button
                            type="button"
                            title="화면에서 색 집기"
                            className="w-8 h-8 shrink-0 rounded-sm border border-border text-secondary hover:text-white cursor-pointer"
                            onClick={pickFromScreen}
                        >
                            <i className="fa fa-solid fa-eye-dropper text-[11px]" />
                        </button>
                    )}
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
