import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerArtifacts } from "./server/register";

export default function contribute(server: PluginServerContext) {
  return registerArtifacts(server);
}
