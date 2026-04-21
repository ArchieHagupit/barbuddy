// JSON extraction + repair — handles malformed AI JSON output.
// Extracted from server.js — behavior unchanged.
// 5-strategy defense: control-char sanitize, markdown fence strip,
// brace-matched extraction, aggressive repair, jsonrepair fallback.

const { jsonrepair } = require('jsonrepair');

function extractJSON(text) {
  if (!text) return null;

  // ── Minimal sanitization (safe for all inputs) ─────────────
  // Only BOM + control characters. Preserves string boundaries, braces, everything else.
  const minSanitized = text
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();

  // ── Strategy 1: Direct parse on minimally-sanitized input ──
  // Well-formed JSON succeeds here without going through fragile transforms.
  // This is the common case — the AI produces valid JSON.
  try {
    const parsed = JSON.parse(minSanitized);
    return parsed;
  } catch(e) {
    const pos = parseInt(e.message.match(/position (\d+)/)?.[1]);
    if (!isNaN(pos)) {
      const contextStart = Math.max(0, pos - 30);
      const contextEnd = Math.min(minSanitized.length, pos + 30);
      console.warn('[extractJSON] Strategy 1 failed:', e.message, '| char code at pos:', minSanitized.charCodeAt(pos), '| context:', JSON.stringify(minSanitized.slice(contextStart, contextEnd)));
    } else {
      console.warn('[extractJSON] Strategy 1 failed:', e.message);
    }
  }

  // ── Strategy 2: Safe transforms then parse ─────────────────
  // Rewrites bogus escape sequences + markdown fence strip + NaN/Infinity fix +
  // trailing comma fix. None of these affect string-boundary detection.
  let t2 = minSanitized
    .replace(/\\'/g,  "'")   // \' → '
    .replace(/\\s/g,  "s")   // \s → s
    .replace(/\\d/g,  "d")   // \d → d
    .replace(/\\w/g,  "w")   // \w → w
    .replace(/\\-/g,  "-")   // \- → -
    .replace(/\\%/g,  "%")   // \% → %
    .replace(/\\&/g,  "&")   // \& → &
    .replace(/\\\(/g, "(")   // \( → (
    .replace(/\\\)/g, ")")   // \) → )
    .replace(/\\\./g, ".")   // \. → .
    .replace(/\\,/g,  ",")   // \, → ,
    .replace(/\\:/g,  ":")   // \: → :
    .replace(/\\;/g,  ";");  // \; → ;

  t2 = t2
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  t2 = t2
    .replace(/,\s*}/g, '}')
    .replace(/,\s*]/g, ']')
    .replace(/:\s*NaN/g, ': null')
    .replace(/:\s*Infinity/g, ': null')
    .replace(/:\s*undefined/g, ': null');

  try {
    const parsed = JSON.parse(t2);
    console.log('[extractJSON] Strategy 2 (safe transforms) succeeded');
    return parsed;
  } catch(_) { /* fall through */ }

  // ── Strategy 3: Brace-matched extraction (string-aware) ─────
  // Finds the outermost balanced { ... } and tries parsing just that slice.
  // Handles cases where the AI added trailing explanation text after the JSON.
  {
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < t2.length; i++) {
      const ch = t2[i];
      if (esc)          { esc = false; continue; }
      if (ch === '\\')  { esc = true;  continue; }
      if (ch === '"')   { inStr = !inStr; continue; }
      if (inStr)        continue;
      if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0 && start !== -1) {
          try {
            const parsed = JSON.parse(t2.slice(start, i + 1));
            console.log('[extractJSON] Strategy 3 (brace-match) succeeded');
            return parsed;
          } catch(_) { break; }
        }
      }
    }
  }

  // ── Strategy 4: Strip in-string { } then parse ─────────────
  // Most aggressive character-stripping repair. Only runs here, NOT as early
  // preprocessing — earlier runs could corrupt well-formed JSON if an earlier
  // unescaped quote confused the string-tracking state.
  //
  // Also: if there are an odd number of unescaped " in the text, the
  // string-tracking is fundamentally ambiguous — skip this strategy and
  // let Strategy 5/6 try repair instead.
  const quoteCount = (t2.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 === 0) {
    const stripped = sanitizeNestedBraces(t2);
    try {
      const parsed = JSON.parse(stripped);
      console.log('[extractJSON] Strategy 4 (strip in-string braces) succeeded');
      return parsed;
    } catch(_) { /* fall through */ }
  } else {
    console.warn('[extractJSON] Strategy 4 skipped — odd number of unescaped quotes suggests unbalanced string state');
  }

  // ── Strategy 5: Custom repairJSON then parse ───────────────
  try {
    const repaired = repairJSON(t2);
    if (repaired) {
      const parsed = JSON.parse(repaired);
      console.log('[extractJSON] Strategy 5 (repairJSON) succeeded');
      return parsed;
    }
  } catch(_) { /* fall through */ }

  // ── Strategy 6: jsonrepair library as last resort ──────────
  try {
    const repaired = jsonrepair(t2);
    const parsed = JSON.parse(repaired);
    if (parsed && typeof parsed === 'object') {
      console.log('[extractJSON] Strategy 6 (jsonrepair) succeeded');
      return parsed;
    }
  } catch(e) {
    console.warn('[extractJSON] Strategy 6 (jsonrepair) failed:', e.message);
  }

  // All strategies exhausted — log enough context to diagnose
  console.error('[extractJSON] All strategies failed. Length:', t2.length, '| First 500 chars:', t2.slice(0, 500));
  console.error('[extractJSON] All strategies failed. Last 300 chars:', t2.slice(-300));
  return null;
}

