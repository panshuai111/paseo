import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import type { FileState } from "../shared/contracts";
import { MAX_DOWNLOAD_BYTES } from "../shared/contracts";
import { hasControlCharacters } from "../shared/citations";

export class ArtifactPathError extends Error {}

async function resolveFilePath(root: string, source: string) {
  if (!source || hasControlCharacters(source) || /^[a-z][a-z0-9+.-]*:\/\//i.test(source))
    throw new ArtifactPathError("文件路径无效，请使用主机上的本地文件路径。");
  const requested =
    source === "~" || source.startsWith("~/")
      ? path.resolve(os.homedir(), source.slice(2))
      : path.resolve(root, source);
  return realpath(requested);
}

async function openFile(root: string, source: string) {
  const resolved = await resolveFilePath(root, source);
  const handle = await open(
    resolved,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("NOT_FILE");
    return { handle, stat, path: resolved };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function versionOf(file: Awaited<ReturnType<typeof openFile>>): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        file.path,
        file.stat.dev,
        file.stat.ino,
        file.stat.size,
        file.stat.mtimeMs,
        file.stat.ctimeMs,
      ]),
    )
    .digest("hex");
}

export async function artifactVersion(root: string, source: string) {
  const file = await openFile(root, source);
  try {
    return { version: versionOf(file), size: file.stat.size };
  } finally {
    await file.handle.close();
  }
}

export async function copyArtifact(
  root: string,
  source: string,
  destination: string,
  expectedVersion: string,
) {
  const file = await openFile(root, source);
  let output;
  try {
    if (versionOf(file) !== expectedVersion) throw new Error("文件已变化，请重新预览。");
    if (file.stat.size > MAX_DOWNLOAD_BYTES) throw new Error("预览文件不能超过 32 MiB。");
    output = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < file.stat.size) {
      const { bytesRead } = await file.handle.read(
        buffer,
        0,
        Math.min(buffer.length, file.stat.size - offset),
        offset,
      );
      if (!bytesRead) throw new Error("文件已变化，请重新预览。");
      let written = 0;
      while (written < bytesRead)
        written += (await output.write(buffer, written, bytesRead - written)).bytesWritten;
      offset += bytesRead;
    }
    const after = await file.handle.stat();
    if (
      after.size !== file.stat.size ||
      after.mtimeMs !== file.stat.mtimeMs ||
      after.ctimeMs !== file.stat.ctimeMs
    )
      throw new Error("文件已变化，请重新预览。");
  } finally {
    await output?.close();
    await file.handle.close();
  }
}

export function artifactFailure(error: unknown): Exclude<FileState, { status: "ready" }> {
  if (error instanceof ArtifactPathError) return { status: "denied", message: error.message };
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "ENOENT" || code === "ENOTDIR")
    return { status: "missing", message: "文件已不存在，可能已移动或删除。" };
  if (code === "EACCES" || code === "EPERM")
    return { status: "denied", message: "主机系统拒绝读取此文件，请检查文件权限。" };
  if (code === "ELOOP")
    return { status: "denied", message: "无法读取此文件：符号链接无效或已变化。" };
  return { status: "error", message: "无法读取此路径，请确认它指向普通文件。" };
}

export async function inspectArtifact(root: string, source: string): Promise<FileState> {
  try {
    const file = await openFile(root, source);
    try {
      return {
        status: "ready",
        path: file.path,
        name: path.basename(file.path),
        size: file.stat.size,
        modifiedAt: file.stat.mtimeMs,
      };
    } finally {
      await file.handle.close();
    }
  } catch (error) {
    return artifactFailure(error);
  }
}

export async function readArtifact(
  root: string,
  source: string,
  expected: { size: number; modifiedAt: number },
) {
  const file = await openFile(root, source).catch((error: unknown) => {
    throw new Error(artifactFailure(error).message);
  });
  try {
    if (file.stat.size > MAX_DOWNLOAD_BYTES)
      throw new Error("文件超过 32 MiB，请通过 Paseo 文件面板下载。");
    if (file.stat.size !== expected.size || file.stat.mtimeMs !== expected.modifiedAt)
      throw new Error("文件已变化，请刷新后重试。");
    // A fixed-size read prevents a concurrently growing file from exhausting memory.
    const buffer = Buffer.alloc(file.stat.size);
    let position = 0;
    while (position < buffer.length) {
      const { bytesRead } = await file.handle.read(
        buffer,
        position,
        buffer.length - position,
        position,
      );
      if (!bytesRead) throw new Error("文件已变化，请刷新后重试。");
      position += bytesRead;
    }
    const after = await file.handle.stat();
    if (
      after.size !== file.stat.size ||
      after.mtimeMs !== file.stat.mtimeMs ||
      after.ctimeMs !== file.stat.ctimeMs
    )
      throw new Error("文件已变化，请刷新后重试。");
    return { base64: buffer.toString("base64"), name: path.basename(file.path) };
  } finally {
    await file.handle.close();
  }
}
