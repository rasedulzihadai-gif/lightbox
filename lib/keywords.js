// ─── Keyword quality analyzer ──────────────────────────────────────────
// Answers: "kon keyword valo, konta kharap?" — scores every platform's
// title + keywords and explains each verdict in plain language so the
// contributor knows exactly what to keep, fix, or delete before upload.
//
// Scoring (0-100):
//   starts at 100, then coverage bonuses are implicit (no deduction when
//   a layer is covered) and problems deduct:
//     hard-bad keyword (spam/rejected-type) .... -12 each (max -36)
//     duplicate keyword ........................ -6 each  (max -18)
//     weak/generic filler beyond allowance ..... -4 each  (max -20)
//     missing color coverage (<4) .............. -5 each  (max -20)
//     missing use-case coverage (<5) ........... -4 each  (max -20)
//     contradiction pair ....................... -8 each  (max -16)
//     title problem ............................ -5..-12
// Grades: A ≥85 · B ≥70 · C ≥55 · D ≥40 · F <40

export const PLATFORM_LIMITS = {
  adobe_stock:   { label: "Adobe Stock",        titleMax: 200, titleBest: 70,  noCommasInTitle: true,  kwMin: 5,  kwMax: 49, kwSweet: [25, 40] },
  shutterstock:  { label: "Shutterstock",       titleMax: 200, titleBest: 100, noCommasInTitle: false, kwMin: 7,  kwMax: 50, kwSweet: [30, 40] },
  istock_getty:  { label: "iStock / Getty",     titleMax: 200, titleBest: 120, noCommasInTitle: false, kwMin: 5,  kwMax: 50, kwSweet: [20, 30] },
  freepik_vecteezy: { label: "Freepik / Vecteezy", titleMax: 100, titleBest: 70, noCommasInTitle: false, kwMin: 5, kwMax: 50, kwSweet: [20, 25] },
};

// Single-word color names the analyzer recognizes (rule A coverage).
const COLOR_WORDS = new Set(
  "red,crimson,scarlet,maroon,burgundy,ruby,orange,amber,tangerine,coral,peach,yellow,gold,golden,mustard,lemon,green,emerald,mint,teal,olive,lime,jade,blue,navy,cobalt,azure,sky,turquoise,cyan,indigo,purple,violet,lavender,lilac,magenta,pink,rose,fuchsia,brown,bronze,copper,beige,tan,khaki,cream,ivory,white,silver,grey,gray,black,charcoal,slate,neon,pastel,multicolor,multicolored,colorful,monochrome".split(",")
);

// Fixed buyer use-case pool (rule B coverage) — must match the prompt.
export const USE_CASE_POOL = [
  "website background", "banner background", "social media background",
  "presentation background", "app background", "poster design",
  "phone wallpaper", "desktop wallpaper", "packaging design", "cover design",
  "print design", "book cover", "youtube thumbnail",
  "instagram story background", "brochure design", "flyer design",
  "product background", "greeting card", "invitation background", "header background",
];
const USE_CASE_SET = new Set(USE_CASE_POOL);

// Generic filler words: weak ranking power, keep at most a few (rule C).
const FILLER_WORDS = new Set(
  "modern,abstract,creative,art,artistic,aesthetic,style,stylish,element,elements,design,designed,structure,contemporary,visual,effect,effects,composition,surface,tech,digital,technology,technological,cyber,system,display,concept,concepts,image,images,photo,photos,picture,pictures,illustration,background,wallpaper,texture,pattern,template,graphic,graphics,cool,nice,fun,beautiful,pretty,lorem,ipsum".split(",")
);

// Hard-bad: file-type / platform-rejected tokens.
const FILETYPE_RE = /^(eps10?|psd|jpg|jpeg|png|svg|ai|cdr|tiff?|gif|bmp|pdf|zip|rar)$/i;
const HASHTAG_RE = /#/;
const BADCHAR_RE = /[;<>\\|]/;

// Contradiction pairs (rule D).
const CONTRADICTIONS = [
  ["vibrant", "pastel"], ["vivid", "pastel"], ["dark", "bright"], ["dark", "light"],
  ["black", "white"], ["retro", "futuristic"], ["retro", "modern"], ["vintage", "futuristic"],
  ["vintage", "modern"], ["vintage", "tech"], ["minimalist", "ornate"], ["minimal", "busy"],
  ["calm", "chaotic"], ["elegant", "grunge"], ["luxury", "grunge"], ["warm", "cool"],
  ["summer", "winter"], ["day", "night"], ["indoor", "outdoor"],
];

