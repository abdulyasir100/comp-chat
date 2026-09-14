/* Gathering — poke around a map stage and find something.

   Only on the map (state.place '' = a Spine scene) and never at home: each
   stage has its own cooldown (localStorage cc.gather.v1 {stageId: lastMs}).
   What turns up depends on the region: assets/gifts/loot.json lists, per area
   id, the gift ids (weighted) and a coin range; "default" covers the rest.
   A find goes straight into the gift bag (or the purse) and is handed to the
   conversation as a normal turn, so she reacts to the find in character. */
(function (global) {
  'use strict';

  var LOOT_URL = 'assets/gifts/loot.json';
  var KEY = 'cc.gather.v1';
  var COOLDOWN_MS = 20 * 60 * 1000;
  var HOME_STAGE = 'stage_01_001_04';

  var loot = null;

  function readLog() { try { var v = JSON.parse(global.localStorage.getItem(KEY) || '{}'); return (v && typeof v === 'object') ? v : {}; } catch (e) { return {}; } }
  function writeLog(v) { try { global.localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} }

  function pickWeighted(items, rnd) {
    var total = 0, i;
    for (i = 0; i < items.length; i++) total += Math.max(0, items[i].w || 0);
    if (!total) return null;
    var r = (rnd == null ? Math.random() : rnd) * total;
    for (i = 0; i < items.length; i++) {
      r -= Math.max(0, items[i].w || 0);
      if (r < 0) return items[i];
    }
    return items[items.length - 1];
  }

  var Gather = {
    COOLDOWN_MS: COOLDOWN_MS,
    HOME_STAGE: HOME_STAGE,

    load: function () {
      if (loot || typeof fetch !== 'function') return Promise.resolve(loot || {});
      return fetch(LOOT_URL).then(function (r) { return r.ok ? r.json() : {}; }).then(function (j) { loot = j || {}; return loot; })
        .catch(function () { loot = {}; return loot; });
    },
    setLoot: function (j) { loot = j || {}; },

    /* Can you gather here? {ok, reason: 'home'|'place'|'cooldown'|'nomap', wait} */
    check: function (state) {
      state = state || {};
      if (state.place) return { ok: false, reason: 'place' };
      if (!state.stage) return { ok: false, reason: 'nomap' };
      if (state.stage === HOME_STAGE) return { ok: false, reason: 'home' };
      var last = Number(readLog()[state.stage]) || 0;   /* ms timestamps overflow a 32-bit |0 */
      var wait = last + COOLDOWN_MS - Date.now();
      if (wait > 0) return { ok: false, reason: 'cooldown', wait: wait };
      return { ok: true };
    },

    /* The table for a stage: its area's entry or "default". */
    tableFor: function (stageId) {
      var area = null;
      if (global.World && World.areaOf) { try { area = World.areaOf(stageId); } catch (e) { area = null; } }
      var id = area && (area.id || area);
      return (loot && ((id && loot[id]) || loot['default'])) || { gifts: [], coins: [5, 15] };
    },

    /* Roll a find: {kind:'gift', gift} | {kind:'coins', n}. */
    roll: function (stageId, rnd) {
      var t = Gather.tableFor(stageId);
      var coinsChance = t.coinsChance == null ? 0.3 : t.coinsChance;
      var r1 = rnd == null ? Math.random() : rnd;
      var range = Array.isArray(t.coins) ? t.coins : [5, 15];
      var candidates = (t.gifts || []).map(function (g) { return { id: g.id || g, w: g.w == null ? 1 : g.w }; })
        .filter(function (g) { return global.Gifts ? !!Gifts.get(g.id) : true; });
      if (r1 < coinsChance || !candidates.length) {
        var n = range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1));
        return { kind: 'coins', n: n };
      }
      var pick = pickWeighted(candidates);
      return { kind: 'gift', gift: global.Gifts ? Gifts.get(pick.id) : { id: pick.id, name: pick.id } };
    },

    /* Do it: bag/purse update, cooldown, returns the find with its turn text. */
    gather: function (state) {
      var c = Gather.check(state);
      if (!c.ok) return null;
      var find = Gather.roll(state.stage);
      var log = readLog(); log[state.stage] = Date.now(); writeLog(log);
      if (find.kind === 'gift') { if (global.Gifts) Gifts.grant(find.gift.id, 1); }
      else if (global.Game) Game.addMoney(find.n);
      var place = '';
      if (global.World && World.find) { var here = World.find(state.stage); if (here) place = World.placeLabel(here.stageId, here.stage); }
      find.place = place;
      find.text = find.kind === 'gift' ? '*we look around' + (place ? ' ' + place : '') + ' and find ' + find.gift.name + '*'
                                       : '*we look around' + (place ? ' ' + place : '') + ' and find ' + find.n + ' coins*';
      find.extra = 'FOUND: while poking around' + (place ? ' ' + place : '') + ' together you two just found ' +
        (find.kind === 'gift' ? '"' + find.gift.name + '" (it went into their bag; they may give it to you later)' : find.n + ' coins') +
        '. React to the find in one spoken line.';
      return find;
    },

    /* remaining cooldown, formatted "12m" */
    waitLabel: function (ms) { var m = Math.ceil(ms / 60000); return m + 'm'; }
  };

  global.Gather = Gather;
})(typeof window !== 'undefined' ? window : globalThis);
