import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  negotiateProviderCapabilities,
  type ProviderEvent,
  type ProviderInput,
  type ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";

const directory =
  process.env.PASEO_HERMES_STATE_DIR ?? join(homedir(), ".local/state/paseo-hermes-feishu");
const workspace = join(homedir(), "Projects/Hermes Feishu");
const persistenceId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const snapshotSchema = z.object({
  title: z.string(),
  running: z.boolean(),
  authorityEpoch: z.number().int().positive().nullish(),
  executionGeneration: z.number().int().nonnegative().nullish(),
  items: z.array(
    z.object({
      id: z.string(),
      role: z.enum(["user", "assistant", "tool"]),
      text: z.string(),
      name: z.string().optional(),
      timestamp: z.string().optional(),
    }),
  ),
});
type Snapshot = z.infer<typeof snapshotSchema>;
const capabilitiesSupported = [
  "session.persistence",
  "prompt.message",
  "prompt.steer",
  "prompt.steer_only",
] as const;
const activeTaskUnavailable = "当前任务已结束或已切换，无法发送引导。";
const steerFailure = {
  unavailable: "Hermes 网关暂时不可用。",
  stale: activeTaskUnavailable,
  rejected: "Hermes 未能接受这条引导。",
  unknown: "未收到 Hermes 的引导回执，请先查看任务进度再决定是否重发。",
} as const;

interface HermesTurn {
  id: string;
  epoch: number;
  generation: number;
}

function activeTurn(snapshot: Snapshot): HermesTurn | undefined {
  const epoch = snapshot.authorityEpoch;
  const generation = snapshot.executionGeneration;
  if (!snapshot.running || !epoch || !generation) return;
  return { id: `hermes-turn-${epoch}-${generation}`, epoch, generation };
}

