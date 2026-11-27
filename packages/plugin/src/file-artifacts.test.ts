import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { ArtifactPreviews } from "../../../local/file-artifacts/plugin/server/preview";
import { ArtifactAccess } from "../../../local/file-artifacts/plugin/server/access";
import {
  cellForeground,
  contrastRatio,
} from "../../../local/file-artifacts/plugin/shared/contrast";
import { compilePlugin } from "../../server/src/server/plugins/compiler";
import { mkdtemp, mkdir, rm, symlink, writeFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fileLink,
  hasFileCitations,
  citationsToLinks,
  splitFileCitations,
} from "../../../local/file-artifacts/plugin/shared/citations";
import {
  inspectArtifact,
  readArtifact,
  artifactFailure,
} from "../../../local/file-artifacts/plugin/server/files";

const python = path.join(os.homedir(), ".paseo/file-artifacts-runtime/bin/python");
const execute = promisify(execFile);

describe("file artifact previews", () => {
  it("compiles both runtime entries with the real plugin compiler", async () => {
    const root = path.resolve("local/file-artifacts/plugin");
    const bundle = await compilePlugin({
      client: path.join(root, "index.client.tsx"),
      server: path.join(root, "index.server.ts"),
    });
    expect(bundle.clientBundle?.length).toBeGreaterThan(1000);
    expect(bundle.serverBundle?.length).toBeGreaterThan(1000);
  });
  it("previews a real workbook by sheet and page without loading a conversation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "artifact-preview-"));
    const engine = new ArtifactPreviews(path.join(root, "cache"), python);
    const file = path.join(root, "report.xlsx");
    const context = {
      paseo: { agents: { ref: () => ({ refresh: async () => ({ agent: { cwd: root } }) }) } },
    } as unknown as PluginHandlerContext;
    try {
      await execute(python, [
        "-c",
        `from openpyxl import Workbook\nfrom openpyxl.styles import Font,PatternFill\nimport sys\nw=Workbook();s=w.active;s.title='质量分析';s.append(['编号','名称','比例','公式'])\nfor i in range(1,251):s.append([i,'中文数据 '+str(i),0.25,'=A'+str(i+1)+'*2'])\ns['C2'].number_format='0.00%';s['B2'].font=Font(bold=True);s['B2'].fill=PatternFill('solid',fgColor='00FF00')\nw.create_sheet('空表');w.save(sys.argv[1])`,
        file,
      ]);
      const target = { kind: "agent" as const, id: "fixture-agent", path: file };
      const { jobId } = await engine.prepare(context, target);
      await expect
        .poll(async () => (await engine.status(context, target, jobId)).status, { timeout: 15000 })
        .toBe("ready");
      expect(await engine.status(context, target, jobId)).toEqual({
        status: "ready",
        manifest: {
          kind: "table",
          sheets: [
            { name: "质量分析", rows: 251, columns: 4 },
            { name: "空表", rows: 0, columns: 0 },
          ],
        },
      });
      const first = await engine.rows(context, target, jobId, 0, 0, 0);
      expect(first.nextOffset).toBe(100);
      expect(first.rows[1]).toMatchObject([
        { text: "1" },
        { text: "中文数据 1", bold: true, background: "#00FF00" },
        { text: "25.00%" },
        { formula: "=A2*2", text: "（公式无缓存结果）" },
      ]);
      const last = await engine.rows(context, target, jobId, 0, 200, 0);
      expect(last.rows).toHaveLength(51);
      expect(last.nextOffset).toBeNull();
      expect(last.rows[50][0].text).toBe("250");
      expect((await engine.rows(context, target, jobId, 1, 0, 0)).rows).toEqual([]);
      await writeFile(file, "replaced");
      await expect(engine.rows(context, target, jobId, 0, 0, 0)).rejects.toThrow("文件已变化");
      await expect(engine.prepare(context, { ...target, path: "/etc/passwd" })).rejects.toThrow();
    } finally {
      engine.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);

  it("recovers from a corrupt workbook, bounds input and isolates preview job targets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "artifact-preview-errors-"));
    const engine = new ArtifactPreviews(path.join(root, "cache"), python);
    const context = {
      paseo: { agents: { ref: () => ({ refresh: async () => ({ agent: { cwd: root } }) }) } },
    } as unknown as PluginHandlerContext;
    try {
      const broken = { kind: "agent" as const, id: "fixture", path: path.join(root, "bad.xlsx") };
      await writeFile(broken.path, "broken archive");
      const failed = await engine.prepare(context, broken);
      await expect
        .poll(async () => (await engine.status(context, broken, failed.jobId)).status)
        .toBe("error");
      const target = { ...broken, path: path.join(root, "中文.csv") };
      await writeFile(target.path, '\uFEFF编号,名称,说明\n1,中文,"包含,逗号"\n2,测试,第二行\n');
      const good = await engine.prepare(context, target);
      await expect
        .poll(async () => (await engine.status(context, target, good.jobId)).status)
        .toBe("ready");
      expect((await engine.rows(context, target, good.jobId, 0, 0, 0)).rows[1]).toEqual([
        { text: "1" },
        { text: "中文" },
        { text: "包含,逗号" },
      ]);
      await expect(
        engine.status(context, { ...target, id: "another" }, good.jobId),
      ).rejects.toThrow("预览已失效");
      await expect(engine.rows(context, target, good.jobId, 1, 0, 0)).rejects.toThrow("区域不存在");
      const large = { ...target, path: path.join(root, "large.csv") };
      await writeFile(large.path, "");
      await truncate(large.path, 32 * 1024 * 1024 + 1);
      await expect(engine.prepare(context, large)).rejects.toThrow("不能超过 32 MiB");
    } finally {
      engine.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);

  it("previews unreferenced host CSV files from different agents and workspaces without loading agents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "artifact-host-preview-"));
    const engine = new ArtifactPreviews(path.join(root, "cache"), python);
    // Absolute paths must not depend on provider, session history or even a live workspace.
    const context = {} as PluginHandlerContext;
    try {
      const reports = path.join(root, "Reports");
      const uploads = path.join(root, "uploads", "arbitrary-folder");
      await mkdir(reports);
      await mkdir(uploads, { recursive: true });
      const files = [path.join(reports, "推断依据.csv"), path.join(uploads, "未引用.csv")];
      for (const file of files) await writeFile(file, "编号,名称\n1,中文\n2,测试\n");
      for (const file of files) {
        for (const target of [
          { kind: "workspace" as const, id: "source", path: file },
          { kind: "workspace" as const, id: "unrelated", path: file },
          { kind: "agent" as const, id: "non-codex-agent", path: file },
        ]) {
          const { jobId } = await engine.prepare(context, target);
          await expect
            .poll(async () => (await engine.status(context, target, jobId)).status)
            .toBe("ready");
          const rows = await engine.rows(context, target, jobId, 0, 0, 0);
          expect(rows.totalRows).toBe(3);
          expect(rows.totalColumns).toBe(2);
          expect(rows.rows[2]).toEqual([{ text: "2" }, { text: "测试" }]);
        }
      }
    } finally {
      engine.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);

  it("keeps quoted commas intact when escaped quotes occur after the dialect sample", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "artifact-csv-quotes-"));
    const engine = new ArtifactPreviews(path.join(root, "cache"), python);
    const target = {
      kind: "workspace" as const,
      id: "any-workspace",
      path: path.join(root, "quotes.csv"),
    };
    const context = {} as PluginHandlerContext;
    try {
      await writeFile(
        target.path,
        "编号,说明\n" +
          Array.from({ length: 1500 }, (_, i) => `${i},普通记录\n`).join("") +
          '1500,"含有 ""引号"", 逗号"\n',
      );
      const { jobId } = await engine.prepare(context, target);
      await expect
        .poll(async () => (await engine.status(context, target, jobId)).status)
        .toBe("ready");
      const page = await engine.rows(context, target, jobId, 0, 1500, 0);
      expect(page.totalColumns).toBe(2);
      expect(page.rows[1]).toEqual([{ text: "1500" }, { text: '含有 "引号", 逗号' }]);
    } finally {
      engine.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses workspace or agent directories only to resolve relative paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "artifact-relative-"));
    const access = new ArtifactAccess();
    const context = {
      paseo: {
        agents: { ref: () => ({ refresh: async () => ({ agent: { cwd: root } }) }) },
        workspaces: { ref: () => ({ refresh: async () => ({}), directory: root }) },
      },
    } as unknown as PluginHandlerContext;
    try {
      await writeFile(path.join(root, "report.csv"), "a,b\n1,2\n");
      for (const kind of ["agent", "workspace"] as const) {
        const resolved = await access.resolve(context, { kind, id: "fixture", path: "report.csv" });
        expect(resolved).toEqual({ root });
        expect((await inspectArtifact(resolved.root, "report.csv")).status).toBe("ready");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("file artifact citations", () => {
  it("opens historical visualization directives through the same filename-link path", () => {
    const source =
      '方案\n\n\uE200visualize\uE202{"path":"/home/ubuntu/Reports/筛选 100%.html","mode":"wide"}\uE201\n\n附件 :codex-file-citation{path="/tmp/report.xlsx"}';
    expect(citationsToLinks(source)).toBe(
      "方案\n\n[筛选 100%.html](</home/ubuntu/Reports/%E7%AD%9B%E9%80%89%20100%25.html>)\n\n附件 [report.xlsx](</tmp/report.xlsx>)",
    );
    expect(splitFileCitations(source)).toEqual([
      { kind: "text", text: "方案\n\n" },
      { kind: "file", path: "/home/ubuntu/Reports/筛选 100%.html", artifactKind: "html" },
      { kind: "text", text: "\n\n附件 " },
      { kind: "file", path: "/tmp/report.xlsx" },
    ]);
    expect(hasFileCitations(source)).toBe(true);
  });
  it("keeps visualization examples literal in code, links, HTML and escaped text", () => {
    const marker = '\uE200visualize\uE202{"path":"/tmp/example.html"}\uE201';
    const source = [
      `\`\`\`text\n${marker}\n\`\`\``,
      `\`${marker}\``,
      `[example ${marker}](https://example.com)`,
      `<div>${marker}</div>`,
      `\\${marker}`,
    ].join("\n\n");
    expect(citationsToLinks(source)).toBe(source);
    expect(hasFileCitations(source)).toBe(false);
  });
  it("hides incomplete streaming visualization payloads until the terminator arrives", () => {
    const prefix = "\uE200visualize\uE202";
    const payload = '{"path":"/tmp/演示.html","mode":"wide"}';
    for (let end = 0; end <= payload.length; end++) {
      const source = `前文 ${prefix}${payload.slice(0, end)}`;
      expect(citationsToLinks(source, true)).toBe("前文 文件信息生成中…");
      expect(hasFileCitations(source)).toBe(true);
    }
    expect(citationsToLinks(`前文 ${prefix}${payload}\uE201 后文`, true)).toBe(
      "前文 [演示.html](</tmp/%E6%BC%94%E7%A4%BA.html>) 后文",
    );
    expect(citationsToLinks(`${prefix}${payload}`)).toBe("文件引用格式不完整。");
  });
  it("validates visualization JSON and local HTML paths without consuming later paragraphs", () => {
    const prefix = "\uE200visualize\uE202";
    for (const payload of [
      "not-json",
      "null",
      "[]",
      "{}",
      '{"path":42}',
      '{"path":" "}',
      '{"path":"https://example.com/a.html"}',
      '{"path":"/tmp/a.pdf"}',
      '{"path":"/tmp/a\\u0000.html"}',
    ]) {
      expect(splitFileCitations(`${prefix}${payload}\uE201`)).toEqual([{ kind: "invalid" }]);
    }
    expect(splitFileCitations(`${prefix}{"path":"/tmp/a\n\n下一段`, true)).toEqual([
      { kind: "invalid" },
      { kind: "text", text: "\n\n下一段" },
    ]);
    expect(
      splitFileCitations(`${prefix}${JSON.stringify({ path: '/tmp/a}b"c.HTM' })}\uE201`),
    ).toEqual([{ kind: "file", path: '/tmp/a}b"c.HTM', artifactKind: "html" }]);
  });
  it("renders historical and streaming file references as filename links for the native opener", () => {
    for (const extension of ["xlsx", "csv", "pdf", "docx", "pptx", "txt", "zip", "png"]) {
      expect(
        citationsToLinks(`报告 :codex-file-citation{path="/tmp/中文.${extension}"} 完成。`),
      ).toBe(`报告 [中文.${extension}](</tmp/%E4%B8%AD%E6%96%87.${extension}>) 完成。`);
    }
    const ordinary =
      '[原有文件](/tmp/file.txt) 与 `:codex-file-citation{path="/tmp/example.xlsx"}`';
    expect(citationsToLinks(ordinary)).toBe(ordinary);
    expect(citationsToLinks('前文 :codex-file-citation{path="/tmp/中', true)).toBe(
      "前文 文件信息生成中…",
    );
    expect(fileLink("/tmp/[报告]*.xlsx")).toBe(
      "[\\[报告\\]\\*.xlsx](</tmp/%5B%E6%8A%A5%E5%91%8A%5D*.xlsx>)",
    );
  });

  it("preserves surrounding Markdown and resolves each quoted citation", () => {
    expect(
      splitFileCitations(
        '**报告**\n\n:codex-file-citation{path="/tmp/690小时 报告.xlsx" artifact_kind="workbook" purpose="output"}\n\n后文 :codex-file-citation{path=\'/tmp/a}b.pdf\'}',
      ),
    ).toEqual([
      { kind: "text", text: "**报告**\n\n" },
      { kind: "file", path: "/tmp/690小时 报告.xlsx", artifactKind: "workbook" },
      { kind: "text", text: "\n\n后文 " },
      { kind: "file", path: "/tmp/a}b.pdf" },
    ]);
  });
  it("does not turn fenced, inline, linked or escaped examples into file access", () => {
    const source =
      '```text\n:codex-file-citation{path="/tmp/a.xlsx"}\n```\n\n`:codex-file-citation{path="/tmp/b.pdf"}`\n\n[example :codex-file-citation{path="/tmp/c.pdf"}](https://example.com)\n\n\\:codex-file-citation{path="/tmp/d.pdf"}';
    expect(splitFileCitations(source)).toEqual([{ kind: "text", text: source }]);
  });
  it("renders a streaming directive as pending then replaces it with the complete file reference", () => {
    expect(splitFileCitations('回复 :codex-file-citation{path="/tmp/a', true)).toEqual([
      { kind: "text", text: "回复 " },
      { kind: "pending" },
    ]);
    expect(splitFileCitations('回复 :codex-file-citation{path="/tmp/a.pdf"}', false)).toEqual([
      { kind: "text", text: "回复 " },
      { kind: "file", path: "/tmp/a.pdf" },
    ]);
    expect(splitFileCitations(':codex-file-citation{path="/tmp/a', false)).toEqual([
      { kind: "invalid" },
    ]);
  });
  it("rejects malformed attributes, remote URLs, duplicates, and control characters", () => {
    for (const source of [
      ':codex-file-citation{path="https://example.com/a"}',
      ':codex-file-citation{path="/tmp/a" path="/tmp/b"}',
      ":codex-file-citation{path=/tmp/a}",
      ':codex-file-citation{purpose="output"}',
      ':codex-file-citation{path="/tmp/a\u0000"}',
    ])
      expect(splitFileCitations(source)).toEqual([{ kind: "invalid" }]);
  });
  it("preserves paragraphs after an unterminated directive", () => {
    expect(splitFileCitations(':codex-file-citation{path="/tmp/a\n\n下一段', true)).toEqual([
      { kind: "invalid" },
      { kind: "text", text: "\n\n下一段" },
    ]);
    expect(splitFileCitations(":codex-file-citation{path=\n\n下一段")).toEqual([
      { kind: "invalid" },
      { kind: "text", text: "\n\n下一段" },
    ]);
  });
  it("encodes Markdown delimiters and literal percent characters in file links", () => {
    expect(fileLink("/tmp/中文 100% (a)#.xlsx")).toBe(
      "[中文 100% (a)#.xlsx](</tmp/%E4%B8%AD%E6%96%87%20100%25%20(a)%23.xlsx>)",
    );
  });
});

describe("remote artifact filesystem access", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });
  async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-file-artifacts-"));
    roots.push(root);
    await mkdir(path.join(root, "workspace"));
    const directory = path.join(root, "workspace");
    const name = "690小时 原因分析.xlsx";
    await writeFile(path.join(directory, name), Buffer.from([0x50, 0x4b, 0, 255]));
    return { root, directory, name };
  }
  it("inspects and downloads exact original bytes, including Chinese names", async () => {
    const { directory, name } = await fixture();
    const state = await inspectArtifact(directory, name);
    expect(state).toEqual({
      status: "ready",
      path: expect.stringContaining(name),
      name,
      size: 4,
      modifiedAt: expect.any(Number),
    });
    if (state.status !== "ready") throw new Error("Expected fixture file");
    expect(await readArtifact(directory, name, state)).toEqual({
      name,
      base64: Buffer.from([0x50, 0x4b, 0, 255]).toString("base64"),
    });
  });
  it("reports deleted files explicitly", async () => {
    const { directory, name } = await fixture();
    await rm(path.join(directory, name));
    expect(await inspectArtifact(directory, name)).toEqual({
      status: "missing",
      message: "文件已不存在，可能已移动或删除。",
    });
  });
  it("downloads unreferenced uploads and sibling files using host filesystem permissions", async () => {
    const { root, directory } = await fixture();
    const uploads = path.join(root, "uploads", "any-folder");
    await mkdir(uploads, { recursive: true });
    for (const name of ["客户报告.xlsx", "other.xlsx"]) {
      const target = path.join(uploads, name);
      await writeFile(target, "uploaded workbook");
      const state = await inspectArtifact(directory, target);
      expect(state.status).toBe("ready");
      if (state.status !== "ready") throw new Error("Expected readable upload");
      expect(await readArtifact(directory, target, state)).toEqual({
        name,
        base64: Buffer.from("uploaded workbook").toString("base64"),
      });
    }
  });
  it("rejects URLs and malformed file paths", async () => {
    const { directory } = await fixture();
    for (const source of [
      "",
      "https://example.com/report.csv",
      "file:///tmp/report.csv",
      "bad\u0000.csv",
    ])
      expect(await inspectArtifact(directory, source)).toEqual({
        status: "denied",
        message: "文件路径无效，请使用主机上的本地文件路径。",
      });
  });
  it("distinguishes operating system permission failures from scope restrictions", () => {
    expect(artifactFailure(Object.assign(new Error("permission"), { code: "EACCES" }))).toEqual({
      status: "denied",
      message: "主机系统拒绝读取此文件，请检查文件权限。",
    });
  });
  it("reads absolute, parent-relative and symlink paths outside the workspace", async () => {
    const { root, directory } = await fixture();
    const outside = path.join(root, "outside.csv");
    await writeFile(outside, "编号,值\n1,中文\n");
    await symlink(outside, path.join(directory, "linked.csv"));
    for (const target of ["../outside.csv", outside, "linked.csv"]) {
      const state = await inspectArtifact(directory, target);
      expect(state.status).toBe("ready");
      if (state.status !== "ready") throw new Error("Expected readable host file");
      expect((await readArtifact(directory, target, state)).base64).toBe(
        Buffer.from("编号,值\n1,中文\n").toString("base64"),
      );
    }
    expect((await inspectArtifact(path.join(root, "deleted-workspace"), outside)).status).toBe(
      "ready",
    );
  });
  it("rejects changed files and directories instead of returning stale or invalid bytes", async () => {
    const { directory, name } = await fixture();
    const state = await inspectArtifact(directory, name);
    if (state.status !== "ready") throw new Error("Expected fixture file");
    await writeFile(path.join(directory, name), "changed contents");
    await expect(readArtifact(directory, name, state)).rejects.toThrow("文件已变化");
    expect(await inspectArtifact(directory, directory)).toEqual({
      status: "error",
      message: "无法读取此路径，请确认它指向普通文件。",
    });
  });
});

describe("workbook text contrast", () => {
  const dark = { foreground: "#eeeeee", surface0: "#171c19" };
  const light = { foreground: "#171c19", surface0: "#ffffff" };
  it("repairs dark workbook fonts while preserving readable colors and fills", () => {
    expect(cellForeground({ color: "#20394e" }, dark)).toBe(dark.foreground);
    expect(cellForeground({ color: "#20394e" }, light)).toBe("#20394e");
    for (const theme of [dark, light])
      for (const background of [undefined, "#dce5f0", "#243e55", "#000000"]) {
        const color = cellForeground({ color: "#20394e", background }, theme);
        expect(contrastRatio(color, background ?? theme.surface0)).toBeGreaterThanOrEqual(4.5);
      }
    expect(cellForeground({ color: "#ffffff", background: "#243e55" }, dark)).toBe("#ffffff");
  });
});
