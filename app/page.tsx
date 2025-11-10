'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toPng } from 'html-to-image';
import { saveAs } from 'file-saver';
import JSZip from 'jszip';
import { jsPDF } from 'jspdf';

const PAGE_WIDTH_MM = 210;
const PAGE_HEIGHT_MM = 297;
const MIN_COLUMNS = 1;
const MAX_COLUMNS = 12;

const DEFAULT_TEXT = `Multi-column layouts allow dense content to be read efficiently without overwhelming the reader. This preview demonstrates how a large piece of text can be distributed across several columns on an A4 canvas.

You can paste any lengthy source material here, including multilingual content such as മലയാളം, العربية, 日本語, and more. Adjust fonts, spacing, and column widths to fine-tune the presentation for print-ready exports.

Change settings on the left to explore how typography and margins affect the final composition. When satisfied, export the document as a PDF or as page-level PNG images ready for sharing or further processing.`;

type ColumnMode = 'equal' | 'custom';

type Margins = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

type MarginsPx = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

type LayoutPage = {
  columns: {
    lines: string[];
  }[];
};

type LayoutMetrics = {
  pageWidthPx: number;
  pageHeightPx: number;
  marginsPx: MarginsPx;
  columnWidthsPx: number[];
  columnOffsetsPx: number[];
  columnHeightPx: number;
  gapPx: number;
  fontSizePx: number;
  lineHeightPx: number;
  customScale: number;
};

type LayoutConfig = {
  text: string;
  columns: number;
  fontFamily: string;
  fontSize: number;
  lineSpacing: number;
};

const FONT_OPTIONS = [
  'Inter',
  'Roboto',
  'Lora',
  'Noto Sans',
  'Noto Serif',
  'Noto Sans Malayalam',
  'Times New Roman',
  'Georgia',
  'Garamond',
  'Courier New'
];

const mmToPx = (mm: number) => (mm * 96) / 25.4;
const ptToPx = (pt: number) => (pt * 96) / 72;

const formatFontFamily = (family: string) =>
  family.includes(' ') ? `'${family}'` : family;

const createEmptyPage = (columns: number): LayoutPage => ({
  columns: Array.from({ length: columns }, () => ({ lines: [] }))
});

const tokenize = (text: string) => {
  const normalized = text.replace(/\r\n/g, '\n');
  const regex = /(\n|\s+|[^\s]+)/g;
  const tokens: { type: 'newline' | 'space' | 'word'; value: string }[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(normalized)) !== null) {
    const chunk = match[0];

    if (chunk === '\n') {
      tokens.push({ type: 'newline', value: chunk });
      continue;
    }

    if (/^\s+$/.test(chunk)) {
      for (const char of chunk) {
        if (char === '\n') {
          tokens.push({ type: 'newline', value: '\n' });
        } else {
          tokens.push({ type: 'space', value: char });
        }
      }
      continue;
    }

    tokens.push({ type: 'word', value: chunk });
  }

  return tokens;
};

