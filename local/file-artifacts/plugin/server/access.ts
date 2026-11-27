import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import path from "node:path";
import type { PreviewTarget } from "../shared/preview";

export class ArtifactAccess {
  async resolve(context: PluginHandlerContext, target: PreviewTarget): Promise<{ root: string }> {
    // Host file access follows the daemon user's OS permissions. Only relative paths
    // need workspace metadata; absolute paths never load an agent or inspect its history.
    if (path.isAbsolute(target.path) || target.path === "~" || target.path.startsWith("~/"))
      return { root: path.parse(path.resolve(target.path)).root };
    if (target.kind === "workspace") {
      const workspace = context.paseo.workspaces.ref(target.id);
      await workspace.refresh();
      if (!workspace.directory)
        throw new Error("工作区已不可用，无法解析相对路径，请使用绝对路径。");
      return { root: workspace.directory };
    }
    const snapshot = await context.paseo.agents.ref(target.id).refresh();
    if (!snapshot?.agent.cwd) throw new Error("会话已不可用，无法解析相对路径，请使用绝对路径。");
    return { root: snapshot.agent.cwd };
  }
}
