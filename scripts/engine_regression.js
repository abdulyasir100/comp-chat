/* companion-chat engine regression. Loads the browser modules into a node vm
   sandbox (same technique as memory_regression.js) and drives the engine with a
   fake LLM provider.  Run: node scripts/engine_regression.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'web');
let failures = 0;
const bad = (msg) => { failures++; console.log('  FAIL ' + msg); };
const ok = (cond, name) => { if (cond) console.log('  PASS ' + name); else bad(name); };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name + ' (' + JSON.stringify(a) + ')');

const store = {};
const sandbox = {
  console, Math, JSON, String, Array, RegExp, Object, Date, Number, isFinite,
  parseInt, parseFloat, Infinity, NaN, Set, Map, Promise, Error,
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    key: (i) => Object.keys(store)[i] || null,
    get length() { return Object.keys(store).length; }
  }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.document = { getElementById() { return null; } };
sandbox.XMLHttpRequest = function () {};
sandbox.location = { origin: 'http://127.0.0.1:8765' };
vm.createContext(sandbox);

function load(f) {
  vm.runInContext(fs.readFileSync(path.join(WEB, f), 'utf8'), sandbox, { filename: f });
}
['js/util.js', 'js/config.js', 'js/i18n.js', 'js/api.js', 'js/memory.js',
 'engine/store.js', 'engine/affection.js', 'engine/graph.js', 'engine/guard.js', 'engine/reply.js',
 'engine/prompt.js', 'engine/characters.js', 'engine/providers/registry.js',
 'engine/providers/llm-openai.js', 'engine/providers/tts-omnivoice.js', 'engine/index.js'
].forEach(load);

load('engine/outfits.js');
load('engine/gifts.js');
load('js/places.js');
load('js/gather.js');
load('js/mapview.js');
{
  const { Graph, Reply, Prompt } = sandbox;
  console.log('Graph');
  Graph.clear('g1');
  eq(Graph.add('g1', [['user', 'likes', 'ramen'], ['I', 'lives in', 'Tokyo'], ['user', 'likes', 'ramen'], ['x', 'is', ''], ['me', 'is', 'me']]), 2, 'add: dedupes, drops empty and self-loops, "I" = user');
  eq(Graph.count('g1'), 2, 'two edges stored');
  eq(Graph.add('g1', [['user', 'lives in', 'Osaka']]), 1, 'single-valued relation: new object accepted');
  const g = Graph.list('g1');
  ok(g.edges.filter(e => e.o === 'tokyo')[0].ended && !g.edges.filter(e => e.o === 'osaka')[0].ended, 'old value closed, new one open');
  const rc = Graph.recall('g1', 'do you remember what I said about ramen?', 12);
  ok(rc.some(e => e.o === 'ramen'), 'recall by mention');
  ok(/ramen/.test(Graph.promptBlock('g1', 'ramen', { user: 'Dio', me: 'Sui' })) && /Dio likes ramen/.test(Graph.promptBlock('g1', 'ramen', { user: 'Dio', me: 'Sui' })), 'prompt lines name the user');
  ok(/no longer true/.test(Graph.line(g.edges[1], g, {})), 'ended edge reads as history');
  const r = Reply.parse('{"line":{"en":"ok"},"emotion":"neutral","verdict":"liked","remember":[["user","has","a cat named Momo"],["bad"]]}', { langs: ['en'] });
  eq(r.facts, [['user', 'has', 'a cat named Momo']], 'reply carries cleaned facts');
  ok(/"remember": \[\]/.test(Prompt.system({ card: { name: 'T' }, langs: ['en'] })), 'output spec asks for remember');
  ok(/Things you know/.test(Prompt.system({ card: { name: 'T' }, langs: ['en'], graphBlock: '## Things you know\n- x' })), 'graph block injected');
  ok(Graph.removeEdge('g1', 0) && Graph.count('g1') === 2, 'remove edge');
  Graph.clear('g1');
}
{
  const { MapView } = sandbox;
  console.log('MapView');
  MapView.setPins({ field_01_002: [83, 66] });
  eq(MapView.fieldPos('field_01_002'), [83, 66], 'authored field position');
  const p = MapView.fieldPos('field_99_999');
  ok(p[0] >= 15 && p[0] <= 85 && p[1] >= 15 && p[1] <= 85 && MapView.fieldPos('field_99_999')[0] === p[0], 'unknown field: stable spot inside the picture');
  eq(MapView.stagePos('field_01_002', 0, 4), [83, 66], 'first stage sits on the field');
  const s2 = MapView.stagePos('field_01_002', 2, 4);
  ok(Math.abs(s2[0] - 83) < 8 && Math.abs(s2[1] - 66) < 10 && (s2[0] !== 83 || s2[1] !== 66), 'other stages fan around it');
}
{
  const { Gather, Gifts } = sandbox;
  console.log('Gather');
  Gifts.setCatalog([{ id: 'tea', name: 'Tea', tier: 'common', price: 10 }, { id: 'ring', name: 'Ring', tier: 'epic', price: 200 }]);
  Gather.setLoot({ default: { coinsChance: 0.5, coins: [5, 5], gifts: [{ id: 'tea', w: 3 }, { id: 'ring', w: 1 }, { id: 'missing', w: 9 }] } });
  eq(Gather.check({ place: 'my-room', stage: 'stage_02_001_01' }).reason, 'place', 'no gathering on an image background');
  eq(Gather.check({ place: '', stage: Gather.HOME_STAGE }).reason, 'home', 'never at home');
  ok(Gather.check({ place: '', stage: 'stage_02_001_01' }).ok, 'a map stage is gatherable');
  eq(Gather.roll('stage_02_001_01', 0.1).kind, 'coins', 'low roll = coins');
  const g = Gather.roll('stage_02_001_01', 0.9);
  ok(g.kind === 'gift' && ['tea', 'ring'].indexOf(g.gift.id) !== -1, 'high roll = a catalogue gift (unknown ids skipped)');
  const find = Gather.gather({ place: '', stage: 'stage_02_001_01' });
  ok(find && /^\*we look around/.test(find.text), 'gather returns a narration turn');
  eq(Gather.check({ place: '', stage: 'stage_02_001_01' }).reason, 'cooldown', 'then the stage cools down');
}
{
  const { Places } = sandbox;
  console.log('Places');
  eq(Places.cycleTod('mor', false), 'aft', 'cycle mor -> aft');
  eq(Places.cycleTod('ngt', false), 'auto', 'cycle ngt -> auto');
  eq(Places.cycleTod('eve', true), 'mor', 'auto -> mor (whatever the clock says)');
  eq(Places.tintClass('ngt'), 'tod-ngt', 'tint class');
  eq(Places.tintClass('bogus'), 'tod-aft', 'unknown band = no tint');
  eq(Places.imagePlaces().map(p => p.id), ['home'], 'home is always there');
  eq(Places.hasBandImage('home', 'ngt'), false, 'home has no per-band picture');
}
{
  const { Gifts } = sandbox;
  console.log('Gifts');
  Gifts.setCatalog([{ id: 'cake', name: 'Cake', tags: ['sweet'], tier: 'uncommon', price: 25, icon: 'cake.svg' },
                    { id: 'ring', name: 'Ring', tags: ['promise'], tier: 'epic', price: 200 }]);
  eq(Gifts.get('cake').icon, 'assets/gifts/icons/cake.svg', 'built-in icon path');
  const mine = Gifts.addCustom({ name: 'Cake', tags: 'home made, sweet', tier: 'bogus', price: '5' });
  eq(mine.id, 'my-cake', 'custom id prefixed, no clash with built-in');
  eq(mine.tags, ['home', 'made', 'sweet'], 'tags split on commas and spaces');
  eq(mine.tier, 'common', 'unknown tier falls back to common');
  eq(Gifts.catalog().length, 3, 'catalog = built-in + custom');
  eq(Gifts.grant('cake', 2), 2, 'grant adds to the bag');
  eq(Gifts.grant('cake', -1), 1, 'grant can consume');
  eq(Gifts.bagItems().map(i => i.gift.id + 'x' + i.n), ['cakex1'], 'bag items');
  eq(Gifts.bonusFor(Gifts.get('ring'), 'liked'), 8, 'epic bonus');
  eq(Gifts.bonusFor(Gifts.get('ring'), 'annoyed'), 0, 'no bonus when she hated it');
  ok(/GIFT: they just handed you "Ring" \(epic; promise\)/.test(Gifts.promptBlock(Gifts.get('ring'))), 'prompt block names tier + tags');
  eq(Gifts.turnText(Gifts.get('cake')), '*hands you Cake*', 'turn text is narration');
  eq(Gifts.coinsForTurn({ verdict: 'loved' }), 10, 'coins: base + loved bonus');
  Gifts.removeCustom('my-cake');
  eq(Gifts.catalog().length, 2, 'custom removed');
}
const { Store, Affection, Guard, Reply, Prompt, Characters, Providers, Engine, Memory, Config, TtsOmnivoice, Outfits } = sandbox;

/* -------------------------------------------------------------- Outfits */
console.log('Outfits');
{
  const chara = { defaultCostume: 'nrml-0004-00', costumes: [
    { id: 'cmmn-0000-00', name: 'Casual', model: 'costumes/cmmn-0000-00/00018-cmmn-0000-00.model3.json' },
    { id: 'nrml-0004-00', name: 'Idol', model: 'costumes/nrml-0004-00/00018-nrml-0004-00.model3.json' } ] };
  const models = ['costumes/nrml-0004-00/00018-nrml-0004-00.model3.json', 'costumes/cmmn-0000-00/00018-cmmn-0000-00.model3.json', 'extra/Haru.model3.json'];
  const list = Outfits.fromModels(models, chara);
  eq(list.map(o => o.id), ['cmmn-0000-00', 'nrml-0004-00', 'extra'], 'ids: export ids, folder for unknown');
  eq(list.map(o => o.name), ['Casual', 'Idol', 'extra'], 'names from live2d-character.json');
  eq(Outfits.defaultModel(list, chara, null), chara.costumes[1].model, 'default = export defaultCostume');
  eq(Outfits.defaultModel(list, null, 'extra/Haru.model3.json'), 'extra/Haru.model3.json', 'default = preferred when no export');
  eq(Outfits.defaultModel(list, null, null), list[0].model, 'default = first otherwise');
  eq(Outfits.fromModels(['a/x.model3.json', 'b/x.model3.json'], null).map(o => o.id), ['a', 'b'], 'folder ids');
  eq(Outfits.fromModels(['x.model3.json', 'y/x.model3.json'], null).map(o => o.id), ['x', 'y'], 'root model uses its own name');
}


