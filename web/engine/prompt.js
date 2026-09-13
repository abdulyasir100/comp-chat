/* System prompt + message list for one turn.

   Layout mirrors what worked in town.exe's Visit menu and keeps ryza's
   prefix-cache discipline: everything per-character but per-turn-stable comes
   first (persona, mode, closeness, output spec), the memory block after it, and
   the live history as real chat messages so an OpenAI-compatible endpoint can
   reuse the prefix across turns. */
(function (global) {
  'use strict';

  var LANG_NAMES = {
    en: 'English', ja: 'Japanese', id: 'Bahasa Indonesia', ko: 'Korean',
    zh: 'Chinese (Simplified)', 'zh-tw': 'Chinese (Traditional)', hi: 'Hindi',
    'pt-br': 'Brazilian Portuguese', es: 'Spanish', fr: 'French', de: 'German'
  };

  /* Dialogue modes (from ryza, rewritten character-agnostic). */
  var MODES = {
    chat: { text: 'Casual conversation. Listen to what they say and keep the talk going naturally.', words: 45 },
    story: { text: 'You are moving a short story forward together. A touch of scene-setting, then keep the dialogue moving.', words: 70 },
    immersive: { text: 'Slow, immersive narration of the two of you being together right now, with the senses in it — but always spoken in first person.', words: 80 },
    asmr: { text: 'Quiet and close. Slow, gentle, short words, as if whispered right beside their ear.', words: 30 },
    text: { text: 'A text-message exchange. Brief and clear.', words: 60 }
  };

  /* Closeness ladder — verbatim from town.exe _VISIT_CLOSENESS (0..6). */
  var CLOSENESS = {
    0: 'STRANGER: you barely know this person. Polite at best, guarded — you owe them nothing.',
    1: 'FAMILIAR: you recognize them now. Still reserved, but the edge is off.',
    2: "ACQUAINTANCE: you're comfortable around them. You'll banter, and you'll answer honestly.",
    3: 'FRIEND: you genuinely like this person. Warm, teasing, unguarded in your own way.',
    4: "CONFIDANT: you trust them with things you don't say to others. You can be candid, even vulnerable, without it feeling out of character.",
    5: "DEVOTED: this person matters to you more than almost anyone. Openly fond (your way — smug, flustered, deadpan, whatever fits), and you don't hide that they're special.",
    6: 'BONDED: they gave you a ring, and you accepted it. This is the person you chose. Speak with the ease of someone who has nothing left to prove to them — the warmest, most personal register you have. Still fully yourself, never syrupy.'
  };

  var SPOKEN_LINE_RULE =
    '`line` is the LITERAL WORDS YOU SPEAK, first person, as if written between quotation marks. ' +
    'Never describe yourself from the outside. "She teases him and laughs it off" is WRONG — that is ' +
    'narration. "Ha! You wish, buddy." is RIGHT. No emotion tags, no stage directions, no asterisks.';

  var VERDICT_RULE =
    'You ALSO report how what they said actually landed with YOU — judged by your own personality ' +
    'and taste, not by politeness:\n' +
    '- `loved`: it delighted you — it hit something you genuinely care about, or it was exactly the ' +
    'kind of thing you want to hear from them.\n' +
    '- `liked`: pleasant. Kind, funny, or interesting to you.\n' +
    '- `neutral`: small talk, or something you have no feelings about either way.\n' +
    '- `annoyed`: it rubbed you the wrong way — rude, boring, presumptuous, or it stepped on ' +
    'something you dislike.\n' +
    'Be honest and be YOURSELF: a blunt character can be annoyed by flattery, a cold one can be ' +
    'unmoved by kindness. Do not default to `liked` to be agreeable, and do not punish an ordinary ' +
    'friendly remark. Your spoken line must MATCH your verdict.';

  function langName(lg) { return LANG_NAMES[lg] || lg; }

  /* Port of town.exe _personality_block, on the companion-chat card schema. */
  function personaBlock(card) {
    var name = card.name || 'You';
    var has = card.description || card.personality || card.speech_style ||
              (card.example_messages && card.example_messages.length) || card.background;
    if (!has) {
      return 'You are ' + name + ', an ordinary person with no notable traits. Behave as a generic, rational human.';
    }
    var L = ['You are ' + name + '.'];
    if (card.nickname) L.push('People also call you: ' + card.nickname + '.');
    if (card.description) L.push('About you: ' + card.description);
    if (card.background) L.push('Background: ' + card.background);
    if (card.personality) L.push('Personality: ' + card.personality);
    if (card.speech_style) L.push('Speech style: ' + card.speech_style);
    if (card.likes) L.push('Likes: ' + card.likes);
    if (card.dislikes) L.push('Dislikes: ' + card.dislikes);
    if (card.situation) L.push('Situation: ' + card.situation);
    var ex = card.example_messages || [];
    if (ex.length) {
      L.push('Voice examples:\n' + ex.map(function (e) {
        return e.role === 'user' ? '  Q: ' + e.content : '  You: ' + e.content;
      }).join('\n'));
    }
    if (card.extra) L.push(String(card.extra));
    return L.join('\n');
  }

  function userBlock(profile) {
    if (!profile) return '';
    var L = [];
    if (profile.name) L.push('The person you are talking to is called ' + profile.name + (profile.callMe ? ' (call them "' + profile.callMe + '")' : '') + '.');
    else if (profile.callMe) L.push('Call the person you are talking to "' + profile.callMe + '".');
    if (profile.background) L.push('About them: ' + profile.background);
    if (profile.hobby) L.push('Their hobbies: ' + profile.hobby);
    return L.join('\n');
  }

  function outputSpec(langs, emotions, words) {
    var keys = langs.map(function (lg) {
      return '"' + lg + '": "<the exact words you say out loud, first person, in ' + langName(lg) + '>"';
    }).join(', ');
    var em = emotions && emotions.length ? emotions.join('|') : 'neutral';
    return [
      'Respond with ONLY a JSON object, no prose, no fences:',
      '{"line": {' + keys + '}, "emotion": "' + em + '", "verdict": "loved|liked|neutral|annoyed"}',
      'Every language version must convey the SAME meaning and tone, each within ' + words + ' words. ' +
      'Write naturally in each language (not a stiff word-for-word translation).',
      '`emotion` is the face you make while saying it — pick ONE from the list.',
      SPOKEN_LINE_RULE
    ].join('\n');
  }

  var Prompt = {
    LANG_NAMES: LANG_NAMES,
    MODES: MODES,
    CLOSENESS: CLOSENESS,
    langName: langName,
    personaBlock: personaBlock,

    /* Languages a line must be produced in: sub first (canonical, shown), dub
       added when it differs (spoken). */
    langsFor: function (subLang, dubLang) {
      var out = [subLang || 'en'];
      if (dubLang && dubLang !== out[0]) out.push(dubLang);
      return out;
    },

    /* opts: { card, mode, style, bondLevel, langs, emotions, memoryBlock, profile, extra } */
    system: function (opts) {
      opts = opts || {};
      var card = opts.card || {};
      var mode = MODES[opts.mode] || MODES.chat;
      var words = opts.words || mode.words;
      var langs = opts.langs || ['en'];
      var S = [];
      S.push(personaBlock(card));
      var ub = userBlock(opts.profile);
      if (ub) S.push(ub);
      S.push('This is a private, one-to-one conversation between you and them. No roles, no game, no ' +
             'audience — just the two of you. They just said something to you. Answer with ONE short ' +
             'spoken line (max ' + words + ' words), fully in character.');
      S.push('Conversation mode: ' + mode.text + (opts.style === 'text'
             ? ' This is text, not read aloud, so a little longer is fine.'
             : ' Your line will be read aloud by a voice: keep it short and spoken, no lists.'));
      var lvl = opts.bondLevel | 0;
      if (CLOSENESS[lvl]) S.push('How close you are to them — ' + CLOSENESS[lvl]);
      S.push(VERDICT_RULE);
      S.push(outputSpec(langs, opts.emotions, words));
      if (opts.memoryBlock) S.push(opts.memoryBlock);
      if (opts.extra) S.push(String(opts.extra));
      return S.filter(Boolean).join('\n\n');
    },

    /* What the model sees as its own previous reply: the compact JSON it was
       asked for, so the format is reinforced by every turn of history. */
    assistantHistory: function (reply) {
      var o = { line: reply.by || reply.text || '', emotion: reply.emotion || 'neutral' };
      return JSON.stringify(o);
    },

    messages: function (system, history, userText) {
      return [{ role: 'system', content: system }]
        .concat(history || [])
        .concat([{ role: 'user', content: String(userText || '') }]);
    }
  };

  global.Prompt = Prompt;
})(typeof window !== 'undefined' ? window : globalThis);
