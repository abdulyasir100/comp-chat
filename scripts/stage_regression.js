/* Renderer layer regression: Stage facade routing + the pure helpers of the
   Spine and Cubism backends (emotion resolution, motion index shapes).
   Run: node scripts/stage_regression.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'web');
let failures = 0;
const bad = (msg) => { failures++; console.log('  FAIL ' + msg); };
const ok = (cond, name) => { if (cond) console.log('  PASS ' + name); else bad(name); };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name + ' (' + JSON.stringify(a) + ')');

const sandbox = { console, Math, JSON, String, Array, Object, Number, Promise, Error, Float32Array, Uint8Array, Image: function () {} };
sandbox.window = sandbox; sandbox.globalThis = sandbox;
sandbox.document = { getElementById() { return null; }, createElement() { return { getContext() { return null; }, style: {} }; } };
sandbox.requestAnimationFrame = () => 0;
sandbox.performance = { now: () => 0 };
vm.createContext(sandbox);
const load = (f) => vm.runInContext(fs.readFileSync(path.join(WEB, f), 'utf8'), sandbox, { filename: f });
['engine/capabilities.js', 'renderers/stage.js', 'renderers/spine.js', 'renderers/cubism.js'].forEach(load);
const { Stage, SpineBackend, CubismBackend } = sandbox;

console.log('Stage');
eq(Stage.names().sort(), ['cubism', 'spine'], 'both backends registered');
ok(Stage.kind() === 'none' && Stage.hitPartAt(1, 1) === null && Stage.poke('x') === null, 'no backend: inert');

(async () => {
  const calls = [];
  Stage.register('fake', {
    name: 'fake',
    init() { calls.push('init'); return Promise.resolve(); },
    loadPack(card) { calls.push('load:' + card.id); return Promise.resolve({ ok: 1 }); },
    unload() { calls.push('unload'); },
    setEmotion(e) { calls.push('emo:' + e); },
    setHidden(on) { calls.push('hide:' + on); },
    hitPartAt() { return 'Head'; },
    poke(p) { return 'poke-' + p; },
    capabilities() { return { emotions: ['a'], parts: ['Head'] }; }
  });
  Stage.setEmotion('happy');                       // remembered before any pack
  const r = await Stage.loadPack({ id: 'c1', pack: { renderer: 'fake' } });
  ok(r && r.ok === 1 && Stage.kind() === 'fake', 'loadPack picks the backend');
  ok(calls.indexOf('init') === 0 && calls.indexOf('load:c1') > calls.indexOf('hide:false'), 'init once, unhide, then load');
  ok(calls[calls.length - 1] === 'emo:happy', 'last emotion re-applied after load');
  ok(Stage.hitPartAt(0, 0) === 'Head' && Stage.poke('Head') === 'poke-Head', 'forwarding');
  ok(Stage.hidden() === false, 'visible after load');
  Stage.setHidden(true);
  ok(Stage.hidden() === true && calls[calls.length - 1] === 'hide:true', 'setHidden stores + forwards');
  Stage.setHidden(!Stage.hidden());
  ok(Stage.hidden() === false && calls[calls.length - 1] === 'hide:false', 'toggle from Stage state (Cubism fix)');
  eq(Stage.capabilities().parts, ['Head'], 'capabilities');
  calls.length = 0;
  await Stage.loadPack({ id: 'c2', pack: { renderer: 'fake' } });
  ok(calls.indexOf('init') === -1, 'init not repeated for the same backend');
  await Stage.loadPack({ id: 'c3', pack: { renderer: 'none' } });
  ok(Stage.kind() === 'none' && calls.indexOf('unload') !== -1 && calls.indexOf('hide:true') !== -1, 'switching away unloads + hides');
  const r2 = await Stage.loadPack({ id: 'c4', pack: { renderer: 'missing' } });
  ok(r2 === null && Stage.kind() === 'none', 'unknown renderer degrades to none');

  console.log('SpineBackend');
  eq(SpineBackend.resolveEmotion('smug'), 'tease', 'fallback map');
  eq(SpineBackend.resolveEmotion('HAPPY'), 'happy', 'case-insensitive');
  eq(SpineBackend.resolveEmotion('bogus'), null, 'unknown → null (keep face)');
  eq(SpineBackend.resolveEmotion('serious', { serious: 'sad' }), 'sad', 'pack map wins');

  console.log('CubismBackend helpers');
  const groups = { Idle: [{ File: 'm/i1.motion3.json', FadeInTime: -1, FadeOutTime: -1 }, { File: 'm/i2.motion3.json' }], TapBody: [{ File: 'm/t1.motion3.json', FadeInTime: 0.5 }] };
  const mi = CubismBackend.motionsFromGroups(groups);
  eq(mi.map((m) => m.name), ['Idle-0', 'Idle-1', 'TapBody-0'], 'group motions named group-index');
  ok(mi[0].loop === true && mi[2].loop === false && mi[2].fadeIn === 0.5, 'Idle group loops, fades kept');
  ok(mi[0].fadeIn === undefined && mi[0].fadeOut === undefined, 'model3 -1 (absent) fade → undefined');
  ok(CubismBackend.PRI.REACT > CubismBackend.PRI.AMBIENT && CubismBackend.PRI.AMBIENT > CubismBackend.PRI.IDLE, 'priorities ordered');
  const expr = ['idle-01', 'joy-01', 'doya-01', 'sad-01', 'F01', 'F02'];
  const flat = [{ name: 'joy-01_lv03', loop: false }, { name: 'idle-01', loop: true }, { name: 'anger-01_lv01', loop: false }];
  let r3 = CubismBackend.resolveEmotion('happy', { happy: { expression: 'joy-01', motions: ['joy-'] } }, expr, flat);
  ok(r3.expression === 'joy-01' && r3.motion === 'joy-01_lv03', 'pack map: expression + prefix motion (non-loop only)');
  r3 = CubismBackend.resolveEmotion('smug', null, expr, flat);
  ok(r3.expression === 'doya-01' && r3.motion === null, 'heuristic: smug → doya');
  r3 = CubismBackend.resolveEmotion('happy', null, ['F01', 'F02'], []);
  ok(r3.expression === 'F02', 'heuristic: sample F0x numbering');
  r3 = CubismBackend.resolveEmotion('neutral', { neutral: 'idle-01' }, expr, flat);
  ok(r3.expression === 'idle-01', 'string rule = expression only');
  r3 = CubismBackend.resolveEmotion('angry', { angry: { expression: 'nope' } }, expr, flat);
  ok(r3.expression === null, 'unknown expression in map → none (no crash)');
  ok(CubismBackend.pickByPrefix(flat, ['idle-'], true) === 'idle-01', 'pickByPrefix loop filter');
  ok(CubismBackend.pickByPrefix(flat, ['idle-'], false) === null, 'pickByPrefix excludes loops when asked');

  /* mergeMaps: pack rules only override what they set (shared library survives) */
  const auto = { emotions: { happy: { expression: 'F02', motions: ['joy-'] }, sad: { expression: null, motions: ['sad-'] } },
                 idle: { loop: ['Idle-'], ambient: ['blink-'], gap: [9, 24] }, tap: { Head: ['contact-'] } };
  const mm = CubismBackend.mergeMaps(auto, { emotions: { happy: 'F09', sad: { expression: 'F03', motions: [] } },
                                             idle: { ambient: [], gap: [5, 10] }, tap: { Body: ['poke-'] } });
  eq(mm.emotions.happy, { expression: 'F09', motions: ['joy-'] }, 'string rule keeps the automatic motions');
  eq(mm.emotions.sad, { expression: 'F03', motions: ['sad-'] }, 'empty motion list counts as unset');
  eq(mm.idle, { loop: ['Idle-'], ambient: ['blink-'], gap: [5, 10] }, 'idle merges per key');
  eq(mm.tap, { Head: ['contact-'], Body: ['poke-'] }, 'tap zones union');

  console.log(failures ? '\nSTAGE: ' + failures + ' FAILURES' : '\nSTAGE: ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('  CRASH ' + (e && e.stack || e)); process.exit(1); });
