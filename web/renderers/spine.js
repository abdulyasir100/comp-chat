/* Spine backend — a thin adapter over ryza's Avatar (web/js/avatar.js).

   Avatar owns the scene canvas, the gesture tables and the Ryza rig; it is
   initialised by App at boot regardless (the scene layer draws the background
   even when another renderer holds the character). This adapter only maps
   the Stage interface onto it and translates card emotions into the nine faces
   the rig knows. */
(function (global) {
  'use strict';

  var FACES = ['neutral', 'happy', 'laughing', 'tease', 'shy', 'cuddle', 'sad', 'crying', 'angry'];
  var FALLBACK = { surprised: 'happy', smug: 'tease', serious: 'neutral', laugh: 'laughing',
                   cry: 'crying', excited: 'happy', annoyed: 'angry', thinking: 'neutral' };

  function resolveEmotion(name, map) {
    var e = String(name || '').toLowerCase();
    if (map && map[e]) e = String(map[e]).toLowerCase();
    if (FACES.indexOf(e) === -1) e = FALLBACK[e] || null;
    return e;
  }

  var SpineBackend = {
    name: 'spine',
    FACES: FACES,
    resolveEmotion: resolveEmotion,
    _map: null,

    init: function () { return Promise.resolve(); },

    loadPack: function (card) {
      var pack = (card && card.pack) || {};
      SpineBackend._map = pack.emotions || null;
      var A = global.Avatar;
      if (!A) return Promise.resolve(null);
      /* pack.skin = outfit id (crf_skn_002_0001); posture suffix is Avatar's. */
      return new Promise(function (resolve, reject) {
        /* loadSkin reports a missing media index / outfit through cb(err);
           surface it so Stage can toast "media not installed" */
        if (pack.skin) A.loadSkin(pack.skin, function (err) { if (err) reject(err); else resolve(pack.skin); });
        else resolve(null);
      });
    },

    unload: function () { /* the rig stays loaded; setHidden hides it */ },

    setEmotion: function (name, attitude) {
      var e = resolveEmotion(name, SpineBackend._map);
      if (e && global.Avatar) Avatar.setEmotion(e, attitude || null);
    },
    setTalking: function (on) { if (global.Avatar) Avatar.setTalking(on); },
    setTalkingEnvelope: function (env) { if (global.Avatar) Avatar.setTalkingEnvelope(env); },
    hitPartAt: function (x, y) { return global.Avatar ? Avatar.hitPartAt(x, y) : null; },
    poke: function (part) { return global.Avatar ? Avatar.poke(part) : null; },
    resize: function () { if (global.Avatar) Avatar.resize(); },
    setHidden: function (on) { if (global.Avatar) Avatar.setHidden(on); },
    capabilities: function () { return { emotions: FACES.slice(), parts: [] }; }
  };

  global.SpineBackend = SpineBackend;
  if (global.Stage) Stage.register('spine', SpineBackend);
})(typeof window !== 'undefined' ? window : globalThis);