/* ---------------------------------------------------------------- Store */
console.log('Store');
Store.set('a', 'history', [1, 2]);
Store.set('b', 'history', [3]);
eq(Store.get('a', 'history'), [1, 2], 'get/set per character');
eq(Store.get('b', 'history'), [3], 'other character untouched');
eq(Store.get('c', 'history', 'fb'), 'fb', 'fallback');
ok(Store.wipe('a') === 1 && Store.get('a', 'history') === undefined, 'wipe');

/* ------------------------------------------------------------ Affection */
console.log('Affection');
eq(Affection.deltaFor('LOVED'), 2, 'verdict case-insensitive');
eq(Affection.deltaFor('bogus'), 0, 'unknown verdict scores 0');
Affection.reset('x');
let r = Affection.apply('x', -5);
eq(r.affection, 0, '0-floor');
r = Affection.apply('x', 30);
ok(r.rank_up && r.rank_up.level === 1 && r.rank_up.name === 'Familiar', 'rank-up at 30');
r = Affection.apply('x', -2); r = Affection.apply('x', 2);
ok(r.rank_up === null, 'bouncing over a threshold does not re-trigger rank-up');
r = Affection.apply('x', 200);
ok(r.rank_up && r.rank_up.level === 3, 'jumping two ranks reports the top one');
eq(Affection.level('x'), 3, 'level reads ladder');
ok(!Affection.canBond('x'), 'cannot bond before Devoted');
Affection.apply('x', 1000);
ok(Affection.canBond('x') && Affection.bond('x').level === 6 && Affection.level('x') === 6, 'bond → 6');

