/* Outfits — several Live2D costumes on one character card.

   A card's pack has ONE active model (`pack.model`). Outfits are the list of
   model3 files the pack could show instead:
     pack.outfits = [{ id, name, model }]     (model is pack-relative)
   Where the list comes from:
     - an imported zip that holds several .model3.json (a hololive Dreams
       export: costumes/<id>/<id>.model3.json + live2d-character.json with
       the display names and the default costume)
     - "Add outfit": another zip merged into the stored pack under
       outfits/<slug>/ (imported packs only — shipped packs are read-only)
     - a shipped pack whose folder has live2d-character.json: only the
       costumes actually on disk are offered
   Thumbnails are captured from the live canvas after an outfit is worn and
   kept per character in Store bucket "outfit-thumbs" ({ outfitId: dataURL }). */
(function (global) {
  'use strict';

  var CHAR_JSON = 'live2d-character.json';
  var THUMBS = 'outfit-thumbs';
  var cache = {};   // cardId -> [{id,name,model}] derived for shipped packs

  function slug(s) { return global.PackFS ? PackFS.slug(s) : String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
  function dirOf(rel) { return rel.indexOf('/') !== -1 ? rel.slice(0, rel.lastIndexOf('/')) : ''; }
  function baseName(rel) { return rel.split('/').pop().replace(/\.model3\.json$/i, ''); }

  /* Outfit id + name for a model3 path, using live2d-character.json when it
     lists it. `chara` is the parsed live2d-character.json or null. */
  function describe(model, chara) {
    var hit = null;
    ((chara && chara.costumes) || []).some(function (c) {
      if (c && c.model && (c.model === model || model.slice(-c.model.length) === c.model)) { hit = c; return true; }
      return false;
    });
    var folder = dirOf(model).split('/').pop();
    var id = slug(hit && hit.id ? hit.id : (folder || baseName(model)));
    var name = hit && hit.name ? String(hit.name) : (folder || baseName(model)).replace(/[-_]+/g, ' ');
    return { id: id, name: name, model: model };
  }

  /* Build the outfit list from a set of model3 paths (+ optional chara json).
     Pure; used by the importer, add-outfit and the regression. */
  function fromModels(models, chara) {
    var seen = {}, out = [];
    (models || []).slice().sort().forEach(function (m) {
      var o = describe(m, chara);
      var base = o.id, n = 2;
      while (seen[o.id]) o.id = base + '-' + (n++);
      seen[o.id] = true;
      out.push(o);
    });
    return out;
  }

  /* The model the pack should open with: live2d-character.json's default
     costume when present, else the caller's pick, else the first. */
  function defaultModel(outfits, chara, preferred) {
    var def = chara && chara.defaultCostume;
    var hit = def && outfits.filter(function (o) { return o.id === slug(def); })[0];
    if (hit) return hit.model;
    if (preferred && outfits.some(function (o) { return o.model === preferred; })) return preferred;
    return outfits.length ? outfits[0].model : null;
  }

  function fetchJson(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  var Outfits = {
    fromModels: fromModels,
    defaultModel: defaultModel,
    describe: describe,

    /* Outfits of a card -> Promise<[{id,name,model,active}]> (always >= 1 when
       the pack has a model). */
    list: function (card) {
      var pack = (card && card.pack) || {};
      if (!pack.model) return Promise.resolve([]);
      var mark = function (list) {
        return list.map(function (o) { return { id: o.id, name: o.name, model: o.model, active: o.model === pack.model }; });
      };
      if (Array.isArray(pack.outfits) && pack.outfits.length) return Promise.resolve(mark(pack.outfits));
      if (cache[card.id]) return Promise.resolve(mark(cache[card.id]));
      var single = [{ id: slug(baseName(pack.model)), name: baseName(pack.model), model: pack.model }];
      if (pack.source === 'idb' && global.PackFS) {
        return PackFS.get(pack.packId).then(function (rec) {
          var models = Object.keys((rec && rec.files) || {}).filter(function (r) { return /\.model3\.json$/i.test(r); });
          var charaP = rec && rec.files[CHAR_JSON] ? rec.files[CHAR_JSON].text().then(JSON.parse).catch(function () { return null; }) : Promise.resolve(null);
          return charaP.then(function (chara) {
            cache[card.id] = models.length ? fromModels(models, chara) : single;
            return mark(cache[card.id]);
          });
        }).catch(function () { return mark(single); });
      }
      if (!pack.path || typeof fetch !== 'function') return Promise.resolve(mark(single));
      /* shipped pack: the export's costume list, kept to what exists on disk */
      return fetchJson(pack.path + '/' + CHAR_JSON).then(function (chara) {
        var models = ((chara && chara.costumes) || []).map(function (c) { return c && c.model; }).filter(Boolean);
        return Promise.all(models.map(function (m) {
          return fetch(pack.path + '/' + m, { method: 'HEAD' }).then(function (r) { return r.ok ? m : null; }, function () { return null; });
        })).then(function (present) {
          var have = present.filter(Boolean);
          if (have.indexOf(pack.model) === -1) have.push(pack.model);
          cache[card.id] = fromModels(have, chara);
          return mark(cache[card.id]);
        });
      }).catch(function () { return mark(single); });
    },

    /* Switch the card's active model. Returns the updated card (persisted). */
    wear: function (card, outfitId) {
      return Outfits.list(card).then(function (list) {
        var o = list.filter(function (x) { return x.id === outfitId; })[0];
        if (!o) throw new Error('no such outfit: ' + outfitId);
        var next = JSON.parse(JSON.stringify(card));
        next.pack.model = o.model;
        if (!Array.isArray(next.pack.outfits) || !next.pack.outfits.length) {
          next.pack.outfits = list.map(function (x) { return { id: x.id, name: x.name, model: x.model }; });
        }
        return Characters.upsert(next);
      });
    },

    /* Merge another zip/folder into an imported pack as a new outfit. */
    add: function (card, files, name) {
      var pack = (card && card.pack) || {};
      if (pack.source !== 'idb' || !global.PackFS) return Promise.reject(new Error('outfits can only be added to imported characters'));
      var m3 = PackFS.findModel3(files);
      if (!m3.length) return Promise.reject(new Error('no .model3.json in the pack'));
      var id = slug(name || baseName(m3[0]));
      var existing = Array.isArray(pack.outfits) ? pack.outfits : [];
      var base = id, n = 2;
      while (existing.some(function (o) { return o.id === id; })) id = base + '-' + (n++);
      var prefix = 'outfits/' + id + '/';
      return PackFS.merge(pack.packId, files, prefix).then(function (rec) {
        var model = rec.files.filter(function (r) { return r.indexOf(prefix) === 0 && /\.model3\.json$/i.test(r); }).sort()[0];
        if (!model) throw new Error('outfit model not stored');
        return Outfits.list(card).then(function (list) {
          var next = JSON.parse(JSON.stringify(card));
          next.pack.outfits = list.map(function (x) { return { id: x.id, name: x.name, model: x.model }; });
          next.pack.outfits.push({ id: id, name: name || id, model: model });
          delete cache[card.id];
          return Characters.upsert(next);
        });
      });
    },

    /* Drop an added outfit (its files stay in the pack; only the entry goes). */
    forget: function (card, outfitId) {
      var next = JSON.parse(JSON.stringify(card));
      var list = Array.isArray(next.pack.outfits) ? next.pack.outfits : [];
      next.pack.outfits = list.filter(function (o) { return o.id !== outfitId; });
      var t = Outfits.thumbs(card.id); delete t[outfitId]; Outfits._saveThumbs(card.id, t);
      return Characters.upsert(next);
    },

    /* ---------------------------------------------------------- thumbnails */
    thumbs: function (cardId) {
      var t = global.Store ? Store.get(cardId, THUMBS, {}) : {};
      return (t && typeof t === 'object') ? t : {};
    },
    _saveThumbs: function (cardId, t) { if (global.Store) Store.set(cardId, THUMBS, t); },
    setThumb: function (cardId, outfitId, dataUrl) {
      var t = Outfits.thumbs(cardId);
      if (dataUrl) t[outfitId] = dataUrl; else delete t[outfitId];
      Outfits._saveThumbs(cardId, t);
    },

    invalidate: function (cardId) { delete cache[cardId]; }
  };

  global.Outfits = Outfits;
})(typeof window !== 'undefined' ? window : globalThis);
