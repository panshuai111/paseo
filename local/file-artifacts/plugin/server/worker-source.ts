// Embedded Python asset: the plugin runtime evaluates a single CommonJS bundle.
export const WORKER_SOURCE = String.raw`import sys, os, json, sqlite3, csv, re, datetime, math, subprocess, shutil, struct, zipfile
from pathlib import Path

MAX_CELLS = 2000000
MAX_ROWS = 100000
MAX_COLUMNS = 512

def sandbox(command, folder):
    binary = '/usr/local/libexec/paseo-artifacts-bwrap' if Path('/usr/local/libexec/paseo-artifacts-bwrap').is_file() else shutil.which('bwrap')
    if sys.platform != 'linux' or not binary:
        raise ValueError('文档转换需要 Linux 上的 bubblewrap 隔离环境。')
    (folder / 'home').mkdir(exist_ok=True)
    args = [binary, '--unshare-all', '--die-with-parent', '--new-session']
    for name in ['/usr', '/bin', '/lib', '/lib64', '/etc/fonts', '/etc/libreoffice', '/var/lib/libreoffice', '/etc/alternatives', '/etc/ld.so.cache', '/etc/passwd', '/etc/group', '/etc/nsswitch.conf', '/etc/localtime']:
        if Path(name).exists(): args += ['--ro-bind', name, name]
    args += ['--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', str(folder), '/work', '--chdir', '/work', '--setenv', 'HOME', '/work/home', '--setenv', 'XDG_CONFIG_HOME', '/work/home/.config', '--']
    args += [str(x).replace(str(folder), '/work') for x in command]
    result = subprocess.run(args, capture_output=True, timeout=25)
    if result.returncode:
        raise ValueError('隔离转换失败，文件可能损坏、加密或格式不受支持。')
    return result.stdout.decode('utf-8', errors='replace')

def convert(source, extension):
    folder = source.parent
    profile = folder / 'office-profile'
    user = profile / 'user'; user.mkdir(parents=True, exist_ok=True)
    (user / 'registrymodifications.xcu').write_text('<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>')
    sandbox(['/usr/bin/libreoffice', '-env:UserInstallation=' + profile.as_uri(), '--headless', '--nologo', '--nodefault', '--norestore', '--convert-to', extension, '--outdir', str(folder), str(source)], folder)
    output = source.with_suffix('.' + extension)
    if not output.is_file() or output.stat().st_size > 64 * 1024 * 1024:
        raise ValueError('转换没有产生有效预览，或转换结果超过 64 MiB。')
    return output

def rgb(value):
    if value is not None and value.type == 'rgb' and re.fullmatch('[0-9A-Fa-f]{8}', str(value.rgb)):
        return '#' + str(value.rgb)[-6:]
    return None

def value_text(value, fmt):
    if value is None: return ''
    if isinstance(value, bool): return 'TRUE' if value else 'FALSE'
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)): return value.isoformat(sep=' ') if isinstance(value, datetime.datetime) else value.isoformat()
    if isinstance(value, (float, int)) and not isinstance(value, bool):
        if isinstance(value, float) and not math.isfinite(value): return str(value)
        code = (fmt or '').split(';')[0]
        decimals = re.search(r'\.([0#]+)', code)
        places = min(12, len(decimals.group(1))) if decimals else 0
        if '%' in code: return format(value * 100, '.' + str(places) + 'f') + '%'
        if code != 'General' and ('0' in code or '#' in code):
            currency = next((x for x in ['¥', '$', '€', '£'] if x in code), '')
            return currency + format(value, (',' if ',' in code else '') + '.' + str(places) + 'f')
    return str(value)

def cell_view(cell, cached):
    formula = str(cell.value) if cell.data_type == 'f' else None
    text = value_text(cached.value if formula else cell.value, cell.number_format)
    if formula and cached.value is None: text = '（公式无缓存结果）'
    item = {'text': text[:10000]}
    if formula: item['formula'] = formula[:10000]
    if cell.font is not None and cell.font.bold: item['bold'] = True
    bg = rgb(cell.fill.fgColor) if cell.fill is not None and cell.fill.patternType == 'solid' else None
    fg = rgb(cell.font.color) if cell.font is not None else None
    if bg: item['background'] = bg
    if fg: item['color'] = fg
    return item

def build_table(source, folder):
    connection = sqlite3.connect(folder / 'table.pending.sqlite')
    connection.execute('DROP TABLE IF EXISTS rows')
    connection.execute('CREATE TABLE rows (sheet INTEGER, row INTEGER, data TEXT, PRIMARY KEY(sheet,row))')
    sheets = []; total = 0
    def add(sheet, row, cells):
        nonlocal total
        if row > MAX_ROWS or len(cells) > MAX_COLUMNS: raise ValueError('表格预览上限为每页签 10 万行、512 列。请下载原文件查看完整内容。')
        total += len(cells)
        if total > MAX_CELLS: raise ValueError('表格超过 200 万单元格预览上限。请下载原文件。')
        while cells and cells[-1] == {'text': ''}: cells.pop()
        if row % 500 == 0 and (folder / 'table.pending.sqlite').stat().st_size > 64 * 1024 * 1024: raise ValueError('表格预览缓存超过 64 MiB 上限。')
        if cells: connection.execute('INSERT INTO rows VALUES (?,?,?)', (sheet, row, json.dumps(cells, ensure_ascii=False)))
        return len(cells)
    if source.suffix.lower() == '.csv':
        raw = source.read_bytes()
        try: text = raw.decode('utf-8-sig')
        except UnicodeDecodeError: text = raw.decode('gb18030')
        try: dialect = csv.Sniffer().sniff(text[:8192], delimiters=',;\t|')
        except csv.Error: dialect = csv.excel
        import io
        count = 0; columns = 0
        # A short sample cannot prove escaped quotes are absent later in the file.
        for count, values in enumerate(csv.reader(io.StringIO(text), dialect, doublequote=True), 1):
            columns = max(columns, add(0, count, [{'text': value[:10000]} for value in values]))
        sheets.append({'name': source.stem, 'rows': count, 'columns': columns})
    else:
        from openpyxl import load_workbook
        with zipfile.ZipFile(source) as archive:
            if sum(x.file_size for x in archive.infolist()) > 256 * 1024 * 1024: raise ValueError('解压后的工作簿超过 256 MiB 预览上限。')
        formulas = load_workbook(source, read_only=True, data_only=False, keep_links=False)
        values = load_workbook(source, read_only=True, data_only=True, keep_links=False)
        try:
            for index, sheet in enumerate(formulas):
                value_sheet = values[sheet.title]
                sheet.reset_dimensions(); value_sheet.reset_dimensions()
                count = 0; columns = 0
                for count, (row, cached) in enumerate(zip(sheet.iter_rows(), value_sheet.iter_rows()), 1):
                    if len(row) > MAX_COLUMNS: raise ValueError('表格超过 512 列预览上限。')
                    cells = [cell_view(a, b) for a, b in zip(row, cached)]
                    columns = max(columns, add(index, count, cells))
                sheets.append({'name': sheet.title, 'rows': count, 'columns': columns})
        finally:
            formulas.close(); values.close()
    connection.commit()
    if (folder / 'table.pending.sqlite').stat().st_size > 64 * 1024 * 1024: raise ValueError('表格预览缓存超过 64 MiB 上限。')
    connection.close()
    (folder / 'table.pending.sqlite').replace(folder / 'table.sqlite')
    return {'kind': 'table', 'sheets': sheets}

def prepare(data):
    folder = Path(data['folder']).resolve(); source = Path(data['source']).resolve()
    if source.suffix.lower() == '.xls': source = convert(source, 'xlsx')
    if source.suffix.lower() in ['.xlsx', '.xlsm', '.csv']: return build_table(source, folder)
    pdf = source if source.suffix.lower() == '.pdf' else convert(source, 'pdf')
    if pdf != folder / 'source.pdf': shutil.copy2(pdf, folder / 'source.pdf')
    info = sandbox(['/usr/bin/pdfinfo', str(folder / 'source.pdf')], folder)
    match = re.search(r'^Pages:\s+(\d+)', info, re.M)
    if not match: raise ValueError('无法确定 PDF 页数。')
    pages = int(match.group(1))
    if not 1 <= pages <= 2000: raise ValueError('文档超过 2000 页预览上限。')
    return {'kind': 'document', 'pages': pages}

def rows(data):
    folder = Path(data['folder']); sheet = int(data['sheet']); offset = int(data['offset']); col = int(data['columnOffset'])
    manifest = json.loads((folder / 'manifest.json').read_text())
    meta = manifest['sheets'][sheet]
    connection = sqlite3.connect('file:' + str(folder / 'table.sqlite') + '?mode=ro', uri=True)
    found = dict(connection.execute('SELECT row,data FROM rows WHERE sheet=? AND row>? AND row<=? ORDER BY row', (sheet, offset, offset+100)))
    connection.close()
    result = []; used = 0; clipped = False
    for number in range(offset+1, min(offset+100, meta['rows'])+1):
        cells = json.loads(found.get(number, '[]'))[col:col+20]
        for cell in cells:
            if len(cell['text']) > 1000: cell['text'] = cell['text'][:1000] + '…'; clipped = True
        used += len(json.dumps(cells, ensure_ascii=False).encode())
        if used > 450000 and result: break
        result.append(cells)
    end = offset + len(result)
    return {'rows': result, 'offset': offset, 'nextOffset': end if end < meta['rows'] else None, 'totalRows': meta['rows'], 'totalColumns': meta['columns'], 'columnOffset': col, 'clipped': clipped}

def jpeg_size(raw):
    pos = 2
    while pos < len(raw):
        while raw[pos] == 255: pos += 1
        marker = raw[pos]; pos += 1
        length = int.from_bytes(raw[pos:pos+2], 'big')
        if marker in [192,193,194]:
            return int.from_bytes(raw[pos+5:pos+7], 'big'), int.from_bytes(raw[pos+3:pos+5], 'big')
        pos += length
    raise ValueError('预览图片无效。')

def page(data):
    folder = Path(data['folder']); number = int(data['page'])
    image = folder / ('page-' + str(number) + '.jpg')
    if not image.exists():
        sandbox(['/usr/bin/pdftoppm', '-f', str(number), '-l', str(number), '-scale-to', '1400', '-singlefile', '-jpeg', '-jpegopt', 'quality=80', str(folder/'source.pdf'), str(image.with_suffix(''))], folder)
    raw = image.read_bytes()
    if len(raw) > 3 * 1024 * 1024: raise ValueError('页面图片超过 3 MiB 预览上限。')
    width, height = jpeg_size(raw)
    import base64
    return {'base64': base64.b64encode(raw).decode(), 'width': width, 'height': height}

try:
    command = sys.argv[1]; data = json.load(sys.stdin)
    handlers = {'prepare':prepare, 'rows':rows, 'page':page}
    value = handlers[command](data)
    print(json.dumps({'ok':True,'value':value}, ensure_ascii=False))
except Exception as error:
    print(json.dumps({'ok':False,'error':str(error)[:500]}, ensure_ascii=False))
    sys.exit(1)
`;
