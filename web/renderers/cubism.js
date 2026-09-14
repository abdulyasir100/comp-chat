/* Cubism (Live2D) backend. Ported from live2d-companion (src/model.ts,
   idle.ts, audio.ts) onto the Stage interface, in plain JS against the
   bundled framework (web/vendor/cubism-framework.js, global `Cubism`) and
   the Core (web/vendor/live2dcubismcore.min.js — fetch with
   scripts/fetch_cubism_core.py, it is not in git).

   Pack fields (card.pack):
     renderer: "cubism"
     path:     "assets/models/aria"            directory of the model
     model:    "costumes/x/x.model3.json"      model3 relative to path
     motions:  "motions/index.json"            optional flat motion index
                                               [{name,file,duration,loop}]
     emotions: { happy: {expression:"joy-01", motions:["joy-","smile-"]}, ...}
     idle:     { loop:["idle-"], ambient:["look-around-",...], gap:[9,24] }
     tap:      { Head: ["contact-"], Body: ["TapBody"] }   part -> motion prefixes / groups
     scale:    1.35   margin: 0.06    offsetY: 0.0      framing tweaks
     anchor:   "top" (default; head under the top bar, body cropped) | "fit"
     topMargin: 0.10  clip-space gap above the art when anchored top

   Motions come from three places, merged into one list: the model3.json
   "Motions" groups (Live2D samples), the pack's flat index file (converted
   game rigs) and the SHARED LIBRARY (assets/motions/shared/index.json)
   that every Cubism pack gets unless pack.shared_motions === false. Shared
   clips animate on the standard Cubism parameter ids (angle, body, eyes,
   mouth, breath); curves for parameters a model lacks are skipped by the
   framework, so one library serves any uploaded model. A pack's own clip wins
   over a shared clip of the same name. Group motions get the group name as
   their prefix, e.g. "TapBody-0", so the same prefix rules cover all three. */
