// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// One click, one browser window — and the URL arrives intact. Both were reported as bugs
// (two browsers for one link; a quoted URL opening a search page), so they are pinned here.

import { describe, expect, it } from "vitest";
import { admitExternalOpen, cleanExternalUrl, EXTERNAL_DEDUPE_MS } from "./externalopen";

describe("cleanExternalUrl", () => {
    it("strips wrapping quotes and brackets", () => {
        expect(cleanExternalUrl('"https://example.com/a"')).toBe("https://example.com/a");
        expect(cleanExternalUrl("(https://example.com/a)")).toBe("https://example.com/a");
        expect(cleanExternalUrl("<https://example.com/a>")).toBe("https://example.com/a");
    });

    it("drops sentence punctuation that trailed the link", () => {
        expect(cleanExternalUrl("https://example.com/a.")).toBe("https://example.com/a");
        expect(cleanExternalUrl("https://example.com/a,")).toBe("https://example.com/a");
    });

    it("leaves a normal URL alone, including its query", () => {
        const url = "https://console.cloud.google.com/apis/api/x.com/quotas?project=kk-499602";
        expect(cleanExternalUrl(url)).toBe(url);
    });
});

describe("admitExternalOpen", () => {
    it("admits the first request", () => {
        expect(admitExternalOpen(null, "https://a.example", 1000)).toEqual({ url: "https://a.example", ts: 1000 });
    });

    it("ignores the same URL arriving again right after", () => {
        const gate = { url: "https://a.example", ts: 1000 };
        expect(admitExternalOpen(gate, "https://a.example", 1200)).toBe(null);
        expect(admitExternalOpen(gate, "https://a.example", 1000 + EXTERNAL_DEDUPE_MS - 1)).toBe(null);
    });

    it("admits the same URL once the window has passed", () => {
        const gate = { url: "https://a.example", ts: 1000 };
        expect(admitExternalOpen(gate, "https://a.example", 1000 + EXTERNAL_DEDUPE_MS)).toEqual({
            url: "https://a.example",
            ts: 1000 + EXTERNAL_DEDUPE_MS,
        });
    });

    it("never blocks a different URL", () => {
        const gate = { url: "https://a.example", ts: 1000 };
        expect(admitExternalOpen(gate, "https://b.example", 1001)).toEqual({ url: "https://b.example", ts: 1001 });
    });
});
