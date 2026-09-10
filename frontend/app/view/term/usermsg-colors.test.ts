// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// A setting that isn't a valid CSS color used to erase the message box fill and leave the
// edges hanging on their own. These pin the recovery.

import { describe, expect, it } from "vitest";
import { normalizeColor, userMsgVars } from "./usermsg-colors";

describe("normalizeColor", () => {
    it("accepts hex that is missing its #", () => {
        expect(normalizeColor("33ff33")).toBe("#33ff33");
        expect(normalizeColor("000000")).toBe("#000000");
    });

    it("keeps valid values as they are", () => {
        expect(normalizeColor("#1e90ff")).toBe("#1e90ff");
        expect(normalizeColor("rgba(0, 0, 0, 0.5)")).toBe("rgba(0, 0, 0, 0.5)");
    });

    it("rejects what is not a color", () => {
        expect(normalizeColor("")).toBe(null);
        expect(normalizeColor("green-ish")).toBe(null);
        expect(normalizeColor(undefined)).toBe(null);
    });
});

describe("userMsgVars", () => {
    it("always produces a usable fill, even from a bad setting", () => {
        const vars = userMsgVars("nonsense", null);
        expect(vars["--nw-usermsg-bg"]).toBe("rgba(51, 255, 51, 0.13)");
    });

    it("does not obey a black fill, which would hide the box entirely", () => {
        expect(userMsgVars("000000", "#33ff33")["--nw-usermsg-bg"]).toBe("rgba(51, 255, 51, 0.13)");
    });

    it("honors a real background choice", () => {
        expect(userMsgVars("#203040", "#33ff33")["--nw-usermsg-bg"]).toBe("#203040");
    });

    it("tints the fill with the chosen text color when no background is set", () => {
        expect(userMsgVars(null, "#1e90ff")["--nw-usermsg-bg"]).toBe("rgba(30, 144, 255, 0.13)");
    });

    it("outlines the bubble in the accent color", () => {
        expect(userMsgVars(null, "#1e90ff")["--nw-usermsg-edge"]).toBe("rgba(30, 144, 255, 0.4)");
    });

    it("only sets the text color var when the user actually chose one", () => {
        expect(userMsgVars(null, null)["--nw-usermsg-fg"]).toBeUndefined();
        expect(userMsgVars(null, "#1e90ff")["--nw-usermsg-fg"]).toBe("#1e90ff");
    });
});
