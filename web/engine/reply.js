/* Reply parsing. The LLM is asked for ONE JSON object:

     {"line": {"en": "...", "ja": "..."}, "emotion": "<pack emotion>",
      "verdict": "loved|liked|neutral|annoyed", "state": {}}

   Everything here is tolerant: fenced JSON, prose around it, a bare string
   instead of a per-language object, a missing field. A reply with no JSON at all
   still produces a usable line (the raw text) so a weak model never blanks the
   screen — it just earns no verdict and keeps the current face. */
(function (global) {
  'use strict';

  var FENCE_RE = /```(?:json)?\s*([\s\S]*?)\s*```/;

  /* Port of town.exe claude_client.extract_json: first balanced object/array. */
  function extractJson(text) {
    if (!text) return null;
    var m = FENCE_RE.exec(text);
    var cand = m ? m[1] : String(text);
    try { return JSON.parse(cand.trim()); } catch (e) {}
    var pairs = [['{', '}'], ['[', ']']], p, start, depth, i, ch;
    for (p = 0; p < pairs.length; p++) {
      start = cand.indexOf(pairs[p][0]);
      if (start === -1) continue;
      depth = 0;
      for (i = start; i < cand.length; i++) {
        ch = cand[i];
        if (ch === pairs[p][0]) depth++;
        else if (ch === pairs[p][1]) {
          depth--;
          if (depth === 0) {
            try { return JSON.parse(cand.slice(start, i + 1)); } catch (e) { break; }
          }
        }
      }
    }
    return null;
  }

  function clean(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  /* Port of town.exe localize_reasoning: (canonical, {lang: text}).
     A string means "one language"; an object is per-language. The first
     requested language is canonical; empty slots fall back to it. */
  function localize(raw, langs) {
    var by = {}, first = langs[0] || 'en', k;
    if (raw && typeof raw === 'object') {
      for (k in raw) if (raw.hasOwnProperty(k)) by[k] = clean(raw[k]);
      var canon = by[first] || '';
      if (!canon) for (k in by) if (by[k]) { canon = by[k]; break; }
      var missing = [];
      langs.forEach(function (lg) { if (!by[lg]) { by[lg] = canon; missing.push(lg); } });
      by[first] = canon;
      return { text: canon, by: by, missing: missing };
    }
    var s = clean(raw);
    langs.forEach(function (lg) { by[lg] = s; });
    return { text: s, by: by, missing: langs.slice(1) };
  }

  var Reply = {
    extractJson: extractJson,
    localize: localize,

    /* opts: { langs: ['en','ja'], emotions: [...allowed], verdicts: [...] } */
    parse: function (text, opts) {
      opts = opts || {};
      var langs = (opts.langs && opts.langs.length) ? opts.langs : ['en'];
      var emotions = opts.emotions || [];
      var verdicts = opts.verdicts || (global.Affection ? Affection.VERDICTS : ['loved', 'liked', 'neutral', 'annoyed']);
      var raw = String(text || '');
      var j = extractJson(raw);
      var out = { ok: false, text: '', by: {}, emotion: null, verdict: 'neutral', state: null, raw: raw };

      if (!j || typeof j !== 'object' || Array.isArray(j)) {
        /* No JSON: speak the raw text, strip a stray fence, no verdict. */
        var loc = localize(raw.replace(FENCE_RE, '$1'), langs);
        out.text = loc.text; out.by = loc.by; out.missing = loc.missing || [];
        out.ok = !!out.text;
        out.degraded = true;
        return out;
      }

      var lineRaw = j.line != null ? j.line : (j.reasoning != null ? j.reasoning : (j.text != null ? j.text : j.reply));
      var loc2 = localize(lineRaw, langs);
      out.text = loc2.text; out.by = loc2.by; out.missing = loc2.missing || [];

      var em = clean(j.emotion).toLowerCase();
      if (em && (!emotions.length || emotions.indexOf(em) !== -1)) out.emotion = em;

      var vd = clean(j.verdict).toLowerCase();
      out.verdict = verdicts.indexOf(vd) !== -1 ? vd : 'neutral';

      if (j.state && typeof j.state === 'object' && !Array.isArray(j.state)) out.state = j.state;

      out.ok = !!out.text;
      return out;
    }
  };

  global.Reply = Reply;
})(typeof window !== 'undefined' ? window : globalThis);
