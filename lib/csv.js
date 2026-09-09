// ─── Shared CSV helpers ────────────────────────────────────────────────

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

function dedupeCaseInsensitive(list) {
  const seen = new Set();
  const out = [];
  for (const kw of list) {
    const key = String(kw).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(String(kw).trim());
  }
  return out;
}

// ─── Freepik / Magnific ────────────────────────────────────────────────
// Official bulk-CSV spec (support.freepik.com — "How to create a csv file",
// contributor panel template, and the field behavior documented by
// photokeyworder.ai's 2026 contributor guide):
//   • semicolon-delimited, every field double-quoted, CRLF line endings
//     (this is what Excel's "CSV (MS-DOS)" save produces)
//   • header is EXACTLY:  File name;Title;Keywords
//     (+ optional Prompt;Model columns for AI-generated content)
//   • keywords stay comma-joined WITHOUT spaces INSIDE the quoted field:
//     "sunset,sun,summer,beach,mountain"
//   • title: max 100 chars, no file-type mentions, no special characters
//   • keywords: 5-50 per asset (sweet spot ~20-25), English, no hashtags,
//     no file types, no special characters
//   • File name must match the uploaded file, extension included
//
// The most common upload errors this builder guards against:
//   1. wrong header ("Filename" instead of "File name") → rejected outright
//   2. comma used as the field delimiter instead of ";" → won't parse
//   3. stray ";" or newline inside title/keywords → breaks column alignment
//   4. title longer than 100 chars → rejected row
//   5. fewer than 5 or more than 50 keywords → rejected row

export const FREEPIK_TITLE_MAX = 100;
export const FREEPIK_KW_MIN = 5;
export const FREEPIK_KW_MAX = 50;
export const FREEPIK_AI_TAG = "_ai_generated";

export function sanitizeFreepikTitle(title) {
  let t = String(title ?? "")
    .replace(/[\r\n]+/g, " ") // newlines would break the row
    .replace(/;/g, ",") // ";" would break column alignment
    .replace(/\s+/g, " ")
    .trim();
  // Strip file-type mentions ("EPS10", ".jpg", ...) — Freepik rejects these.
  t = t.replace(/\b(eps10|eps|psd|jpg|jpeg|png|svg|ai file|vector file)\b\.?/gi, "").replace(/\s+/g, " ").trim();
  if (t.length > FREEPIK_TITLE_MAX) {
    // Truncate at the last word boundary that fits, avoid cutting mid-word.
    const cut = t.slice(0, FREEPIK_TITLE_MAX);
    const lastSpace = cut.lastIndexOf(" ");
    t = (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim();
  }
  return t;
}

export function sanitizeFreepikKeyword(kw) {
  return String(kw ?? "")
    .replace(/[\r\n;]+/g, " ") // ";" / newline would corrupt the CSV structure
    .replace(/#/g, "") // hashtags are rejected by Freepik
    .replace(/\s+/g, " ")
    .trim();
}

const FREEPIK_FILENAME_RISKY = /[,;.!'()\[\]{}@#$^+=\/\\]/;

export function sanitizeFreepikKeywords(keywords, { aiGenerated = false } = {}) {
  let list = (keywords || [])
    .map(sanitizeFreepikKeyword)
    .filter(Boolean)
    // Drop file-type keywords ("EPS10", "jpg", ...) — rejected by Freepik.
    .filter((kw) => !/^(eps10?|psd|jpg|jpeg|png|svg|ai|cdr)$/i.test(kw));
  list = dedupeCaseInsensitive(list);
  if (aiGenerated && !list.some((kw) => kw.toLowerCase() === FREEPIK_AI_TAG)) {
    list.push(FREEPIK_AI_TAG); // mandatory tag for AI content
  }
  return list.slice(0, FREEPIK_KW_MAX);
}

// Validate rows BEFORE export so the UI can show exactly what Freepik
// would reject, instead of the user discovering it after upload.
export function validateFreepikRows(items, { aiGenerated = false } = {}) {
  const issues = [];
  items.forEach((it, i) => {
    const rowNo = i + 1;
    const meta = it.result?.platforms?.freepik_vecteezy;
    if (!meta) {
      issues.push({ row: rowNo, filename: it.filename, level: "error", message: "No metadata generated for this image yet." });
      return;
    }
    const filename = String(it.filename || "").trim();
    if (!filename) {
      issues.push({ row: rowNo, filename: "(missing)", level: "error", message: "Filename is empty." });
    } else {
      if (!/\.[a-z0-9]+$/i.test(filename)) {
        issues.push({ row: rowNo, filename, level: "error", message: "Filename has no extension — Freepik matches rows by full name including .jpg." });
      }
      if (FREEPIK_FILENAME_RISKY.test(filename.replace(/\.[a-z0-9]+$/i, ""))) {
        issues.push({ row: rowNo, filename, level: "warning", message: "Filename contains , ; . or symbols — Freepik renames these on upload, which can break CSV matching. Prefer letters, numbers, _ and -." });
      }
    }
    const title = sanitizeFreepikTitle(meta.title);
    if (!title) {
      issues.push({ row: rowNo, filename, level: "error", message: "Title is empty after cleanup." });
    } else if (title.length < 10) {
      issues.push({ row: rowNo, filename, level: "warning", message: `Title is very short (${title.length} chars) — descriptive titles rank better.` });
    }
    if (String(meta.title || "").length > FREEPIK_TITLE_MAX) {
      issues.push({ row: rowNo, filename, level: "warning", message: `Title was ${meta.title.length} chars — auto-trimmed to ${FREEPIK_TITLE_MAX}.` });
    }
    const kws = sanitizeFreepikKeywords(meta.keywords, { aiGenerated });
    if (kws.length < FREEPIK_KW_MIN) {
      issues.push({ row: rowNo, filename, level: "error", message: `Only ${kws.length} usable keywords — Freepik needs at least ${FREEPIK_KW_MIN}. Regenerate this image.` });
    } else if (kws.length < 15) {
      issues.push({ row: rowNo, filename, level: "warning", message: `Only ${kws.length} keywords — 20-25 relevant tags is the download sweet spot.` });
    }
    if ((meta.keywords || []).length > FREEPIK_KW_MAX) {
      issues.push({ row: rowNo, filename, level: "warning", message: `${meta.keywords.length} keywords generated — trimmed to ${FREEPIK_KW_MAX} (Freepik max).` });
    }
    const dupes = (meta.keywords || []).length - dedupeCaseInsensitive(meta.keywords || []).length;
    if (dupes > 0) {
      issues.push({ row: rowNo, filename, level: "warning", message: `${dupes} duplicate keyword${dupes > 1 ? "s" : ""} removed automatically.` });
    }
  });
  return issues;
}

export function buildFreepikCsv(items, { aiGenerated = false, prompt = "", model = "" } = {}) {
  // NOTE: header MUST be "File name" (with a space). "Filename" is rejected.
  const header = aiGenerated
    ? ["File name", "Title", "Keywords", "Prompt", "Model"]
    : ["File name", "Title", "Keywords"];
  const rows = [header];
  for (const it of items) {
    const meta = it.result.platforms.freepik_vecteezy;
    const title = sanitizeFreepikTitle(meta.title);
    const keywords = sanitizeFreepikKeywords(meta.keywords, { aiGenerated }).join(","); // NO spaces — matches Freepik's own example
    const row = [String(it.filename).trim(), title, keywords];
    if (aiGenerated) {
      row.push(
        String(prompt || "").replace(/[\r\n;]+/g, " ").trim(),
        String(model || "").replace(/[\r\n;]+/g, " ").trim()
      );
    }
    rows.push(row);
  }
  return toCsv(rows, ";");
}

// ─── Adobe Stock ───────────────────────────────────────────────────────
// (helpx.adobe.com — "Organize with CSV files"): Filename, Title,
// Keywords, Category, Releases. Required: Filename, Title, Keywords.
// Title: NO commas, best <= 70 chars. Keywords: 5-49.
// Adobe also caps a single CSV at 5,000 rows and 1MB.
export function buildAdobeStockCsv(items) {
  const header = ["Filename", "Title", "Keywords", "Category", "Releases"];
  const rows = [header];
  for (const it of items) {
    const meta = it.result.platforms.adobe_stock;
    const title = String(meta.title).replace(/,/g, "").replace(/\s+/g, " ").trim().slice(0, 70);
    rows.push([it.filename, title, dedupeCaseInsensitive(meta.keywords).slice(0, 49).join(", "), "", ""]);
  }
  return toCsv(rows);
}

// ─── Shutterstock ──────────────────────────────────────────────────────
// Filename, Description, Keywords, Categories, Illustration,
// Mature content, Editorial. Keywords: 7-50.
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
      dedupeCaseInsensitive(meta.keywords).slice(0, 50).join(", "),
      "",
      "No",
      "No",
      "No",
    ]);
  }
  return toCsv(rows);
}