/* ---------------------------------------------------------------- Guard */
console.log('Guard');
ok(Guard.readsAsNarration('She teases him and laughs it off.', 'Aria'), 'third-person narration');
ok(Guard.readsAsNarration('Aria laughs it off and waves.', 'Aria'), 'own-name narration');
ok(!Guard.readsAsNarration('Aria! Over here.', 'Aria'), 'own name as address is speech');
ok(!Guard.readsAsNarration("She's not coming, is she?", 'Aria'), 'speech about an absent she');
ok(!Guard.readsAsNarration('Ha! You wish, buddy. I win again.', 'Aria'), 'first person is speech');
const rm = Guard.retryMessages([{ role: 'user', content: 'hi' }], 'bad');
ok(rm.length === 3 && rm[1].role === 'assistant' && /third person/.test(rm[2].content), 'retry messages shape');

/* ---------------------------------------------------------------- Reply */
console.log('Reply');
let p = Reply.parse('```json\n{"line":{"en":"Hey.","ja":"やあ。"},"emotion":"happy","verdict":"liked"}\n```',
                    { langs: ['en', 'ja'], emotions: ['neutral', 'happy'] });
ok(p.ok && p.text === 'Hey.' && p.by.ja === 'やあ。' && p.emotion === 'happy' && p.verdict === 'liked', 'fenced JSON');
p = Reply.parse('Sure! {"line": "Just text.", "emotion": "RAGE", "verdict": "meh"}', { langs: ['en'], emotions: ['neutral'] });
ok(p.ok && p.text === 'Just text.' && p.emotion === null && p.verdict === 'neutral', 'prose around JSON, invalid enums dropped');
p = Reply.parse('{"line":{"ja":"やあ"},"emotion":"happy"}', { langs: ['en', 'ja'] });
ok(p.text === 'やあ' && p.by.en === 'やあ', 'missing sub language falls back');
p = Reply.parse('I have no JSON at all.', { langs: ['en'] });
ok(p.ok && p.degraded && p.text === 'I have no JSON at all.' && p.verdict === 'neutral', 'no JSON → raw text, degraded');
p = Reply.parse('{"line":"x","state":{"stamina_delta":-1}}', { langs: ['en'] });
eq(p.state, { stamina_delta: -1 }, 'state passthrough');

