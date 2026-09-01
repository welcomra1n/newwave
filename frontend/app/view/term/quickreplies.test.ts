// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "vitest";
import { forgetLearnedReply, getLearnedReplies, recordSentLine, suggestCompletion } from "./quickreplies";

// the module persists counts in localStorage; tests run in node, so provide a tiny stand-in
function installMemoryStorage() {
    const data = new Map<string, string>();
    (globalThis as any).localStorage = {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => data.set(k, v),
        removeItem: (k: string) => data.delete(k),
        clear: () => data.clear(),
    };
}

function sendTimes(line: string, times: number) {
    for (let i = 0; i < times; i++) recordSentLine(line);
}

describe("quick reply learning", () => {
    beforeEach(() => {
        installMemoryStorage();
    });

    it("offers a line only after it has been repeated", () => {
        sendTimes("ㅇㅇ 진행해", 2);
        expect(getLearnedReplies()).toEqual([]);
        recordSentLine("ㅇㅇ 진행해");
        expect(getLearnedReplies()).toEqual(["ㅇㅇ 진행해"]);
    });

    it("ranks by how often each line was sent", () => {
        sendTimes("계속", 5);
        sendTimes("중단", 3);
        sendTimes("그대로 해", 4);
        expect(getLearnedReplies()).toEqual(["계속", "그대로 해", "중단"]);
    });

    it("skips noise: too short, paths, urls and slash commands", () => {
        sendTimes("ㅇ", 5);
        sendTimes("/clear", 5);
        sendTimes("C:/Dev/waveterm-kime/package.json", 5);
        sendTimes("https://example.com/thing", 5);
        expect(getLearnedReplies()).toEqual([]);
    });

    it("completes from the most frequent previous line", () => {
        sendTimes("배포까지 해줘", 5);
        sendTimes("배포는 하지 마", 2);
        expect(suggestCompletion("배포")).toBe("배포까지 해줘");
        // nothing to add once it is fully typed
        expect(suggestCompletion("배포까지 해줘")).toBe(null);
        // a single character is too little to guess from
        expect(suggestCompletion("배")).toBe(null);
    });

    it("forgets a line on demand", () => {
        sendTimes("다시 해", 4);
        expect(getLearnedReplies()).toContain("다시 해");
        forgetLearnedReply("다시 해");
        expect(getLearnedReplies()).not.toContain("다시 해");
    });
});
