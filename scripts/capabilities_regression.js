/* Capability mapping regression (pure). Run: node scripts/capabilities_regression.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'web');
let failures = 0;
const bad = (msg) => { failures++; console.log('  FAIL ' + msg); };
const ok = (cond, name) => { if (cond) console.log('  PASS ' + name); else bad(name); };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name + ' (' + JSON.stringify(a) + ')');

const sandbox = { console, Math, JSON, String, Array, Object, Number, Promise, Error };
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const load = (f) => vm.runInContext(fs.readFileSync(path.join(WEB, f), 'utf8'), sandbox, { filename: f });
['engine/capabilities.js', 'engine/packfs.js'].forEach(load);
const { Capabilities: C, PackFS } = sandbox;

console.log('inspectModel3');
const haru = {
  FileReferences: {
    Moc: 'Haru.moc3', Physics: 'Haru.physics3.json', Pose: 'Haru.pose3.json',
    Expressions: [{ Name: 'F01', File: 'expressions/F01.exp3.json' }, { Name: 'F02', File: 'x' }, { Name: 'F03', File: 'x' }],
    Motions: { Idle: [{ File: 'a' }, { File: 'b' }], TapBody: [{ File: 'c' }] }
  },
  HitAreas: [{ Id: 'HitArea', Name: 'Head' }, { Id: 'HitArea2', Name: 'Body' }],
  Groups: [{ Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen'] }, { Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] }]
};
const caps = C.inspectModel3(haru);
eq(caps.expressions, ['F01', 'F02', 'F03'], 'expressions');
eq(caps.motionGroups, ['Idle', 'TapBody'], 'motion groups');
ok(caps.motionCount === 3 && caps.lipSync && caps.eyeBlink && caps.physics && caps.pose, 'counts + groups + files');
eq(caps.hitAreas, ['Head', 'Body'], 'hit areas');
eq(C.inspectModel3({}).expressions, [], 'empty model3 tolerated');

console.log('autoPack — Live2D sample (groups, no flat index)');
let p = C.autoPack(caps, ['Idle-0', 'Idle-1', 'TapBody-0']);
eq(p.emotions.neutral.expression, 'F01', 'F01 → neutral');
eq(p.emotions.happy.expression, 'F02', 'F02 → happy');
eq(p.emotions.sad.expression, 'F03', 'F03 → sad');
ok(!p.emotions.angry, 'no F04 → no angry entry');
eq(p.idle.loop, ['Idle-'], 'Idle group loops');
eq(p.tap, { Head: ['TapBody-'], Body: ['TapBody-'] }, 'tap falls back to TapBody for both areas');

console.log('autoPack — converted game rig (flat index, no hit areas)');
const sui = C.inspectModel3({
  FileReferences: { Expressions: ['anger-01', 'doya-01', 'idle-01', 'joy-01', 'sad-01', 'serious-01', 'shy-01', 'smile-01', 'surprise-01'].map((n) => ({ Name: n, File: n })) },
  Groups: [{ Name: 'LipSync', Ids: ['ParamMouthOpenY'] }]
});
const names = ['idle-01', 'idle-02', 'joy-01_lv03', 'anger-01_lv01', 'doya-01_lv03', 'contact-l-01_lv03', 'look-around-01_lv03', 'wink-01_lv03', 'appeal-01_lv03'];
p = C.autoPack(sui, names);
eq(p.emotions.smug, { expression: 'doya-01', motions: ['doya-', 'appeal-'] }, 'smug → doya + appeal');
eq(p.emotions.happy.expression, 'joy-01', 'happy → joy-01 (joy before smile)');
eq(p.emotions.angry.motions, ['anger-'], 'only present prefixes kept');
eq(p.idle.loop, ['idle-'], 'idle- loop');
eq(p.idle.ambient, ['look-around-', 'wink-'], 'ambient only the present ones, minus loop');
eq(p.tap, { Head: ['contact-'], Body: ['contact-'], Legs: ['contact-'] }, 'no hit areas → the three ZONES bands share contact-');
eq(C.emotionList(p.emotions).slice(0, 3), ['neutral', 'happy', 'sad'], 'emotion list for the card, neutral first');
ok(C.emotionList({}).length === 1, 'empty map → neutral only');

console.log('zones');
eq([C.zoneFor(0.1), C.zoneFor(0.5), C.zoneFor(0.95), C.zoneFor(1.2)], ['Head', 'Body', 'Legs', null], 'top-down bands');

console.log('PackFS helpers');
eq(PackFS._stripCommonRoot(['Model/a.moc3', 'Model/x/y.png']), 'Model/', 'common root');
eq(PackFS._stripCommonRoot(['a.moc3', 'x/y.png']), '', 'no common root');
eq(PackFS.norm('.\\foo\\bar.json'), 'foo/bar.json', 'norm slashes');
eq(PackFS.slug('My Model v2.model3.json'), 'my-model-v2', 'slug');
eq(PackFS.findModel3({ 'a/b.model3.json': 1, 'c.moc3': 1, 'D.MODEL3.JSON': 1 }), ['D.MODEL3.JSON', 'a/b.model3.json'], 'findModel3');

console.log(failures ? '\nCAPABILITIES: ' + failures + ' FAILURES' : '\nCAPABILITIES: ALL PASS');
process.exit(failures ? 1 : 0);
