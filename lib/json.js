// JSON extraction + repair — handles malformed AI JSON output.
// Extracted from server.js — behavior unchanged.
// 5-strategy defense: control-char sanitize, markdown fence strip,
// brace-matched extraction, aggressive repair, jsonrepair fallback.

const { jsonrepair } = require('jsonrepair');

function extractJSON(text) {
  if (!text) return null;

  // Sanitize: remove BOM and control characters before anything else
  let t = text
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();

  // Fix invalid JSON escape sequences that AI models emit
  t = t
    .replace(/\\'/g,  "'")   // \' → '
    .replace(/\\s/g,  "s")   // \s → s
    .replace(/\\d/g,  "d")   // \d → d
    .replace(/\\w/g,  "w")   // \w → w
    .replace(/\\-/g,  "-")   // \- → -
    .replace(/\\%/g,  "%")   // \% → %
    .replace(/\\&/g,  "&")   // \& → &
    .replace(/\\\(/g, "(")   // \( → (
    .replace(/\\\)/g, ")")   // \) → )
    .replace(/\\\./g, ".")   // \. → .  (note: /\\./ would match any char — use /\\\. /)
    .replace(/\\,/g,  ",")   // \, → ,
    .replace(/\\:/g,  ":")   // \: → :
    .replace(/\\;/g,  ";");  // \; → ;

  // Strip { } inside quoted string values using a character-by-character walk so
  // structural braces are preserved and escaped quotes are handled correctly.
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
  t = sanitizeNestedBraces(t);

  // Fix trailing commas before closing braces/brackets
  t = t.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');

  // Fix non-JSON numeric literals
  t = t.replace(/:\s*NaN/g, ': null').replace(/:\s*Infinity/g, ': null').replace(/:\s*undefined/g, ': null');

  // Strip markdown fences (Sonnet fallback returns ```json ... ```)
  t = t
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  // Strategy 1: Direct parse
  try {
    return JSON.parse(t);
  } catch(e) {
    const pos = parseInt(e.message.match(/position (\d+)/)?.[1]);
    if (!isNaN(pos)) {
      console.warn('[extractJSON] Strategy 1 failed:', e.message, '| char code at pos:', t.charCodeAt(pos));
    } else {
      console.warn('[extractJSON] Strategy 1 failed:', e.message);
    }
  }

  // Strategy 2: Strip markdown fences (secondary pass on original t)
  let stripped = t
    .replace(/^```(?:json)?[\r\n]*/i, '')
    .replace(/[\r\n]*```[\s\S]*$/i, '')
    .trim();
  try { return JSON.parse(stripped); } catch(_) {}

  // Strategy 3: Brace-matched extraction (string-aware, handles trailing text)
  {
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
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
          try { return JSON.parse(t.slice(start, i + 1)); } catch(_) { break; }
        }
      }
    }
  }

  // Strategy 4: Aggressive repair then parse
  try {
    const repaired = repairJSON(t);
    if (repaired) return JSON.parse(repaired);
  } catch(_) {}

  // Strategy 5: jsonrepair as last resort (handles structural issues)
  try {
    const { jsonrepair } = require('jsonrepair');
    const repaired = jsonrepair(t);
    const parsed = JSON.parse(repaired);
    if (parsed && typeof parsed === 'object') {
      console.log('[extractJSON] Strategy 5 (jsonrepair) succeeded');
      return parsed;
    }
  } catch(e) {
    console.warn('[extractJSON] Strategy 5 (jsonrepair) failed:', e.message);
  }

  console.error('[extractJSON] All strategies failed. First 300 chars:', t.slice(0, 300));
  return null;
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
