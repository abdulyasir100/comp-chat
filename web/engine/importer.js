/* Importer — turn a folder or zip of Live2D files into a character card.

   Steps: store the files in PackFS -> find the model3.json -> inspect its
   capabilities -> build the automatic emotion / idle / tap mapping -> create
   (or update) a card whose pack points at the stored files. The card is a
   normal custom card: it lives in Characters (localStorage) and can be edited
   in the character editor like any other. */
(function (global) {
  'use strict';

  var Importer = {
    /* files: { rel: Blob }; opts: { id, name, model (rel of model3 if several), card (extra fields) }
       -> Promise<{ card, caps, pack, model3s }> */
    fromFiles: function (files, opts) {
      opts = opts || {};
      var model3s = PackFS.findModel3(files);
      if (!model3s.length) return Promise.reject(new Error('no .model3.json in the pack'));
      var model3 = opts.model && model3s.indexOf(opts.model) !== -1 ? opts.model : model3s[0];
      var name = opts.name || PackFS.slug(model3.split('/').pop()).replace(/-/g, ' ');
      var id = PackFS.slug(opts.id || name);
      if (Characters.get(id) && Characters.get(id).builtin) id = id + '-2';
      return PackFS.put(id, name, files).then(function (rec) {
        /* the stored paths may have lost a common root; re-find the model3 */
        var stored = rec.files.filter(function (r) { return /\.model3\.json$/i.test(r); }).sort();
        var picked = stored.filter(function (r) { return model3.indexOf(r) !== -1 || r.indexOf(model3) !== -1; })[0] || stored[0];
        /* several model3 = several outfits (a Dreams export); the export's
           live2d-character.json names them and picks the default */
        var charaP = rec.files.indexOf('live2d-character.json') !== -1
          ? PackFS.readJson(id, 'live2d-character.json').catch(function () { return null; }) : Promise.resolve(null);
        return charaP.then(function (chara) {
        var outfits = global.Outfits ? Outfits.fromModels(stored, chara) : [];
        var m3 = (global.Outfits && Outfits.defaultModel(outfits, chara, opts.model ? picked : null)) || picked;
        return PackFS.readJson(id, m3).then(function (json) {
          var caps = Capabilities.inspectModel3(json);
          var dir = m3.indexOf('/') !== -1 ? m3.slice(0, m3.lastIndexOf('/') + 1) : '';
          /* optional flat motion index next to the model or at the root */
          var idxRel = ['motions/index.json', dir + 'motions/index.json'].filter(function (r) { return rec.files.indexOf(r) !== -1; })[0] || null;
          var listP = idxRel ? PackFS.readJson(id, idxRel).catch(function () { return []; }) : Promise.resolve([]);
          /* the shared library is part of what the model can play, so the
             automatic mapping must see its names too (same merge as the loader) */
          var sharedP = (global.CubismBackend && CubismBackend.sharedIndex) ? CubismBackend.sharedIndex() : Promise.resolve([]);
          return Promise.all([listP, sharedP]).then(function (both) {
            var flat = both[0], shared = both[1];
            var motionNames = (Array.isArray(flat) ? flat : []).map(function (e) { return e && e.name; }).filter(Boolean);
            Object.keys(json.FileReferences && json.FileReferences.Motions || {}).forEach(function (g) {
              (json.FileReferences.Motions[g] || []).forEach(function (_, i) { motionNames.push(g + '-' + i); });
            });
            (shared || []).forEach(function (e) { if (motionNames.indexOf(e.name) === -1) motionNames.push(e.name); });
            var auto = Capabilities.autoPack(caps, motionNames);
            var pack = {
              renderer: 'cubism', source: 'idb', packId: id, path: '', model: m3,
              motions: idxRel, emotions: auto.emotions, idle: auto.idle, tap: auto.tap,
              outfits: outfits.length > 1 ? outfits : [],
              media_required: false, imported: Date.now(), bytes: rec.bytes
            };
            var card = Object.assign({
              id: id, name: name,
              description: '', personality: '', speech_style: '',
              example_messages: [],
              voice: { provider: 'omnivoice', ref_audio: null, instruct: null }
            }, opts.card || {}, { id: id, pack: pack, emotions: Capabilities.emotionList(auto.emotions) });
            Characters.upsert(card);
            return { card: Characters.get(id), caps: caps, pack: pack, model3s: stored, motions: motionNames.length, outfits: outfits.length };
          });
        });
        });
      });
    },

    /* Remove a custom character and its stored pack (built-ins only revert). */
    remove: function (id) {
      var card = Characters.get(id);
      var p = (card && card.pack && card.pack.source === 'idb') ? PackFS.remove(card.pack.packId).catch(function () {}) : Promise.resolve();
      return p.then(function () {
        Characters.remove(id);
        if (global.Store) Store.wipe(id);
        return true;
      });
    }
  };

  global.Importer = Importer;
})(typeof window !== 'undefined' ? window : globalThis);
