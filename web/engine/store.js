/* Per-character storage. Every persisted thing the engine owns is keyed by
   character id so switching characters can never bleed history, memory or
   affection between them:  cc.<charId>.<bucket>

   localStorage-shaped on purpose: the Electron host mirrors localStorage to a
   JSON file (desktop/web-storage.js) and the Android WebView keeps its own, so
   one storage API covers all three hosts. Every access is wrapped — a private
   window or a wiped profile must degrade to "empty", never throw into the talk
   loop. */
(function (global) {
  'use strict';

  var PREFIX = 'cc.';

  function ls() {
    try { return global.localStorage || null; } catch (e) { return null; }
  }

  function key(charId, bucket) {
    return PREFIX + String(charId || '_') + '.' + String(bucket || '');
  }

  var Store = {
    PREFIX: PREFIX,
    key: key,

    get: function (charId, bucket, fallback) {
      var s = ls();
      if (!s) return fallback;
      try {
        var raw = s.getItem(key(charId, bucket));
        if (raw == null) return fallback;
        return JSON.parse(raw);
      } catch (e) { return fallback; }
    },

    set: function (charId, bucket, value) {
      var s = ls();
      if (!s) return false;
      try { s.setItem(key(charId, bucket), JSON.stringify(value)); return true; }
      catch (e) { return false; }
    },

    remove: function (charId, bucket) {
      var s = ls();
      if (!s) return;
      try { s.removeItem(key(charId, bucket)); } catch (e) {}
    },

    /* Global (character-independent) engine settings live under cc._.<bucket>. */
    getGlobal: function (bucket, fallback) { return Store.get('_', bucket, fallback); },
    setGlobal: function (bucket, value) { return Store.set('_', bucket, value); },

    /* Every key this character owns. */
    keysOf: function (charId) {
      var s = ls(), out = [], i, k;
      if (!s) return out;
      var p = PREFIX + String(charId) + '.';
      try {
        for (i = 0; i < s.length; i++) {
          k = s.key(i);
          if (k && k.indexOf(p) === 0) out.push(k);
        }
      } catch (e) {}
      return out;
    },

    /* Forget one character entirely (history, memory, affection, everything). */
    wipe: function (charId) {
      var s = ls();
      if (!s) return 0;
      var keys = Store.keysOf(charId);
      keys.forEach(function (k) { try { s.removeItem(k); } catch (e) {} });
      return keys.length;
    }
  };

  global.Store = Store;
})(typeof window !== 'undefined' ? window : globalThis);
