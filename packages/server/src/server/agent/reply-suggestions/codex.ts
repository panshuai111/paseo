import { z } from "zod";

interface CodexPredictionClient {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
}

const forkSchema = z.object({ thread: z.object({ id: z.string() }) });
const completedSchema = z.object({
  threadId: z.string(),
  turn: z.object({
    status: z.string(),
    error: z.object({ message: z.string() }).nullable().optional(),
    items: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  }),
});
const suggestionSchema = z.object({ suggestion: z.string().trim().max(500).nullable() });

interface Prediction {
  text: string | null;
  turnId: string | null;
  completed: boolean;
  resolve(value: string | null): void;
  reject(error: Error): void;
}

export class CodexReplySuggestions {
  private readonly pending = new Map<string, Prediction>();
  // Retain tombstones until the owning app-server closes: unsubscribe can race final notifications.
  private readonly threads = new Set<string>();
  private readonly operations = new Set<AbortController>();

  get busy(): boolean {
    return this.operations.size > 0;
  }

  owns(params: unknown): boolean {
    const envelope = z.object({ threadId: z.string() }).safeParse(params);
    return envelope.success && this.threads.has(envelope.data.threadId);
  }

  interactiveRequest<T>(params: unknown, request: () => T): T {
    if (this.owns(params)) throw new Error("Prediction cannot request tools or permissions");
    return request();
  }

  notification(method: string, params: unknown): boolean {
    const envelope = z.object({ threadId: z.string() }).safeParse(params);
    if (!envelope.success || !this.threads.has(envelope.data.threadId)) return false;
    if (method === "thread/closed") {
      this.threads.delete(envelope.data.threadId);
      return true;
    }
    const prediction = this.pending.get(envelope.data.threadId);
    if (!prediction) return true;
    if (method === "turn/started") {
      const started = z.object({ turn: z.object({ id: z.string() }) }).safeParse(params);
      if (started.success) prediction.turnId = started.data.turn.id;
      return true;
    }
    if (method === "item/completed") {
      const item = z
        .object({ item: z.object({ type: z.literal("agentMessage"), text: z.string() }) })
        .safeParse(params);
      if (item.success) prediction.text = item.data.item.text;
      return true;
    }
    if (method !== "turn/completed") return true;
    prediction.completed = true;
    const completed = completedSchema.safeParse(params);
    if (!completed.success) {
      prediction.reject(new Error("Invalid prediction completion"));
      return true;
    }
    if (completed.data.turn.status !== "completed") {
      prediction.reject(
        new Error(completed.data.turn.error?.message ?? "Prediction did not complete"),
      );
      return true;
    }
    const messages = (completed.data.turn.items ?? []).filter(
      (item) => item.type === "agentMessage",
    );
    const text = messages.at(-1)?.text ?? prediction.text;
    try {
      const parsed: unknown = JSON.parse(text ?? "{}");
      prediction.resolve(suggestionSchema.parse(parsed).suggestion || null);
    } catch {
      prediction.reject(new Error("Codex returned an invalid reply suggestion"));
    }
    return true;
  }

  close(): void {
    for (const operation of this.operations) operation.abort(new Error("Codex session closed"));
  }

  async generate(input: {
    client: CodexPredictionClient;
    threadId: string;
    prompt: string;
    signal: AbortSignal;
    onFork(threadId: string): void;
  }): Promise<string | null> {
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    this.operations.add(controller);
    let forkId: string | null = null;
    let abort = () => {};
    try {
      signal.throwIfAborted();
      const fork = forkSchema.parse(
        await input.client.request(
          "thread/fork",
          {
            threadId: input.threadId,
            experimentalPredictionMode: true,
            experimentalDisablePredictionMcp: true,
            ephemeral: true,
            excludeTurns: true,
            threadSource: "composer_predictions",
          },
          10000,
        ),
      );
      forkId = fork.thread.id;
      this.threads.add(forkId);
      input.onFork(forkId);
      signal.throwIfAborted();
      const result = new Promise<string | null>((resolve, reject) => {
        this.pending.set(fork.thread.id, {
          resolve,
          reject,
          text: null,
          turnId: null,
          completed: false,
        });
        abort = () =>
          reject(signal.reason instanceof Error ? signal.reason : new Error("Prediction canceled"));
        signal.addEventListener("abort", abort, { once: true });
      });
      // Observe the rejection while the start RPC is still in flight.
      void result.catch(() => undefined);
      const started = await input.client.request(
        "turn/start",
        {
          threadId: forkId,
          input: [{ type: "text", text: input.prompt, text_elements: [] }],
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
        10000,
      );
      const receipt = z.object({ turn: z.object({ id: z.string() }) }).parse(started);
      const prediction = this.pending.get(forkId);
      if (prediction) prediction.turnId = receipt.turn.id;
      return await result;
    } finally {
      signal.removeEventListener("abort", abort);
      try {
        if (forkId) {
          const prediction = this.pending.get(forkId);
          this.pending.delete(forkId);
          if (signal.aborted && prediction?.turnId && !prediction.completed) {
            await input.client
              .request("turn/interrupt", { threadId: forkId, turnId: prediction.turnId }, 3000)
              .catch(() => undefined);
          }
          try {
            await input.client.request("thread/unsubscribe", { threadId: forkId }, 3000);
          } finally {
            await input.client
              .request("thread/delete", { threadId: forkId }, 3000)
              .catch(() => undefined);
          }
        }
      } finally {
        this.operations.delete(controller);
      }
    }
  }
}
