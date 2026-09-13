/* Capabilities — what a Live2D model can actually do, read from its
   model3.json (and an optional flat motion index), and the automatic pack
   mapping built from it.

   An uploaded model carries no hand-authored gesture config. This turns what
   it declares — expressions, motion groups, hit areas, lip-sync / blink
   parameter groups — into the pack fields the Cubism backend consumes:

     emotions: { happy: {expression, motions:[prefixes]}, ... }
     idle:     { loop:[prefixes], ambient:[prefixes], gap:[min,max] }
     tap:      { Part: [prefixes] }

   Everything here is pure and unit-tested (scripts/capabilities_regression.js).
   The user can then edit the result in the character editor; edits are stored
   on the card and win over the automatic guess. */
(function (global) {
  'use strict';

  /* Expression-name fragments per emotion, first match wins. Covers the
     converted game-rig naming (joy/doya/…), Live2D sample numbering (F0x) and
     plain English. Keep in sync with the emotion list cards may use. */
  var EXPR_HINTS = {
    neutral: ['idle', 'normal', 'default', 'neutral', 'f01', 'exp_01', 'exp01'],
    happy: ['joy', 'happy', 'smile', 'laugh', 'fun', 'f02', 'exp_02', 'exp02'],
    sad: ['sad', 'cry', 'tear', 'down', 'f03', 'exp_03', 'exp03'],
    angry: ['anger', 'angry', 'mad', 'rage', 'f04', 'exp_04', 'exp04'],
    surprised: ['surprise', 'shock', 'wow', 'f05', 'exp_05', 'exp05'],
    shy: ['shy', 'blush', 'embarrass', 'f06', 'exp_06', 'exp06'],
    smug: ['doya', 'smug', 'proud', 'confident', 'f07', 'exp_07', 'exp07'],
    serious: ['serious', 'think', 'focus', 'f08', 'exp_08', 'exp08'],
    sleepy: ['sleep', 'tired', 'yawn']
  };

  /* Motion-name prefixes per emotion (one-shots that fit the feeling). */
  var MOTION_HINTS = {
    happy: ['joy-', 'happy-', 'smile-', 'laugh-', 'fun-', 'Happy-', 'Joy-'],
    sad: ['sad-', 'disappoint-', 'tear-', 'cry-', 'Sad-'],
    angry: ['anger-', 'angry-', 'provoke-', 'Angry-'],
    surprised: ['surprise-', 'notice-', 'shock-', 'Surprise-'],
    shy: ['shy-', 'embarrass-', 'blush-', 'Shy-'],
    smug: ['doya-', 'appeal-', 'proud-', 'Smug-'],
    serious: ['think-', 'question-', 'serious-', 'Think-'],
    neutral: []
  };

  var IDLE_LOOP = ['idle-', 'Idle-', 'idle_', 'Idle_'];
  var AMBIENT = ['look-around-', 'deep-breath-', 'default-', 'turn-', 'notice-', 'wink-', 'smile-', 'blink-', 'breath-', 'Idle-'];
  var TAP_DEFAULT = ['contact-', 'poke-', 'touch-', 'Tap', 'tap'];

  function lower(s) { return String(s || '').toLowerCase(); }

  /* Parse a model3.json object into a flat capability record. */
  function inspectModel3(model3) {
    var fr = (model3 && model3.FileReferences) || {};
    var out = {
      moc: fr.Moc || null,
      expressions: (fr.Expressions || []).map(function (e) { return e.Name; }).filter(Boolean),
      motionGroups: Object.keys(fr.Motions || {}),
      motionCount: 0,
      hitAreas: (model3 && model3.HitAreas || []).map(function (h) { return h.Name; }).filter(Boolean),
      lipSync: false, eyeBlink: false,
      physics: !!fr.Physics, pose: !!fr.Pose
    };
    Object.keys(fr.Motions || {}).forEach(function (g) { out.motionCount += (fr.Motions[g] || []).length; });
    (model3 && model3.Groups || []).forEach(function (g) {
      if (g.Name === 'LipSync' && g.Ids && g.Ids.length) out.lipSync = true;
      if (g.Name === 'EyeBlink' && g.Ids && g.Ids.length) out.eyeBlink = true;
    });
    return out;
  }

  function pickExpression(emotion, expressions) {
    var hints = EXPR_HINTS[emotion] || [];
    for (var i = 0; i < hints.length; i++) {
      for (var j = 0; j < expressions.length; j++) {
        if (lower(expressions[j]).indexOf(hints[i]) !== -1) return expressions[j];
      }
    }
    return null;
  }

  function prefixesPresent(prefixes, motionNames) {
    return prefixes.filter(function (p) {
      return motionNames.some(function (n) { return n.indexOf(p) === 0; });
    });
  }

  /* Build pack.emotions / idle / tap from a capability record + motion names.
     `motionNames` = every motion the backend will index: flat-index names plus
     "Group-i" names for model3 groups. */
  function autoPack(caps, motionNames, wanted) {
    motionNames = motionNames || [];
    var emotions = {};
    (wanted || Object.keys(EXPR_HINTS)).forEach(function (e) {
      var expr = pickExpression(e, caps.expressions || []);
      var mo = prefixesPresent(MOTION_HINTS[e] || [], motionNames);
      if (expr || mo.length) emotions[e] = { expression: expr, motions: mo };
    });
    var loop = prefixesPresent(IDLE_LOOP, motionNames);
    var ambient = prefixesPresent(AMBIENT, motionNames).filter(function (p) { return loop.indexOf(p) === -1; });
    var tap = {};
    /* no HitAreas -> the renderer falls back to the ZONES bands, so map those */
    var parts = (caps.hitAreas && caps.hitAreas.length) ? caps.hitAreas : ZONES.map(function (z) { return z.name; });
    parts.forEach(function (part) {
      var pref = prefixesPresent(['Tap' + part + '-', 'tap' + lower(part) + '-'], motionNames);
      if (!pref.length) pref = prefixesPresent(TAP_DEFAULT.map(function (p) { return /^tap$/i.test(p) ? p + 'Body-' : p; }), motionNames);
      if (pref.length) tap[part] = pref;
    });
    return { emotions: emotions, idle: { loop: loop, ambient: ambient, gap: [9, 24] }, tap: tap };
  }

  /* Card emotion list a pack supports (what the LLM may pick from). */
  function emotionList(packEmotions) {
    var out = ['neutral'];
    Object.keys(packEmotions || {}).forEach(function (e) {
      var r = packEmotions[e];
      if (e !== 'neutral' && r && (r.expression || (r.motions && r.motions.length) || typeof r === 'string')) out.push(e);
    });
    return out;
  }

  /* Fallback tap zones for models without HitAreas: bands of the drawn art,
     top-down. ratio = (y - top) / height in art space (0 = top). */
  var ZONES = [{ name: 'Head', to: 0.32 }, { name: 'Body', to: 0.78 }, { name: 'Legs', to: 1.01 }];
  function zoneFor(ratio) {
    for (var i = 0; i < ZONES.length; i++) if (ratio <= ZONES[i].to) return ZONES[i].name;
    return null;
  }

  global.Capabilities = {
    EXPR_HINTS: EXPR_HINTS, MOTION_HINTS: MOTION_HINTS, IDLE_LOOP: IDLE_LOOP, AMBIENT: AMBIENT, ZONES: ZONES,
    inspectModel3: inspectModel3,
    pickExpression: pickExpression,
    prefixesPresent: prefixesPresent,
    autoPack: autoPack,
    emotionList: emotionList,
    zoneFor: zoneFor
  };
})(typeof window !== 'undefined' ? window : globalThis);
