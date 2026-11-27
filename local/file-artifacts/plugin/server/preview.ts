import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  imagePage,
  jobState,
  previewManifest,
  tablePage,
  type ImagePage,
  type JobState,
  type PreviewTarget,
} from "../shared/preview";
import { artifactVersion, copyArtifact } from "./files";
import { artifactHome, PreviewWorker, workerVersion } from "./worker";
import { ArtifactAccess } from "./access";

interface PreviewJob {
  id: string;
  key: string;
  folder: string;
  version: string;
  scope: string;
  state: JobState;
  pages: Map<number, ImagePage>;
  used: number;
}
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "预览失败，请重试。";

export class ArtifactPreviews {
  private jobs = new Map<string, PreviewJob>();
  private byKey = new Map<string, string>();
  private preparing = new Map<string, Promise<{ jobId: string }>>();
  private images = new Map<string, ImagePage>();
  private conversions: Promise<void> = Promise.resolve();
  private disposed = false;
  readonly worker: PreviewWorker;
  readonly access: ArtifactAccess;
  constructor(
    private home = artifactHome,
    python?: string,
  ) {
    this.worker = new PreviewWorker(home, python);
    this.access = new ArtifactAccess();
  }

  private scope(target: PreviewTarget) {
    return JSON.stringify([target.kind, target.id, target.path]);
  }

  async prepare(context: PluginHandlerContext, target: PreviewTarget): Promise<{ jobId: string }> {
    const access = await this.access.resolve(context, target);
    const current = await artifactVersion(access.root, target.path);
    if (current.size > 32 * 1024 * 1024) throw new Error("预览文件不能超过 32 MiB。");
    const extension = path.extname(target.path).toLowerCase();
    if (
      ![".xlsx", ".xls", ".xlsm", ".csv", ".pdf", ".docx", ".doc", ".pptx", ".ppt"].includes(
        extension,
      )
    )
      throw new Error("此格式暂不支持预览。");
    const scope = this.scope(target);
    const key = createHash("sha256")
      .update(scope + current.version + workerVersion)
      .digest("hex");
    const existing = this.jobs.get(this.byKey.get(key) ?? "");
    if (existing && existing.state.status !== "error") {
      existing.used = Date.now();
      for (const [page, state] of existing.pages) {
        if (state.status === "error") {
          existing.pages.delete(page);
          await rm(path.join(existing.folder, `page-${page}.jpg`), { force: true });
        }
      }
      return { jobId: existing.id };
    }
    if (existing) this.jobs.delete(existing.id);
    const pending = this.preparing.get(key);
    if (pending) return pending;
    const create = this.createJob(key, scope, current.version, extension, target, access).finally(
      () => {
        this.preparing.delete(key);
      },
    );
    this.preparing.set(key, create);
    return create;
  }

  private async createJob(
    key: string,
    scope: string,
    version: string,
    extension: string,
    target: PreviewTarget,
    access: Awaited<ReturnType<ArtifactAccess["resolve"]>>,
  ) {
    if (this.disposed) throw new Error("插件已停止。");
    if (
      [...this.jobs.values()].filter(
        (job) => job.state.status === "queued" || job.state.status === "processing",
      ).length >= 32
    )
      throw new Error("预览队列已满，请稍后重试。");
    const id = randomUUID();
    const folder = path.join(this.home, "jobs", key);
    const source = path.join(folder, "source" + extension);
    const job: PreviewJob = {
      id,
      key,
      folder,
      version,
      scope,
      state: { status: "queued" },
      pages: new Map(),
      used: Date.now(),
    };
    this.jobs.set(id, job);
    this.byKey.set(key, id);
    this.conversions = this.conversions
      .catch(() => undefined)
      .then(() => this.initialize(job, source, target, access))
      .catch((error) => {
        job.state = { status: "error", message: messageOf(error) };
      });
    return { jobId: id };
  }

  private async initialize(
    job: PreviewJob,
    source: string,
    target: PreviewTarget,
    access: Awaited<ReturnType<ArtifactAccess["resolve"]>>,
  ) {
    if (this.disposed) throw new Error("预览插件已停止。");
    await this.prune();
    job.state = { status: "processing" };
    try {
      const cached = previewManifest.parse(
        JSON.parse(await readFile(path.join(job.folder, "manifest.json"), "utf8")),
      );
      await stat(path.join(job.folder, cached.kind === "table" ? "table.sqlite" : "source.pdf"));
      job.state = { status: "ready", manifest: cached };
      return;
    } catch {
      /* Only a completed conversion has a manifest. */
    }
    await rm(job.folder, { recursive: true, force: true });
    await mkdir(job.folder, { recursive: true, mode: 0o700 });
    await copyArtifact(access.root, target.path, source, job.version);
    job.state = { status: "processing" };
    const manifest = previewManifest.parse(
      await this.worker.run("prepare", { folder: job.folder, source }),
    );
    await writeFile(path.join(job.folder, "manifest.json"), JSON.stringify(manifest), {
      mode: 0o600,
    });
    job.state = { status: "ready", manifest };
  }