(function (global) {
  'use strict';

  var HEURISTIC = {
    /* expression name fragments per emotion, checked in order (built-in
       fallback; a pack's own emotion map takes precedence) */
    happy: ['joy', 'happy', 'smile', 'f02'],
    sad: ['sad', 'cry', 'tear', 'f03'],
    angry: ['anger', 'angry', 'mad', 'f04'],
    surprised: ['surprise', 'shock', 'f05'],
    shy: ['shy', 'blush', 'f06'],
    smug: ['doya', 'smug', 'proud', 'f07'],
    serious: ['serious', 'think', 'f08'],
    neutral: ['idle', 'normal', 'default', 'f01']
  };

  function fetchBuffer(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(r.status + ' ' + url);
      return r.arrayBuffer();
    });
  }

  function makeTexture(gl, img) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  /* Motion priorities (the framework only records them; we enforce): a
     reaction (tap / emotion) is never interrupted by an ambient clip, and
     the idle loop only restarts when nothing else is playing. */
  var PRI = { IDLE: 1, AMBIENT: 2, REACT: 3 };
  /* Fade used when neither the model3 group nor the motion3 Meta gives one.
     The framework defaults an unspecified Meta fade to a 1 s pop-in. */
  var DEFAULT_FADE = 0.5;
  /* Shared motion library (app-relative). Cached across pack loads. */
  var SHARED_INDEX = 'assets/motions/shared/index.json';
  var sharedP = null;
  function sharedIndex() {
    if (sharedP) return sharedP;
    var dir = SHARED_INDEX.slice(0, SHARED_INDEX.lastIndexOf('/') + 1);
    sharedP = (typeof fetch === 'function' ? fetch(SHARED_INDEX) : Promise.reject(new Error('no fetch')))
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) {
        return (Array.isArray(list) ? list : []).filter(function (e) { return e && e.name && e.file; }).map(function (e) {
          return { name: e.name, file: e.file, loop: !!e.loop, duration: e.duration, url: dir + e.file, shared: true };
        });
      }).catch(function () { return []; });
    return sharedP;
  }

  /* ---- pure helpers (unit-tested in scripts/stage_regression.js) ---- */

  /* Motion list from a model3 "Motions" section: {group: [{File, ...}]} */
  function motionsFromGroups(groups) {
    var out = [];
    Object.keys(groups || {}).forEach(function (g) {
      (groups[g] || []).forEach(function (m, i) {
        if (!m || !m.File) return;
        /* CubismModelSettingJson reports -1 for an absent fade → leave undefined */
        var fi = (typeof m.FadeInTime === 'number' && m.FadeInTime >= 0) ? m.FadeInTime : undefined;
        var fo = (typeof m.FadeOutTime === 'number' && m.FadeOutTime >= 0) ? m.FadeOutTime : undefined;
        out.push({ name: g + '-' + i, file: m.File, group: g, loop: /^idle$/i.test(g),
                   fadeIn: fi, fadeOut: fo });
      });
    });
    return out;
  }

  /* Which expression + one-shot motion an emotion maps to for this model. */
  function resolveEmotion(emotion, map, expressions, motionIndex) {
    var e = String(emotion || 'neutral').toLowerCase();
    var rule = (map && map[e]) || null;
    var expr = null, prefixes = [];
    if (rule) {
      if (typeof rule === 'string') rule = { expression: rule };
      if (rule.expression && expressions.indexOf(rule.expression) !== -1) expr = rule.expression;
      prefixes = rule.motions || [];
    }
    if (!expr) {
      var frags = HEURISTIC[e] || [];
      for (var i = 0; i < frags.length && !expr; i++) {
        for (var j = 0; j < expressions.length; j++) {
          if (expressions[j].toLowerCase().indexOf(frags[i]) !== -1) { expr = expressions[j]; break; }
        }
      }
    }
    var motions = motionIndex.filter(function (m) {
      return !m.loop && prefixes.some(function (p) { return m.name.indexOf(p) === 0; });
    });
    return { expression: expr, motion: motions.length ? motions[Math.floor(Math.random() * motions.length)].name : null };
  }

  /* Effective maps = automatic mapping filled in by the pack's own rules.
     A pack rule only overrides what it actually sets: a bare expression
     string (sample cards) keeps the automatic motion prefixes, and an empty
     prefix list counts as unset so the shared library still applies. */
  function mergeMaps(auto, pack) {
    var out = { emotions: {}, idle: {}, tap: {} };
    var pe = (pack && pack.emotions) || {};
    Object.keys(auto.emotions || {}).concat(Object.keys(pe)).forEach(function (e) {
      var a = auto.emotions[e] || {}, r = pe[e];
      if (typeof r === 'string') r = { expression: r };
      r = r || {};
      out.emotions[e] = {
        expression: r.expression !== undefined ? r.expression : (a.expression || null),
        motions: (r.motions && r.motions.length) ? r.motions : (a.motions || [])
      };
    });
    var ai = auto.idle || {}, pi = (pack && pack.idle) || {};
    out.idle = {
      loop: (pi.loop && pi.loop.length) ? pi.loop : (ai.loop || []),
      ambient: (pi.ambient && pi.ambient.length) ? pi.ambient : (ai.ambient || []),
      gap: pi.gap || ai.gap || [9, 24]
    };
    var at = auto.tap || {}, pt = (pack && pack.tap) || {};
    Object.keys(at).concat(Object.keys(pt)).forEach(function (part) {
      out.tap[part] = (pt[part] && pt[part].length) ? pt[part] : (at[part] || []);
    });
    return out;
  }

  function pickByPrefix(motionIndex, prefixes, loop) {
    var hits = motionIndex.filter(function (m) {
      return !!m.loop === !!loop && prefixes.some(function (p) { return m.name.indexOf(p) === 0; });
    });
    return hits.length ? hits[Math.floor(Math.random() * hits.length)].name : null;
  }

  /* ---- the model (CubismUserModel subclass) ---- */

  function defineModelClass() {
    var C = global.Cubism;
    class CModel extends C.CubismUserModel {
      constructor() {
        super();
        this.expressions = {};
        this.expressionNames = [];
        this.motions = {};
        this.motionIndex = [];
        this.hitAreas = [];       // [{name, id}]
        this.res = null;
        this.projection = new C.CubismMatrix44();
        this.lookTarget = { x: 0, y: 0 };
        this.lookCurrent = { x: 0, y: 0 };
        this.mouthOpen = 0;
        this.zoom = 1; this.margin = 0.06; this.offsetY = 0; this.panelFrac = 0;
        this.anchor = 'top'; this.topMargin = 0.10;
        this._ids = {};
        this._art = null;
        this._effectIds = null;
      }

      id(name) {
        if (!this._ids[name]) this._ids[name] = C.CubismFramework.getIdManager().getId(name);
        return this._ids[name];
      }

      /* res(rel) -> url resolves pack-relative paths (http path or blob URL).
         model3Rel / motionsRel are pack-relative; model3 references resolve
         against the model3's OWN folder. */
      static load(gl, res, model3Rel, motionsRel, onStep, useShared) {
        var self = new CModel();
        var setting;
        onStep = onStep || function () {};
        var mdir = model3Rel.indexOf('/') !== -1 ? model3Rel.slice(0, model3Rel.lastIndexOf('/') + 1) : '';
        var at = function (rel) { return res(mdir + rel); };
        self.res = res;
        return fetchBuffer(res(model3Rel)).then(function (buf) {
          setting = new C.CubismModelSettingJson(buf, buf.byteLength);
          self.setting = setting;
          return fetchBuffer(at(setting.getModelFileName()));
        }).then(function (mocBuf) {
          self.mocVersion = new Uint8Array(mocBuf)[4];
          var supported = global.Live2DCubismCore.Version.csmGetLatestMocVersion();
          if (self.mocVersion > supported) throw new Error('moc3 v' + self.mocVersion + ' newer than Core v' + supported);
          self.loadModel(mocBuf, true);
          if (!self.getModel()) throw new Error('Core rejected the moc3');
          var chain = Promise.resolve();
          var physics = setting.getPhysicsFileName();
          if (physics) chain = chain.then(function () { return fetchBuffer(at(physics)); })
            .then(function (b) { self.loadPhysics(b, b.byteLength); });
          var pose = setting.getPoseFileName();
          if (pose) chain = chain.then(function () { return fetchBuffer(at(pose)); })
            .then(function (b) { self.loadPose(b, b.byteLength); });
          var n = setting.getExpressionCount();
          for (let i = 0; i < n; i++) {
            chain = chain.then(function () {
              var name = setting.getExpressionName(i);
              return fetchBuffer(at(setting.getExpressionFileName(i))).then(function (b) {
                var m = self.loadExpression(b, b.byteLength, name);
                if (m) { self.expressions[name] = m; self.expressionNames.push(name); }
              });
            });
          }
          return chain;
        }).then(function () {
          onStep(self.expressionNames.length + ' expressions');
          for (let i = 0; i < setting.getHitAreasCount(); i++) {
            self.hitAreas.push({ name: setting.getHitAreaName(i), id: setting.getHitAreaId(i) });
          }
          self.setupIdle();
          var count = setting.getTextureCount();
          self.createRenderer(0, 0);
          self.getRenderer().startUp(gl);
          self.getRenderer().setIsPremultipliedAlpha(true);
          var tex = Promise.resolve();
          for (let i = 0; i < count; i++) {
            tex = tex.then(function () {
              var img = new Image();
              img.src = at(setting.getTextureFileName(i));
              return img.decode().then(function () { self.getRenderer().bindTexture(i, makeTexture(gl, img)); });
            });
          }
          return tex;
        }).then(function () {
          /* motions: model3 groups + optional flat index */
          var groups = {};
          for (let g = 0; g < setting.getMotionGroupCount(); g++) {
            var gname = setting.getMotionGroupName(g);
            groups[gname] = [];
            for (let k = 0; k < setting.getMotionCount(gname); k++) {
              groups[gname].push({
                File: setting.getMotionFileName(gname, k),
                FadeInTime: setting.getMotionFadeInTimeValue(gname, k),
                FadeOutTime: setting.getMotionFadeOutTimeValue(gname, k)
              });
            }
          }
          self.motionIndex = motionsFromGroups(groups).map(function (m) { m.rel = mdir + m.file; return m; });
          if (!motionsRel) return;
          var idir = motionsRel.indexOf('/') !== -1 ? motionsRel.slice(0, motionsRel.lastIndexOf('/') + 1) : '';
          return fetch(res(motionsRel)).then(function (r) { return r.ok ? r.json() : []; }).then(function (list) {
            (Array.isArray(list) ? list : []).forEach(function (e) {
              if (e && e.name && e.file) self.motionIndex.push({ name: e.name, file: e.file, loop: !!e.loop, duration: e.duration, rel: idir + e.file });
            });
          }).catch(function () {});
        }).then(function () {
          if (useShared === false) return;
          return sharedIndex().then(function (list) {
            var have = {};
            self.motionIndex.forEach(function (m) { have[m.name] = true; });
            list.forEach(function (e) { if (!have[e.name]) self.motionIndex.push(e); });
          });
        }).then(function () {
          onStep(self.motionIndex.length + ' motions');
          self.setInitialized(true);
          return self;
        });
      }

      effectIds() {
        if (!this._effectIds) {
          var eye = new C.csmVector(), lip = new C.csmVector(), i;
          for (i = 0; i < this.setting.getEyeBlinkParameterCount(); i++) eye.pushBack(this.setting.getEyeBlinkParameterId(i));
          for (i = 0; i < this.setting.getLipSyncParameterCount(); i++) lip.pushBack(this.setting.getLipSyncParameterId(i));
          this._effectIds = [eye, lip];
        }
        return this._effectIds;
      }

      get motionIdle() { return !this._motionManager || this._motionManager.isFinished(); }

      currentPriority() {
        return (this._motionManager && this._motionManager.getCurrentPriority) ? this._motionManager.getCurrentPriority() : 0;
      }

      playMotion(name, priority) {
        var self = this;
        var prio = priority || PRI.AMBIENT;
        var motion = this.motions[name];
        if (motion) { this._motionManager.startMotionPriority(motion, false, prio); return Promise.resolve(true); }
        var entry = null;
        for (var i = 0; i < this.motionIndex.length; i++) if (this.motionIndex[i].name === name) { entry = this.motionIndex[i]; break; }
        if (!entry) return Promise.resolve(false);
        return fetchBuffer(entry.url || self.res(entry.rel)).then(function (b) {
          var m = self.loadMotion(b, b.byteLength, name);
          if (!m) return false;
          var ids = self.effectIds();
          m.setEffectIds(ids[0], ids[1]);
          if (m.setLoop) m.setLoop(!!entry.loop); else if (m.setIsLoop) m.setIsLoop(!!entry.loop);
          /* entry fade (model3 group / flat index) wins; otherwise keep the
             motion3 Meta value unless it is the framework's "unspecified" 1 s */
          if (m.setFadeInTime) m.setFadeInTime(entry.fadeIn != null ? entry.fadeIn : (m.getFadeInTime && m.getFadeInTime() !== 1 ? m.getFadeInTime() : DEFAULT_FADE));
          if (m.setFadeOutTime) m.setFadeOutTime(entry.fadeOut != null ? entry.fadeOut : (m.getFadeOutTime && m.getFadeOutTime() !== 1 ? m.getFadeOutTime() : DEFAULT_FADE));
          self.motions[name] = m;
          self._motionManager.startMotionPriority(m, false, prio);
          return true;
        }).catch(function () { return false; });
      }

      setupIdle() {
        this._eyeBlink = C.CubismEyeBlink.create(this.setting);
        var idm = C.CubismFramework.getIdManager();
        var breath = new C.csmVector();
        var D = C.CubismDefaultParameterId;
        [[D.ParamAngleX, 0, 15, 6.5345, 0.5], [D.ParamAngleY, 0, 8, 3.5345, 0.5],
         [D.ParamAngleZ, 0, 10, 5.5345, 0.5], [D.ParamBodyAngleX, 0, 4, 15.5345, 0.5],
         [D.ParamBreath, 0.5, 0.5, 3.2345, 0.5]].forEach(function (p) {
          breath.pushBack(new C.BreathParameterData(idm.getId(p[0]), p[1], p[2], p[3], p[4]));
        });
        this._breath = C.CubismBreath.create();
        this._breath.setParameters(breath);
      }

      setExpression(name) {
        var m = this.expressions[name];
        if (m) this._expressionManager.startMotion(m, false);
      }

      lookAt(x, y) {
        this.lookTarget.x = Math.max(-1, Math.min(1, x));
        this.lookTarget.y = Math.max(-1, Math.min(1, y));
      }

      update(dt) {
        var model = this.getModel();
        model.loadParameters();
        var motionPlayed = false;
        if (this._motionManager && !this._motionManager.isFinished()) motionPlayed = this._motionManager.updateMotion(model, dt);
        model.saveParameters();
        if (this._expressionManager) this._expressionManager.updateMotion(model, dt);
        if (!motionPlayed && this._eyeBlink) this._eyeBlink.updateParameters(model, dt);
        var ease = Math.min(1, 9 * dt);
        this.lookCurrent.x += (this.lookTarget.x - this.lookCurrent.x) * ease;
        this.lookCurrent.y += (this.lookTarget.y - this.lookCurrent.y) * ease;
        var x = this.lookCurrent.x, y = this.lookCurrent.y;
        model.addParameterValueById(this.id('ParamAngleX'), x * 30);
        model.addParameterValueById(this.id('ParamAngleY'), y * 30);
        model.addParameterValueById(this.id('ParamAngleZ'), x * y * -30);
        model.addParameterValueById(this.id('ParamBodyAngleX'), x * 10);
        model.addParameterValueById(this.id('ParamEyeBallX'), x);
        model.addParameterValueById(this.id('ParamEyeBallY'), y);
        if (this.mouthOpen > 0.01) {
          model.setParameterValueById(this.id('ParamMouthOpenY'), this.mouthOpen);
          model.setParameterValueById(this.id('ParamLipSync'), this.mouthOpen);
        }
        if (this._breath) this._breath.updateParameters(model, dt);
        if (this._physics) this._physics.evaluate(model, dt);
        if (this._pose) this._pose.updateParameters(model, dt);
        model.update();
      }

      artBounds() {
        if (this._art) return this._art;
        var d = this.getModel()._model.drawables;
        var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (var i = 0; i < d.count; i++) {
          var v = d.vertexPositions[i];
          for (var k = 0; k < v.length; k += 2) {
            if (v[k] < x0) x0 = v[k]; if (v[k] > x1) x1 = v[k];
            if (v[k + 1] < y0) y0 = v[k + 1]; if (v[k + 1] > y1) y1 = v[k + 1];
          }
        }
        this._art = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
        return this._art;
      }

      /* Build the model->clip matrix for this viewport (also used by hit-test). */
      solveProjection(width, height) {
        var P = this.projection;
        P.loadIdentity();
        P.scale(1.0, width / height);
        P.multiplyByMatrix(this._modelMatrix);
        var a = this.artBounds();
        var m = this._modelMatrix.getArray();
        var aspect = width / height;
        var wClip = a.w * m[0];
        var hClip = a.h * m[5] * aspect;
        var usable = 2 * (1 - this.margin);
        /* Fit the art's HEIGHT to the canvas, then the card's zoom: with the
           top anchor her legs run down behind the conversation panel (a
           figure that ends above the panel looks like it is floating). Width
           is only a cap so a portrait phone never crops her sideways — the
           old min(width, height) fit made the head span 127% of a phone. */
        var k = (usable / hClip) * this.zoom;
        if (wClip * k > usable) k = usable / wClip;
        var cx = a.cx * m[0] + m[12];
        var cy = (a.cy * m[5] + m[13]) * aspect;
        P.scaleRelative(k, k);
        P.translateRelative(-k * cx, -k * cy + this.offsetY);
        if (this.anchor === 'top') {
          this._anchorTop(P, a);
          /* Half-body art (cut at the thighs) would end above the chat panel
             and float. Make sure the art's bottom edge is BEHIND the panel:
             slide her down while the head keeps its headroom, then scale up
             for whatever is still short (the crop hides the cut edge). */
          var pf = this.panelFrac || 0;
          if (pf > 0) {
            var want = (-1 + 2 * pf) - 0.08;                  /* just under the panel's top edge */
            var bottomY = P.transformY(a.cy - a.h / 2);
            if (bottomY > want) {
              var topNow = P.transformY(a.cy + a.h / 2);
              var unit2 = this._unitY(P, a);
              var room = Math.max(0, topNow - (1 - this.topMargin - 0.30));
              var shift = Math.min(bottomY - want, room);
              if (unit2 && shift > 0) P.translateRelative(0, -shift / unit2);
              bottomY = P.transformY(a.cy - a.h / 2);
              if (bottomY > want + 0.001) {
                topNow = P.transformY(a.cy + a.h / 2);
                var f = Math.min(1.8, (topNow - want) / Math.max(0.05, topNow - bottomY));
                if (f > 1) { P.scaleRelative(f, f); this._anchorTop(P, a); }
              }
            }
          }
        }
        return P;
      }

      /* clip units per pre-scale unit along Y (translateRelative works in
         pre-scale units; measure instead of guessing the matrix convention) */
      _unitY(P, a) {
        var y0 = P.transformY(a.cy);
        P.translateRelative(0, 1);
        var u = P.transformY(a.cy) - y0;
        P.translateRelative(0, -1);
        return u;
      }

      /* put the top of the art just under the top bar; whatever does not
         fit is cropped at the bottom (the real app frames her this way) */
      _anchorTop(P, a) {
        var topY = a.cy + a.h / 2;
        var y0 = P.transformY(topY);
        var unit = this._unitY(P, a);
        var d = (1 - this.topMargin) - y0;
        if (unit) P.translateRelative(0, d / unit);
      }

      draw(gl, width, height) {
        this.solveProjection(width, height);
        var r = this.getRenderer();
        r.setMvpMatrix(this.projection);
        r.setRenderState(null, [0, 0, width, height]);
        r.drawModel();
      }

      /* clip-space point -> first hit area name */
      hitAreaAt(clipX, clipY) {
        var mx = this.projection.invertTransformX(clipX);
        var my = this.projection.invertTransformY(clipY);
        for (var i = 0; i < this.hitAreas.length; i++) {
          if (this.isHit(this.hitAreas[i].id, mx, my)) return this.hitAreas[i].name;
        }
        return null;
      }
    }
    return CModel;
  }

  /* ---- the backend ---- */

  var CubismBackend = {
    name: 'cubism',
    motionsFromGroups: motionsFromGroups,
    mergeMaps: mergeMaps,
    resolveEmotion: resolveEmotion,
    pickByPrefix: pickByPrefix,
    PRI: PRI,
    HEURISTIC: HEURISTIC,

    canvas: null, gl: null, model: null, pack: null, Model: null,
    _talking: false, _env: null, _hidden: false, _last: 0, _loading: null,
    _idle: { timer: 0, next: 12, gap: [9, 24], starting: false },
    _buf: null,

    available: function () { return !!(global.Cubism && global.Live2DCubismCore); },

    init: function () {
      if (!CubismBackend.available()) {
        return Promise.reject(new Error('Live2D runtime missing — run scripts/fetch_cubism_core.py'));
      }
      var stage = document.getElementById('stage');
      var hit = document.getElementById('avatar-hit');
      var c = document.createElement('canvas');
      c.id = 'cubism-canvas';
      if (stage) stage.insertBefore(c, hit || null);
      var gl = c.getContext('webgl2', { alpha: true, premultipliedAlpha: true }) ||
               c.getContext('webgl', { alpha: true, premultipliedAlpha: true });
      if (!gl) return Promise.reject(new Error('no WebGL'));
      CubismBackend.canvas = c;
      CubismBackend.gl = gl;
      var C = global.Cubism;
      if (!CubismBackend._started) {
        var opt = new C.Option();
        opt.logFunction = function (m) { console.log('[cubism]', m); };
        opt.loggingLevel = C.LogLevel.LogLevel_Warning;
        C.CubismFramework.startUp(opt);
        C.CubismFramework.initialize();
        CubismBackend._started = true;
      }
      CubismBackend.Model = defineModelClass();
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      CubismBackend.resize();
      CubismBackend._last = performance.now();
      requestAnimationFrame(CubismBackend._frame);
      return Promise.resolve();
    },

    loadPack: function (card) {
      var pack = (card && card.pack) || {};
      if (!pack.model || (!pack.path && pack.source !== 'idb')) return Promise.reject(new Error('pack needs a model (and a path unless imported)'));
      CubismBackend.unload();
      CubismBackend.pack = pack;
      var resP = (pack.source === 'idb')
        ? PackFS.resolver(pack.packId)
        : Promise.resolve(function (rel) { return (pack.path ? pack.path + '/' : '') + rel; });
      var p = resP.then(function (res) {
        return CubismBackend.Model.load(CubismBackend.gl, res, pack.model, pack.motions || null,
          function (s) { console.log('[cubism] ' + s); }, pack.shared_motions !== false);
      });
      CubismBackend._loading = p;
      return p.then(function (model) {
        if (CubismBackend._loading !== p) { model.release(); return null; }   // superseded
        CubismBackend.model = model;
        CubismBackend._pack = pack;
        CubismBackend.setFraming(pack);
        /* effective maps: the pack's own, filled in by the automatic mapping */
        var auto = global.Capabilities ? Capabilities.autoPack(
          { expressions: model.expressionNames, hitAreas: model.hitAreas.map(function (h) { return h.name; }) },
          model.motionIndex.map(function (m) { return m.name; })) : { emotions: {}, idle: {}, tap: {} };
        CubismBackend.maps = mergeMaps(auto, pack);
        CubismBackend._idle.gap = (CubismBackend.maps.idle && CubismBackend.maps.idle.gap) || [9, 24];
        CubismBackend._idle.next = CubismBackend._gap();
        CubismBackend.resize();
        return { expressions: model.expressionNames.slice(), motions: model.motionIndex.length,
                 parts: model.hitAreas.map(function (h) { return h.name; }) };
      });
    },

    /* Framing from pack fields (scale / margin / offsetY / anchor / topMargin);
       also called live by the character editor's sliders. */
    setFraming: function (f) {
      var model = CubismBackend.model;
      if (!model) return;
      f = f || {};
      model.zoom = Number(f.scale) || 1.35;
      if (f.margin != null) model.margin = Number(f.margin);
      model.offsetY = Number(f.offsetY) || 0;
      model.anchor = f.anchor || 'top';
      if (f.topMargin != null) model.topMargin = Number(f.topMargin);
      CubismBackend.resize();
    },

    /* Editor helpers: every motion name the loaded model can play, and a
       preview by prefix list (same picking rule the emotion/tap paths use). */
    motionNames: function () {
      var m = CubismBackend.model;
      return m ? m.motionIndex.map(function (x) { return x.name; }) : [];
    },
    previewMotion: function (prefixes) {
      var m = CubismBackend.model;
      if (!m) return false;
      var name = pickByPrefix(m.motionIndex, prefixes || [], false);
      if (!name) return false;
      m.playMotion(name, PRI.REACT);
      return name;
    },
    sharedIndex: sharedIndex,

    unload: function () {
      CubismBackend._loading = null;
      if (CubismBackend.model) { try { CubismBackend.model.release(); } catch (e) {} }
      CubismBackend.model = null;
      var old = CubismBackend.pack;
      if (old && old.source === 'idb' && global.PackFS) PackFS.release(old.packId);
      CubismBackend.maps = null;
    },

    setEmotion: function (name) {
      var m = CubismBackend.model;
      if (!m) return;
      var r = resolveEmotion(name, CubismBackend.maps && CubismBackend.maps.emotions, m.expressionNames, m.motionIndex);
      if (r.expression) m.setExpression(r.expression);
      if (r.motion) m.playMotion(r.motion, PRI.REACT);
    },

    setTalking: function (on) {
      CubismBackend._talking = !!on;
      if (!on) { CubismBackend._env = null; if (CubismBackend.model) CubismBackend.model.mouthOpen = 0; }
    },

    setTalkingEnvelope: function (env) {
      CubismBackend._talking = true;
      if (env && env.envelope && env.envelope.length) {
        CubismBackend._env = { samples: env.envelope, window: (Number(env.windowMs) || 20) / 1000, t: 0 };
      }
    },

    /* mouth level from App's analyser on the <audio> element, or the envelope */
    _mouthTarget: function (dt) {
      if (!CubismBackend._talking) return 0;
      var env = CubismBackend._env;
      if (env) {
        env.t += dt;
        var i = Math.floor(env.t / env.window);
        if (i >= env.samples.length) return 0;
        return Math.min(1, env.samples[i] * 4);
      }
      var an = global.App && App._voiceAnalyser;
      if (!an || !App.audio || App.audio.paused) return 0;
      if (!CubismBackend._buf || CubismBackend._buf.length !== an.fftSize) CubismBackend._buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(CubismBackend._buf);
      var sum = 0, b = CubismBackend._buf;
      for (var k = 0; k < b.length; k++) sum += b[k] * b[k];
      return Math.min(1, Math.sqrt(sum / b.length) * 5.5);
    },

    _gap: function () {
      var g = CubismBackend._idle.gap;
      return g[0] + Math.random() * (g[1] - g[0]);
    },

    _idleTick: function (dt) {
      var m = CubismBackend.model, st = CubismBackend._idle;
      if (!m || st.starting) return;
      var idle = (CubismBackend.maps && CubismBackend.maps.idle) || {};
      var busy = CubismBackend._talking;
      if (busy) { st.timer = 0; return; }
      var play = function (name, prio) {
        if (!name) return;
        st.starting = true;
        m.playMotion(name, prio).then(function () { st.starting = false; }, function () { st.starting = false; });
      };
      /* sitting: the pack's sit clip loops instead of the idle; nothing
         ambient on top (it would stand her back up) */
      if (CubismBackend._sitting) {
        var sitName = CubismBackend.sitMotion();
        if (sitName) { if (m.motionIdle) play(sitName, PRI.IDLE); return; }
      }
      if (m.motionIdle) {
        var loopName = pickByPrefix(m.motionIndex, (idle.loop && idle.loop.length) ? idle.loop : ['idle-', 'Idle-'], true);
        if (loopName) { play(loopName, PRI.IDLE); return; }
      }
      st.timer += dt;
      if (st.timer < st.next) return;
      st.timer = 0; st.next = CubismBackend._gap();
      if (m.currentPriority() >= PRI.REACT) return;   /* let a tap / emotion finish */
      play(pickByPrefix(m.motionIndex, (idle.ambient && idle.ambient.length) ? idle.ambient : ['look-around-', 'deep-breath-', 'default-', 'turn-', 'notice-', 'wink-', 'smile-', 'Idle-'], false), PRI.AMBIENT);
    },

    _frame: function (now) {
      requestAnimationFrame(CubismBackend._frame);
      var dt = Math.min(0.1, (now - CubismBackend._last) / 1000) || 0;
      CubismBackend._last = now;
      CubismBackend._render(dt);
    },

    /* One frame. Split from _frame so snapshot() can draw synchronously and
       read the pixels before the (non-preserved) buffer is cleared. */
    _render: function (dt) {
      var gl = CubismBackend.gl, c = CubismBackend.canvas, m = CubismBackend.model;
      if (!gl || !c) return;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!m || CubismBackend._hidden) return;
      var ptr = global.Avatar && Avatar._pointer;
      if (ptr && ptr.on && c.clientWidth && c.clientHeight) {
        m.lookAt((ptr.x / c.clientWidth) * 2 - 1, -((ptr.y / c.clientHeight) * 2 - 1));
      } else m.lookAt(0, 0);
      var target = CubismBackend._mouthTarget(dt);
      var rate = target > m.mouthOpen ? 26 : 12;
      m.mouthOpen += (target - m.mouthOpen) * Math.min(1, rate * dt);
      CubismBackend._idleTick(dt);
      m.update(dt);
      m.draw(gl, c.width, c.height);
    },

    /* Thumbnail of the current model: draw a frame, crop the top-centre of
       the canvas at 3:4 and scale it to w x h. Returns a data URL or null. */
    snapshot: function (w, h) {
      var c = CubismBackend.canvas, m = CubismBackend.model;
      if (!c || !m || !c.width || !c.height) return null;
      w = w || 180; h = h || 240;
      try {
        CubismBackend._render(0);
        var cw = c.width, ch = c.height;
        var sw = Math.min(cw, ch * w / h), sh = sw * h / w;
        var out = document.createElement('canvas');
        out.width = w; out.height = h;
        var ctx = out.getContext('2d');
        ctx.drawImage(c, (cw - sw) / 2, 0, sw, sh, 0, 0, w, h);
        return out.toDataURL('image/jpeg', 0.82);
      } catch (e) { return null; }
    },

    hitPartAt: function (cssX, cssY) {
      var m = CubismBackend.model, c = CubismBackend.canvas;
      if (!m || !c || !c.clientWidth || !c.clientHeight) return null;
      m.solveProjection(c.width, c.height);
      var clipX = (cssX / c.clientWidth) * 2 - 1, clipY = -((cssY / c.clientHeight) * 2 - 1);
      var part = m.hitAreaAt(clipX, clipY);
      if (part) return part;
      /* No declared hit area under the tap (or none at all): zones are
         horizontal bands of the drawn art - Head / Body / Legs top-down
         (Capabilities.ZONES) - so every tap on the character reacts. */
      var mx = m.projection.invertTransformX(clipX), my = m.projection.invertTransformY(clipY);
      var a = m.artBounds();
      if (Math.abs(mx - a.cx) > a.w / 2) return null;
      var ratio = ((a.cy + a.h / 2) - my) / a.h;
      if (ratio < 0 || ratio > 1) return null;
      return global.Capabilities ? Capabilities.zoneFor(ratio) : 'Body';
    },

    poke: function (part) {
      var m = CubismBackend.model, tap = (CubismBackend.maps && CubismBackend.maps.tap) || {};
      if (!m || !part) return null;
      var rules = (tap[part] || tap['*'] || []);
      if (!rules.length) rules = ['Tap' + part + '-', 'TapBody-', 'contact-', 'poke-', 'touch-'];
      var name = pickByPrefix(m.motionIndex, rules, false);
      if (!name) return null;
      m.playMotion(name, PRI.REACT);
      return name;
    },

    resize: function () {
      var c = CubismBackend.canvas;
      if (!c) return;
      if (CubismBackend.model && global.Stage && Stage.panelFrac) CubismBackend.model.panelFrac = Stage.panelFrac();
      var z = (global.Avatar && Avatar._cssZoom) ? Avatar._cssZoom(c) : 1;
      var dpr = Math.max(1, window.devicePixelRatio || 1) * z;
      var w = Math.max(1, Math.floor(c.clientWidth * dpr)), h = Math.max(1, Math.floor(c.clientHeight * dpr));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      CubismBackend.gl.viewport(0, 0, w, h);
    },

    /* ---- posture: a pack may name sitting clips (pack.posture.sit, prefix
       list; default "sit-"/"sitting-"/"chair-"). No clip = stand only. */
    sitPrefixes: function () {
      var p = CubismBackend._pack && CubismBackend._pack.posture;
      var list = p && Array.isArray(p.sit) ? p.sit.filter(Boolean) : [];
      return list.length ? list : ['sit-', 'sitting-', 'chair-'];
    },
    sitMotion: function () {
      var m = CubismBackend.model;
      if (!m) return null;
      var pre = CubismBackend.sitPrefixes();
      return pickByPrefix(m.motionIndex, pre, true) || pickByPrefix(m.motionIndex, pre, false);
    },
    canSit: function () { return !!CubismBackend.sitMotion(); },
    setPosture: function (sitting) {
      CubismBackend._sitting = !!sitting && CubismBackend.canSit();
      var m = CubismBackend.model;
      if (!m) return;
      if (CubismBackend._sitting) { var s = CubismBackend.sitMotion(); if (s) m.playMotion(s, PRI.REACT).catch(function () {}); }
      else { CubismBackend._idle.timer = 0; }
    },

    setHidden: function (on) {
      CubismBackend._hidden = !!on;
      if (CubismBackend.canvas) CubismBackend.canvas.style.display = on ? 'none' : '';
    },

    capabilities: function () {
      var m = CubismBackend.model;
      return { emotions: m ? m.expressionNames.slice() : [], parts: m ? m.hitAreas.map(function (h) { return h.name; }) : [] };
    }
  };

  global.CubismBackend = CubismBackend;
  if (global.Stage) Stage.register('cubism', CubismBackend);
})(typeof window !== 'undefined' ? window : globalThis);
