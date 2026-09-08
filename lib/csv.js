function csvEscape(value, delimiter) {
  const s = String(value ?? "");
  // Freepik's format always quotes every field, per their spec — quote
  // unconditionally when delimiter is ";" to match exactly.
  if (delimiter === ";") return `"${s.replace(/"/g, '""')}"`;
  if (new RegExp(`[",${delimiter}\n]`).test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, delimiter = ",") {
  return rows.map((row) => row.map((v) => csvEscape(v, delimiter)).join(delimiter)).join("\r\n");
}

// Adobe Stock (helpx.adobe.com — "Organize with CSV files"): Filename,
// Title, Keywords, Category, Releases. Required columns are Filename,
// Title, Keywords. Adobe also caps a single CSV at 5,000 rows and 1MB —
// batch above that into multiple files if you ever scale up that far.
export function buildAdobeStockCsv(items) {
  const header = ["Filename", "Title", "Keywords", "Category", "Releases"];
  const rows = [header];
  for (const it of items) {
    const meta = it.result.platforms.adobe_stock;
    const title = meta.title.replace(/,/g, "").slice(0, 70);
    rows.push([it.filename, title, meta.keywords.slice(0, 50).join(", "), "", ""]);
  }
  return toCsv(rows);
}

// Shutterstock: Filename, Description, Keywords, Categories, Illustration, Mature content, Editorial
export function buildShutterstockCsv(items) {
  const header = [
    "Filename",
    "Description",
    "Keywords",
    "Categories",
    "Illustration",
    "Mature content",
    "Editorial",
  ];
  const rows = [header];
  for (const it of items) {
    const meta = it.result.platforms.shutterstock;
    rows.push([
      it.filename,
      meta.title,
      meta.keywords.slice(0, 50).join(", "),
      "",
      "No",
      "No",
      "No",
    ]);
  }
  return toCsv(rows);
}

// Freepik official bulk-CSV spec (support.freepik.com — "How to create a
// csv file"): semicolon-delimited, every field double-quoted, columns
// File name;Title;Keywords, keywords stay comma-joined INSIDE the quoted
// keywords field. We emit CRLF + quote-everything here, matching what
// "CSV (MS-DOS)" export produces, so no extra save-as step is needed.
export function buildFreepikCsv(items) {
  const header = ["Filename", "Title", "Keywords"];
  const rows = [header];
  for (const it of items) {
    const meta = it.result.platforms.freepik_vecteezy;
    rows.push([it.filename, meta.title, meta.keywords.join(",")]);
  }
  return toCsv(rows, ";");
}

// Vecteezy official CSV spec (vecteezy.com blog — "Contributors: Use a CSV
// to Upload Metadata Faster" / eezycontributors Zendesk "CSV Metadata
// Upload"): standard comma-delimited CSV, columns in this exact order —
// Filename, Title, Description, Keywords. Unlike Freepik this is NOT
// semicolon-delimited and fields aren't force-quoted, so it can't just
// reuse buildFreepikCsv's output — that's why the two were failing when
// treated as one combined "freepik_vecteezy" export.
export function buildVecteezyCsv(items) {
  const header = ["Filename", "Title", "Description", "Keywords"];
  const rows = [header];
  for (const it of items) {
    const meta = it.result.platforms.freepik_vecteezy;
    const description = it.result.description || meta.title;
    rows.push([it.filename, meta.title, description, meta.keywords.join(", ")]);
  }
  return toCsv(rows, ",");
}

// iStock / Getty Images (via Getty's ESP CSV import + third-party tools
// like DeepMeta/PixTagger that document the same columns): File name,
// Created date, Title, Description, Country, Brief code, Keywords.
//
// IMPORTANT CAVEAT: Getty validates keywords against their own "controlled
// vocabulary" — a fixed, curated term list. Free-form AI keywords that
// aren't in that vocabulary can be rejected or flagged even when every
// column here is correctly formatted. Treat this CSV as a strong first
// draft to review/adjust inside Getty's own submission tool, not a
// guaranteed one-click import the way Adobe/Shutterstock/Freepik are.
export function buildIstockGettyCsv(items) {
  const header = ["File name", "Created date", "Title", "Description", "Country", "Brief code", "Keywords"];
  const rows = [header];
  for (const it of items) {
    const meta = it.result.platforms.istock_getty;
    rows.push([
      it.filename,
      "",
      meta.title,
      it.result.description || meta.title,
      "",
      "",
      meta.keywords.slice(0, 50).join(", "),
    ]);
  }
  return toCsv(rows);
}

export function downloadCsv(csvString, filename) {
  const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
