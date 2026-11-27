"""Apply the local file-card bridge to the verified q5m-math source, with backups.

Run on the daemon host: python3 bridge-math.py MATH_ROOT PLUGIN_ROOT BACKUP_ROOT
The original math rendering and formula RPC stay owned by q5m-math.
"""
import json
import pathlib
import shutil
import sys


def main():
    math, plugin, backup = map(pathlib.Path, sys.argv[1:])
    manifest = json.loads((math / "paseo-plugin.json").read_text())
    if manifest["id"] != "q5m-math":
        raise SystemExit("Unexpected math plugin; refusing to patch")
    targets = ["index.client.tsx", "index.server.ts", "client/math-message.tsx", "shared/message.ts"]
    installed = "FileArtifactsMessage" in (math / "client/math-message.tsx").read_text()
    backup.mkdir(parents=True, exist_ok=False, mode=0o700)
    for name in targets:
        out = backup / name
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(math / name, out)

    for directory in ["client", "server", "shared"]:
        destination = math / directory / "file-artifacts"
        if destination.exists():
            shutil.copytree(destination, backup / directory / "file-artifacts")
            shutil.rmtree(destination)
        shutil.copytree(plugin / directory, destination)
        if directory in ["client", "server"]:
            for source in destination.rglob("*.ts*"):
                source.write_text(source.read_text().replace('"../shared/', '"../../shared/file-artifacts/'))

    source = math / "index.server.ts"
    text = source.read_text()
    if installed:
        marker = '  registerArtifacts(server);\n  return () => {};'
        if '  return registerArtifacts(server);' in text:
            print("Math bridge refreshed; backup:", backup)
            return
        if marker not in text:
            raise SystemExit("Math server cleanup changed; restore backup before retrying")
        source.write_text(text.replace(marker, '  return registerArtifacts(server);'))
        print("Math bridge upgraded; backup:", backup)
        return
    marker = '  server.handle(renderMath, renderFormula);'
    if marker not in text or '  return () => {};' not in text:
        raise SystemExit("Math server entry changed; restore backup before retrying")
    source.write_text('import { registerArtifacts } from "./server/file-artifacts/register.js";\n' + text.replace('  return () => {};', '  return registerArtifacts(server);'))

    source = math / "client/math-message.tsx"
    text = source.read_text()
    marker = '  return <MemoizedMathMessage {...props} />;'
    if marker not in text:
        raise SystemExit("Math client entry changed; restore backup before retrying")
    bridge = '''  const renderText = useCallback((text: string) => (
    <MemoizedMathMessage {...props} item={{ ...props.item, data: { text } }} />
  ), [props]);
  if (hasFileCitations(props.item.data.text)) {
    return <FileArtifactsMessage {...props} renderText={renderText} />;
  }
  return <MemoizedMathMessage {...props} />;'''
    source.write_text('import { FileArtifactsMessage } from "./file-artifacts/message.js";\nimport { hasFileCitations } from "../shared/file-artifacts/citations.js";\n' + text.replace(marker, bridge))

    source = math / "index.client.tsx"
    text = source.read_text().replace('transform({ item })', 'transform({ item, phase })').replace('data: { text: item.text }', 'data: { text: item.text, streaming: phase === "streaming" }')
    source.write_text(text)
    source = math / "shared/message.ts"
    text = source.read_text().replace('text: z.string(),', 'text: z.string(),\n  streaming: z.boolean().optional(),')
    if 'streaming: z.boolean()' not in text:
        raise SystemExit("Math message schema changed; restore backup before retrying")
    source.write_text(text)
    print("Math bridge written; backup:", backup)


if __name__ == "__main__":
    main()
