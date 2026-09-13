/* Character registry. A character is one card:

   {
     "id": "aria",
     "name": "Aria", "nickname": "Ari",
     "description": "...", "personality": "...", "speech_style": "...",
     "likes": "...", "dislikes": "...", "situation": "...",
     "example_messages": [{"role":"user","content":"..."},{"role":"assistant","content":"..."}],
     "emotions": ["neutral","happy","sad","angry","surprised","shy","smug"],
     "languages": {"sub": "en", "dub": "ja"},          // optional; falls back to app settings
     "voice": {"provider": "omnivoice", "ref_audio": "ref/aria.wav", "instruct": null},
     "pack": {"renderer": "cubism", "path": "models/aria", "media_required": false},
     "providers": {"llm": {"model": "..."}}             // optional per-character overrides
   }

   Built-in cards ship under web/assets/characters/<id>/character.json and are
   listed by web/assets/characters/index.json. A second, gitignored folder,
   web/assets/characters-private/ (same layout, own index.json), holds cards
   that must never be published; it is loaded after the public list when it
   exists (dev checkout, personal -Full builds). User-created or edited cards are
   persisted in Store (global bucket "characters") and win over a built-in with
   the same id. The active id is Store global "active". */
(function (global) {
  'use strict';

  var DEFAULT_EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'surprised'];
  var builtin = {};     // id -> card (from assets)
  var custom = {};      // id -> card (from Store)
  var order = [];       // ids in listing order

  function loadCustom() {
    var rec = global.Store ? Store.getGlobal('characters', {}) : {};
    custom = (rec && typeof rec === 'object') ? rec : {};
  }
  function saveCustom() {
    if (global.Store) Store.setGlobal('characters', custom);
  }

  function normalize(card) {
    if (!card || typeof card !== 'object' || !card.id) return null;
    var c = JSON.parse(JSON.stringify(card));
    c.id = String(c.id).replace(/[^a-z0-9_-]/gi, '').toLowerCase();
    if (!c.id) return null;
    c.name = c.name || c.id;
    if (!Array.isArray(c.emotions) || !c.emotions.length) c.emotions = DEFAULT_EMOTIONS.slice();
    c.emotions = c.emotions.map(function (e) { return String(e).toLowerCase(); });
    if (c.emotions.indexOf('neutral') === -1) c.emotions.unshift('neutral');
    c.example_messages = Array.isArray(c.example_messages) ? c.example_messages.filter(function (m) {
      return m && m.role && m.content;
    }) : [];
    c.voice = c.voice || {};
    c.pack = c.pack || {};
    c.providers = c.providers || {};
    return c;
  }

  function fetchJson(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  var Characters = {
    DEFAULT_EMOTIONS: DEFAULT_EMOTIONS,
    normalize: normalize,

    /* Load built-in cards (browser). Resolves to the count loaded; never rejects. */
    load: function (base) {
      base = base || 'assets/characters/';
      loadCustom();
      if (typeof fetch !== 'function') return Promise.resolve(0);
      var ids = [];
      var privBase = base.replace(/characters\/$/, 'characters-private/');
      var loadList = function (dir) {
        return fetchJson(dir + 'index.json').then(function (list) {
          var found = Array.isArray(list) ? list : [];
          ids = ids.concat(found);
          return Promise.all(found.map(function (id) {
            return fetchJson(dir + id + '/character.json').then(function (card) {
              var c = normalize(card);
              if (c) { c.builtin = true; builtin[c.id] = c; }
            }).catch(function () {});
          }));
        });
      };
      return loadList(base).then(function () {
        return loadList(privBase).catch(function () {});   /* optional */
      }).then(function () {
        /* index.json order is the listing order AND the default card
           (activeId falls back to order[0]); Promise.all fills `builtin` in
           fetch-completion order, so re-key it by the index. */
        var ordered = {};
        ids.forEach(function (id) { if (builtin[id]) ordered[id] = builtin[id]; });
        Object.keys(builtin).forEach(function (id) { if (!ordered[id]) ordered[id] = builtin[id]; });
        builtin = ordered;
        order = Object.keys(builtin).concat(Object.keys(custom).filter(function (id) { return !builtin[id]; }));
        return order.length;
      }).catch(function () { order = Object.keys(custom); return order.length; });
    },

    /* Register cards directly (tests, packs unpacked at runtime). */
    seed: function (cards, asBuiltin) {
      loadCustom();
      (cards || []).forEach(function (card) {
        var c = normalize(card);
        if (!c) return;
        if (asBuiltin) { c.builtin = true; builtin[c.id] = c; }
        else custom[c.id] = c;
      });
      order = Object.keys(builtin).concat(Object.keys(custom).filter(function (id) { return !builtin[id]; }));
      if (!asBuiltin) saveCustom();
    },

    list: function () {
      return order.map(function (id) { return Characters.get(id); }).filter(Boolean);
    },

    get: function (id) {
      if (!id) return null;
      return custom[id] || builtin[id] || null;
    },

    upsert: function (card) {
      var c = normalize(card);
      if (!c) return null;
      loadCustom();
      custom[c.id] = c;
      if (order.indexOf(c.id) === -1) order.push(c.id);
      saveCustom();
      return c;
    },

    /* Remove a custom card (a built-in reverts to its shipped version). */
    remove: function (id) {
      loadCustom();
      if (!custom[id]) return false;
      delete custom[id];
      if (!builtin[id]) order = order.filter(function (x) { return x !== id; });
      saveCustom();
      return true;
    },

    activeId: function () {
      var id = global.Store ? Store.getGlobal('active', null) : null;
      if (id && Characters.get(id)) return id;
      return order[0] || null;
    },
    active: function () { return Characters.get(Characters.activeId()); },
    setActive: function (id) {
      if (!Characters.get(id)) return false;
      if (global.Store) Store.setGlobal('active', id);
      return true;
    },

    /* Effective sub/dub language for a card: card override, else app settings. */
    /* Precedence: an explicit app setting (llm.lang / tts.lang other than
       'auto') > the card's own languages > the 'auto' chain (Langs). A card
       pin used to beat the settings, so "Dub: Japanese" did nothing. */
    langs: function (card) {
      var cfg = global.Config && Config.section ? Config : null;
      var setLlm = cfg && cfg.section('llm') ? cfg.section('llm').lang : null;
      var setTts = cfg && cfg.section('tts') ? cfg.section('tts').lang : null;
      var cl = (card && card.languages) || {};
      var sub = (setLlm && setLlm !== 'auto') ? setLlm : (cl.sub || (global.Langs ? Langs.llm() : 'en'));
      var dub = (setTts && setTts !== 'auto') ? setTts : (cl.dub || (global.Langs ? Langs.tts() : sub));
      return { sub: sub, dub: dub };
    },

    _reset: function () { builtin = {}; custom = {}; order = []; }
  };

  global.Characters = Characters;
})(typeof window !== 'undefined' ? window : globalThis);
