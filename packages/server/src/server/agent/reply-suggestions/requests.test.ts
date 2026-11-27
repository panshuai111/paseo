import { describe, expect, it } from "vitest";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { AgentSession } from "../agent-sdk-types.js";
import { createStub } from "../../test-utils/class-mocks.js";
import { ReplySuggestionRequests, type SuggestionAgent } from "./requests.js";

const revision = "2026-10-26T06:00:00.000Z";

function fixture() {
  let complete: (text: string | null) => void = () => {};
  let starts = 0;
  let aborted = false;
  const session = createStub<AgentSession>({
    suggestReply: ({ signal }: { signal: AbortSignal }) => {
      starts++;
      return new Promise<string | null>((resolve) => {
        complete = resolve;
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve(null);
        });
      });
    },
  });
  let current: SuggestionAgent | null = {
    lifecycle: "idle",
    lastUserMessageAt: new Date(revision),
    session,
  };
  const messages: SessionOutboundMessage[] = [];
  const request = (owner: ReplySuggestionRequests, id: string) =>
    owner.request({
      message: {
        type: "agent.codex.reply_suggestion.request",
        requestId: id,
        agentId: "agent",
        revision,
        prompt: "Predict",
      },
      load: async () => {
        if (!current) throw new Error("gone");
        return current;
      },
      current: () => current,
      emit: (message) => messages.push(message),
    });
  return {
    request,
    messages,
    complete: (text: string | null) => complete(text),
    starts: () => starts,
    aborted: () => aborted,
    change: () => {
      current = null;
    },
  };
}

describe("reply suggestion request ownership", () => {
  it("deduplicates sibling windows and keeps work until the final consumer cancels", async () => {
    const f = fixture();
    const first = new ReplySuggestionRequests();
    const second = new ReplySuggestionRequests();
    const a = f.request(first, "a");
    const b = f.request(second, "b");
    await Promise.resolve();
    await Promise.resolve();
    expect(f.starts()).toBe(1);
    first.cancel("a");
    await a;
    expect(f.aborted()).toBe(false);
    second.dispose();
    await b;
    expect(f.aborted()).toBe(true);
    expect(f.messages).toEqual([
      {
        type: "agent.codex.reply_suggestion.response",
        payload: { requestId: "a", text: null, error: null },
      },
      {
        type: "agent.codex.reply_suggestion.response",
        payload: { requestId: "b", text: null, error: null },
      },
    ]);
  });

  it("discards an answer after the source session disappears", async () => {
    const f = fixture();
    const pending = f.request(new ReplySuggestionRequests(), "stale");
    await Promise.resolve();
    await Promise.resolve();
    f.change();
    f.complete("obsolete");
    await pending;
    expect(f.messages).toEqual([
      {
        type: "agent.codex.reply_suggestion.response",
        payload: { requestId: "stale", text: null, error: null },
      },
    ]);
  });

  it("reuses a completed answer without another generation", async () => {
    const f = fixture();
    const owner = new ReplySuggestionRequests();
    const first = f.request(owner, "a");
    await Promise.resolve();
    await Promise.resolve();
    f.complete("Try an example?");
    await first;
    await f.request(owner, "b");
    expect(f.starts()).toBe(1);
    expect(f.messages.at(-1)).toEqual({
      type: "agent.codex.reply_suggestion.response",
      payload: { requestId: "b", text: "Try an example?", error: null },
    });
  });
});
