import { describe, expect, it } from "vitest";
import { CodexReplySuggestions } from "./codex.js";

function approved() {
  return "approved";
}

interface Call {
  method: string;
  params: unknown;
}

function fixture() {
  const suggestions = new CodexReplySuggestions();
  const calls: Call[] = [];
  let started = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const client = {
    async request(method: string, params?: unknown) {
      calls.push({ method, params });
      if (method === "thread/fork") return { thread: { id: "prediction" } };
      if (method === "turn/start") {
        started();
        return { turn: { id: "prediction-turn" } };
      }
      return {};
    },
  };
  const controller = new AbortController();
  const run = () =>
    suggestions.generate({
      client,
      threadId: "original",
      prompt: "Predict",
      signal: controller.signal,
      onFork() {},
    });
  return { suggestions, calls, ready, controller, run };
}

describe("Codex reply suggestions", () => {
  it("generates only on an ephemeral fork and leaves original notifications alone", async () => {
    const f = fixture();
    const result = f.run();
    await f.ready;
    expect(f.suggestions.busy).toBe(true);
    expect(
      f.suggestions.notification("turn/completed", {
        threadId: "original",
        turn: { status: "completed" },
      }),
    ).toBe(false);
    f.suggestions.notification("item/completed", {
      threadId: "prediction",
      item: { type: "agentMessage", text: '{"suggestion":"下一步怎么做？"}' },
    });
    f.suggestions.notification("turn/completed", {
      threadId: "prediction",
      turn: { status: "completed" },
    });
    await expect(result).resolves.toBe("下一步怎么做？");
    expect(f.calls).toEqual([
      {
        method: "thread/fork",
        params: {
          threadId: "original",
          experimentalPredictionMode: true,
          experimentalDisablePredictionMcp: true,
          ephemeral: true,
          excludeTurns: true,
          threadSource: "composer_predictions",
        },
      },
      {
        method: "turn/start",
        params: {
          threadId: "prediction",
          input: [{ type: "text", text: "Predict", text_elements: [] }],
          effort: "low",
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          turnTrigger: "composer_predictions",
          outputSchema: {
            type: "object",
            properties: { suggestion: { type: ["string", "null"] } },
            required: ["suggestion"],
            additionalProperties: false,
          },
        },
      },
      { method: "thread/unsubscribe", params: { threadId: "prediction" } },
      { method: "thread/delete", params: { threadId: "prediction" } },
    ]);
    expect(f.suggestions.busy).toBe(false);
    expect(() => f.suggestions.interactiveRequest({ threadId: "prediction" }, approved)).toThrow(
      "Prediction cannot request tools or permissions",
    );
    expect(f.suggestions.interactiveRequest({ threadId: "original" }, () => "original")).toBe(
      "original",
    );
    expect(f.suggestions.notification("turn/completed", { threadId: "prediction" })).toBe(true);
  });

  it("cancels and releases only the prediction thread", async () => {
    const f = fixture();
    const result = f.run();
    await f.ready;
    f.controller.abort();
    await expect(result).rejects.toThrow();
    expect(f.calls.slice(-3)).toEqual([
      { method: "turn/interrupt", params: { threadId: "prediction", turnId: "prediction-turn" } },
      { method: "thread/unsubscribe", params: { threadId: "prediction" } },
      { method: "thread/delete", params: { threadId: "prediction" } },
    ]);
    expect(f.suggestions.busy).toBe(false);
  });

  it("surfaces malformed output and releases its thread", async () => {
    const f = fixture();
    const result = f.run();
    await f.ready;
    f.suggestions.notification("turn/completed", {
      threadId: "prediction",
      turn: { status: "completed", items: [{ type: "agentMessage", text: "not json" }] },
    });
    await expect(result).rejects.toThrow("invalid reply suggestion");
    expect(f.calls.at(-1)).toEqual({
      method: "thread/delete",
      params: { threadId: "prediction" },
    });
    expect(f.suggestions.busy).toBe(false);
  });
});
