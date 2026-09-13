/* TTS provider: OmniVoice (k2-fsa) FastAPI server. Ported from town.exe
   backend/voice/omnivoice.py.

   Contract (OmniVoice Studio, server/app.py):
     POST {base}/synthesize {text, ref_audio?, instruct?, language?, guidance_scale?, asmr?}
       -> {audio_url: "/audio/<file>.wav", duration, rtf}
     GET  {base}{audio_url} -> WAV bytes
     GET  {base}/health -> {status, model, cuda}

   Config section "omnivoice": {baseUrl, guidanceScale, timeout, language}.
   Per-character voice comes from card.voice {ref_audio, instruct}; ref_audio is
   a path ON THE OMNIVOICE HOST under its allowed reference directories.

   ASMR mode (opts.mode === 'asmr') swaps in card.voice.asmr_ref (a whisper
   recording of the same voice) when the card has one, otherwise falls back
   to the normal voice with the soft post-processing only;
   card.voice.asmr_fx picks the server-side post-processing preset
   (close | room | drift, default drift). Pure: see voiceFor(). */
(function (global) {
  'use strict';

  var TILDES = /[~\uFF5E\u301C\u3030]+/g;   // ~ ～ 〜 〰 — read aloud otherwise
  var MAX_CHARS = 600;

  function cleanForTts(text) { return String(text || '').replace(TILDES, ''); }

  /* Cap without ever cutting mid-sentence: sentence end → clause → word. */
  function truncate(text, max) {
    max = max || MAX_CHARS;
    text = String(text || '').trim();
    if (text.length <= max) return text;
    var cut = text.slice(0, max), best = -1;
    ['. ', '! ', '? ', '\u3002', '\uFF01', '\uFF1F'].forEach(function (s) { best = Math.max(best, cut.lastIndexOf(s)); });
    if (best > 40) return cut.slice(0, best + 1).trim();
    best = -1;
    [', ', '; ', ': ', ' \u2014 ', '\u3001'].forEach(function (s) { best = Math.max(best, cut.lastIndexOf(s)); });
    if (best > 40) return cut.slice(0, best).trim();
    var sp = cut.lastIndexOf(' ');
    return (sp > 0 ? cut.slice(0, sp) : cut).trim();
  }

  function base(settings) {
    return String(settings.baseUrl || 'http://127.0.0.1:9192').replace(/\/+$/, '');
  }

  /* Resolve {ref_audio, instruct, asmr} for a mode. Exported for tests. */
  function voiceFor(voice, mode) {
    voice = voice || {};
    var out = { ref_audio: voice.ref_audio || null, instruct: voice.instruct || null, asmr: null };
    if (mode !== 'asmr') return out;
    if (voice.asmr_ref) {
      out.ref_audio = voice.asmr_ref;
      out.instruct = voice.asmr_instruct || null;      /* the real whisper clip carries the style */
      out.asmr = voice.asmr_fx || 'drift';
    } else {
      /* no whisper clip: her normal voice, softened by the close preset only.
         (An instruct like 'whisper' is ignored by OmniVoice once a cloning
         reference is given, so it is not attempted.) */
      out.instruct = voice.asmr_instruct || null;
      out.asmr = voice.asmr_fx || 'close';
    }
    return out;
  }

  var TtsOmnivoice = {
    name: 'omnivoice',
    cleanForTts: cleanForTts,
    truncate: truncate,
    voiceFor: voiceFor,

    health: function (settings) {
      settings = settings || Providers.settings('tts', 'omnivoice', null);
      return fetch(Api._localProxy(base(settings) + '/health')).then(function (r) { return r.ok; }).catch(function () { return false; });
    },

    /* opts: {text, language, voice:{ref_audio, instruct}, settings} -> Promise<objectURL> */
    speak: function (opts) {
      opts = opts || {};
      var settings = opts.settings || Providers.settings('tts', 'omnivoice', null);
      var text = truncate(cleanForTts(opts.text), settings.maxChars || MAX_CHARS);
      if (!text) return Promise.reject(new Error('EMPTY'));
      var voice = voiceFor(opts.voice, opts.mode);
      var payload = { text: text, guidance_scale: Number(settings.guidanceScale) || 2.0 };
      if (voice.ref_audio) payload.ref_audio = voice.ref_audio;
      if (voice.instruct) payload.instruct = voice.instruct;
      if (voice.asmr) payload.asmr = voice.asmr;
      var lang = opts.language || settings.language;
      if (lang && lang !== 'auto') payload.language = lang;
      var b = base(settings);
      return Api._request(Api._localProxy(b + '/synthesize'), payload, '', Number(settings.timeout) || 180000)
        .then(function (j) {
          if (!j || !j.audio_url) throw new Error('OmniVoice returned no audio_url');
          return fetch(Api._localProxy(b + j.audio_url));
        })
        .then(function (r) {
          if (!r.ok) throw new Error('audio fetch HTTP ' + r.status);
          return r.blob();
        })
        .then(function (blob) { return URL.createObjectURL(blob); });
    }
  };

  global.TtsOmnivoice = TtsOmnivoice;
  if (global.Providers) Providers.register('tts', 'omnivoice', TtsOmnivoice);
})(typeof window !== 'undefined' ? window : globalThis);