// ─── Vecteezy ──────────────────────────────────────────────────────────
// Official CSV spec (vecteezy.com blog — "Contributors: Use a CSV to
// Upload Metadata Faster" / eezycontributors Zendesk "CSV Metadata
// Upload"): standard comma-delimited CSV, columns in this exact order —
// Filename, Title, Description, Keywords. Their own example joins
// keywords with bare commas ("abstract,icons,flat,..."), so we do the
// same. Unlike Freepik this is NOT semicolon-delimited and fields
// aren't force-quoted.
export function buildVecteezyCsv(items) {
  const header = ["Filename", "Title", "Description", "Keywords"];
  const rows = [header];
  for (const it of items) {
    const meta = it.result.platforms.freepik_vecteezy;
    const description = it.result.description || meta.title;
    rows.push([it.filename, meta.title, description, dedupeCaseInsensitive(meta.keywords).join(",")]);
  }
  return toCsv(rows, ",");
}

// ─── iStock / Getty Images ─────────────────────────────────────────────
// (via Getty's ESP CSV import + third-party tools like DeepMeta /
// PixTagger that document the same columns): File name, Created date,
// Title, Description, Country, Brief code, Keywords.
//
// IMPORTANT CAVEAT: Getty validates keywords against their own
// "controlled vocabulary" — a fixed, curated term list. Free-form AI
// keywords that aren't in that vocabulary can be rejected or flagged
// even when every column here is correctly formatted. Treat this CSV
// as a strong first draft to review/adjust inside Getty's own
// submission tool, not a guaranteed one-click import the way
// Adobe/Shutterstock/Freepik are.
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
      dedupeCaseInsensitive(meta.keywords).slice(0, 50).join(", "),
    ]);
  }
  return toCsv(rows);
}

export function downloadCsv(csvString, filename) {
  // No BOM on purpose: several stock parsers match the header row
  // byte-for-byte, and a BOM would corrupt that first header cell.
  const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
