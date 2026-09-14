/* Gifts — a bag of things to hand her, and how they land.

   Catalogue: assets/gifts/index.json (built-in, with icons) + custom gifts the
   user adds (name, tags, tier, image) kept in localStorage. Coins (Game money,
   earned by talking) buy gifts into the bag; giving one consumes it.

   Giving is a normal conversation turn: the text is *hands you <gift>* and a
   GIFT block in the system prompt names the tags and tier, so the model reacts
   by the card's likes/dislikes and reports a VERDICT like any other line. The
   verdict delta is applied by the engine as usual; on top of that a tier bonus
   is added when she did not dislike it (town.exe gifts.py: rarity matters, but
   a gift she hates never earns points). Every gift is logged per character so
   the Memories and the sheet can show what she was given. */
(function (global) {
  'use strict';

  var CATALOG_URL = 'assets/gifts/index.json';
  var ICON_BASE = 'assets/gifts/icons/';
  var CUSTOM_KEY = 'cc.gifts.custom.v1';
  var BAG_KEY = 'cc.gifts.bag.v1';
  var LOG_BUCKET = 'gifts';
  var LOG_CAP = 60;

  var TIERS = ['common', 'uncommon', 'rare', 'epic'];
  /* points on top of the verdict delta, when the verdict is not `annoyed` */
  var TIER_BONUS = { common: 0, uncommon: 2, rare: 4, epic: 8 };
  var COINS_PER_TURN = 5, COINS_LOVED_BONUS = 5;

  var builtin = [];
  var loaded = false;

  function readJson(key, fb) {
    try { var v = JSON.parse(global.localStorage.getItem(key) || 'null'); return v == null ? fb : v; } catch (e) { return fb; }
  }
  function writeJson(key, v) { try { global.localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }
  function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); }
  function tier(t) { return TIERS.indexOf(t) !== -1 ? t : 'common'; }

  function normalize(g, custom) {
    if (!g || !g.id) return null;
    return {
      id: String(g.id), name: String(g.name || g.id), tags: Array.isArray(g.tags) ? g.tags.map(String) : [],
      tier: tier(g.tier), price: Math.max(0, parseInt(g.price, 10) || 0),
      icon: custom ? (g.icon || null) : (g.icon ? ICON_BASE + g.icon : null), custom: !!custom
    };
  }

  var Gifts = {
    TIERS: TIERS,
    TIER_BONUS: TIER_BONUS,
    COINS_PER_TURN: COINS_PER_TURN,

    /* Fetch the built-in catalogue once (never rejects). */
    load: function () {
      if (loaded || typeof fetch !== 'function') return Promise.resolve(builtin);
      return fetch(CATALOG_URL).then(function (r) { return r.ok ? r.json() : []; }).then(function (list) {
        builtin = (Array.isArray(list) ? list : []).map(function (g) { return normalize(g, false); }).filter(Boolean);
        loaded = true;
        return builtin;
      }).catch(function () { loaded = true; return builtin; });
    },
    /* For tests / other hosts: install the catalogue directly. */
    setCatalog: function (list) { builtin = (list || []).map(function (g) { return normalize(g, false); }).filter(Boolean); loaded = true; },

    custom: function () { return readJson(CUSTOM_KEY, []).map(function (g) { return normalize(g, true); }).filter(Boolean); },
    catalog: function () { return builtin.concat(Gifts.custom()); },
    get: function (id) { return Gifts.catalog().filter(function (g) { return g.id === id; })[0] || null; },

    /* Add a gift of the user's own: { name, tags: [] | "a, b", tier, price, icon (data URL) } */
    addCustom: function (g) {
      var list = readJson(CUSTOM_KEY, []);
      var base = 'my-' + (slug(g.name) || 'gift'), id = base, n = 2;
      var taken = Gifts.catalog().map(function (x) { return x.id; });
      while (taken.indexOf(id) !== -1) id = base + '-' + (n++);
      var tags = Array.isArray(g.tags) ? g.tags : String(g.tags || '').split(/[,\s]+/);
      tags = tags.map(function (t) { return String(t).trim().toLowerCase(); }).filter(Boolean);
      var rec = { id: id, name: String(g.name || '').trim() || id, tags: tags, tier: tier(g.tier),
                  price: Math.max(0, parseInt(g.price, 10) || 0), icon: g.icon || null };
      list.push(rec);
      writeJson(CUSTOM_KEY, list);
      return normalize(rec, true);
    },
    removeCustom: function (id) {
      writeJson(CUSTOM_KEY, readJson(CUSTOM_KEY, []).filter(function (g) { return g.id !== id; }));
      var bag = Gifts.bag(); delete bag[id]; writeJson(BAG_KEY, bag);
    },

    /* ------------------------------------------------------------- bag */
    bag: function () { var b = readJson(BAG_KEY, {}); return (b && typeof b === 'object') ? b : {}; },
    count: function (id) { return Gifts.bag()[id] | 0; },
    /* items in the bag with their gift record: [{gift, n}] */
    bagItems: function () {
      var bag = Gifts.bag();
      return Object.keys(bag).filter(function (id) { return bag[id] > 0; }).map(function (id) {
        var g = Gifts.get(id);
        return g ? { gift: g, n: bag[id] | 0 } : null;
      }).filter(Boolean);
    },
    grant: function (id, n) {
      var bag = Gifts.bag();
      bag[id] = Math.max(0, (bag[id] | 0) + (n == null ? 1 : n | 0));
      if (!bag[id]) delete bag[id];
      writeJson(BAG_KEY, bag);
      return bag[id] | 0;
    },
    /* Buy with Game coins. Returns {ok, reason} */
    buy: function (id) {
      var g = Gifts.get(id);
      if (!g) return { ok: false, reason: 'unknown' };
      var G = global.Game;
      if (G && !G.canPay(g.price)) return { ok: false, reason: 'coins' };
      if (G) G.addMoney(-g.price);
      Gifts.grant(id, 1);
      return { ok: true, gift: g, n: Gifts.count(id) };
    },

    /* ------------------------------------------------------- the turn */
    /* What the player "says" when handing it over, and the prompt block. */
    turnText: function (g) { return '*hands you ' + g.name + '*'; },
    promptBlock: function (g) {
      return 'GIFT: they just handed you "' + g.name + '" (' + g.tier + (g.tags.length ? '; ' + g.tags.join(', ') : '') + '). ' +
        'React to the gift itself in your spoken line — judge it by YOUR likes and dislikes, not by manners. ' +
        'Your verdict must say how it really landed.';
    },
    bonusFor: function (g, verdict) {
      if (!g) return 0;
      if (String(verdict || '').toLowerCase() === 'annoyed') return 0;
      return TIER_BONUS[tier(g.tier)] || 0;
    },

    /* Give a bag item to the active character. opts = the App's chat opts
       ({mode, style, profile}). Resolves to the engine reply, with the tier
       bonus folded into reply.affection / rank / rank_up and reply.gift set. */
    give: function (charId, id, opts) {
      var g = Gifts.get(id);
      if (!g) return Promise.reject(new Error('unknown gift'));
      if (Gifts.count(id) <= 0) return Promise.reject(new Error('not in the bag'));
      opts = Object.assign({}, opts || {}, { extra: [opts && opts.extra, Gifts.promptBlock(g)].filter(Boolean).join('\n') });
      return global.Engine.chat(Gifts.turnText(g), opts).then(function (reply) {
        Gifts.grant(id, -1);
        var bonus = Gifts.bonusFor(g, reply.verdict);
        if (bonus && global.Affection) {
          var r = Affection.apply(charId, bonus);
          reply.affection = r.affection; reply.rank = r.rank; reply.rank_name = r.rank_name;
          if (r.rank_up) reply.rank_up = r.rank_up;
        }
        reply.gift = { id: g.id, name: g.name, tier: g.tier, bonus: bonus };
        Gifts._log(charId, g, reply.verdict, bonus);
        return reply;
      });
    },

    _log: function (charId, g, verdict, bonus) {
      if (!global.Store) return;
      var log = Store.get(charId, LOG_BUCKET, []);
      if (!Array.isArray(log)) log = [];
      log.push({ id: g.id, name: g.name, tier: g.tier, verdict: verdict || 'neutral', bonus: bonus | 0, at: Date.now() });
      if (log.length > LOG_CAP) log = log.slice(log.length - LOG_CAP);
      Store.set(charId, LOG_BUCKET, log);
    },
    history: function (charId) {
      var log = global.Store ? Store.get(charId, LOG_BUCKET, []) : [];
      return Array.isArray(log) ? log.slice().reverse() : [];
    },

    /* Coins for a finished talk turn (the app calls this once per reply). */
    coinsForTurn: function (reply) {
      return COINS_PER_TURN + (reply && String(reply.verdict).toLowerCase() === 'loved' ? COINS_LOVED_BONUS : 0);
    }
  };

  global.Gifts = Gifts;
})(typeof window !== 'undefined' ? window : globalThis);
