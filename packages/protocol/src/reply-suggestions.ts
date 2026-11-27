import { z } from "zod";

export const ReplySuggestionRequestSchema = z.object({
  type: z.literal("agent.codex.reply_suggestion.request"),
  requestId: z.string(),
  agentId: z.string(),
  revision: z.string(),
  prompt: z.string().min(1).max(4000),
});

export const ReplySuggestionCancelRequestSchema = z.object({
  type: z.literal("agent.codex.reply_suggestion.cancel.request"),
  requestId: z.string(),
  predictionRequestId: z.string(),
});

export const ReplySuggestionResponseSchema = z.object({
  type: z.literal("agent.codex.reply_suggestion.response"),
  payload: z.object({
    requestId: z.string(),
    text: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const ReplySuggestionCancelResponseSchema = z.object({
  type: z.literal("agent.codex.reply_suggestion.cancel.response"),
  payload: z.object({ requestId: z.string() }),
});

export interface ReplySuggestionOptions {
  revision: string;
  prompt: string;
  signal?: AbortSignal;
}
