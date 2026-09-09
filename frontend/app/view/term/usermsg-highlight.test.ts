// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Where one speaker's box starts and stops. Getting this wrong shows up as boxes that
// swallow the next turn or break apart mid-message, so the boundaries are pinned here.

import { describe, expect, it } from "vitest";
import { classifyRows } from "./usermsg-highlight";

function rows(...lines: (string | [string, boolean])[]) {
    return lines.map((l) => (Array.isArray(l) ? { text: l[0], isWrapped: l[1] } : { text: l, isWrapped: false }));
}

describe("conversation block boundaries", () => {
    it("keeps an indented continuation inside the user's block", () => {
        expect(classifyRows(rows("> 세션 삭제 해줘", "  그리고 미리보기도"))).toEqual(["user", "user"]);
    });

    it("closes the block on a blank line", () => {
        expect(classifyRows(rows("> 진행해", "", "● 시작합니다"))).toEqual(["user", null, "agent"]);
    });

    it("switches speakers without a blank line between them", () => {
        expect(classifyRows(rows("● 답변입니다", "> 다시 해줘"))).toEqual(["agent", "user"]);
    });

    it("treats terminal-wrapped rows as the same message", () => {
        expect(classifyRows(rows("> 아주 긴 요청", ["이어지는 줄", true]))).toEqual(["user", "user"]);
    });

    it("keeps tool output attached to the agent's block", () => {
        expect(classifyRows(rows("● 파일을 고쳤음", "  ⎿ termlinks.ts (+12 −3)"))).toEqual(["agent", "agent"]);
    });

    it("leaves unindented prose outside any box", () => {
        expect(classifyRows(rows("$ git status", "nothing to commit"))).toEqual([null, null]);
    });

    it("does not treat a bare marker as a message", () => {
        expect(classifyRows(rows(">", "●"))).toEqual([null, null]);
    });
});
