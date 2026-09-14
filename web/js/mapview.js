/* MapView — the world map drawn like the game: the region artwork with
   field pins on their landmarks; tap a field and the map zooms in on it with
   a spotlight, the field's stages appear as diamond pins around it, and the
   bar below offers "‹ Field" (back) and "Current location".

   Data: World (hierarchy, labels), assets/_index/map_pins.json (field -> [x%,
   y%] on the picture), assets/world_map/areas/<area>.jpg (personal builds). */
(function (global) {
  'use strict';

  var PINS_URL = 'assets/_index/map_pins.json';
  var AREA_IMG = 'assets/world_map/areas/';
  var ZOOM = 2.3;
  var pins = null;

  function t(k, fb) { return (global.I18n && I18n.tc) ? I18n.tc(k, fb) : fb; }
  function label(id, base) { return (global.World && World.placeLabel) ? World.placeLabel(id, base) : (base || id); }
  function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  /* [x%, y%] of a field on its region picture */
  function fieldPos(fieldId) {
    if (pins && Array.isArray(pins[fieldId])) return pins[fieldId];
    var h = hash(fieldId);
    return [15 + (h % 70), 15 + ((h >>> 8) % 70)];
  }
  /* stages fan out around the field point; the first one sits on it */
  function stagePos(fieldId, i, n) {
    var f = fieldPos(fieldId);
    if (i === 0) return f;
    var a = (i - 1) / Math.max(1, n - 1) * Math.PI * 1.6 - Math.PI * 0.8 - Math.PI / 2;
    var r = 4.2;
    return [f[0] + Math.cos(a) * r * 1.2, f[1] + Math.sin(a) * r * 1.9];
  }

  var MapView = {
    ZOOM: ZOOM,
    fieldPos: fieldPos,
    stagePos: stagePos,
    setPins: function (p) { pins = p || {}; },
    load: function () {
      if (pins || typeof fetch !== 'function') return Promise.resolve(pins || {});
      return fetch(PINS_URL).then(function (r) { return r.ok ? r.json() : {}; }).then(function (j) { pins = j || {}; return pins; })
        .catch(function () { pins = {}; return pins; });
    },

    _areaId: null, _fieldId: null,

    /* root: the container; stageId: where you are; onPick(stageId) */
    render: function (root, stageId, onPick) {
      if (!root || !global.World) return;
      MapView.load().then(function () { MapView._draw(root, stageId, onPick); });
    },

    _draw: function (root, stageId, onPick) {
      var here = World.find(stageId);
      if (!MapView._areaId) MapView._areaId = here ? here.areaId : (World.areas()[0] || {}).id;
      var areaId = MapView._areaId, fieldId = MapView._fieldId;
      var area = World.areas().filter(function (a) { return a.id === areaId; })[0];
      if (!area) return;
      root.innerHTML = '';
      root.classList.add('wmap-root');

      /* region strip */
      var strip = el('div', 'wmap-areas');
      World.areas().forEach(function (a) {
        var b = el('button', 'wmap-area' + (a.id === areaId ? ' active' : '') + (here && here.areaId === a.id ? ' here' : ''), label(a.id, a.name));
        b.type = 'button';
        b.onclick = function () { MapView._areaId = a.id; MapView._fieldId = null; MapView._draw(root, stageId, onPick); };
        strip.appendChild(b);
      });
      root.appendChild(strip);

      /* the map */
      var view = el('div', 'wmap');
      var scroll = el('div', 'wmap-scroll');
      var inner = el('div', 'wmap-inner' + (fieldId ? ' zoomed' : ''));
      var img = el('img', 'wmap-img'); img.alt = ''; img.src = AREA_IMG + areaId + '.jpg';
      img.onerror = function () { inner.classList.add('noart'); };
      inner.appendChild(img);
      var spot = el('div', 'wmap-spot'); inner.appendChild(spot);
      scroll.appendChild(inner); view.appendChild(scroll);
      root.appendChild(view);

      var pin = function (cls, pos, name, onClick) {
        var p = el('button', 'wmap-pin ' + cls);
        p.type = 'button';
        p.style.left = pos[0] + '%'; p.style.top = pos[1] + '%';
        p.innerHTML = '<i class="wmap-mark"></i>';
        p.appendChild(el('span', 'wmap-label', name));
        p.onclick = function (e) { e.stopPropagation(); onClick(); };
        inner.appendChild(p);
        return p;
      };

      if (!fieldId) {
        area.fields.forEach(function (f) {
          var isHere = here && here.fieldId === f.id;
          pin('field' + (isHere ? ' here' : ''), fieldPos(f.id), label(f.id, f.name), function () {
            MapView._fieldId = f.id; MapView._draw(root, stageId, onPick);
          });
        });
      } else {
        var field = area.fields.filter(function (f) { return f.id === fieldId; })[0];
        if (!field) { MapView._fieldId = null; return MapView._draw(root, stageId, onPick); }
        var fp = fieldPos(fieldId);
        spot.style.setProperty('--sx', fp[0] + '%'); spot.style.setProperty('--sy', fp[1] + '%');
        inner.classList.add('spotlit');
        field.stages.forEach(function (s, i) {
          var isHere = s.id === stageId;
          pin('stage' + (isHere ? ' here' : ''), stagePos(fieldId, i, field.stages.length), label(s.id, s.name), function () {
            if (!isHere) onPick && onPick(s.id);
          });
        });
      }

      /* bottom bar */
      var bar = el('div', 'wmap-bar');
      if (fieldId) {
        var back = el('button', 'wmap-btn', '‹ ' + label(fieldId, (area.fields.filter(function (f) { return f.id === fieldId; })[0] || {}).name));
        back.type = 'button';
        back.onclick = function () { MapView._fieldId = null; MapView._draw(root, stageId, onPick); };
        bar.appendChild(back);
      } else {
        bar.appendChild(el('span', 'wmap-hint', t('places.mapHint', 'Tap a place to zoom in')));
      }
      if (here) {
        var cur = el('button', 'wmap-btn primary', t('places.current', 'Current location'));
        cur.type = 'button';
        cur.onclick = function () { MapView._areaId = here.areaId; MapView._fieldId = here.fieldId; MapView._draw(root, stageId, onPick); };
        bar.appendChild(cur);
      }
      root.appendChild(bar);

      /* size the picture so it fills the viewport's height (16:9) and, when
         zoomed, centre the field */
      var fit = function () {
        var vw = scroll.clientWidth || 360, vh = scroll.clientHeight || 240;
        var base = Math.max(vw, vh * 16 / 9);
        var w = base * (fieldId ? ZOOM : 1), h = w * 9 / 16;
        inner.style.width = w + 'px'; inner.style.height = h + 'px';
        var focus = fieldId ? fieldPos(fieldId) : (here && here.areaId === areaId ? fieldPos(here.fieldId) : [50, 50]);
        var go = function () {
          var left = Math.max(0, focus[0] / 100 * w - vw / 2), top = Math.max(0, focus[1] / 100 * h - vh / 2);
          if (scroll.scrollTo) scroll.scrollTo({ left: left, top: top, behavior: 'smooth' });
          else { scroll.scrollLeft = left; scroll.scrollTop = top; }
        };
        /* the size animates (.45s): scroll now for the range that exists, and
           again once the picture has grown to its final size */
        go(); setTimeout(go, 120); setTimeout(go, 500);
      };
      requestAnimationFrame(fit);
      if (!MapView._fitBound) {
        MapView._fitBound = true;
        global.addEventListener('resize', function () { if (root.isConnected && root.querySelector('.wmap-scroll')) MapView._draw(root, stageId, onPick); });
      }
    }
  };

  global.MapView = MapView;
})(typeof window !== 'undefined' ? window : globalThis);
