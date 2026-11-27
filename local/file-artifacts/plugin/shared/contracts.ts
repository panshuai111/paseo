import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { previewTarget } from "./preview";

const target = z.object({ agentId: z.string().min(1), path: z.string().min(1).max(4096) });
export const fileStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    path: z.string(),
    name: z.string(),
    size: z.number(),
    modifiedAt: z.number(),
  }),
  z.object({ status: z.literal("missing"), message: z.string() }),
  z.object({ status: z.literal("denied"), message: z.string() }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);
export const inspectFile = defineRpc({
  name: "artifacts.inspect",
  input: target,
  output: fileStateSchema,
});
export const readFile = defineRpc({
  name: "artifacts.read",
  input: target.extend({ modifiedAt: z.number(), size: z.number() }),
  output: z.object({ base64: z.string(), name: z.string() }),
});
export const messageSchema = z.object({ text: z.string(), streaming: z.boolean().optional() });
export type ArtifactMessage = z.output<typeof messageSchema>;
export type FileState = z.output<typeof fileStateSchema>;
export const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;

export const inspectTarget = defineRpc({
  name: "artifacts.file.inspect",
  input: previewTarget,
  output: fileStateSchema,
});
export const readTarget = defineRpc({
  name: "artifacts.file.read",
  input: z.object({ target: previewTarget, modifiedAt: z.number(), size: z.number() }),
  output: z.object({ base64: z.string(), name: z.string() }),
});
