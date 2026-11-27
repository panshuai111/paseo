import { useMemo, useState, useId, useEffect, useCallback } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { ScrollView, FlatList, TextInput, copyText } from "@getpaseo/plugin/client/ui";
import { cellForeground } from "../shared/contrast";
import { ArtifactFileToolbar } from "./toolbar";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  preparePreview,
  previewStatus,
  previewRows,
  previewPage,
  type PreviewTarget,
  type PreviewManifest,
  type PreviewCell,
  type TablePage,
} from "../shared/preview";

interface Props {
  target: PreviewTarget;
  theme: PluginTheme;
  hostId: string;
}
interface ReadyProps {
  target: PreviewTarget;
  theme: PluginTheme;
  jobId: string;
  manifest: PreviewManifest;
  queryKey: unknown[];
  retry(): void;
}
interface Selection {
  row: number;
  column: number;
  cell: PreviewCell;
}
const fill = { flex: 1, minHeight: 0, minWidth: 0 };
const noticeStyle = { padding: 16, gap: 12 };
const emptyRows: TableRowData[] = [];
const rowKey = (row: TableRowData) => String(row.row);
const rowLayout = (_: unknown, index: number) => ({ length: 44, offset: 44 * index, index });

function useStyles(theme: PluginTheme) {
  return useMemo(
    () => ({
      tools: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 6,
        alignItems: "center" as const,
        padding: 8,
      },
      text: { color: theme.colors.foreground },
      muted: { color: theme.colors.foregroundMuted },
      footer: { padding: 8, color: theme.colors.foregroundMuted },
      title: { flex: 1, color: theme.colors.foregroundMuted },
      button: {
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 6,
      },
      searchBox: { paddingHorizontal: 8, paddingBottom: 8 },
      input: {
        padding: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 6,
        color: theme.colors.foreground,
      },
      header: { flexDirection: "row" as const, height: 34, backgroundColor: theme.colors.surface1 },
      row: { height: 44, flexDirection: "row" as const },
      rowNumber: {
        width: 48,
        padding: 6,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
        color: theme.colors.foregroundMuted,
      },
      headerNumber: { width: 48, padding: 6, color: theme.colors.foregroundMuted },
      headerCell: { width: 150, padding: 6, color: theme.colors.foregroundMuted },
      selected: { padding: 8, gap: 6, borderTopWidth: 1, borderColor: theme.colors.border },
      imageContainer: { padding: 12 },
    }),
    [theme],
  );
}

function Button({
  children,
  onPress,
  disabled = false,
  theme,
}: {
  children: string;
  onPress(): void;
  disabled?: boolean;
  theme: PluginTheme;
}) {
  const s = useStyles(theme);
  const style = useCallback(
    ({ pressed }: { pressed: boolean }) => {
      let opacity = 1;
      if (disabled) opacity = 0.4;
      else if (pressed) opacity = 0.7;
      return [s.button, { opacity }];
    },
    [disabled, s],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={children}
      disabled={disabled}
      onPress={onPress}
      style={style}
    >
      <Text style={s.text}>{children}</Text>
    </Pressable>
  );
}

function Notice({ text, theme, retry }: { text: string; theme: PluginTheme; retry?: () => void }) {
  const s = useStyles(theme);
  return (
    <View style={noticeStyle}>
      <Text selectable accessibilityRole={retry ? "alert" : undefined} style={s.muted}>
        {text}
      </Text>
      {retry ? (
        <Button theme={theme} onPress={retry}>
          重试预览
        </Button>
      ) : null}
    </View>
  );
}

export function ArtifactPreview(props: Props) {
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  return <PreviewSession key={revision} {...props} retry={retry} />;
}

function PreviewSession({ target, theme, hostId, retry }: Props & { retry(): void }) {
  const instance = useId();
  const s = useStyles(theme);
  const prepare = useRpc(preparePreview);
  const status = useRpc(previewStatus);
  const key = useMemo(
    () => ["workspace-file-artifacts-preview", hostId, instance, target],
    [hostId, instance, target],
  );
  const opened = useQuery({
    queryKey: [...key, "open"],
    queryFn: () => prepare(target),
    retry: false,
    gcTime: 60000,
    refetchOnWindowFocus: false,
  });
  const jobId = opened.data?.jobId;
  const state = useQuery({
    queryKey: [...key, "status", jobId],
    queryFn: () => status({ target, jobId: jobId! }),
    enabled: !!jobId,
    retry: false,
    gcTime: 60000,
    refetchOnWindowFocus: false,
    refetchInterval: (q) => {
      if (q.state.error) return false;
      const value = q.state.data?.status;
      return !value || value === "queued" || value === "processing" ? 600 : false;
    },
  });
  const error = opened.error ?? state.error;
  if (error) return <Notice text={error.message} theme={theme} retry={retry} />;
  if (state.data?.status === "error")
    return <Notice text={state.data.message} theme={theme} retry={retry} />;
  if (!jobId || state.data?.status !== "ready")
    return (
      <Notice
        text={
          state.data?.status === "queued" ? "预览已排队，等待其他文件处理完成…" : "正在准备预览…"
        }
        theme={theme}
      />
    );
  return (
    <View style={fill}>
      <View style={s.tools}>
        <Text numberOfLines={1} style={s.title}>
          {target.path.split(/[\\/]/).pop()} · 只读预览
        </Text>
        <Button theme={theme} onPress={retry}>
          刷新
        </Button>
      </View>
      <ReadyPreview
        target={target}
        theme={theme}
        jobId={jobId}
        manifest={state.data.manifest}
        queryKey={key}
        retry={retry}
      />
    </View>
  );
}