const layoutText = (
  config: LayoutConfig,
  metrics: LayoutMetrics
): LayoutPage[] => {
  if (typeof window === 'undefined') {
    return [createEmptyPage(config.columns)];
  }

  const columnWidths = metrics.columnWidthsPx;
  const columnCount = Math.max(config.columns, 1);
  if (columnWidths.length === 0) {
    return [createEmptyPage(columnCount)];
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return [createEmptyPage(columnCount)];
  }

  ctx.font = `${metrics.fontSizePx}px ${formatFontFamily(config.fontFamily)}, sans-serif`;
  ctx.textBaseline = 'alphabetic';

  const tokens = tokenize(config.text);
  const pages: LayoutPage[] = [];
  let currentPage: LayoutPage = { columns: [] };
  let currentColumnLines: string[] = [];
  let cursorY = 0;
  let currentLine = '';
  let currentLineWidth = 0;

  const measure = (value: string) => ctx.measureText(value).width;

  const getColumnWidth = () => {
    const idx = currentPage.columns.length;
    if (idx < columnWidths.length) {
      return columnWidths[idx];
    }
    return columnWidths[columnWidths.length - 1] ?? columnWidths[0];
  };

  const ensureColumnSpaceForNextLine = () => {
    if (cursorY + metrics.lineHeightPx <= metrics.columnHeightPx + 0.1) {
      return;
    }
    finishColumn();
  };

  const finishColumn = () => {
    currentPage.columns.push({ lines: currentColumnLines });
    currentColumnLines = [];
    cursorY = 0;
    if (currentPage.columns.length === columnCount) {
      pages.push(currentPage);
      currentPage = { columns: [] };
    }
  };

  const commitLine = (rawLine: string) => {
    const trimmed = rawLine.replace(/\s+$/u, '');
    ensureColumnSpaceForNextLine();
    currentColumnLines.push(trimmed === '' ? '\u00A0' : trimmed);
    cursorY += metrics.lineHeightPx;
    currentLine = '';
    currentLineWidth = 0;
  };

  const splitLongWord = (word: string) => {
    let remaining = word;
    while (remaining.length > 0) {
      const columnWidth = getColumnWidth();
      ensureColumnSpaceForNextLine();

      let low = 1;
      let high = remaining.length;
      let best = 0;

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const candidate = remaining.slice(0, mid);
        const width = measure(candidate);
        if (width <= columnWidth + 0.1) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      if (best === 0) {
        best = 1;
      }

      const segment = remaining.slice(0, best);
      if (best === remaining.length) {
        currentLine = segment;
        currentLineWidth = measure(segment);
        remaining = '';
      } else {
        commitLine(segment);
        remaining = remaining.slice(best);
      }
    }
  };

  for (const token of tokens) {
    if (token.type === 'newline') {
      if (currentLine !== '') {
        commitLine(currentLine);
      } else {
        commitLine('');
      }
      continue;
    }

    if (token.type === 'space') {
      if (currentLine === '') {
        continue;
      }
      const columnWidth = getColumnWidth();
      const width = measure(token.value);
      if (currentLineWidth + width <= columnWidth + 0.1) {
        currentLine += token.value;
        currentLineWidth += width;
      } else {
        commitLine(currentLine);
      }
      continue;
    }

    const columnWidth = getColumnWidth();
    const width = measure(token.value);

    if (currentLineWidth > 0 && currentLineWidth + width > columnWidth + 0.1) {
      commitLine(currentLine);
    }

    if (width <= columnWidth + 0.1) {
      if (currentLine === '') {
        ensureColumnSpaceForNextLine();
      }
      currentLine += token.value;
      currentLineWidth += width;
    } else {
      if (currentLine !== '') {
        commitLine(currentLine);
      }
      splitLongWord(token.value);
    }
  }

  if (currentLine !== '') {
    commitLine(currentLine);
  }

  if (currentColumnLines.length > 0 || currentPage.columns.length > 0) {
    currentPage.columns.push({ lines: currentColumnLines });
    currentColumnLines = [];
    while (currentPage.columns.length < columnCount) {
      currentPage.columns.push({ lines: [] });
    }
    pages.push(currentPage);
  }

  if (pages.length === 0) {
    return [createEmptyPage(columnCount)];
  }

  return pages;
};