/* --------------------------------------------------------------- Prompt */
console.log('Prompt');
const card = Characters.normalize({ id: 'T', name: 'Tester', personality: 'blunt', emotions: ['neutral', 'smug'] });
const sys = Prompt.system({ card, mode: 'asmr', bondLevel: 3, langs: ['en', 'ja'], emotions: card.emotions });
ok(/You are Tester\./.test(sys), 'persona');
ok(/FRIEND:/.test(sys), 'closeness line for level 3');
ok(/"ja": "<the exact words/.test(sys) && /"en": "<the exact words/.test(sys), 'per-language spec');
ok(/"emotion": "neutral\|smug"/.test(sys), 'emotion enum from card');
ok(/max 30 words/.test(sys), 'asmr word limit');
ok(!/STRANGER/.test(sys), 'only one closeness line');
const sysMem = Prompt.system({ card, langs: ['en'], memoryBlock: '## MEM\n- fact' });
ok(sysMem.indexOf('## MEM') > sysMem.indexOf('Respond with ONLY'), 'memory after the static spec (prefix cache)');
ok(!/wrap in \*asterisks\*/.test(sys), 'no action rule on a plain turn');
ok(/wrap in \*asterisks\*/.test(Prompt.system({ card, langs: ['en'], hasAction: true })), 'action rule when the text narrates');
ok(Prompt.hasAction('*hands you tea*') && !Prompt.hasAction('hi there') && !Prompt.hasAction('2*3'), 'hasAction detects *narration* only');
eq(Prompt.langsFor('en', 'en'), ['en'], 'langsFor dedupes');
eq(Prompt.langsFor('en', 'ja'), ['en', 'ja'], 'langsFor sub then dub');

