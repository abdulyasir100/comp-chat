/* Affection: the first state system. Ported from town.exe (gifts.py + visit_chat.py).

   The model never picks a number. It reports how what you said landed with the
   character (a VERDICT); this file maps the verdict to a fixed delta, keeps the
   0-floor, and detects rank-ups against a per-character personal best so a
   bouncing score can never re-trigger the same rank.

   Points live in Store bucket "affection": { points, best }. */
(function (global) {
  'use strict';

  /* The four things a character may feel about what you said. Anything outside
     this map scores 0 — the model cannot invent a swing by inventing a verdict. */
  var VERDICT_DELTA = { loved: 2, liked: 1, neutral: 0, annoyed: -2 };
  var VERDICTS = Object.keys(VERDICT_DELTA);

  /* THE ladder (town.exe v7.7, user-tuned). Early ranks come fast, Devoted is a
     real commitment. Bonded (6) is deliberately unreachable by points. */
  var RANKS = [
    { level: 0, name: 'Stranger',     at: 0 },
    { level: 1, name: 'Familiar',     at: 30 },
    { level: 2, name: 'Acquaintance', at: 90 },
    { level: 3, name: 'Friend',       at: 200 },
    { level: 4, name: 'Confidant',    at: 380 },
    { level: 5, name: 'Devoted',      at: 650 }
  ];
  var BONDED = { level: 6, name: 'Bonded' };

  function clampVerdict(v) {
    v = String(v || '').trim().toLowerCase();
    return VERDICTS.indexOf(v) !== -1 ? v : 'neutral';
  }

  function deltaFor(verdict) {
    return VERDICT_DELTA[clampVerdict(verdict)] || 0;
  }

  function rankLevel(points) {
    var lv = 0, i;
    for (i = 0; i < RANKS.length; i++) if (points >= RANKS[i].at) lv = RANKS[i].level;
    return lv;
  }

  function rankName(level) {
    if (level === BONDED.level) return BONDED.name;
    var r = RANKS[level];
    return r ? r.name : RANKS[0].name;
  }

  function nextRank(points) {
    var i;
    for (i = 0; i < RANKS.length; i++) if (points < RANKS[i].at) return RANKS[i];
    return null;
  }

  function progress(points) {
    var lv = rankLevel(points), cur = RANKS[lv], nxt = nextRank(points);
    if (!nxt) return { level: lv, name: rankName(lv), points: points, next: null, ratio: 1 };
    var span = nxt.at - cur.at;
    return { level: lv, name: rankName(lv), points: points,
             next: { level: nxt.level, name: nxt.name, at: nxt.at },
             ratio: span > 0 ? (points - cur.at) / span : 1 };
  }

  function read(charId) {
    var rec = global.Store ? Store.get(charId, 'affection', null) : null;
    if (!rec || typeof rec !== 'object') rec = {};
    var pts = Math.max(0, parseInt(rec.points, 10) || 0);
    var best = parseInt(rec.best, 10);
    if (best !== best) best = rankLevel(pts);    // NaN → seed at current rank
    var bonded = !!rec.bonded;
    return { points: pts, best: best, bonded: bonded };
  }

  function write(charId, rec) {
    if (global.Store) Store.set(charId, 'affection', rec);
  }

  var Affection = {
    VERDICT_DELTA: VERDICT_DELTA,
    VERDICTS: VERDICTS,
    RANKS: RANKS,
    BONDED: BONDED,
    clampVerdict: clampVerdict,
    deltaFor: deltaFor,
    rankLevel: rankLevel,
    rankName: rankName,
    progress: progress,

    points: function (charId) { return read(charId).points; },

    /* What everything downstream should read: the ladder rank, or 6 once bonded. */
    level: function (charId) {
      var r = read(charId);
      return r.bonded ? BONDED.level : rankLevel(r.points);
    },

    state: function (charId) {
      var r = read(charId);
      var p = progress(r.points);
      if (r.bonded) { p.level = BONDED.level; p.name = BONDED.name; p.next = null; p.ratio = 1; }
      return p;
    },

    /* THE single place affection is written. Returns the town.exe-shaped result. */
    apply: function (charId, delta) {
      delta = parseInt(delta, 10) || 0;
      var r = read(charId);
      var after = Math.max(0, r.points + delta);
      var hi = rankLevel(after);
      var rankUp = null;
      if (hi > r.best) {
        rankUp = { level: hi, name: rankName(hi) };
        r.best = hi;
      }
      r.points = after;
      write(charId, r);
      return { delta: delta, affection: after, rank: r.bonded ? BONDED.level : hi,
               rank_name: r.bonded ? BONDED.name : rankName(hi),
               rank_up: rankUp, progress: progress(after) };
    },

    applyVerdict: function (charId, verdict) {
      return Affection.apply(charId, deltaFor(verdict));
    },

    /* Bonded is a gesture, not a score. Only allowed from Devoted. */
    canBond: function (charId) {
      var r = read(charId);
      return !r.bonded && rankLevel(r.points) === RANKS[RANKS.length - 1].level;
    },
    bond: function (charId) {
      if (!Affection.canBond(charId)) return null;
      var r = read(charId);
      r.bonded = true;
      write(charId, r);
      return { level: BONDED.level, name: BONDED.name };
    },

    reset: function (charId) { write(charId, { points: 0, best: 0, bonded: false }); }
  };

  global.Affection = Affection;
})(typeof window !== 'undefined' ? window : globalThis);