const computeMetrics = (
  columns: number,
  mode: ColumnMode,
  columnWidthsMm: number[],
  gapMm: number,
  margins: Margins,
  fontSize: number,
  lineSpacing: number
): LayoutMetrics => {
  const pageWidthPx = mmToPx(PAGE_WIDTH_MM);
  const pageHeightPx = mmToPx(PAGE_HEIGHT_MM);

  const marginsPx: MarginsPx = {
    top: mmToPx(margins.top),
    right: mmToPx(margins.right),
    bottom: mmToPx(margins.bottom),
    left: mmToPx(margins.left)
  };

  const contentWidthPx = Math.max(pageWidthPx - marginsPx.left - marginsPx.right, 1);
  const gapPx = mmToPx(gapMm);
  const totalGapPx = gapPx * Math.max(columns - 1, 0);
  const availableWidthPx = Math.max(contentWidthPx - totalGapPx, 1);
  const availableWidthMm = Math.max(
    PAGE_WIDTH_MM - margins.left - margins.right - gapMm * Math.max(columns - 1, 0),
    1
  );

  const columnCount = Math.max(columns, 1);

  let columnWidthsPx: number[] = [];
  let scale = 1;

  if (mode === 'equal') {
    const width = availableWidthPx / columnCount;
    columnWidthsPx = Array.from({ length: columnCount }, () => width);
  } else {
    const requested = columnWidthsMm.slice(0, columnCount).map((value) => Math.max(value, 0));
    const sum = requested.reduce((acc, value) => acc + value, 0);
    if (sum <= 0) {
      const fallback = availableWidthPx / columnCount;
      columnWidthsPx = Array.from({ length: columnCount }, () => fallback);
      scale = 1;
    } else {
      scale = availableWidthMm / sum;
      columnWidthsPx = requested.map((value) => mmToPx(value * scale));
    }
  }

  const columnOffsetsPx: number[] = [];
  let offset = 0;
  columnWidthsPx.forEach((width, index) => {
    columnOffsetsPx.push(offset);
    offset += width + (index < columnWidthsPx.length - 1 ? gapPx : 0);
  });

  const columnHeightPx = Math.max(pageHeightPx - marginsPx.top - marginsPx.bottom, 16);
  const fontSizePx = ptToPx(fontSize);
  const lineHeightPx = fontSizePx * lineSpacing;

  return {
    pageWidthPx,
    pageHeightPx,
    marginsPx,
    columnWidthsPx,
    columnOffsetsPx,
    columnHeightPx,
    gapPx,
    fontSizePx,
    lineHeightPx,
    customScale: scale
  };
};

