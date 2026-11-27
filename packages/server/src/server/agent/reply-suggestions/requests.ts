import type { AgentSession } from "../agent-sdk-types.js";
import type { ManagedAgent } from "../agent-manager.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";

export type SuggestionAgent = Pick<ManagedAgent, "lifecycle" | "lastUserMessageAt" | "session">;

type Request = Extract<SessionInboundMessage, { type: "agent.codex.reply_suggestion.request" }>;

interface Generation {
  key: string;
  controller: AbortController;
  owners: Set<symbol>;
  result: Promise<string | null>;
  finished: boolean;
}

const generations = new WeakMap<AgentSession, Generation>();

function isCurrent(agent: SuggestionAgent | null, revision: string): boolean {
  return agent?.lifecycle === "idle" && agent.lastUserMessageAt?.toISOString() === revision;
}

function acquire(session: AgentSession, request: Request): Generation {
  const key = JSON.stringify([request.revision, request.prompt]);
  const existing = generations.get(session);
  if (existing?.key === key && !existing.controller.signal.aborted) return existing;
  existing?.controller.abort();
  const controller = new AbortController();
  const generate = session.suggestReply;
  if (!generate) throw new Error("This provider does not support reply suggestions");
  const timer = setTimeout(() => controller.abort(new Error("Reply suggestion timed out")), 25000);
  const entry: Generation = {
    key,
    controller,
    owners: new Set(),
    finished: false,
    result: Promise.resolve().then(() =>
      generate.call(session, { prompt: request.prompt, signal: controller.signal }),
    ),
  };
  generations.set(session, entry);
  entry.result = entry.result.finally(() => {
    clearTimeout(timer);
    entry.finished = true;
  });
  // A failed generation can be retried; a successful one is reused by sibling windows.
  void entry.result.catch(() => {
    if (generations.get(session) === entry) generations.delete(session);
  });
  return entry;
}

export class ReplySuggestionRequests {
  private readonly pending = new Map<string, AbortController>();

  cancel(requestId: string): void {
    this.pending.get(requestId)?.abort();
  }

  dispose(): void {
    for (const request of this.pending.values()) request.abort();
    this.pending.clear();
  }

  async request(input: {
    message: Request;
    load(): Promise<SuggestionAgent>;
    current(): SuggestionAgent | null;
    emit(message: SessionOutboundMessage): void;
  }): Promise<void> {
    const { message } = input;
    const controller = new AbortController();
    this.pending.set(message.requestId, controller);
    let text: string | null = null;
    let error: string | null = null;
    let release = () => {};
    try {
      const agent = await input.load();
      if (controller.signal.aborted || !isCurrent(agent, message.revision)) return;
      if (agent.lifecycle !== "idle") return;
      if (!agent.session?.suggestReply)
        throw new Error("Reply suggestions currently require Codex");
      const generation = acquire(agent.session, message);
      const owner = Symbol();
      generation.owners.add(owner);
      release = () => {
        generation.owners.delete(owner);
        if (!generation.finished && generation.owners.size === 0) generation.controller.abort();
      };
      const canceled = new Promise<null>((resolve) => {
        controller.signal.addEventListener(
          "abort",
          () => {
            release();
            resolve(null);
          },
          { once: true },
        );
      });
      text = await Promise.race([generation.result, canceled]);
      const current = input.current();
      if (controller.signal.aborted || !isCurrent(current, message.revision)) text = null;
      if (current?.lifecycle !== "idle" || current.session !== agent.session) text = null;
    } catch (cause) {
      if (!controller.signal.aborted)
        error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      release();
      this.pending.delete(message.requestId);
      input.emit({
        type: "agent.codex.reply_suggestion.response",
        payload: { requestId: message.requestId, text, error },
      });
    }
  }
}
