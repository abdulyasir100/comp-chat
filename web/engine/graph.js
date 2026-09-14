/* Graph memory — what she knows, as a small knowledge graph.

   Every reply may carry `remember`: a few [subject, relation, object] triples
   about lasting facts ("user" is the player, "me" is the character). They
   become nodes + edges kept per character (Store bucket "graph"). Before each
   turn the engine recalls the edges that touch what the player just said
   (entity match + one hop) plus the freshest facts about the player, and
   renders them as plain lines for the prompt — the model never sees a graph.

   Single-valued relations (lives in, works at, ...) close the previous edge
   when a new object arrives, so "used to live in X" survives as history.
   No embeddings, no database: plain JSON, string matching, recency. */
(function (global) {
  'use strict';

  var BUCKET = 'graph';
  var MAX_EDGES = 400;
  var MAX_FACTS_PER_TURN = 5;
  var MAX_LEN = 60;
  var SINGLE = ['lives in', 'works at', 'works as', 'is named', 'is called', 'studies at', 'is from', 'age is', 'birthday is', 'is dating', 'favorite food is', 'favourite food is'];
  var STOP = { the: 1, and: 1, you: 1, your: 1, are: 1, was: 1, were: 1, have: 1, has: 1, had: 1, that: 1, this: 1, with: 1, from: 1, for: 1, not: 1, but: 1, what: 1, when: 1, where: 1, who: 1, how: 1, why: 1, just: 1, like: 1, really: 1, about: 1, into: 1, then: 1, than: 1, them: 1, they: 1, she: 1, her: 1, him: 1, his: 1, its: 1, our: 1, out: 1, all: 1, any: 1, some: 1, can: 1, will: 1, would: 1, could: 1, should: 1, did: 1, does: 1, been: 1, being: 1, there: 1, here: 1, today: 1, yeah: 1, okay: 1 };

  function norm(s) { return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').slice(0, MAX_LEN); }
  function key(s) {
    var k = norm(s).toLowerCase();
    if (/^(i|me|my|myself|user|the user|player|the player)$/.test(k)) return 'user';
    if (/^(you|yourself|her|she|me \(character\)|character|the character)$/.test(k)) return 'me';
    return k;
  }
  function empty() { return { nodes: {}, edges: [] }; }
  function read(charId) {
    var g = global.Store ? Store.get(charId, BUCKET, null) : null;
    if (!g || typeof g !== 'object' || !g.nodes || !Array.isArray(g.edges)) return empty();
    return g;
  }
  function write(charId, g) { if (global.Store) Store.set(charId, BUCKET, g); }

  /* accept [s,r,o] arrays or {s,r,o} / {subject,relation,object} objects */
  function toTriple(x) {
    if (Array.isArray(x)) return x.length >= 3 ? { s: x[0], r: x[1], o: x[2] } : null;
    if (x && typeof x === 'object') return { s: x.s != null ? x.s : x.subject, r: x.r != null ? x.r : x.relation, o: x.o != null ? x.o : x.object };
    return null;
  }

  var Graph = {
    BUCKET: BUCKET,
    SINGLE: SINGLE,
    key: key,

    /* Clean a model's `remember` list into triples worth storing. */
    cleanFacts: function (list) {
      var out = [];
      (Array.isArray(list) ? list : []).forEach(function (x) {
        var t = toTriple(x);
        if (!t) return;
        var s = norm(t.s), r = norm(t.r).toLowerCase(), o = norm(t.o);
        if (!s || !r || !o || r.length < 2) return;
        if (key(s) === key(o)) return;
        out.push([s, r, o]);
      });
      return out.slice(0, MAX_FACTS_PER_TURN);
    },

    /* Store triples. Returns how many edges were new. */
    add: function (charId, triples, at) {
      var g = read(charId), now = at || Date.now(), added = 0;
      Graph.cleanFacts(triples).forEach(function (t) {
        var sk = key(t[0]), ok = key(t[2]), r = t[1];
        [[sk, t[0]], [ok, t[2]]].forEach(function (pair) {
          var n = g.nodes[pair[0]];
          if (!n) g.nodes[pair[0]] = { id: pair[0], label: pair[0] === 'user' || pair[0] === 'me' ? pair[0] : norm(pair[1]), first: now, last: now, n: 1 };
          else { n.last = now; n.n = (n.n | 0) + 1; }
        });
        var same = g.edges.filter(function (e) { return e.s === sk && e.r === r && e.o === ok; })[0];
        if (same) { same.last = now; same.n = (same.n | 0) + 1; same.ended = null; return; }
        if (SINGLE.indexOf(r) !== -1) {
          g.edges.forEach(function (e) { if (e.s === sk && e.r === r && !e.ended) e.ended = now; });
        }
        g.edges.push({ s: sk, r: r, o: ok, first: now, last: now, n: 1, ended: null });
        added++;
      });
      if (g.edges.length > MAX_EDGES) g.edges = g.edges.slice(g.edges.length - MAX_EDGES);
      write(charId, g);
      return added;
    },

    list: function (charId) { return read(charId); },
    count: function (charId) { return read(charId).edges.length; },
    removeEdge: function (charId, idx) {
      var g = read(charId);
      if (idx < 0 || idx >= g.edges.length) return false;
      g.edges.splice(idx, 1);
      /* drop nodes nothing touches any more (except the two hubs) */
      var used = {};
      g.edges.forEach(function (e) { used[e.s] = 1; used[e.o] = 1; });
      Object.keys(g.nodes).forEach(function (id) { if (!used[id] && id !== 'user' && id !== 'me') delete g.nodes[id]; });
      write(charId, g);
      return true;
    },
    clear: function (charId) { write(charId, empty()); },

    /* Words in the text that could name a node (len >= 3, not a stop word). */
    tokens: function (text) {
      return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/)
        .filter(function (w) { return w.length >= 3 && !STOP[w]; });
    },

    /* Edges relevant to a message: those touching a mentioned node (+ one
       hop), plus the freshest facts about the player. Chronological output. */
    recall: function (charId, text, limit) {
      limit = limit || 12;
      var g = read(charId);
      if (!g.edges.length) return [];
      var toks = Graph.tokens(text);
      var hit = {};
      Object.keys(g.nodes).forEach(function (id) {
        if (id === 'user' || id === 'me') return;
        var lab = (g.nodes[id].label || id).toLowerCase();
        if (toks.some(function (w) { return lab === w || lab.indexOf(w) !== -1 || w.indexOf(lab) !== -1; })) hit[id] = 2;
      });
      /* one hop: neighbours of the hits */
      g.edges.forEach(function (e) {
        if (hit[e.s] === 2 && !hit[e.o]) hit[e.o] = 1;
        if (hit[e.o] === 2 && !hit[e.s]) hit[e.s] = 1;
      });
      var scored = g.edges.map(function (e, i) {
        var direct = hit[e.s] === 2 || hit[e.o] === 2;
        var near = hit[e.s] === 1 || hit[e.o] === 1;
        var score = (direct ? 100 : near ? 40 : 0) + (e.s === 'user' ? 10 : 0) + (e.ended ? -30 : 0) + Math.min(20, (Date.now() - e.last) < 0 ? 20 : 20 - Math.min(20, (Date.now() - e.last) / 864e5));
        return { e: e, i: i, score: score, direct: direct };
      }).filter(function (x) { return x.direct || (!x.e.ended && (x.score > 0)); });
      scored.sort(function (a, b) { return b.score - a.score || b.e.last - a.e.last; });
      return scored.slice(0, limit).sort(function (a, b) { return a.e.last - b.e.last; }).map(function (x) { return x.e; });
    },

    /* One line per edge, with the hubs named. */
    line: function (e, g, names) {
      names = names || {};
      var lab = function (id) {
        if (id === 'user') return names.user || 'the user';
        if (id === 'me') return names.me || 'you';
        return (g.nodes[id] && g.nodes[id].label) || id;
      };
      var s = lab(e.s) + ' ' + e.r + ' ' + lab(e.o);
      return e.ended ? s + ' (no longer true)' : s;
    },
    promptBlock: function (charId, text, names) {
      var edges = Graph.recall(charId, text, 12);
      if (!edges.length) return '';
      var g = read(charId);
      return '## Things you know (facts you learned earlier; "' + ((names && names.user) || 'the user') + '" is the person talking to you)\n' +
        edges.map(function (e) { return '- ' + Graph.line(e, g, names); }).join('\n');
    }
  };

  global.Graph = Graph;
})(typeof window !== 'undefined' ? window : globalThis);
