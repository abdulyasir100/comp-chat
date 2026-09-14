/* Engine — the embedded per-character brain.

   One turn (Engine.chat):
     1. active card + closeness (Affection.level) + memory block → system prompt
     2. per-character history (real chat messages) + the new user line → LLM
     3. Reply.parse → {line per lang, emotion, verdict}
     4. narration guard: one retry; a turn that stays narration is shown but
        NEVER stored (it would teach the character to keep narrating)
     5. verdict → Affection.apply (model picks the feeling, code picks the number)
     6. append history, Memory.ingest

   Engine.speak(text, lang) voices a line with the card's own reference audio.
   The app never talks to a provider directly. */
(function (global) {
  'use strict';

  var HISTORY_TURNS_DEFAULT = 12;

  function cfg(section) {
    try { return (global.Config && Config.section(section)) || {}; } catch (e) { return {}; }
  }

  function historyTurns() {
    var n = parseInt(cfg('llm').historyTurns, 10);
    return n > 0 ? n : HISTORY_TURNS_DEFAULT;
  }

  var Engine = {
    _ready: false,

    /* Load characters, bind memory to the active one. Resolves to the active card. */
    init: function () {
      return Characters.load().then(function () {
        Engine._bind(Characters.activeId());
        Engine._ready = true;
        return Characters.active();
      });
    },

    _bind: function (charId) {
      try { if (global.Memory && Memory.bind) Memory.bind(charId || '_'); } catch (e) {}
    },

    active: function () { return Characters.active(); },

    switchCharacter: function (id) {
      if (!Characters.setActive(id)) return null;
      Engine._bind(id);
      return Characters.get(id);
    },

    /* ---- per-character history: [{role, content}] as the model saw them ---- */
    history: function (charId) {
      charId = charId || Characters.activeId();
      var h = Store.get(charId, 'history', []);
      return Array.isArray(h) ? h : [];
    },
    clearHistory: function (charId) {
      Store.set(charId || Characters.activeId(), 'history', []);
    },
    _appendHistory: function (charId, userText, reply) {
      var h = Engine.history(charId);
      h.push({ role: 'user', content: userText });
      h.push({ role: 'assistant', content: Prompt.assistantHistory(reply) });
      var keep = historyTurns() * 2;
      if (h.length > keep) h = h.slice(h.length - keep);
      Store.set(charId, 'history', h);
      return h;
    },

    /* Human-readable transcript for the UI (spoken line, not the JSON). */
    transcript: function (charId) {
      return Engine.history(charId).map(function (m) {
        if (m.role !== 'assistant') return { role: 'user', text: m.content };
        var j = Reply.extractJson(m.content);
        var line = j && j.line;
        if (line && typeof line === 'object') line = line[Object.keys(line)[0]] || '';
        return { role: 'assistant', text: String(line || m.content), emotion: j && j.emotion };
      });
    },

    /* ---- one turn ---- */
    /* opts: {mode, style, profile, extra} → Promise<reply>
       reply: {text (sub), dubText, by, emotion, verdict, affection, rank, rank_up, narration, degraded, raw} */
    chat: function (userText, opts) {
      opts = opts || {};
      var card = Characters.active();
      if (!card) return Promise.reject(new Error('NO_CHARACTER'));
      var charId = card.id;
      userText = String(userText || '').trim();
      if (!userText) return Promise.reject(new Error('EMPTY'));

      var L = Characters.langs(card);
      var langs = Prompt.langsFor(L.sub, L.dub);
      var mem = '', graph = '';
      try { if (global.Memory) mem = Memory.promptBlock() || ''; } catch (e) { mem = ''; }
      var names = { user: (opts.profile && opts.profile.name) || 'the user', me: card.name || 'you' };
      try { if (global.Graph) graph = Graph.promptBlock(charId, userText, names) || ''; } catch (e) { graph = ''; }
      var system = Prompt.system({
        card: card, mode: opts.mode, style: opts.style,
        bondLevel: Affection.level(charId), langs: langs, emotions: card.emotions,
        memoryBlock: mem, graphBlock: graph, profile: opts.profile, extra: opts.extra,
        hasAction: Prompt.hasAction(userText)
      });
      var messages = Prompt.messages(system, Engine.history(charId), userText);
      var llm = Providers.get('llm', card);
      var settings = Providers.settings('llm', Providers.nameFor('llm', card), card);

      function ask(msgs) {
        return llm.complete({ messages: msgs, settings: settings }).then(function (text) {
          return Reply.parse(text, { langs: langs, emotions: card.emotions });
        });
      }

      return ask(messages).then(function (reply) {
        if (!reply.ok) throw new Error('EMPTY_REPLY');
        if (!Guard.readsAsNarration(reply.text, card.name)) return reply;
        /* She described herself instead of speaking. Show her the slip, ask once more. */
        return ask(Guard.retryMessages(messages, reply.raw)).then(function (fixed) {
          if (fixed.ok && !Guard.readsAsNarration(fixed.text, card.name)) return fixed;
          reply.narration = true;
          return reply;
        }, function () { reply.narration = true; return reply; });
      }).then(function (reply) {
        var aff = Affection.applyVerdict(charId, reply.verdict);
        reply.affection = aff.affection;
        reply.rank = aff.rank;
        reply.rank_name = aff.rank_name;
        reply.rank_up = aff.rank_up;
        /* if the model skipped the dub language, speak the subtitle line in
           ITS language rather than reading English with language:'ja' */
        var dubOk = reply.by[L.dub] && (reply.missing || []).indexOf(L.dub) === -1;
        reply.dubText = dubOk ? reply.by[L.dub] : reply.text;
        reply.subLang = L.sub;
        reply.dubLang = dubOk ? L.dub : L.sub;
        if (!reply.narration) {
          Engine._appendHistory(charId, userText, reply);
          try { if (global.Memory) Memory.ingest(userText, reply.text); } catch (e) {}
          try { if (global.Graph && reply.facts && reply.facts.length) reply.learned = Graph.add(charId, reply.facts); } catch (e) {}
          try { if (global.Graph && reply.facts && reply.facts.length) reply.learned = Graph.add(charId, reply.facts); } catch (e) {}
        }
        return reply;
      });
    },

    /* Voice a line with the active card's voice. Resolves to an object URL. */
    speak: function (text, lang) {
      var card = Characters.active();
      var tts = Providers.get('tts', card);
      var name = Providers.nameFor('tts', card);
      var settings = Providers.settings('tts', name, card);
      var mode = null;
      try { mode = (global.Config && Config.section('state') || {}).mode || null; } catch (e) {}
      return tts.speak({
        text: text,
        language: lang || Characters.langs(card).dub,
        voice: (card && card.voice) || {},
        mode: mode,                       /* 'asmr' switches the voice preset */
        settings: settings
      });
    },

    /* Short plain completion (memory rollups) on the active LLM provider. */
    complete: function (system, user, opts) {
      opts = opts || {};
      var card = Characters.active();
      var llm = Providers.get('llm', card);
      return llm.complete({
        system: String(system || ''),
        messages: [{ role: 'user', content: String(user || '') }],
        temperature: opts.temperature != null ? opts.temperature : 0.2,
        maxTokens: opts.maxTokens || 280,
        timeout: opts.timeout || 60000,
        settings: Providers.settings('llm', Providers.nameFor('llm', card), card)
      });
    }
  };

  global.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
