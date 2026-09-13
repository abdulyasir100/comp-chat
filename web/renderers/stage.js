/* Stage — the one avatar surface the app talks to.

   A character pack names its renderer (card.pack.renderer: "spine" | "cubism"
   | "none"); Stage loads the matching backend and forwards every call. The app
   never knows which runtime is drawing, and card emotions are resolved by the
   backend against what the loaded model can actually show.

   Backend interface (all optional except name):
     init()                       -> Promise   one-time setup (canvas, runtime)
     loadPack(card)               -> Promise   load this character's model
     unload()                                  release the current model
     setEmotion(name)                          card emotion -> face/body
     setTalking(on)                            mouth driven by App's analyser
     setTalkingEnvelope(env)                   pre-analysed amplitude envelope
     hitPartAt(cssX, cssY)        -> part|null  tap hit-test
     poke(part)                   -> id|null    tap reaction; id feeds tap voice
     resize()
     setHidden(on)
     capabilities()               -> {emotions:[], parts:[]}                    */
(function (global) {
  'use strict';

  var backends = {};
  var active = null;
  var activeKind = 'none';
  var lastEmotion = null;
  var hidden = false;     // show/hide character, owned here for every backend

  /* the tap / cursor layer follows the visible character */
  function hitLayer(off) {
    var h = (typeof document !== 'undefined') ? document.getElementById('avatar-hit') : null;
    if (h) h.style.pointerEvents = off ? 'none' : '';
  }

  function safe(fn) { try { return fn(); } catch (e) { console.warn('[stage]', e); return null; } }

  var Stage = {
    register: function (kind, backend) { backends[kind] = backend; },
    names: function () { return Object.keys(backends); },
    kind: function () { return activeKind; },
    backend: function () { return active; },

    /* Choose + initialise the backend for this card, then load its pack.
       A pack whose renderer is missing (no runtime, no media) degrades to
       "none": chat still works, the stage is just empty. Never rejects. */
    loadPack: function (card) {
      var pack = (card && card.pack) || {};
      var kind = pack.renderer || 'none';
      var next = backends[kind] || null;
      var prev = active;
      if (prev && prev !== next && prev.unload) safe(function () { prev.unload(); });
      /* hide EVERY other backend, not just the previous one: the Spine rig is
         initialised by the app at boot regardless of which pack is active, so
         a Live2D character would otherwise be drawn under (or over) Ryza. The
         Spine scene background keeps drawing — only its character hides. */
      Object.keys(backends).forEach(function (k) {
        var b = backends[k];
        if (b && b !== next && b.setHidden) safe(function () { b.setHidden(true); });
      });
      active = next;
      activeKind = next ? kind : 'none';
      if (!next) return Promise.resolve(null);
      var p = next._inited ? Promise.resolve() : Promise.resolve(next.init && next.init()).then(function () { next._inited = true; });
      return p.then(function () {
        hidden = false; hitLayer(false);
        if (next.setHidden) next.setHidden(false);
        return next.loadPack ? next.loadPack(card) : null;
      }).then(function (r) {
        if (lastEmotion && next.setEmotion) safe(function () { next.setEmotion(lastEmotion); });
        return r;
      }).catch(function (e) {
        console.warn('[stage] pack load failed for ' + kind + ':', e && e.message);
        var msg = pack.media_required && global.I18n
          ? I18n.tc('avatar.mediaMissing', 'Character media is not installed for this pack (see README).')
          : (global.I18n ? I18n.tc('avatar.loadFail', 'Character failed to load: ') : 'Character failed to load: ') + (e && e.message ? e.message : '');
        if (global.App && App.toast) App.toast(msg, true);
        return null;
      });
    },

    setEmotion: function (name, attitude) {
      lastEmotion = name || lastEmotion;
      if (active && active.setEmotion) safe(function () { active.setEmotion(name, attitude); });
    },
    setTalking: function (on) {
      if (active && active.setTalking) safe(function () { active.setTalking(!!on); });
    },
    setTalkingEnvelope: function (env) {
      if (active && active.setTalkingEnvelope) safe(function () { active.setTalkingEnvelope(env); });
      else Stage.setTalking(true);
    },
    hitPartAt: function (x, y) {
      return (active && active.hitPartAt) ? safe(function () { return active.hitPartAt(x, y); }) : null;
    },
    poke: function (part) {
      return (active && active.poke) ? safe(function () { return active.poke(part); }) : null;
    },
    resize: function () {
      /* every backend that has a canvas keeps it fitted, not only the active one */
      Object.keys(backends).forEach(function (k) {
        var b = backends[k];
        if (b && b._inited && b.resize) safe(function () { b.resize(); });
      });
    },
    hidden: function () { return hidden; },
    setHidden: function (on) {
      hidden = !!on;
      hitLayer(hidden);
      if (active && active.setHidden) safe(function () { active.setHidden(hidden); });
    },
    capabilities: function () {
      return (active && active.capabilities) ? (safe(function () { return active.capabilities(); }) || {}) : { emotions: [], parts: [] };
    }
  };

  global.Stage = Stage;
})(typeof window !== 'undefined' ? window : globalThis);