const HomePage = () => {
  const [text, setText] = useState(DEFAULT_TEXT);
  const [columns, setColumns] = useState<number>(8);
  const [fontFamily, setFontFamily] = useState<string>('Noto Sans');
  const [fontSize, setFontSize] = useState<number>(12);
  const [lineSpacing, setLineSpacing] = useState<number>(1.4);
  const [margins, setMargins] = useState<Margins>({ top: 10, right: 10, bottom: 10, left: 10 });
  const [gap, setGap] = useState<number>(2);
  const [columnMode, setColumnMode] = useState<ColumnMode>('equal');
  const [columnWidthsMm, setColumnWidthsMm] = useState<number[]>(() => {
    const availableWidthMm = PAGE_WIDTH_MM - 10 - 10 - 2 * (8 - 1);
    const perColumn = availableWidthMm / 8;
    return Array.from({ length: 8 }, () => Number(perColumn.toFixed(2)));
  });
  const [isExporting, setIsExporting] = useState<'pdf' | 'images' | null>(null);

  const availableWidthMm = useMemo(
    () =>
      Math.max(
        PAGE_WIDTH_MM - margins.left - margins.right - gap * Math.max(columns - 1, 0),
        1
      ),
    [columns, gap, margins.left, margins.right]
  );

  useEffect(() => {
    setColumnWidthsMm((prev) => {
      const next = [...prev];
      if (next.length < columns) {
        const fallback = Math.max(availableWidthMm / columns, 1);
        for (let i = next.length; i < columns; i += 1) {
          next.push(Number(fallback.toFixed(2)));
        }
      } else if (next.length > columns) {
        next.length = columns;
      }
      return next;
    });
  }, [availableWidthMm, columns]);

  const metrics = useMemo(
    () =>
      computeMetrics(columns, columnMode, columnWidthsMm, gap, margins, fontSize, lineSpacing),
    [columns, columnMode, columnWidthsMm, gap, margins, fontSize, lineSpacing]
  );

  const pages = useMemo(() => {
    if (metrics.columnWidthsPx.length === 0) {
      return [createEmptyPage(columns)];
    }
    return layoutText(
      {
        text,
        columns,
        fontFamily,
        fontSize,
        lineSpacing
      },
      metrics
    );
  }, [columns, fontFamily, fontSize, lineSpacing, metrics, text]);

  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const previewContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    pageRefs.current = pageRefs.current.slice(0, pages.length);
  }, [pages.length]);

  const handleExportPdf = useCallback(async () => {
    if (!pages.length) {
      return;
    }
    setIsExporting('pdf');
    try {
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const validPages = pageRefs.current
        .slice(0, pages.length)
        .map((node) => node)
        .filter((node): node is HTMLDivElement => Boolean(node));

      for (let i = 0; i < validPages.length; i += 1) {
        const node = validPages[i];
        const dataUrl = await toPng(node, {
          pixelRatio: 2,
          cacheBust: true,
          backgroundColor: '#ffffff'
        });
        if (i > 0) {
          doc.addPage();
        }
        doc.addImage(dataUrl, 'PNG', 0, 0, PAGE_WIDTH_MM, PAGE_HEIGHT_MM);
      }

      doc.save('multi-column-layout.pdf');
    } finally {
      setIsExporting(null);
    }
  }, [pages.length]);

  const handleExportImages = useCallback(async () => {
    if (!pages.length) {
      return;
    }
    setIsExporting('images');
    try {
      const zip = new JSZip();
      const validPages = pageRefs.current
        .slice(0, pages.length)
        .map((node) => node)
        .filter((node): node is HTMLDivElement => Boolean(node));

      for (let i = 0; i < validPages.length; i += 1) {
        const node = validPages[i];
        const dataUrl = await toPng(node, {
          pixelRatio: 2,
          cacheBust: true,
          backgroundColor: '#ffffff'
        });
        const base64 = dataUrl.split(',')[1];
        zip.file(`page-${i + 1}.png`, base64, { base64: true });
      }

      const blob = await zip.generateAsync({ type: 'blob' });
      saveAs(blob, 'multi-column-layout-pages.zip');
    } finally {
      setIsExporting(null);
    }
  }, [pages.length]);

  return (
    <main className="workspace">
      <aside className="sidebar">
        <h1 className="title">Multi-Column A4 Text Layout Maker</h1>
        <section className="panel">
          <label className="panel-label" htmlFor="text-input">
            Input Text
          </label>
          <textarea
            id="text-input"
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="text-input"
            placeholder="Paste your text here"
          />
        </section>

        <section className="panel">
          <h2 className="panel-title">Layout Controls</h2>
          <div className="panel-grid">
            <label className="control">
              <span>Columns</span>
              <input
                type="number"
                min={MIN_COLUMNS}
                max={MAX_COLUMNS}
                value={columns}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isNaN(value)) return;
                  const clamped = Math.min(Math.max(value, MIN_COLUMNS), MAX_COLUMNS);
                  setColumns(clamped);
                }}
              />
            </label>
            <label className="control">
              <span>Column Gap (mm)</span>
              <input
                type="number"
                min={0}
                step={0.5}
                value={gap}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isNaN(value)) {
                    setGap(Math.max(value, 0));
                  }
                }}
              />
            </label>
            <label className="control">
              <span>Font</span>
              <select value={fontFamily} onChange={(event) => setFontFamily(event.target.value)}>
                {FONT_OPTIONS.map((font) => (
                  <option key={font} value={font}>
                    {font}
                  </option>
                ))}
              </select>
            </label>
            <label className="control">
              <span>Font Size (pt)</span>
              <input
                type="number"
                min={6}
                max={72}
                value={fontSize}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isNaN(value)) {
                    setFontSize(Math.min(Math.max(value, 6), 96));
                  }
                }}
              />
            </label>
            <label className="control">
              <span>Line Spacing</span>
              <input
                type="number"
                step={0.1}
                min={1}
                max={3}
                value={lineSpacing}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isNaN(value)) {
                    setLineSpacing(Math.min(Math.max(value, 1), 4));
                  }
                }}
              />
            </label>
          </div>
        </section>

        <section className="panel">
          <h2 className="panel-title">Margins (mm)</h2>
          <div className="panel-grid panel-grid--four">
            {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
              <label key={side} className="control">
                <span>{side[0].toUpperCase() + side.slice(1)}</span>
                <input
                  type="number"
                  min={0}
                  max={40}
                  value={margins[side]}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isNaN(value)) {
                      setMargins((prev) => ({ ...prev, [side]: Math.max(value, 0) }));
                    }
                  }}
                />
              </label>
            ))}
          </div>
        </section>

        <section className="panel">
          <h2 className="panel-title">Column Widths</h2>
          <div className="mode-toggle">
            <button
              type="button"
              className={columnMode === 'equal' ? 'mode-button mode-button--active' : 'mode-button'}
              onClick={() => setColumnMode('equal')}
            >
              Equal
            </button>
            <button
              type="button"
              className={columnMode === 'custom' ? 'mode-button mode-button--active' : 'mode-button'}
              onClick={() => setColumnMode('custom')}
            >
              Custom
            </button>
          </div>

          {columnMode === 'custom' ? (
            <div className="column-widths">
              <p className="hint">
                Available width: {availableWidthMm.toFixed(2)} mm. Values are scaled by factor
                {' '}
                {metrics.customScale.toFixed(2)} to fit.
              </p>
              <div className="column-widths-list">
                {columnWidthsMm.map((value, index) => (
                  <label key={index} className="control">
                    <span>Col {index + 1}</span>
                    <input
                      type="number"
                      min={0.5}
                      step={0.5}
                      value={value}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        if (!Number.isNaN(next)) {
                          setColumnWidthsMm((prev) => {
                            const copy = [...prev];
                            copy[index] = Math.max(next, 0.5);
                            return copy;
                          });
                        }
                      }}
                    />
                  </label>
                ))}
              </div>
            </div>
          ) : (
            <p className="hint">Columns are automatically sized to fill the available width.</p>
          )}
        </section>

        <section className="panel">
          <h2 className="panel-title">Export</h2>
          <div className="export-actions">
            <button
              type="button"
              onClick={handleExportPdf}
              className="primary-button"
              disabled={isExporting === 'pdf'}
            >
              {isExporting === 'pdf' ? 'Preparing…' : 'Download PDF'}
            </button>
            <button
              type="button"
              onClick={handleExportImages}
              className="secondary-button"
              disabled={isExporting === 'images'}
            >
              {isExporting === 'images' ? 'Preparing…' : 'Download PNG (ZIP)'}
            </button>
          </div>
        </section>
      </aside>

      <section className="preview" ref={previewContainerRef}>
        <header className="preview-banner">
          <div>
            <strong>{pages.length}</strong> {pages.length === 1 ? 'page' : 'pages'} · {columns}{' '}
            {columns === 1 ? 'column' : 'columns'}
          </div>
          <div>A4 · Portrait · {fontFamily}</div>
        </header>
        <div className="pages">
          {pages.map((page, pageIndex) => (
            <div
              key={`page-${pageIndex}`}
              ref={(element) => {
                pageRefs.current[pageIndex] = element;
              }}
              className="page"
              style={{ width: metrics.pageWidthPx, height: metrics.pageHeightPx }}
            >
              <div className="page-inner">
                {page.columns.map((column, columnIndex) => (
                  <div
                    key={`page-${pageIndex}-col-${columnIndex}`}
                    className="page-column"
                    style={{
                      left: metrics.marginsPx.left + metrics.columnOffsetsPx[columnIndex],
                      top: metrics.marginsPx.top,
                      width: metrics.columnWidthsPx[columnIndex],
                      height: metrics.columnHeightPx,
                      fontFamily,
                      fontSize: `${metrics.fontSizePx}px`,
                      lineHeight: `${metrics.lineHeightPx}px`
                    }}
                  >
                    {column.lines.map((line, lineIndex) => (
                      <div
                        key={`line-${lineIndex}`}
                        className="page-line"
                        style={{ height: metrics.lineHeightPx, lineHeight: `${metrics.lineHeightPx}px` }}
                      >
                        {line}
                      </div>
                    ))}
                  </div>
                ))}
                <div
                  className="page-outline"
                  style={{
                    left: metrics.marginsPx.left,
                    top: metrics.marginsPx.top,
                    right: metrics.marginsPx.right,
                    bottom: metrics.marginsPx.bottom
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
};

export default HomePage;
