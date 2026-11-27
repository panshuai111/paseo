import { execFileSync } from "node:child_process";
import { app } from "electron";

const SYSCTL_TRANSLATED_KEY = "sysctl.proc_translated";

let cachedRunningUnderARM64Translation: boolean | null = null;

export function detectRunningUnderARM64Translation(input: {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  electronReportedTranslation?: boolean;
  execFileSyncImpl?: typeof execFileSync;
}): boolean {
  // A native arm64 process cannot be running through Rosetta, regardless of
  // what Electron or sysctl reports for a child process.
  if (input.platform !== "darwin" || input.arch !== "x64") {
    return false;
  }

  if (input.electronReportedTranslation === true) {
    return true;
  }

  const execImpl = input.execFileSyncImpl ?? execFileSync;

  try {
    const output = execImpl("sysctl", ["-in", SYSCTL_TRANSLATED_KEY], {
      encoding: "utf-8",
      timeout: 1000,
    });
    return output.trim() === "1";
  } catch {
    return false;
  }
}

export function isRunningUnderARM64Translation(): boolean {
  if (cachedRunningUnderARM64Translation !== null) {
    return cachedRunningUnderARM64Translation;
  }

  cachedRunningUnderARM64Translation = detectRunningUnderARM64Translation({
    platform: process.platform,
    arch: process.arch,
    electronReportedTranslation: app.runningUnderARM64Translation,
  });
  return cachedRunningUnderARM64Translation;
}