function ReadyPreview(props: ReadyProps) {
  return props.manifest.kind === "table" ? (
    <TablePreview {...props} sheets={props.manifest.sheets} />
  ) : (
    <DocumentPreview {...props} pages={props.manifest.pages} />
  );
}
function columnName(index: number) {
  let value = index + 1;
  let result = "";
  while (value) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}
interface TableRowData {
  cells: PreviewCell[];
  row: number;
}

function SheetButton({
  name,
  index,
  selected,
  theme,
  change,
}: {
  name: string;
  index: number;
  selected: number;
  theme: PluginTheme;
  change(index: number): void;
}) {
  const select = useCallback(() => change(index), [change, index]);
  return (
    <Button theme={theme} disabled={selected === index} onPress={select}>
      {name}
    </Button>
  );
}

function TablePreview({
  target,
  theme,
  jobId,
  sheets,
  queryKey,
  retry,
}: ReadyProps & { sheets: Array<{ name: string; rows: number; columns: number }> }) {
  const s = useStyles(theme);
  const read = useRpc(previewRows);
  const [sheet, setSheet] = useState(0);
  const [offset, setOffset] = useState(0);
  const [history, setHistory] = useState<number[]>([]);
  const [columnOffset, setColumnOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<Selection>();
  const query = useQuery({
    queryKey: [...queryKey, "rows", jobId, sheet, offset, columnOffset],
    queryFn: () => read({ target, jobId, sheet, offset, columnOffset }),
    retry: false,
    gcTime: 60000,
    refetchOnWindowFocus: false,
  });
  const data = query.data;
  const changeSheet = useCallback((index: number) => {
    setSheet(index);
    setOffset(0);
    setHistory([]);
    setColumnOffset(0);
    setSearch("");
    setSelection(undefined);
  }, []);
  const previous = useCallback(() => {
    setOffset(history.at(-1) ?? 0);
    setHistory((value) => value.slice(0, -1));
    setSelection(undefined);
  }, [history]);
  const next = useCallback(() => {
    if (data?.nextOffset != null) {
      setHistory((value) => [...value, offset]);
      setOffset(data.nextOffset);
    }
    setSelection(undefined);
  }, [data, offset]);
  const previousColumns = useCallback(() => {
    setColumnOffset((value) => Math.max(0, value - 20));
    setSelection(undefined);
  }, []);
  const nextColumns = useCallback(() => {
    setColumnOffset((value) => value + 20);
    setSelection(undefined);
  }, []);
  const select = useCallback((value: Selection) => setSelection(value), []);
  const range = data?.rows.length ? `${offset + 1}–${offset + data.rows.length}` : "0";
  if (query.error) return <Notice text={query.error.message} theme={theme} retry={retry} />;
  return (
    <View style={fill}>
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator>
          <View style={s.tools}>
            {sheets.map((item, index) => (
              <SheetButton
                key={item.name}
                name={item.name}
                index={index}
                selected={sheet}
                theme={theme}
                change={changeSheet}
              />
            ))}
          </View>
        </ScrollView>
      </View>
      <View style={s.tools}>
        <Button theme={theme} disabled={offset === 0 || query.isFetching} onPress={previous}>
          上一页
        </Button>
        <Button
          theme={theme}
          disabled={data?.nextOffset == null || query.isFetching}
          onPress={next}
        >
          下一页
        </Button>
        <Text style={s.muted}>
          {sheets[sheet]?.rows ?? 0} 行 · {sheets[sheet]?.columns ?? 0} 列 · 当前 {range} 行
        </Text>
        <Button
          theme={theme}
          disabled={columnOffset === 0 || query.isFetching}
          onPress={previousColumns}
        >
          前 20 列
        </Button>
        <Button
          theme={theme}
          disabled={columnOffset + 20 >= (data?.totalColumns ?? 0) || query.isFetching}
          onPress={nextColumns}
        >
          后 20 列
        </Button>
      </View>
      <View style={s.searchBox}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="搜索本页"
          placeholderTextColor={theme.colors.foregroundMuted}
          accessibilityLabel="搜索本页"
          style={s.input}
        />
      </View>
      <TableGrid
        theme={theme}
        data={data}
        loading={query.isFetching}
        columnOffset={columnOffset}
        search={search}
        select={select}
      />
      {data?.clipped ? (
        <Text style={s.footer}>长单元格仅显示前 1000 字符，完整内容请下载原文件。</Text>
      ) : null}
      {selection ? <CellDetails selection={selection} theme={theme} /> : null}
    </View>
  );
}

function TableGrid({
  theme,
  data,
  loading,
  columnOffset,
  search,
  select,
}: {
  theme: PluginTheme;
  data?: TablePage;
  loading: boolean;
  columnOffset: number;
  search: string;
  select(value: Selection): void;
}) {
  const s = useStyles(theme);
  const rows = useMemo(
    () =>
      data?.rows
        .map((cells, index) => ({ cells, row: data.offset + index + 1 }))
        .filter(
          (row) =>
            !search ||
            row.cells.some((cell) => cell.text.toLowerCase().includes(search.toLowerCase())),
        ) ?? emptyRows,
    [data, search],
  );
  const columns = useMemo(
    () =>
      Array.from(
        { length: Math.min(20, Math.max(0, (data?.totalColumns ?? 0) - columnOffset)) },
        (_, i) => columnName(columnOffset + i),
      ),
    [data, columnOffset],
  );
  const contentStyle = useMemo(() => ({ minWidth: 48 + columns.length * 150 }), [columns.length]);
  const bodyStyle = useMemo(
    () => ({ width: 48 + columns.length * 150, flex: 1, minHeight: 0 }),
    [columns.length],
  );
  const renderRow = useCallback(
    ({ item }: { item: TableRowData }) => (
      <TableRow
        item={item}
        theme={theme}
        columns={columns}
        columnOffset={columnOffset}
        select={select}
      />
    ),
    [theme, columns, columnOffset, select],
  );
  if (loading) return <Notice text="正在读取表格…" theme={theme} />;
  if (!data?.rows.length) return <Notice text="此工作表为空。" theme={theme} />;
  if (!rows.length) return <Notice text="本页没有匹配内容。" theme={theme} />;
  return (
    <ScrollView horizontal style={fill} contentContainerStyle={contentStyle}>
      <View style={bodyStyle}>
        <View style={s.header}>
          <Text style={s.headerNumber}>行</Text>
          {columns.map((name) => (
            <Text key={name} style={s.headerCell}>
              {name}
            </Text>
          ))}
        </View>
        <FlatList
          data={rows}
          style={fill}
          keyExtractor={rowKey}
          initialNumToRender={12}
          getItemLayout={rowLayout}
          renderItem={renderRow}
        />
      </View>
    </ScrollView>
  );
}

function TableRow({
  item,
  theme,
  columns,
  columnOffset,
  select,
}: {
  item: TableRowData;
  theme: PluginTheme;
  columns: string[];
  columnOffset: number;
  select(value: Selection): void;
}) {
  const s = useStyles(theme);
  return (
    <View style={s.row}>
      <Text style={s.rowNumber}>{item.row}</Text>
      {columns.map((name, index) => (
        <TableCell
          key={name}
          name={name}
          cell={item.cells[index]}
          theme={theme}
          row={item.row}
          column={columnOffset + index}
          select={select}
        />
      ))}
    </View>
  );
}
const emptyCell: PreviewCell = { text: "" };
function TableCell({
  name,
  cell = emptyCell,
  theme,
  row,
  column,
  select,
}: {
  name: string;
  cell?: PreviewCell;
  theme: PluginTheme;
  row: number;
  column: number;
  select(value: Selection): void;
}) {
  const choose = useCallback(() => select({ row, column, cell }), [select, row, column, cell]);
  const box = useMemo(
    () => ({
      width: 150,
      padding: 6,
      borderWidth: 0.5,
      borderColor: theme.colors.border,
      backgroundColor: cell.background ?? theme.colors.surface0,
    }),
    [theme, cell],
  );
  const text = useMemo(
    () => ({
      fontSize: 12,
      color: cellForeground(cell, theme.colors),
      fontWeight: cell.bold ? ("700" as const) : ("400" as const),
    }),
    [theme, cell],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}${row}: ${cell.text}`}
      onPress={choose}
      style={box}
    >
      <Text numberOfLines={2} style={text}>
        {cell.text}
      </Text>
    </Pressable>
  );
}
function CellDetails({ selection, theme }: { selection: Selection; theme: PluginTheme }) {
  const s = useStyles(theme);
  const [notice, setNotice] = useState("");
  const copy = useCallback(() => {
    void copyText(selection.cell.text).then(
      () => setNotice("已复制显示内容。"),
      () => setNotice("复制失败，请选择文字手动复制。"),
    );
  }, [selection]);
  return (
    <View style={s.selected}>
      <Text selectable numberOfLines={3} style={s.text}>
        {columnName(selection.column)}
        {selection.row}: {selection.cell.text}
      </Text>
      {selection.cell.formula ? (
        <Text selectable numberOfLines={2} style={s.muted}>
          公式：{selection.cell.formula}
        </Text>
      ) : null}
      <Button theme={theme} onPress={copy}>
        复制单元格
      </Button>
      {notice ? (
        <Text accessibilityLiveRegion="polite" style={s.muted}>
          {notice}
        </Text>
      ) : null}
    </View>
  );
}

function DocumentPreview({
  target,
  theme,
  jobId,
  pages,
  queryKey,
  retry,
}: ReadyProps & { pages: number }) {
  const s = useStyles(theme);
  const read = useRpc(previewPage);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(600);
  const previous = useCallback(() => setPage((value) => value - 1), []);
  const next = useCallback(() => setPage((value) => value + 1), []);
  const smaller = useCallback(() => setZoom((value) => Math.max(0.5, value - 0.25)), []);
  const larger = useCallback(() => setZoom((value) => Math.min(2, value + 0.25)), []);
  const layout = useCallback(
    (event: { nativeEvent: { layout: { width: number } } }) =>
      setWidth(event.nativeEvent.layout.width),
    [],
  );
  const query = useQuery({
    queryKey: [...queryKey, "page", jobId, page],
    queryFn: () => read({ target, jobId, page }),
    retry: false,
    gcTime: 15000,
    refetchOnWindowFocus: false,
    refetchInterval: (q) => {
      if (q.state.error) return false;
      const value = q.state.data?.status;
      return !value || value === "queued" || value === "processing" ? 600 : false;
    },
  });
  const image = query.data?.status === "ready" ? query.data : null;
  let error = query.error?.message;
  if (query.data?.status === "error") error = query.data.message;
  return (
    <View style={fill} onLayout={layout}>
      <View style={s.tools}>
        <Button theme={theme} disabled={page === 1} onPress={previous}>
          上一页
        </Button>
        <Text style={s.text}>
          {page} / {pages}
        </Text>
        <Button theme={theme} disabled={page === pages} onPress={next}>
          下一页
        </Button>
        <Button theme={theme} disabled={zoom <= 0.5} onPress={smaller}>
          缩小
        </Button>
        <Text style={s.muted}>{Math.round(zoom * 100)}%</Text>
        <Button theme={theme} disabled={zoom >= 2} onPress={larger}>
          放大
        </Button>
      </View>
      {error ? (
        <Notice text={error} theme={theme} retry={retry} />
      ) : (
        <DocumentImage image={image} width={width} zoom={zoom} page={page} theme={theme} />
      )}
      <Text style={s.footer}>分页图像预览 · 原文、链接和可编辑内容请下载原文件查看。</Text>
    </View>
  );
}
function DocumentImage({
  image,
  width,
  zoom,
  page,
  theme,
}: {
  image: { base64: string; width: number; height: number } | null;
  width: number;
  zoom: number;
  page: number;
  theme: PluginTheme;
}) {
  const s = useStyles(theme);
  const source = useMemo(() => ({ uri: `data:image/jpeg;base64,${image?.base64 ?? ""}` }), [image]);
  const imageStyle = useMemo(() => {
    const size = Math.max(200, width - 24) * zoom;
    return {
      width: size,
      height: image ? (size * image.height) / image.width : 0,
      backgroundColor: "white",
    };
  }, [image, width, zoom]);
  if (!image) return <Notice text="正在生成页面预览…" theme={theme} />;
  return (
    <ScrollView style={fill}>
      <ScrollView horizontal contentContainerStyle={s.imageContainer}>
        <Image
          accessibilityLabel={`第 ${page} 页`}
          source={source}
          style={imageStyle}
          resizeMode="contain"
        />
      </ScrollView>
    </ScrollView>
  );
}

export function ArtifactFilePanel({
  file,
  workspaceId,
  theme,
  host,
  layout,
}: PluginFilePanelProps) {
  const [revision, setRevision] = useState(0);
  useEffect(() => file.watch(() => setRevision((value) => value + 1)), [file]);
  const target = useMemo<PreviewTarget>(
    () => ({ kind: "workspace", id: workspaceId, path: file.path }),
    [file.path, workspaceId],
  );
  return (
    <View style={fill}>
      <ArtifactFileToolbar target={target} file={file} theme={theme} platform={layout.platform} />
      <ArtifactPreview key={revision} target={target} theme={theme} hostId={host.id} />
    </View>
  );
}
