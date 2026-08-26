// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { continuesUrl } from "./termlinks";

describe("continuesUrl", () => {
    it("joins a URL the agent split mid-token", () => {
        // exactly what claude prints when a long console URL exceeds its own text width
        const prev = "  할당량 페이지 (직행) https://console.cloud.google.com/apis/api/youtube.googleapis";
        const next = "s.com/quotas?project=kkcms-499602";
        expect(continuesUrl(prev, next)).toBe(true);
    });

    it("joins when the tail row is only query characters", () => {
        expect(continuesUrl("see https://example.com/a/b?x=1&y", "=2#frag")).toBe(true);
    });

    it("leaves prose after a URL alone", () => {
        expect(continuesUrl("Fetch(https://github.com/jamiepine/voicebox)", "Received 447KB (200 OK)")).toBe(false);
        expect(continuesUrl("docs at https://docs.voicebox.sh", "Received 0 bytes")).toBe(false);
    });

    it("ignores rows that do not end inside a URL", () => {
        expect(continuesUrl("plain sentence ending here", "continuation")).toBe(false);
        expect(continuesUrl("", "s.com/quotas")).toBe(false);
        expect(continuesUrl("https://example.com", "")).toBe(false);
    });

    it("does not join a row that starts with a space", () => {
        expect(continuesUrl("https://example.com/very/long/pa", " th/continues")).toBe(false);
    });
});
