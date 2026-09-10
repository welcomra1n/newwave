// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Turns the two user-facing settings (term:usermsgbg, term:usermsgcolor) into the CSS
// variables the conversation boxes are painted with.
//
// This exists because a hand-typed "000000" (no leading #) is not a CSS color: dropped
// straight into `background-color: var(--nw-usermsg-bg, ...)` it makes the declaration
// invalid, the fallback never runs, and the box loses its fill — leaving only the edge
// lines floating on the terminal background. That shipped once and looked like dirt.

const HEX_RE = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNC_RE = /^(?:rgb|rgba|hsl|hsla|color)\(/i;

// Adds the missing "#" and rejects anything we cannot vouch for. Returning null (rather
// than passing the value through) is what keeps a bad setting from erasing the fill.
export function normalizeColor(value: string | null | undefined): string | null {
    if (!value) return null;
    const v = value.trim();
    if (v === "") return null;
    if (FUNC_RE.test(v)) return v;
    const m = HEX_RE.exec(v);
    if (m) return "#" + m[1];
    return null;
}

function hexToRgb(hex: string): [number, number, number] | null {
    const m = HEX_RE.exec(hex);
    if (!m) return null;
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).replace(/./g, (c) => c + c);
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function tint(hex: string, alpha: number): string | null {
    const rgb = hexToRgb(hex);
    if (!rgb) return null;
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

// A fill that matches the terminal's own black is the same as having no box at all, so a
// near-black setting is read as "just tint it with my accent color" instead of obeying it
// literally and showing nothing.
function isNearBlack(hex: string): boolean {
    const rgb = hexToRgb(hex);
    return rgb != null && rgb[0] + rgb[1] + rgb[2] <= 24;
}

const DEFAULT_ACCENT = "#33ff33";
const FILL_ALPHA = 0.13;
const EDGE_ALPHA = 0.4;

export function userMsgVars(
    bgSetting: string | null | undefined,
    colorSetting: string | null | undefined
): Record<string, string> {
    const vars: Record<string, string> = {};
    const accent = normalizeColor(colorSetting) ?? DEFAULT_ACCENT;
    const bg = normalizeColor(bgSetting);
    const fill = bg != null && !isNearBlack(bg) ? bg : (tint(accent, FILL_ALPHA) ?? tint(DEFAULT_ACCENT, FILL_ALPHA));
    if (fill) vars["--nw-usermsg-bg"] = fill;
    const normColor = normalizeColor(colorSetting);
    if (normColor) vars["--nw-usermsg-fg"] = normColor;
    const edge = tint(accent, EDGE_ALPHA);
    if (edge) vars["--nw-usermsg-edge"] = edge;
    return vars;
}