function findContradictions(keywords) {
  const present = new Set(keywords.map((k) => String(k).toLowerCase().trim()));
  // Match whole-word hits inside multi-word tags too ("dark background").
  const has = (w) => {
    if (present.has(w)) return true;
    for (const k of present) if (k.split(/\s+/).includes(w)) return true;
    return false;
  };
  return CONTRADICTIONS.filter(([a, b]) => has(a) && has(b));
}

export function analyzeKeywords(platformKey, title, keywords) {
  const limits = PLATFORM_LIMITS[platformKey] || PLATFORM_LIMITS.freepik_vecteezy;
  const kws = (keywords || []).map((k) => String(k ?? "").trim()).filter(Boolean);
  const lower = kws.map((k) => k.toLowerCase());

  const good = [];   // { kw, index, reasons[] }
  const weak = [];   // { kw, index, reasons[] }
  const bad = [];    // { kw, index, reasons[] }
  const suggestions = [];
  let score = 100;

  // — Duplicates (case-insensitive): every repeat is bad.
  const seen = new Set();
  const dupeIdx = new Set();
  lower.forEach((k, i) => {
    if (seen.has(k)) dupeIdx.add(i);
    else seen.add(k);
  });

  // — Per-keyword verdicts.
  let fillerCount = 0;
  kws.forEach((kw, i) => {
    const l = lower[i];
    const reasonsBad = [];
    const reasonsWeak = [];
    const reasonsGood = [];

    if (dupeIdx.has(i)) reasonsBad.push("Duplicate — repeated tags are ignored or penalized");
    if (!kw) reasonsBad.push("Empty keyword");
    if (HASHTAG_RE.test(kw)) reasonsBad.push("Hashtag — Freepik/Shutterstock reject #tags");
    if (FILETYPE_RE.test(kw.replace(/^\./, ""))) reasonsBad.push("File-type word — platforms reject these");
    if (BADCHAR_RE.test(kw)) reasonsBad.push("Contains ; < > \\ or | — breaks CSV / rejected");
    if (kw.length > 50) reasonsBad.push("Too long — split into shorter tags");
    if (/^\d+$/.test(kw)) reasonsBad.push("Numbers alone are not searchable");
    if (/[^\x00-\x7F]/.test(kw)) reasonsWeak.push("Non-English characters — stock search is English-first");

    const words = l.split(/\s+/);
    const isSingle = words.length === 1;
    if (USE_CASE_SET.has(l)) {
      reasonsGood.push("Buyer use-case phrase — high download intent");
    } else if (COLOR_WORDS.has(l) && isSingle) {
      reasonsGood.push("Color tag — buyers filter by color");
    } else if (FILLER_WORDS.has(l) && isSingle) {
      fillerCount += 1;
      reasonsWeak.push("Generic filler — weak ranking power, keep only a few");
    } else if (!isSingle && l.length >= 6) {
      reasonsGood.push("Specific buyer phrase");
    } else if (isSingle && l.length >= 3) {
      reasonsGood.push("Specific single tag");
    }
    if (isSingle && l.endsWith("s") && l.length > 4 && !/(ss|us|is)$/.test(l)) {
      reasonsWeak.push("Plural form — singular ranks better on Freepik");
    }

    if (reasonsBad.length > 0) bad.push({ kw, index: i, reasons: reasonsBad });
    else if (reasonsWeak.length > 0) weak.push({ kw, index: i, reasons: reasonsWeak });
    else good.push({ kw, index: i, reasons: reasonsGood.length ? reasonsGood : ["Relevant tag"] });
  });

  // — Deductions (each capped so one problem can't nuke the score).
  const applyCap = (count, per, max) => Math.min(count * per, max);
  score -= applyCap(bad.length, 12, 36);
  const dupeCount = dupeIdx.size;
  score -= applyCap(dupeCount, 6, 18);
  const excessFiller = Math.max(0, fillerCount - 6);
  score -= applyCap(excessFiller, 4, 20);

  // — Coverage: colors (rule A).
  const colorHits = lower.filter((k) => COLOR_WORDS.has(k));
  if (colorHits.length < 4) {
    score -= Math.min((4 - colorHits.length) * 5, 20);
    suggestions.push(`Add ${4 - colorHits.length} more color tag${4 - colorHits.length > 1 ? "s" : ""} buyers actually filter by (only ${colorHits.length} found).`);
  }

  // — Coverage: use-case (rule B). iStock is literal-first, so softer there.
  const useHits = lower.filter((k) => USE_CASE_SET.has(k));
  const useNeed = platformKey === "istock_getty" ? 3 : 5;
  if (useHits.length < useNeed) {
    score -= Math.min((useNeed - useHits.length) * 4, 20);
    suggestions.push(`Add ${useNeed - useHits.length} more buyer use-case phrase${useNeed - useHits.length > 1 ? "s" : ""} (e.g. ${USE_CASE_POOL.filter((u) => !useHits.includes(u)).slice(0, 3).join(", ")}).`);
  }

  // — Contradictions (rule D).
  const contras = findContradictions(kws);
  contras.forEach(([a, b]) => {
    score -= 8;
    suggestions.push(`Contradiction: "${a}" + "${b}" pull opposite ways — remove the one that fits less.`);
  });
  score = Math.max(score, 0);
  if (contras.length > 2) score = Math.min(score + (contras.length - 2) * 8, 100); // cap at 2 pairs

  // — Count checks.
  if (kws.length < limits.kwMin) {
    score -= 12;
    suggestions.push(`Only ${kws.length} keywords — ${limits.label} needs at least ${limits.kwMin}. Regenerate.`);
  } else if (kws.length > limits.kwMax) {
    score -= 5;
    suggestions.push(`${kws.length} keywords — over the ${limits.kwMax} max, extras get trimmed on export.`);
  } else if (kws.length < limits.kwSweet[0]) {
    suggestions.push(`${kws.length} keywords is OK, but ${limits.kwSweet[0]}-${limits.kwSweet[1]} relevant tags is the download sweet spot on ${limits.label}.`);
  }

  // — Title checks.
  const titleChecks = [];
  const t = String(title || "");
  if (!t.trim()) {
    score -= 12;
    titleChecks.push({ ok: false, text: "Title is empty." });
  } else {
    if (t.length > limits.titleMax) {
      score -= 10;
      titleChecks.push({ ok: false, text: `Title is ${t.length} chars — max ${limits.titleMax}, it will be trimmed.` });
    } else if (t.length > limits.titleBest) {
      score -= 3;
      titleChecks.push({ ok: true, text: `Title is ${t.length} chars — under max, but ≤${limits.titleBest} ranks best.` });
    } else if (t.length < 15) {
      score -= 5;
      titleChecks.push({ ok: false, text: `Title is very short (${t.length} chars) — add subject + color + layout.` });
    } else {
      titleChecks.push({ ok: true, text: `Title length ${t.length} chars — good.` });
    }
    if (limits.noCommasInTitle && t.includes(",")) {
      score -= 8;
      titleChecks.push({ ok: false, text: "Adobe titles must not contain commas — they break the CSV columns." });
    }
    if (/[#;]/.test(t)) {
      score -= 5;
      titleChecks.push({ ok: false, text: "Title contains # or ; — platforms reject these." });
    }
    if (/\b(eps10?|psd|jpg|jpeg|png)\b/i.test(t)) {
      score -= 5;
      titleChecks.push({ ok: false, text: "Title mentions a file type — remove it." });
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : score >= 40 ? "D" : "F";

  if (bad.length === 0 && weak.length <= 3 && contras.length === 0 && suggestions.length === 0) {
    suggestions.push("Excellent — this set is upload-ready. Keep the strongest tags first.");
  }

  return {
    score, grade, good, weak, bad,
    fillerCount, colorHits: colorHits.length, useHits: useHits.length,
    contradictions: contras, titleChecks, suggestions: suggestions.slice(0, 6),
    counts: { total: kws.length, good: good.length, weak: weak.length, bad: bad.length },
  };
}

export function gradeColor(grade) {
  if (grade === "A") return "var(--success)";
  if (grade === "B") return "var(--success)";
  if (grade === "C") return "var(--warning)";
  if (grade === "D") return "var(--warning)";
  return "var(--danger)";
}