// Strip { } inside quoted string values. Character-by-character walk so
// structural braces are preserved and escaped quotes are handled correctly.
// Called only by Strategy 4 in extractJSON.
function sanitizeNestedBraces(str) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escaped) { result += ch; escaped = false; continue; }
    if (ch === '\\') { escaped = true; result += ch; continue; }
    if (ch === '"') { inString = !inString; result += ch; continue; }
    if (inString && ch === '{') { result += ''; continue; }
    if (inString && ch === '}') { result += ''; continue; }
    result += ch;
  }
  return result;
}

function repairJSON(text) {
  if (!text) return null;
  let t = text.replace(/^\uFEFF/, '').trim();

  // Strip markdown fences
  t = t.replace(/^```(?:json)?[\r\n]*/i, '').replace(/[\r\n]*```[\s\S]*$/i, '').trim();

  // Find outermost braces
  const start = t.indexOf('{');
  const end   = t.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  t = t.slice(start, end + 1);

  // Fix 1: Remove trailing commas before } or ]
  t = t.replace(/,(\s*[}\]])/g, '$1');

  // Fix 2: Escape unescaped control chars inside strings (char-by-char)
  let result = '', inStr = false, escaped = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i], code = t.charCodeAt(i);
    if (escaped)       { result += ch; escaped = false; continue; }
    if (ch === '\\')   { result += ch; escaped = true;  continue; }
    if (ch === '"')    { inStr = !inStr; result += ch; continue; }
    if (inStr) {
      if      (code === 10) result += '\\n';
      else if (code === 13) result += '\\r';
      else if (code === 9)  result += '\\t';
      else result += ch;
    } else {
      result += ch;
    }
  }

  // Fix 3: Close any open string and open braces (handles truncation)
  let depth = 0, inString = false, isEscaped = false;
  for (let i = 0; i < result.length; i++) {
    const ch = result[i];
    if (isEscaped)    { isEscaped = false; continue; }
    if (ch === '\\')  { isEscaped = true;  continue; }
    if (ch === '"')   { inString = !inString; continue; }
    if (!inString) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
    }
  }
  if (inString) result += '"';
  while (depth > 0) { result += '}'; depth--; }

  return result;
}

function sanitizeAIResponse(text) {
  if (!text) return text;
  return text
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

module.exports = { extractJSON, repairJSON, sanitizeAIResponse };
