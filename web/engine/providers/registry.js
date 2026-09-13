/* Provider registry. Two tiny interfaces:

     LLM.complete({system, messages, temperature, maxTokens, timeout}) -> Promise<string>
     TTS.speak({text, language, styleHint, voice:{ref_audio, instruct}})   -> Promise<objectURL>

   Which implementation is active comes from Config section "engine"
   ({llm: 'openai', tts: 'omnivoice'}); a character card may override either in
   card.providers.llm.provider / card.providers.tts.provider. Adding a provider
   is one file that calls Providers.register(). */
(function (global) {
  'use strict';

  var impls = { llm: {}, tts: {} };
  var DEFAULTS = { llm: 'openai', tts: 'omnivoice' };

  function engineCfg() {
    try { return (global.Config && Config.section('engine')) || {}; } catch (e) { return {}; }
  }

  var Providers = {
    register: function (kind, name, impl) {
      if (!impls[kind]) impls[kind] = {};
      impls[kind][name] = impl;
    },
    names: function (kind) { return Object.keys(impls[kind] || {}); },

    /* Active provider name for a kind, honoring a card override. */
    nameFor: function (kind, card) {
      var ov = card && card.providers && card.providers[kind] && card.providers[kind].provider;
      var cfg = engineCfg();
      return ov || cfg[kind] || DEFAULTS[kind];
    },

    get: function (kind, card) {
      var name = Providers.nameFor(kind, card);
      var impl = impls[kind] && impls[kind][name];
      if (!impl) throw new Error('NO_PROVIDER:' + kind + ':' + name);
      return impl;
    },

    /* Settings for a provider: global Config section merged with the card's
       overrides for that kind (card wins, shallow). */
    settings: function (kind, name, card) {
      var base = {};
      try { base = (global.Config && Config.section(name)) || {}; } catch (e) {}
      if (kind === 'llm' && name === 'openai') {
        try { base = (global.Config && Config.section('llm')) || base; } catch (e) {}
      }
      var out = {}, k;
      for (k in base) if (base.hasOwnProperty(k)) out[k] = base[k];
      var ov = card && card.providers && card.providers[kind];
      if (ov && typeof ov === 'object') for (k in ov) if (ov.hasOwnProperty(k) && k !== 'provider') out[k] = ov[k];
      return out;
    }
  };

  global.Providers = Providers;
})(typeof window !== 'undefined' ? window : globalThis);
