import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { WORKER_SOURCE } from "./worker-source";

export const artifactHome = path.join(
  process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo"),
  "file-artifacts-cache",
  "v3",
);
export const workerVersion = createHash("sha256").update(WORKER_SOURCE).digest("hex").slice(0, 16);

async function treeRss(pid: number): Promise<number> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const own = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024;
    const children = (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8"))
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const childRss = await Promise.all(children.map((id) => treeRss(Number(id))));
    return own + childRss.reduce((sum, value) => sum + value, 0);
  } catch {
    return 0;
  }
}

export class PreviewWorker {
  constructor(
    private home = artifactHome,
    private python?: string,
  ) {}
  private tail: Promise<unknown> = Promise.resolve();
  private active = new Set<ChildProcess>();
  private reads: Promise<unknown> = Promise.resolve();
  private closed = false;
  private script: Promise<string> | undefined;

  private asset(): Promise<string> {
    this.script ??= (async () => {
      await mkdir(this.home, { recursive: true, mode: 0o700 });
      const file = path.join(this.home, `worker-${workerVersion}.py`);
      await writeFile(file, WORKER_SOURCE, { mode: 0o600 });
      return file;
    })();
    return this.script;
  }

  run(command: string, input: object): Promise<unknown> {
    const task = this.tail.catch(() => undefined).then(() => this.execute(command, input));
    this.tail = task;
    return task;
  }

  read(command: "rows", input: object): Promise<unknown> {
    const task = this.reads.catch(() => undefined).then(() => this.execute(command, input));
    this.reads = task;
    return task;
  }

  private async execute(command: string, input: object): Promise<unknown> {
    if (this.closed) throw new Error("预览插件已停止。");
    const script = await this.asset();
    const python =
      this.python ??
      process.env.PASEO_ARTIFACTS_PYTHON ??
      path.join(
        process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo"),
        "file-artifacts-runtime",
        "bin",
        "python",
      );
    return new Promise((resolve, reject) => {
      const child = spawn(python, [script, command], {
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: { ...process.env, PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" },
      });
      this.active.add(child);
      let output = "";
      let stopped: string | undefined;
      let checking = false;
      const stop = (message: string) => {
        stopped = message;
        this.kill(child);
      };
      const deadline = setTimeout(
        () => stop("预览超过 30 秒，请下载原文件或缩小文件后重试。"),
        30_000,
      );
      const memory = setInterval(() => {
        if (process.platform !== "linux" || !child.pid || checking) return;
        checking = true;
        void treeRss(child.pid)
          .then((bytes) => {
            if (bytes > 768 * 1024 * 1024) stop("预览内存超过 768 MiB，任务已停止。");
            return undefined;
          })
          .finally(() => {
            checking = false;
          });
      }, 250);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.length > 6 * 1024 * 1024) stop("预览响应超过传输上限。");
      });
      child.stderr.resume();
      child.stdin.on("error", () => {});
      const cleanup = () => {
        clearTimeout(deadline);
        clearInterval(memory);
        this.active.delete(child);
      };
      child.once("error", () => {
        cleanup();
        reject(new Error("预览运行环境不可用，请检查插件 Python 环境。"));
      });
      child.once("close", () => {
        cleanup();
        if (stopped) {
          reject(new Error(stopped));
          return;
        }
        try {
          const result = JSON.parse(output);
          if (!result.ok)
            throw new Error(typeof result.error === "string" ? result.error : "预览失败。");
          resolve(result.value);
        } catch (error) {
          reject(error instanceof SyntaxError ? new Error("预览进程未返回有效结果。") : error);
        }
      });
      child.stdin.end(JSON.stringify(input));
    });
  }

  private kill(child: ChildProcess) {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      /* The worker already exited. */
    }
  }

  dispose() {
    this.closed = true;
    for (const child of this.active) this.kill(child);
  }
}
