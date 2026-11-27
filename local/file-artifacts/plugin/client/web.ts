import { Platform } from "react-native";

declare const document: {
  createElement(tag: "a"): { href: string; download: string; click(): void };
};
declare const URL: { createObjectURL(blob: unknown): string; revokeObjectURL(url: string): void };
declare const Blob: new (parts: Uint8Array[], options: { type: string }) => unknown;
declare function atob(input: string): string;

export function saveDownload(base64: string, name: string) {
  if (Platform.OS !== "web") throw new Error("请在桌面或网页版下载原文件。");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