function steerHermes(sessionId: string, turn: HermesTurn, text: string): Promise<string> {
  const launcher = join(homedir(), ".local/share/paseo-hermes-feishu/read-hermes");
  return new Promise((resolve) => {
    const child = execFile(
      launcher,
      [],
      { env: { ...process.env, PASEO_HERMES_STEER: "1" }, timeout: 12_000, maxBuffer: 16_384 },
      (error, stdout) => resolve(error ? "unknown" : stdout.trim()),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(
      JSON.stringify({ sessionId, epoch: turn.epoch, generation: turn.generation, text }),
    );
  });
}

async function readSnapshot(file: string): Promise<Snapshot> {
  return snapshotSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

async function snapshotVersion(file: string): Promise<string> {
  const info = await stat(file, { bigint: true });
  return `${info.ino}:${info.mtimeNs}`;
}

function timelineItem(row: Snapshot["items"][number]): ProviderTimelineItem {
  if (row.role === "tool") {
    return {
      id: row.id,
      type: "tool_call",
      callId: row.id,
      name: row.name || "Hermes tool",
      status: "completed",
      error: null,
      detail: { type: "plain_text", text: row.text },
    };
  }
  return {
    id: row.id,
    type: row.role === "user" ? "user_message" : "assistant_message",
    text: row.text,
  };
}

export default function register(server: PluginServerContext) {
  server.registerProvider({
    id: "hermes-feishu",
    label: "Hermes · 飞书",
    description: "View and guide running Hermes Feishu conversations.",
    async connect(request) {
      const capabilities = negotiateProviderCapabilities(
        request.capabilities,
        request.capabilities.includes("prompt.steer_only")
          ? capabilitiesSupported
          : ["session.persistence"],
      );
      const listeners = new Set<(event: ProviderEvent) => void>();
      const observers = new Map<
        string,
        {
          stop: () => void;
          steer: (input: Extract<ProviderInput, { type: "session.prompt" }>) => Promise<void>;
        }
      >();
      const emit = (event: ProviderEvent) => {
        for (const listener of listeners) listener(event);
      };

      async function open(input: Extract<ProviderInput, { type: "session.open" }>) {
        const external = persistenceId.safeParse(input.persistence?.data);
        if (!external.success || input.config.cwd !== workspace) {
          throw new Error("飞书会话由 Hermes 创建。请从飞书发起对话。");
        }
        const externalId = external.data;
        const sessionId = input.sessionId;
        const file = join(directory, externalId + ".json");
        let lastVersion = "";
        const initial = await readSnapshot(file);
        let disposed = false;
        let runningTurn: HermesTurn | undefined;
        const known = new Map<string, string>();

        function projectTurn(snapshot: Snapshot) {
          const current = activeTurn(snapshot);
          if (current?.id === runningTurn?.id) return;
          if (runningTurn)
            emit({ type: "session.turn", sessionId, turnId: runningTurn.id, state: "completed" });
          runningTurn = current;
          if (current)
            emit({ type: "session.turn", sessionId, turnId: current.id, state: "started" });
        }

        function project(snapshot: Snapshot) {
          for (const row of snapshot.items) {
            const version = JSON.stringify(row);
            if (known.get(row.id) === version) continue;
            known.set(row.id, version);
            emit({
              type: "timeline.item",
              sessionId,
              item: timelineItem(row),
              timestamp: row.timestamp,
            });
          }
        }

        emit({
          type: "session.opened",
          requestId: input.requestId,
          sessionId,
          capabilities,
          persistence: input.persistence,
          restoration: "core",
          cwd: workspace,
          title: initial.title,
        });
        project(initial);
        emit({ type: "session.ready", requestId: input.requestId, sessionId });

        let timer: ReturnType<typeof setTimeout>;
        async function refresh() {
          try {
            const version = await snapshotVersion(file);
            if (!disposed && version !== lastVersion) {
              const snapshot = await readSnapshot(file);
              if (!disposed) {
                projectTurn(snapshot);
                project(snapshot);
                lastVersion = version;
              }
            }
          } catch {
            // An unavailable source must not replace the last valid timeline.
          } finally {
            if (!disposed) timer = setTimeout(() => void refresh(), 2_000);
          }
        }
        timer = setTimeout(() => void refresh(), 2_000);
        observers.set(sessionId, {
          stop() {
            disposed = true;
            clearTimeout(timer);
          },
          async steer({ prompt }) {
            const turn = runningTurn;
            const result = (
              outcome: Extract<ProviderEvent, { type: "session.prompt_result" }>["result"],
            ) =>
              emit({
                type: "session.prompt_result",
                sessionId,
                clientMessageId: prompt.clientMessageId,
                result: outcome,
              });
            const fail = (message: string) => result({ type: "failed", error: { message } });
            if (
              !capabilities.includes("prompt.steer_only") ||
              prompt.delivery !== "steer" ||
              !turn ||
              prompt.expectedTurnId !== turn.id
            ) {
              fail(activeTaskUnavailable);
              return;
            }
            const content = prompt.input.type === "message" ? prompt.input.content : [];
            const text = content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n")
              .trim();
            if (!text || text.length > 16_000 || content.some((part) => part.type !== "text")) {
              fail("引导仅支持不超过 16000 字的纯文本。");
              return;
            }
            const answer = await steerHermes(externalId, turn, text);
            if (answer === "accepted") {
              result({ type: "steer", turnId: turn.id });
            } else {
              fail(steerFailure[answer as keyof typeof steerFailure] ?? steerFailure.unknown);
            }
          },
        });
      }

      return {
        version: 1,
        capabilities,
        onEvent(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        async close() {
          for (const observer of observers.values()) observer.stop();
          observers.clear();
          listeners.clear();
        },
        async send(input) {
          switch (input.type) {
            case "catalog":
              emit({
                type: "catalog",
                requestId: input.requestId,
                catalog: { models: [], modes: [] },
              });
              return;
            case "session.open":
              try {
                await open(input);
              } catch {
                emit({
                  type: "request.failed",
                  requestId: input.requestId,
                  error: { message: "无法读取 Hermes 飞书会话，请检查同步服务。" },
                });
              }
              return;
            case "session.close":
              observers.get(input.sessionId)?.stop();
              observers.delete(input.sessionId);
              emit({ type: "session.closed", sessionId: input.sessionId });
              emit({ type: "request.completed", requestId: input.requestId });
              return;
            case "session.prompt": {
              const observer = observers.get(input.sessionId);
              if (observer) await observer.steer(input);
              else
                emit({
                  type: "session.prompt_result",
                  sessionId: input.sessionId,
                  clientMessageId: input.prompt.clientMessageId,
                  result: { type: "failed", error: { message: activeTaskUnavailable } },
                });
              return;
            }
            case "session.interrupt":
              emit({
                type: "request.failed",
                requestId: input.requestId,
                error: { message: "请在飞书停止 Hermes 任务。" },
              });
              return;
            default:
              if ("requestId" in input)
                emit({
                  type: "request.failed",
                  requestId: input.requestId,
                  error: { message: "此操作请在飞书完成。" },
                });
          }
        },
      };
    },
  });
  return () => {};
}
