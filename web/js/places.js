/* Places — where the two of you are, and what time of day it is.

   A place is a backdrop behind the character:
     - image places: one picture, or one per time band (mor/aft/eve/ngt).
       Built-in "Home" ships with the app; the user adds their own from photos
       (shrunk to 1600px JPEGs, kept as Blobs in the PackFS pack "__places__",
       meta in localStorage cc.places.v1). A single-picture place gets a CSS
       tint per band so evening and night still read as evening and night.
     - spine places: the Spine rig's own scenes (a personal build with the
       licensed media) — listed only while a Spine character is active and
       handed to the existing gotoStage path.
   Time of day: the app clock (real / flow / manual) picks the band; the round
   button on the stage cycles morning -> afternoon -> evening -> night -> auto. */
(function (global) {
  'use strict';

  var META_KEY = 'cc.places.v1';
  var PACK_ID = '__places__';
  var TODS = ['mor', 'aft', 'eve', 'ngt'];
  var CYCLE = ['mor', 'aft', 'eve', 'ngt', 'auto'];
  var MAX_SIDE = 1600;
  /* Home ships without a picture: a CSS night-sky backdrop (#stage.place-home),
     so no upstream art is bundled. */
  var HOME = { id: 'home', name: null, image: null, builtin: true, css: 'place-home' };

  function readMeta() { try { var v = JSON.parse(global.localStorage.getItem(META_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function writeMeta(v) { try { global.localStorage.setItem(META_KEY, JSON.stringify(v)); } catch (e) {} }
  function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'place'; }
  function t(k, fb) { return (global.I18n && I18n.tc) ? I18n.tc(k, fb) : fb; }

  /* Shrink an image File to a JPEG Blob no larger than MAX_SIDE. */
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var im = new Image();
      im.onload = function () {
        var k = Math.min(1, MAX_SIDE / Math.max(im.width, im.height));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(im.width * k)); c.height = Math.max(1, Math.round(im.height * k));
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('encode failed')); }, 'image/jpeg', 0.86);
      };
      im.onerror = function () { URL.revokeObjectURL(url); reject(new Error('not an image')); };
      im.src = url;
    });
  }

  var Places = {
    TODS: TODS,
    CYCLE: CYCLE,

    /* next band on the stage button: mor -> aft -> eve -> ngt -> auto -> mor */
    cycleTod: function (cur, auto) {
      var key = auto ? 'auto' : cur;
      var i = CYCLE.indexOf(key);
      return CYCLE[(i + 1) % CYCLE.length];
    },

    /* CSS class for the backdrop tint of a single-picture place. */
    tintClass: function (tod) { return TODS.indexOf(tod) !== -1 ? 'tod-' + tod : 'tod-aft'; },

    /* Image places the user can pick: built-in Home + custom ones. */
    imagePlaces: function () {
      var home = Object.assign({}, HOME, { name: t('places.home', 'Home') });
      return [home].concat(readMeta().map(function (p) {
        return { id: p.id, name: p.name, custom: true, tods: p.tods || {}, any: p.any || null, ambient: p.ambient | 0 };
      }));
    },
    get: function (id) { return Places.imagePlaces().filter(function (p) { return p.id === id; })[0] || null; },

    /* Resolve the backdrop URL of a place for a band (blob URL for custom). */
    imageFor: function (id, tod) {
      var p = Places.get(id);
      if (!p) return Promise.resolve(null);
      if (!p.custom) return Promise.resolve(p.image || null);   /* built-in: null = CSS backdrop */
      var rel = (p.tods && p.tods[tod]) || p.any || (p.tods && p.tods[Object.keys(p.tods)[0]]);
      if (!rel || !global.PackFS) return Promise.resolve(null);
      return PackFS.resolver(PACK_ID).then(function (res) { return res(rel); }).catch(function () { return null; });
    },
    /* true when the place has its own picture for that band (no tint needed) */
    hasBandImage: function (id, tod) {
      var p = Places.get(id);
      return !!(p && p.custom && p.tods && p.tods[tod]);
    },
    thumbFor: function (id) { return Places.imageFor(id, 'aft'); },

    /* Add a place: { name, files: { any?: File, mor?: File, aft?: File, eve?: File, ngt?: File }, ambient } */
    add: function (spec) {
      var name = String(spec && spec.name || '').trim();
      if (!name) return Promise.reject(new Error('name'));
      var files = (spec && spec.files) || {};
      var slots = Object.keys(files).filter(function (k) { return files[k] && (k === 'any' || TODS.indexOf(k) !== -1); });
      if (!slots.length) return Promise.reject(new Error('image'));
      var meta = readMeta();
      var base = slug(name), id = base, n = 2;
      var taken = Places.imagePlaces().map(function (p) { return p.id; });
      while (taken.indexOf(id) !== -1) id = base + '-' + (n++);
      return Promise.all(slots.map(function (k) { return shrink(files[k]).then(function (b) { return { k: k, blob: b }; }); }))
        .then(function (blobs) {
          /* files go in under "<id>/" via merge (put() would strip a lone
             common folder and lose the id prefix) */
          var pack = {};
          var rec = { id: id, name: name, tods: {}, any: null, ambient: (spec.ambient | 0) };
          blobs.forEach(function (x) {
            pack[x.k + '.jpg'] = x.blob;
            var rel = id + '/' + x.k + '.jpg';
            if (x.k === 'any') rec.any = rel; else rec.tods[x.k] = rel;
          });
          return PackFS.get(PACK_ID).then(function (existing) {
            return existing ? null : PackFS.put(PACK_ID, 'places', {});
          }).then(function () {
            return PackFS.merge(PACK_ID, pack, id);
          }).then(function () {
            meta.push(rec);
            writeMeta(meta);
            return Places.get(id);
          });
        });
    },

    remove: function (id) {
      writeMeta(readMeta().filter(function (p) { return p.id !== id; }));
      /* the blobs stay in the pack until the next put; small and harmless */
      return Promise.resolve(true);
    }
  };

  global.Places = Places;
})(typeof window !== 'undefined' ? window : globalThis);
