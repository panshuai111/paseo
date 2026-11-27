import type { PreviewCell } from "./preview";

type RGB = readonly [number, number, number];
function rgb(color: string): RGB | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
    return [0, 2, 4].map(
      (start) => parseInt(full.slice(start, start + 2), 16) / 255,
    ) as unknown as RGB;
  }
  const parts = /^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*1)?\s*\)$/i.exec(color);
  return parts ? [Number(parts[1]) / 255, Number(parts[2]) / 255, Number(parts[3]) / 255] : null;
}
function luminance(color: RGB): number {
  const linear = color.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
export function contrastRatio(foreground: string, background: string): number | null {
  const a = rgb(foreground);
  const b = rgb(background);
  if (!a || !b) return null;
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** Preserve workbook colors only when readable on the displayed cell's background. */
export function cellForeground(
  cell: Pick<PreviewCell, "color" | "background">,
  theme: { foreground: string; surface0: string },
): string {
  const background = cell.background ?? theme.surface0;
  const requested = cell.color ?? theme.foreground;
  if ((contrastRatio(requested, background) ?? 0) >= 4.5) return requested;
  const themed = contrastRatio(theme.foreground, background);
  if (themed === null || themed >= 4.5) return theme.foreground;
  return (contrastRatio("#111111", background) ?? 0) > (contrastRatio("#ffffff", background) ?? 0)
    ? "#111111"
    : "#ffffff";
}