/* ----------------------------------------------------------- Characters */
console.log('Characters');
Characters._reset();
Characters.seed([{ id: 'Alpha', name: 'A' }, { id: 'beta', name: 'B', emotions: ['happy'] }], true);
eq(Characters.list().map((c) => c.id), ['alpha', 'beta'], 'ids normalized, listed');
eq(Characters.get('beta').emotions, ['neutral', 'happy'], 'neutral always present');
ok(Characters.setActive('beta') && Characters.activeId() === 'beta', 'setActive');
ok(!Characters.setActive('nope') && Characters.activeId() === 'beta', 'unknown id rejected');
Characters.upsert({ id: 'beta', name: 'B2' });
ok(Characters.get('beta').name === 'B2' && !Characters.get('beta').builtin, 'custom overrides builtin');
Characters.remove('beta');
ok(Characters.get('beta').name === 'B', 'remove reverts to builtin');
console.log('Characters.langs precedence');
Characters.seed([{ id: 'pinned', name: 'P', languages: { sub: 'en', dub: 'en' } }], true);
Config.set('llm.lang', 'auto'); Config.set('tts.lang', 'auto');
eq(Characters.langs(Characters.get('pinned')), { sub: 'en', dub: 'en' }, 'auto → card pin');
Config.set('tts.lang', 'ja');
eq(Characters.langs(Characters.get('pinned')), { sub: 'en', dub: 'ja' }, 'explicit tts.lang beats the card pin');
eq(Characters.langs(Characters.get('alpha')).dub, 'ja', 'explicit tts.lang for an unpinned card');
Config.set('tts.lang', 'auto');
const miss = Reply.parse('{"line":{"en":"hi"},"emotion":"happy"}', { langs: ['en', 'ja'], emotions: ['neutral', 'happy'] });
ok(miss.by.ja === 'hi' && miss.missing.indexOf('ja') !== -1, 'localize backfills AND flags the missing dub');

/* ------------------------------------------------------------ Providers */
console.log('Providers');
eq(Providers.nameFor('llm', null), 'openai', 'default llm');
eq(Providers.nameFor('tts', { providers: { tts: { provider: 'x' } } }), 'x', 'card override');
Config.set('llm.model', 'global-model');
eq(Providers.settings('llm', 'openai', { providers: { llm: { model: 'card-model' } } }).model, 'card-model', 'card setting wins');
eq(Providers.settings('tts', 'omnivoice', null).baseUrl, 'http://127.0.0.1:9192', 'omnivoice defaults');

/* --------------------------------------------------------- TtsOmnivoice */
console.log('TtsOmnivoice');
eq(TtsOmnivoice.cleanForTts('nani~ nani～'), 'nani nani', 'tilde strip');
const vz = { ref_audio: 'r.wav', instruct: null, asmr_ref: 'r_asmr.wav', asmr_fx: 'drift' };
eq(TtsOmnivoice.voiceFor(vz, 'chat'), { ref_audio: 'r.wav', instruct: null, asmr: null }, 'normal mode: plain voice');
eq(TtsOmnivoice.voiceFor(vz, 'asmr'), { ref_audio: 'r_asmr.wav', instruct: null, asmr: 'drift' }, 'asmr with a whisper ref: swap ref, no instruct');
eq(TtsOmnivoice.voiceFor({ ref_audio: 's.wav' }, 'asmr'), { ref_audio: 's.wav', instruct: null, asmr: 'close' }, 'asmr without a whisper ref: normal voice + close fx');
const long = 'A sentence that is long enough to matter. '.repeat(30);
const t = TtsOmnivoice.truncate(long, 200);
ok(t.length <= 200 && /\.$/.test(t), 'sentence-safe truncation');

/* --------------------------------------------------------------- Engine */
console.log('Engine (fake LLM)');
Characters._reset();
Characters.seed([
  { id: 'aria', name: 'Aria', personality: 'blunt', emotions: ['neutral', 'smug'] },
  { id: 'ryza', name: 'Ryza', emotions: ['neutral', 'happy'] }
], true);
Config.set('llm.baseUrl', 'http://localhost:1235/v1');
Config.set('llm.historyTurns', 2);
Config.set('memory.enabled', true);
Config.set('memory.turnsPerSession', 1);
Memory.setSummarizer((items, kind) => 'SUM:' + items.length);

const calls = [];
let script = [];
Providers.register('llm', 'openai', {
  complete(opts) {
    calls.push(opts.messages);
    const next = script.shift();
    return Promise.resolve(typeof next === 'function' ? next(opts) : next);
  }
});

