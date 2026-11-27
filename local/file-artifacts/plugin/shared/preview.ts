import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const PREVIEW_EXTENSIONS = [
  "xlsx",
  "xls",
  "xlsm",
  "csv",
  "pdf",
  "docx",
  "doc",
  "pptx",
  "ppt",
];
export const previewTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), id: z.string().min(1), path: z.string().min(1).max(4096) }),
  z.object({
    kind: z.literal("workspace"),
    id: z.string().min(1),
    path: z.string().min(1).max(4096),
  }),
]);
export type PreviewTarget = z.infer<typeof previewTarget>;
export const previewManifest = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("table"),
    sheets: z.array(z.object({ name: z.string(), rows: z.number(), columns: z.number() })),
  }),
  z.object({ kind: z.literal("document"), pages: z.number().int().positive() }),
]);
export type PreviewManifest = z.infer<typeof previewManifest>;
export const jobState = z.discriminatedUnion("status", [
  z.object({ status: z.literal("queued") }),
  z.object({ status: z.literal("processing") }),
  z.object({ status: z.literal("ready"), manifest: previewManifest }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);
export const preparePreview = defineRpc({
  name: "artifacts.preview.prepare",
  input: previewTarget,
  output: z.object({ jobId: z.string() }),
});
const jobInput = z.object({ target: previewTarget, jobId: z.string().uuid() });
export const previewStatus = defineRpc({
  name: "artifacts.preview.status",
  input: jobInput,
  output: jobState,
});
export const cellSchema = z.object({
  text: z.string(),
  formula: z.string().optional(),
  bold: z.boolean().optional(),
  background: z.string().optional(),
  color: z.string().optional(),
});
export const tablePage = z.object({
  rows: z.array(z.array(cellSchema)),
  offset: z.number(),
  nextOffset: z.number().nullable(),
  totalRows: z.number(),
  totalColumns: z.number(),
  columnOffset: z.number(),
  clipped: z.boolean(),
});
export const previewRows = defineRpc({
  name: "artifacts.preview.rows",
  input: jobInput.extend({
    sheet: z.number().int().min(0),
    offset: z.number().int().min(0),
    columnOffset: z.number().int().min(0).default(0),
  }),
  output: tablePage,
});
export const imagePage = z.discriminatedUnion("status", [
  z.object({ status: z.literal("queued") }),
  z.object({ status: z.literal("processing") }),
  z.object({
    status: z.literal("ready"),
    base64: z.string(),
    width: z.number(),
    height: z.number(),
  }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);
export const previewPage = defineRpc({
  name: "artifacts.preview.page",
  input: jobInput.extend({ page: z.number().int().min(1) }),
  output: imagePage,
});
export type PreviewCell = z.infer<typeof cellSchema>;
export type TablePage = z.infer<typeof tablePage>;
export type JobState = z.infer<typeof jobState>;
export type ImagePage = z.infer<typeof imagePage>;

export function canPreview(path: string): boolean {
  return PREVIEW_EXTENSIONS.includes(path.split(".").pop()?.toLowerCase() ?? "");
}
