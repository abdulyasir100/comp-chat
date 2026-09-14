/* Bond UI — makes affection visible.

   The engine (engine/affection.js) owns the numbers: verdict -> delta, ranks,
   personal best, bonded flag. This module only draws them:
     - a glass chip above the conversation panel: a heart that fills toward
       the next rank, the rank name, a hairline progress bar
     - a floating "+2" / "−2" when a reply lands, chip pulse (gain) or shake (loss)
     - a ribbon across the stage with a shine sweep on rank-up (replaces the toast)
     - a bond sheet (tap the chip): big heart, points to next rank, the ladder
       drawn as a constellation with the reached ranks lit, and the Bond
       gesture once Devoted.
   Rank names/descriptions come from I18n (bond.rank.N / bond.desc.N), falling
   back to the engine's English names. */
(function (global) {
  'use strict';

  var HEART = 'M12 21s-6.7-4.3-9.3-8.1C.5 9.6 2 5.4 5.7 4.3c2-.6 4.2.1 5.5 1.7 1.3-1.6 3.5-2.3 5.5-1.7 3.7 1.1 5.2 5.3 3 8.6C18.7 16.7 12 21 12 21z';
  var POP_MS = 1300, PULSE_MS = 700, RIBBON_MS = 2800;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function t(key, fb) { return (global.I18n && I18n.tc) ? I18n.tc(key, fb) : fb; }
  function tf(key, fb, map) {
    var s = t(key, fb);
    Object.keys(map || {}).forEach(function (k) { s = s.split('{' + k + '}').join(map[k]); });
    return s;
  }
  function charId() { return global.Characters ? Characters.activeId() : null; }
  function rankName(level) {
    var fb = global.Affection ? Affection.rankName(level) : '';
    return t('bond.rank.' + level, fb);
  }
  function heartSvg(clipId) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<defs><clipPath id="' + clipId + '"><rect x="0" y="24" width="24" height="24"/></clipPath></defs>' +
      '<path class="bond-heart-bg" d="' + HEART + '"/>' +
      '<path class="bond-heart-fill" clip-path="url(#' + clipId + ')" d="' + HEART + '"/>' +
      '<path class="bond-heart-line" d="' + HEART + '"/></svg>';
  }
  /* fill from the bottom: y = 24 * (1 - ratio) */
  function setHeart(svgHost, ratio) {
    if (!svgHost) return;
    var r = svgHost.querySelector('clipPath rect');
    if (r && r.setAttribute) r.setAttribute('y', String(24 * (1 - Math.max(0, Math.min(1, ratio)))));
  }

  var Bond = {
    _mounted: false,
    _lastLevel: null,

    /* Build the chip + ribbon inside the talk view. Safe to call twice. */
    mount: function () {
      var host = $('view-talk');
      if (!host || Bond._mounted || !host.insertBefore) return;
      Bond._mounted = true;

      var chip = el('button', 'bond-chip');
      chip.type = 'button';
      chip.id = 'bond-chip';
      chip.title = t('bond.title', 'Bond');
      chip.innerHTML = '<span class="bond-heart" id="bond-chip-heart">' + heartSvg('bond-clip-chip') + '</span>' +
        '<span class="bond-text"><b id="bond-rank"></b><i class="bond-bar"><u id="bond-bar-fill"></u></i></span>';
      chip.onclick = function () { Bond.openSheet(); };

      var ribbon = el('div', 'bond-ribbon hidden');
      ribbon.id = 'bond-ribbon';
      ribbon.innerHTML = '<div class="bond-ribbon-inner"><small id="bond-ribbon-cap"></small><b id="bond-ribbon-name"></b>' +
        '<span class="bond-spark"></span><span class="bond-spark"></span><span class="bond-spark"></span>' +
        '<span class="bond-spark"></span><span class="bond-spark"></span><span class="bond-spark"></span></div>';

      var panel = $('log-panel');
      host.insertBefore(chip, panel || null);
      host.insertBefore(ribbon, panel || null);
      Bond.refresh();
    },

    /* Redraw the chip from the engine state (character switch, boot, sheet close). */
    refresh: function () {
      if (!global.Affection || !charId()) return;
      var s = Affection.state(charId());
      var rank = $('bond-rank');
      if (rank) rank.textContent = rankName(s.level);
      setHeart($('bond-chip-heart'), s.ratio);
      var fill = $('bond-bar-fill');
      if (fill) fill.style.width = Math.round(s.ratio * 100) + '%';
      var chip = $('bond-chip');
      if (chip) {
        chip.classList.toggle('bonded', s.level === Affection.BONDED.level);
        chip.title = rankName(s.level) + ' · ' + s.points + (s.next ? ' / ' + s.next.at : '');
      }
      Bond._lastLevel = s.level;
    },

    /* A reply landed: float the delta, pulse the chip, ribbon on rank-up. */
    onReply: function (reply) {
      if (!reply || !global.Affection) return;
      var delta = Affection.deltaFor(reply.verdict);
      Bond.refresh();
      if (delta) Bond._pop(delta);
      if (reply.rank_up) Bond.celebrate(reply.rank_up.level);
    },

    _pop: function (delta) {
      var chip = $('bond-chip');
      if (!chip || !chip.parentNode) return;
      var cls = delta > 0 ? 'gain' : 'loss';
      chip.classList.remove('gain', 'loss');
      void chip.offsetWidth;                       /* restart the animation */
      chip.classList.add(cls);
      setTimeout(function () { chip.classList.remove(cls); }, PULSE_MS);
      var pop = el('span', 'bond-pop ' + cls, (delta > 0 ? '+' : '−') + Math.abs(delta));
      chip.parentNode.insertBefore(pop, chip.nextSibling);
      setTimeout(function () { if (pop.parentNode) pop.parentNode.removeChild(pop); }, POP_MS);
    },

    /* Rank-up ribbon across the stage. */
    celebrate: function (level) {
      var rb = $('bond-ribbon');
      if (!rb) { if (global.App && App.toast) App.toast('♥ ' + rankName(level)); return; }
      var cap = $('bond-ribbon-cap'), name = $('bond-ribbon-name');
      if (cap) cap.textContent = level === (Affection.BONDED.level) ? t('bond.bondedCap', 'A promise made') : t('bond.up', 'Bond deepened');
      if (name) name.textContent = rankName(level);
      rb.classList.remove('hidden', 'show');
      void rb.offsetWidth;
      rb.classList.add('show');
      if (global.Sound && Sound.se) { try { Sound.se('quest_clear'); } catch (e) {} }
      clearTimeout(Bond._ribbonT);
      Bond._ribbonT = setTimeout(function () { rb.classList.remove('show'); rb.classList.add('hidden'); }, RIBBON_MS);
    },

    /* ---------------------------------------------------------- the sheet */
    openSheet: function () {
      if (!global.Affection || !charId()) return;
      Bond.closeSheet();
      var id = charId();
      var s = Affection.state(id);
      var card = global.Characters ? Characters.active() : null;
      var who = card ? (card.nickname || card.name || '') : '';

      var scrim = el('div', 'bond-scrim');
      scrim.id = 'bond-sheet';
      var sheet = el('div', 'bond-sheet');
      scrim.appendChild(sheet);

      var head = el('div', 'bond-head');
      head.innerHTML = '<span class="bond-heart big" id="bond-sheet-heart">' + heartSvg('bond-clip-sheet') + '</span>';
      var ht = el('div', 'bond-head-text');
      ht.appendChild(el('small', null, tf('bond.with', 'Bond with {name}', { name: who })));
      ht.appendChild(el('b', null, rankName(s.level)));
      var line = s.next
        ? tf('bond.next', '{n} more to {rank}', { n: s.next.at - s.points, rank: rankName(s.next.level) })
        : (s.level === Affection.BONDED.level ? t('bond.desc.6', '') : t('bond.max', 'As close as points can bring you'));
      ht.appendChild(el('span', 'bond-next', line));
      ht.appendChild(el('span', 'bond-pts', tf('bond.points', '{p} pts', { p: s.points })));
      head.appendChild(ht);
      var x = el('button', 'bond-close', '✕');
      x.type = 'button';
      x.onclick = Bond.closeSheet;
      head.appendChild(x);
      sheet.appendChild(head);

      /* the ladder as a constellation: reached ranks lit, the current one pulsing */
      var lad = el('ol', 'bond-ladder');
      var ranks = Affection.RANKS.concat([{ level: Affection.BONDED.level, at: null }]);
      ranks.forEach(function (r) {
        var li = el('li', 'bond-node');
        var reached = r.level <= s.level;
        if (reached) li.classList.add('lit');
        if (r.level === s.level) li.classList.add('now');
        if (r.level === Affection.BONDED.level) li.classList.add('bond-node-final');
        var dot = el('i', 'bond-star');
        li.appendChild(dot);
        var body = el('div', 'bond-node-text');
        var nm = el('b', null, rankName(r.level));
        body.appendChild(nm);
        body.appendChild(el('span', null, t('bond.desc.' + r.level, '')));
        var meta = el('em', null, r.at == null ? t('bond.gesture', 'a gesture, not a score') : (r.at + ' pts'));
        body.appendChild(meta);
        if (r.level === Affection.BONDED.level) {
          if (Affection.canBond(id)) {
            var b = el('button', 'btn primary bond-btn', t('bond.bond', 'Make the bond'));
            b.type = 'button';
            b.onclick = function () {
              var res = Affection.bond(id);
              if (!res) return;
              Bond.closeSheet();
              Bond.refresh();
              Bond.celebrate(res.level);
            };
            body.appendChild(b);
          } else if (s.level === Affection.BONDED.level) {
            body.appendChild(el('span', 'bond-done', '✦ ' + t('bond.bonded', 'Bonded')));
          }
        }
        li.appendChild(body);
        lad.appendChild(li);
      });
      sheet.appendChild(lad);

      scrim.onclick = function (e) { if (e.target === scrim) Bond.closeSheet(); };
      (document.getElementById('phone') || document.body).appendChild(scrim);
      setHeart($('bond-sheet-heart'), 0);
      requestAnimationFrame(function () {
        scrim.classList.add('open');
        setTimeout(function () { setHeart($('bond-sheet-heart'), s.ratio); }, 60);
      });
    },

    closeSheet: function () {
      var s = $('bond-sheet');
      if (s && s.parentNode) s.parentNode.removeChild(s);
    }
  };

  global.Bond = Bond;
})(typeof window !== 'undefined' ? window : globalThis);
