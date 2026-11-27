# File Artifacts 0.3.4

Turn Codex file citations and visualization references into filename links in live and historical replies. Visualization links open their HTML file in Paseo’s sandboxed HTML file panel, including interactive pages; chat-only layout hints do not change the panel. Links use Paseo’s native file opener and file panels; no chat cards or preview modals are created. This build requires Paseo 0.16.1 on both app and daemon. Install on the daemon that owns the files.

Excel (xlsx, xlsm, xls) and CSV previews show sheet tabs, 100 rows per page and 20 columns at a time. Search filters the visible page. Select a cell to inspect and copy its displayed value; formulas show their saved result and formula text. Common number formats, bold text and RGB fills are preserved. Font colors are adapted when needed to maintain 4.5:1 contrast on the displayed cell background. This is a data preview: formulas are not recalculated, and charts, merged layouts and full Excel styling are not reproduced.

PDF, Word (doc, docx) and PowerPoint (ppt, pptx) previews show page images with paging and zoom. Image previews do not support selecting document text or following embedded links. Download the original for editing or full fidelity. Desktop and web support original downloads up to 32 MiB.

The daemon needs Linux, bubblewrap, LibreOffice and Poppler for document and legacy Excel conversions. The isolated Python runtime needs openpyxl and defusedxml. Conversion runs in a separate process, one job at a time, with a 30-second timeout and a 768 MiB process-tree memory budget. No public file server or external conversion service is used.

Preview and download any local file readable by the daemon's operating-system account, including files outside workspaces and uploads from other conversations. No conversation reference or provider-specific grant is required. Relative paths use the selected workspace or agent directory; absolute and home-relative paths do not query an agent or its history. Symbolic links to readable files are supported. Each preview request rechecks the source version. The plugin keeps a private preview cache (512 MiB target, 24-hour expiry, with active jobs retained); it does not archive original files. Deleted or changed sources require reopening the preview.

A compatibility bridge supplies the same filename-link renderer and RPCs to the existing q5m-math plugin, preserving its formula renderer. The file panel is registered once by File Artifacts.

Office and supported archive file panels provide copy-path and desktop/web download actions. Text, Markdown, HTML and image files keep Paseo’s built-in viewers.
