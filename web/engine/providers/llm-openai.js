/* LLM provider: any OpenAI-compatible /chat/completions endpoint.
   Covers OpenRouter, Grok (xAI), Groq, Cerebras, LM Studio, Ollama, and the
   Claude bridge. Reuses ryza's transport (Api._request through the same-origin
   /_proxy) and its thinking/effort mapping so reasoning models behave. */
(function (global) {
  'use strict';

  function choiceText(j) {
    var msg = j && j.choices && j.choices[0] && j.choices[0].message;
    if (!msg) return '';
    var c = msg.content;
    if (Array.isArray(c)) {
      return c.map(function (p) { return (p && p.text) || ''; }).join('');
    }
    return String(c || '');
  }

  var LlmOpenai = {
    name: 'openai',

    /* opts: {system, messages, temperature, maxTokens, timeout, settings} */
    complete: function (opts) {
      opts = opts || {};
      var llm = opts.settings || Providers.settings('llm', 'openai', null);
      if (!llm.apiKey && !/^(https?:\/\/)?(127\.0\.0\.1|localhost|100\.)/.test(String(llm.baseUrl || ''))) {
        return Promise.reject(new Error('NO_KEY'));
      }
      if (!llm.baseUrl) return Promise.reject(new Error('NO_URL'));
      var messages = opts.messages || [];
      if (opts.system && !(messages[0] && messages[0].role === 'system')) {
        messages = [{ role: 'system', content: opts.system }].concat(messages);
      }
      var body = {
        model: llm.model,
        messages: messages,
        temperature: opts.temperature != null ? opts.temperature : (Number(llm.temperature) || 0.9),
        max_tokens: opts.maxTokens || Number(llm.maxTokens) || 400
      };
      try { if (global.Api && Api.attachThinking) Api.attachThinking(body, llm, null); } catch (e) {}
      var url = Api._localProxy(String(llm.baseUrl).replace(/\/+$/, '') + '/chat/completions');
      return Api._request(url, body, llm.apiKey, opts.timeout || 120000).then(function (j) {
        return choiceText(j);
      });
    }
  };

  global.LlmOpenai = LlmOpenai;
  if (global.Providers) Providers.register('llm', 'openai', LlmOpenai);
})(typeof window !== 'undefined' ? window : globalThis);
