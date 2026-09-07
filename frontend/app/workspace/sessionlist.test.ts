// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Rules that decide what the sidebar and the jump palette show. These are the parts that
// quietly broke before (pins disappearing behind a status filter, a name sort that still
// looked like recency), so they are tested directly rather than through the components.

import { describe, expect, it } from "vitest";
import { selectPaletteSessions } from "./sessionpalette";
import { selectSidebarSessions } from "./sessionsidebar";

function session(over: Partial<CliSessionEntry> & { sessionid: string }): CliSessionEntry {
    return {
        agent: "claude",
        cwd: "C:/Dev/proj",
        title: over.sessionid,
        mtime: 1000,
        filepath: `/tmp/${over.sessionid}.jsonl`,
        alias: "",
        pinned: false,
        color: "",
        project: "",
        snippet: "",
        lastmsg: "",
        lastrole: "",
        model: "",
        ...over,
    } as CliSessionEntry;
}

const none = new Set<string>();

function sidebar(over: Partial<Parameters<typeof selectSidebarSessions>[0]>) {
    return selectSidebarSessions({
        sessions: [],
        agentFilter: "all",
        statusFilter: "all",
        sort: "recent",
        query: "",
        attention: none,
        working: none,
        open: none,
        live: none,
        contentMatches: null,
        ...over,
    });
}

describe("sidebar session list", () => {
    const a = session({ sessionid: "a", title: "정치판 카드뉴스", mtime: 300 });
    const b = session({ sessionid: "b", title: "shhh 결제", agent: "codex", mtime: 200 });
    const c = session({ sessionid: "c", title: "가나다 정리", mtime: 100, pinned: true });

    it("filters by agent", () => {
        const out = sidebar({ sessions: [a, b, c], agentFilter: "codex" });
        expect(out.map((s) => s.sessionid)).toEqual(["b"]);
    });

    it("keeps pinned sessions visible under a status filter", () => {
        const out = sidebar({
            sessions: [a, b, c],
            statusFilter: "waiting",
            attention: new Set(["a"]),
        });
        // "a" matches the filter, "c" survives because it is pinned, "b" is dropped
        expect(out.map((s) => s.sessionid).sort()).toEqual(["a", "c"]);
    });

    it("matches title, alias and cwd, plus backend content hits", () => {
        const withAlias = session({ sessionid: "d", title: "무제", alias: "배포 담당" });
        const byContent = session({ sessionid: "e", title: "무관한 제목" });
        expect(sidebar({ sessions: [a, withAlias], query: "배포" }).map((s) => s.sessionid)).toEqual(["d"]);
        expect(sidebar({ sessions: [a, b], query: "proj" }).length).toBe(2); // cwd match
        expect(
            sidebar({
                sessions: [byContent],
                query: "없는말",
                contentMatches: new Map([["e", "본문에서 찾음"]]),
            }).map((s) => s.sessionid)
        ).toEqual(["e"]);
    });

    it("sorts by name with pinned first", () => {
        // same script on both sides: cross-script ordering is ICU's business, not ours
        const na = session({ sessionid: "na", title: "나중 작업", mtime: 500 });
        const ga = session({ sessionid: "ga", title: "가장 먼저", mtime: 100 });
        const out = sidebar({ sessions: [na, ga, c], sort: "name" });
        expect(out[0].sessionid).toBe("c"); // pinned wins regardless of name
        expect(out.slice(1).map((s) => s.title)).toEqual(["가장 먼저", "나중 작업"]);
    });

    it("sorts by status: waiting, then working, then open, then the rest", () => {
        const out = sidebar({
            sessions: [a, b, c],
            sort: "status",
            attention: new Set(["b"]),
            working: new Set(["a"]),
        });
        expect(out.map((s) => s.sessionid)).toEqual(["c", "b", "a"]); // c pinned, then waiting, then working
    });

    it("leaves recency order untouched", () => {
        const out = sidebar({ sessions: [a, b, c], sort: "recent" });
        expect(out.map((s) => s.sessionid)).toEqual(["a", "b", "c"]);
    });
});

describe("jump palette list", () => {
    const waiting = session({ sessionid: "w", title: "대기중 세션", mtime: 100 });
    const recent = session({ sessionid: "r", title: "최근 세션", mtime: 900 });
    const old = session({ sessionid: "o", title: "옛날 세션", mtime: 50 });
    const attention = new Set(["w"]);

    it("starts with only the sessions waiting on an answer", () => {
        const out = selectPaletteSessions([waiting, recent, old], attention, "waiting", "");
        expect(out.map((s) => s.sessionid)).toEqual(["w"]);
    });

    it("widens to everything as soon as the user types", () => {
        const out = selectPaletteSessions([waiting, recent, old], attention, "waiting", "세션");
        expect(out.map((s) => s.sessionid)).toEqual(["w", "r", "o"]); // waiting first, then recency
    });

    it("shows everything in the all scope, waiting still first", () => {
        const out = selectPaletteSessions([recent, old, waiting], attention, "all", "");
        expect(out[0].sessionid).toBe("w");
        expect(out.map((s) => s.sessionid)).toEqual(["w", "r", "o"]);
    });

    it("caps the list", () => {
        const many = Array.from({ length: 80 }, (_, i) => session({ sessionid: `s${i}`, mtime: i }));
        expect(selectPaletteSessions(many, none, "all", "", 50)).toHaveLength(50);
    });
});