  private async job(context: PluginHandlerContext, target: PreviewTarget, id: string) {
    const job = this.jobs.get(id);
    if (!job || job.scope !== this.scope(target)) throw new Error("预览已失效，请重新打开。");
    const access = await this.access.resolve(context, target);
    const current = await artifactVersion(access.root, target.path);
    if (current.version !== job.version) throw new Error("文件已变化，请关闭预览后重新打开。");
    job.used = Date.now();
    return job;
  }

  async status(context: PluginHandlerContext, target: PreviewTarget, id: string) {
    return jobState.parse((await this.job(context, target, id)).state);
  }

  async rows(
    context: PluginHandlerContext,
    target: PreviewTarget,
    id: string,
    sheet: number,
    offset: number,
    columnOffset: number,
  ) {
    const job = await this.job(context, target, id);
    if (job.state.status !== "ready" || job.state.manifest.kind !== "table")
      throw new Error("表格尚未准备好。");
    const meta = job.state.manifest.sheets[sheet];
    if (!meta || offset > meta.rows || columnOffset > meta.columns)
      throw new Error("请求的表格区域不存在。");
    return tablePage.parse(
      await this.worker.read("rows", { folder: job.folder, sheet, offset, columnOffset }),
    );
  }

  async page(
    context: PluginHandlerContext,
    target: PreviewTarget,
    id: string,
    page: number,
  ): Promise<ImagePage> {
    const job = await this.job(context, target, id);
    if (
      job.state.status !== "ready" ||
      job.state.manifest.kind !== "document" ||
      page > job.state.manifest.pages
    )
      throw new Error("请求的文档页不存在。");
    const key = id + ":" + page;
    const image = this.images.get(key);
    if (image) return image;
    const existing = job.pages.get(page);
    if (existing?.status === "processing" || existing?.status === "error") return existing;
    job.pages.set(page, { status: "processing" });
    void this.render(job, page, key).catch((error) => {
      job.pages.set(page, { status: "error", message: messageOf(error) });
    });
    return { status: "processing" };
  }

  private async render(job: PreviewJob, page: number, key: string) {
    const value = await this.worker.run("page", { folder: job.folder, page });
    const result = imagePage.parse(Object.assign({ status: "ready" }, value));
    this.images.set(key, result);
    while (this.images.size > 6) this.images.delete(this.images.keys().next().value!);
    job.pages.delete(page);
    const files = await readdir(job.folder);
    const pages = await Promise.all(
      files
        .filter((name) => /^page-\d+\.jpg$/.test(name))
        .map(async (name) => ({ name, time: (await stat(path.join(job.folder, name))).mtimeMs })),
    );
    pages.sort((a, b) => b.time - a.time);
    await Promise.all(
      pages.slice(12).map((file) => rm(path.join(job.folder, file.name), { force: true })),
    );
  }

  private async prune() {
    const root = path.join(this.home, "jobs");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const active = new Set(
      [...this.jobs.values()]
        .filter(
          (job) =>
            job.state.status === "processing" ||
            job.state.status === "queued" ||
            Date.now() - job.used < 60_000,
        )
        .map((job) => job.key),
    );
    const entries = await readdir(root, { withFileTypes: true });
    const folders = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const folder = path.join(root, entry.name);
          return {
            folder,
            key: entry.name,
            time: (await stat(folder)).mtimeMs,
            size: await directorySize(folder),
          };
        }),
    );
    folders.sort((a, b) => b.time - a.time);
    let bytes = 0;
    for (const [index, item] of folders.entries()) {
      bytes += item.size;
      if (active.has(item.key)) continue;
      if (index >= 128 || bytes > 512 * 1024 * 1024 || Date.now() - item.time > 24 * 3600 * 1000) {
        await rm(item.folder, { recursive: true, force: true });
        const id = this.byKey.get(item.key);
        if (id) this.jobs.delete(id);
        this.byKey.delete(item.key);
      }
    }
  }

  dispose() {
    this.disposed = true;
    this.worker.dispose();
    this.jobs.clear();
    this.images.clear();
  }
}

async function directorySize(folder: string): Promise<number> {
  const entries = await readdir(folder, { withFileTypes: true });
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) return 0;
      return entry.isDirectory() ? directorySize(file) : (await stat(file)).size;
    }),
  );
  return sizes.reduce((sum, value) => sum + value, 0);
}
