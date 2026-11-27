import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  inspectFile,
  readFile,
  inspectTarget,
  readTarget,
  type FileState,
} from "../shared/contracts";
import { preparePreview, previewStatus, previewRows, previewPage } from "../shared/preview";
import { inspectArtifact, readArtifact, ArtifactPathError } from "./files";
import { ArtifactPreviews } from "./preview";

export function registerArtifacts(server: PluginServerContext) {
  const previews = new ArtifactPreviews();
  server.handle(inspectFile, async (input, context): Promise<FileState> => {
    try {
      const access = await previews.access.resolve(context, {
        kind: "agent",
        id: input.agentId,
        path: input.path,
      });
      return await inspectArtifact(access.root, input.path);
    } catch (error) {
      return {
        status: error instanceof ArtifactPathError ? "denied" : "error",
        message: error instanceof Error ? error.message : "无法核对会话附件。",
      };
    }
  });
  server.handle(readFile, async (input, context) => {
    const access = await previews.access.resolve(context, {
      kind: "agent",
      id: input.agentId,
      path: input.path,
    });
    return readArtifact(access.root, input.path, input);
  });
  server.handle(inspectTarget, async (target, context): Promise<FileState> => {
    try {
      const access = await previews.access.resolve(context, target);
      return await inspectArtifact(access.root, target.path);
    } catch (error) {
      return {
        status: error instanceof ArtifactPathError ? "denied" : "error",
        message: error instanceof Error ? error.message : "无法核对文件。",
      };
    }
  });
  server.handle(readTarget, async (input, context) => {
    const access = await previews.access.resolve(context, input.target);
    return readArtifact(access.root, input.target.path, input);
  });
  server.handle(preparePreview, (input, context) => previews.prepare(context, input));
  server.handle(previewStatus, (input, context) =>
    previews.status(context, input.target, input.jobId),
  );
  server.handle(previewRows, (input, context) =>
    previews.rows(
      context,
      input.target,
      input.jobId,
      input.sheet,
      input.offset,
      input.columnOffset,
    ),
  );
  server.handle(previewPage, (input, context) =>
    previews.page(context, input.target, input.jobId, input.page),
  );
  return () => previews.dispose();
}