(async () => {
  Characters.setActive('aria');
  Engine._bind('aria');

  script = ['{"line":{"en":"Hmph. Fine."},"emotion":"smug","verdict":"liked"}'];
  let rep = await Engine.chat('hi');
  ok(rep.text === 'Hmph. Fine.' && rep.emotion === 'smug' && rep.verdict === 'liked', 'turn parsed');
  eq(rep.affection, 1, 'liked → +1');
  eq(Engine.history('aria').length, 2, 'history appended');
  ok(/"line"/.test(Engine.history('aria')[1].content), 'assistant history stored as JSON');
  ok(calls[0][0].role === 'system' && /You are Aria/.test(calls[0][0].content), 'system prompt sent');
  ok(/STRANGER/.test(calls[0][0].content), 'closeness at level 0');

  script = ['Aria rolls her eyes at him.', '{"line":{"en":"Roll your own eyes."},"emotion":"smug","verdict":"annoyed"}'];
  rep = await Engine.chat('lol');
  ok(rep.text === 'Roll your own eyes.' && !rep.narration, 'narration retried once and fixed');
  ok(calls.length === 3 && calls[2].length === calls[1].length + 2, 'retry re-sent conversation + slip');
  eq(rep.affection, 0, 'annoyed → -2 floored to 0');

  script = ['She looks at him and sighs.', 'She sighs at him again.'];
  rep = await Engine.chat('again');
  ok(rep.narration === true && rep.text === 'She looks at him and sighs.', 'stubborn narration is shown');
  eq(Engine.history('aria').length, 4, 'but NOT stored');

  script = ['{"line":{"en":"x"},"emotion":"neutral","verdict":"loved"}', '{"line":{"en":"y"},"verdict":"loved"}'];
  await Engine.chat('a'); await Engine.chat('b');
  eq(Engine.history('aria').length, 4, 'history capped at historyTurns*2');
  ok(Engine.history('aria')[0].content === 'a', 'oldest turns dropped');

  /* switching characters isolates everything */
  const memKey = Memory.boundKey();
  Engine.switchCharacter('ryza');
  ok(Memory.boundKey() !== memKey && /cc\.ryza\./.test(Memory.boundKey()), 'memory rebound per character');
  eq(Engine.history('ryza'), [], 'ryza history empty');
  eq(Affection.points('ryza'), 0, 'ryza affection empty');
  ok(Memory.promptBlock() === '', 'ryza memory empty');
  script = ['{"line":{"en":"Hiya!","ja":"やっほー！"},"emotion":"happy","verdict":"loved"}'];
  rep = await Engine.chat('hello');
  ok(rep.emotion === 'happy' && rep.affection === 2, 'ryza turn independent');
  Engine.switchCharacter('aria');
  eq(Engine.history('aria').length, 4, 'sui history intact after round trip');
  ok(Affection.points('aria') === 4, 'sui affection intact');

  /* dub language flows to dubText */
  Characters.seed([{ id: 'jp', name: 'JP', languages: { sub: 'en', dub: 'ja' } }], true);
  Engine.switchCharacter('jp');
  script = ['{"line":{"en":"Good morning.","ja":"おはよう。"},"emotion":"neutral","verdict":"neutral"}'];
  rep = await Engine.chat('morning');
  ok(rep.dubText === 'おはよう。' && rep.text === 'Good morning.' && rep.dubLang === 'ja', 'sub shown, dub spoken');
  ok(/"ja": "<the exact/.test(calls[calls.length - 1][0].content), 'prompt asked for ja');

  const tr = Engine.transcript('jp');
  ok(tr.length === 2 && tr[1].text === 'Good morning.' && tr[1].emotion === 'neutral', 'transcript decodes JSON history');

  /* empty reply rejects, nothing stored */
  script = ['   '];
  let threw = false;
  try { await Engine.chat('blank'); } catch (e) { threw = e.message === 'EMPTY_REPLY'; }
  ok(threw && Engine.history('jp').length === 2, 'empty reply rejects without storing');

  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('  CRASH ' + (e && e.stack || e)); process.exit(1); });
