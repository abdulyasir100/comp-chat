/* PackFS — user-imported character packs, stored in IndexedDB.

   A pack is a flat map of relative path -> Blob (a Live2D folder: model3.json,
   moc3, textures, expressions, motions...). Renderers never read the store
   directly: they get a resolver, `function (rel) -> url`, and the Cubism
   loader fetches through it. Built-in packs resolve to plain http paths; an
   imported pack resolves to blob: URLs minted on demand and revoked when the
   pack is released. The same storage works in the browser, the Electron shell
   and the Android WebView, which is the point — a single APK needs no writable
   asset directory.

   Store "packs":  { id, name, created, files: { rel: Blob }, bytes }
   Store "meta" is not used yet.                                          */
(function (global) {
  'use strict';

  var DB = 'companion-chat', VERSION = 1, STORE = 'packs';
  var dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      if (!global.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      var req = global.indexedDB.open(DB, VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB open failed')); };
    });
    return dbp;
  }

  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var store = t.objectStore(STORE);
        var out = fn(store);
        /* a request resolves to its result (undefined for a missing key —
           the old check leaked the IDBRequest itself, which is truthy) */
        t.oncomplete = function () { resolve(out && typeof out === 'object' && 'result' in out ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('aborted')); };
      });
    });
  }

  function norm(rel) {
    return String(rel || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  }

  /* Strip a common leading directory ("MyModel/…") so model3 sits at the root
     when the zip or folder wrapped everything in one top-level dir. */
  function stripCommonRoot(paths) {
    if (!paths.length) return '';
    var first = paths[0].split('/');
    if (first.length < 2) return '';
    var root = first[0] + '/';
    for (var i = 0; i < paths.length; i++) if (paths[i].indexOf(root) !== 0) return '';
    return root;
  }

  function slug(s) {
    return String(s || '').toLowerCase().replace(/(\.[a-z0-9]+)+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'pack';
  }

  var PackFS = {
    _urls: {},   // packId -> { rel: blobUrl }

    list: function () {
      return tx('readonly', function (s) { return s.getAll(); }).then(function (rows) {
        return (rows || []).map(function (r) {
          return { id: r.id, name: r.name, created: r.created, bytes: r.bytes, count: Object.keys(r.files || {}).length };
        });
      });
    },

    get: function (id) {
      return tx('readonly', function (s) { return s.get(id); });
    },

    /* files: { rel: Blob } — stores and returns the pack record summary. */
    put: function (id, name, files) {
      var clean = {}, bytes = 0, rels = Object.keys(files).map(norm).filter(Boolean);
      var root = stripCommonRoot(rels);
      Object.keys(files).forEach(function (k) {
        var rel = norm(k);
        if (!rel) return;
        if (root && rel.indexOf(root) === 0) rel = rel.slice(root.length);
        if (!rel || /\/$/.test(rel)) return;
        clean[rel] = files[k];
        bytes += files[k].size || 0;
      });
      var rec = { id: id, name: name || id, created: Date.now(), files: clean, bytes: bytes };
      return tx('readwrite', function (s) { s.put(rec); }).then(function () {
        PackFS.release(id);
        return { id: id, name: rec.name, bytes: bytes, count: Object.keys(clean).length, files: Object.keys(clean) };
      });
    },

    /* Add files to an existing pack under a prefix ("outfits/<id>/"). The
       incoming set loses its own common root first, like put(). */
    merge: function (id, files, prefix) {
      prefix = String(prefix || '').replace(/^\/+|\/+$/g, '');
      prefix = prefix ? prefix + '/' : '';
      return PackFS.get(id).then(function (rec) {
        if (!rec) throw new Error('pack not found: ' + id);
        var rels = Object.keys(files).map(norm).filter(Boolean);
        var root = stripCommonRoot(rels);
        Object.keys(files).forEach(function (k) {
          var rel = norm(k);
          if (!rel) return;
          if (root && rel.indexOf(root) === 0) rel = rel.slice(root.length);
          if (!rel || /\/$/.test(rel)) return;
          rec.files[prefix + rel] = files[k];
          rec.bytes = (rec.bytes || 0) + (files[k].size || 0);
        });
        return tx('readwrite', function (s) { s.put(rec); }).then(function () {
          PackFS.release(id);
          return { id: id, name: rec.name, bytes: rec.bytes, count: Object.keys(rec.files).length, files: Object.keys(rec.files) };
        });
      });
    },

    remove: function (id) {
      PackFS.release(id);
      return tx('readwrite', function (s) { s.delete(id); });
    },

    /* Resolver for a stored pack: rel -> blob URL (minted lazily, cached). */
    resolver: function (id) {
      return PackFS.get(id).then(function (rec) {
        if (!rec) throw new Error('pack not found: ' + id);
        var urls = PackFS._urls[id] = PackFS._urls[id] || {};
        return function (rel) {
          rel = norm(rel);
          if (urls[rel]) return urls[rel];
          var blob = rec.files[rel];
          if (!blob) return 'blob:missing/' + rel;   // fetch() will 404-equivalent
          urls[rel] = URL.createObjectURL(blob);
          return urls[rel];
        };
      });
    },

    /* Read a JSON file straight from the store (used by the importer). */
    readJson: function (id, rel) {
      return PackFS.get(id).then(function (rec) {
        var blob = rec && rec.files[norm(rel)];
        if (!blob) throw new Error('missing ' + rel);
        return blob.text().then(JSON.parse);
      });
    },

    release: function (id) {
      var urls = PackFS._urls[id];
      if (!urls) return;
      Object.keys(urls).forEach(function (k) { try { URL.revokeObjectURL(urls[k]); } catch (e) {} });
      delete PackFS._urls[id];
    },

    /* ---- importers: both yield { rel: Blob } ---- */

    /* FileList from <input type=file webkitdirectory> */
    fromFileList: function (fileList) {
      var files = {};
      Array.prototype.forEach.call(fileList || [], function (f) {
        var rel = f.webkitRelativePath || f.name;
        files[rel] = f;
      });
      return Promise.resolve(files);
    },

    /* A .zip Blob, unpacked with JSZip (web/vendor/jszip.min.js). */
    fromZip: function (blob) {
      if (!global.JSZip) return Promise.reject(new Error('JSZip missing'));
      return global.JSZip.loadAsync(blob).then(function (zip) {
        var files = {}, jobs = [];
        zip.forEach(function (rel, entry) {
          if (entry.dir) return;
          if (/(^|\/)(__MACOSX|\.DS_Store)/.test(rel)) return;
          jobs.push(entry.async('blob').then(function (b) { files[rel] = b; }));
        });
        return Promise.all(jobs).then(function () { return files; });
      });
    },

    /* Candidate model3.json entries inside a file map. */
    findModel3: function (files) {
      return Object.keys(files).map(norm).filter(function (r) { return /\.model3\.json$/i.test(r); }).sort();
    },

    slug: slug,
    norm: norm,
    _stripCommonRoot: stripCommonRoot
  };

  global.PackFS = PackFS;
})(typeof window !== 'undefined' ? window : globalThis);
