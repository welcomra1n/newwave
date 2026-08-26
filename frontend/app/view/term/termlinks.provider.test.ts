// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Drives the real link provider against a fake xterm buffer, so the two-row join is verified
// end to end (what the user clicks) rather than only at the helper level.

import type { ILink, Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { registerTermLinkProvider } from "./termlinks";

type Row = { text: string; isWrapped?: boolean };

// Minimal stand-in for the parts of Terminal the provider touches.
function makeTerm(rows: Row[], cols = 120): { term: Terminal; getLinks: (viewportRow: number) => ILink[] } {
    let provider: any = null;
    const term = {
        cols,
        buffer: {
            active: {
                viewportY: 0,
                getLine(idx: number) {
                    const row = rows[idx];
                    if (!row) return undefined;
                    return {
                        isWrapped: row.isWrapped ?? false,
                        // trimRight=true is what the provider asks for; the padded form is only
                        // used by the old width check, so returning the same text is fine
                        translateToString: (_trimRight?: boolean) => row.text,
                    };
                },
            },
        },
        registerLinkProvider(p: any) {
            provider = p;
            return { dispose: () => {} };
        },
    } as unknown as Terminal;

    registerTermLinkProvider(term, { activate: () => {} });

    return {
        term,
        getLinks(viewportRow: number) {
            let out: ILink[] = [];
            provider.provideLinks(viewportRow, (links: ILink[] | undefined) => {
                out = links ?? [];
            });
            return out;
        },
    };
}

describe("term link provider", () => {
    const splitRows: Row[] = [
        { text: "  할당량 페이지 (직행)" },
        { text: "https://console.cloud.google.com/apis/api/youtube.googleapi" },
        { text: "s.com/quotas?project=kkcms-499602" },
        { text: "" },
        { text: "- Queries per day 행의 한도(Limit)" },
    ];

    it("returns the whole URL from the row it starts on", () => {
        const { getLinks } = makeTerm(splitRows);
        const links = getLinks(2); // 1-based viewport row -> buffer index 1
        expect(links).toHaveLength(1);
        expect(links[0].text).toBe(
            "https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas?project=kkcms-499602"
        );
        // the range must cover both rows, otherwise the tail half stays unclickable
        expect(links[0].range.start.y).toBe(2);
        expect(links[0].range.end.y).toBe(3);
    });

    it("returns the same whole URL when clicking the second row", () => {
        const { getLinks } = makeTerm(splitRows);
        const links = getLinks(3);
        expect(links).toHaveLength(1);
        expect(links[0].text).toContain("quotas?project=kkcms-499602");
        expect(links[0].range.start.y).toBe(2);
    });

    it("keeps a single-row URL intact and skips the prose that follows", () => {
        const { getLinks } = makeTerm([
            { text: "Fetch(https://github.com/jamiepine/voicebox)" },
            { text: "Received 447KB (200 OK)" },
        ]);
        const links = getLinks(1);
        expect(links).toHaveLength(1);
        expect(links[0].text).toBe("https://github.com/jamiepine/voicebox");
        expect(links[0].range.end.y).toBe(1);
    });

    it("still joins rows the terminal itself wrapped", () => {
        const { getLinks } = makeTerm([
            { text: "https://example.com/a/very/long/path/that/wrapped" },
            { text: "/at/the/terminal/edge?q=1", isWrapped: true },
        ]);
        const links = getLinks(1);
        expect(links[0].text).toBe("https://example.com/a/very/long/path/that/wrapped/at/the/terminal/edge?q=1");
    });

    it("drops a trailing period so a sentence-ending URL still resolves", () => {
        const { getLinks } = makeTerm([{ text: "docs at https://docs.voicebox.sh/overview." }]);
        expect(getLinks(1)[0].text).toBe("https://docs.voicebox.sh/overview");
    });
});
