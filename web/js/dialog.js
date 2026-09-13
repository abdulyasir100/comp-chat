/* Dialog — in-app replacement for window.prompt / confirm / a pick list.

   Electron does not implement prompt() and the Android WebView answers
   prompt()/confirm() with null/false unless the host wires them up, so
   anything that asked the user for a name or a yes/no silently died in the
   packaged builds. Every call resolves a Promise: confirm -> bool,
   prompt -> string|null, choose -> item|null. Themed like the panels. */
(function (global) {
  'use strict';

  var host = null;

  function tc(k, f) { return global.I18n && I18n.tc ? I18n.tc(k, f) : f; }

  function open(build) {
    close();
    host = document.createElement('div');
    host.id = 'dlg';
    var card = document.createElement('div');
    card.className = 'dlg-card';
    host.appendChild(card);
    document.body.appendChild(host);
    return new Promise(function (resolve) {
      var onKey = function (e) { if (e.key === 'Escape') done(null); };
      var done = function (v) { document.removeEventListener('keydown', onKey); close(); resolve(v); };
      host.onclick = function (e) { if (e.target === host) done(null); };
      document.addEventListener('keydown', onKey);
      build(card, done);
    });
  }

  function close() {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
  }

  function title(card, s) {
    if (!s) return;
    var h = document.createElement('div');
    h.className = 'dlg-title'; h.textContent = s;
    card.appendChild(h);
  }
  function text(card, s) {
    if (!s) return;
    var p = document.createElement('div');
    p.className = 'dlg-text'; p.textContent = s;
    card.appendChild(p);
  }
  function buttons(card, list) {
    var row = document.createElement('div');
    row.className = 'btn-row';
    list.forEach(function (b) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn' + (b.cls ? ' ' + b.cls : '');
      btn.textContent = b.label;
      btn.onclick = b.onClick;
      row.appendChild(btn);
    });
    card.appendChild(row);
    return row;
  }

  var Dialog = {
    /* confirm(text, {title, danger, ok, cancel}) -> Promise<bool> */
    confirm: function (msg, opts) {
      opts = opts || {};
      return open(function (card, done) {
        title(card, opts.title);
        text(card, msg);
        buttons(card, [
          { label: opts.cancel || tc('dlg.cancel', 'Cancel'), onClick: function () { done(false); } },
          { label: opts.ok || tc('dlg.ok', 'OK'), cls: opts.danger ? 'danger' : 'primary', onClick: function () { done(true); } }
        ]);
      }).then(function (v) { return !!v; });
    },

    /* prompt(label, value, {title, hint, placeholder, multi}) -> Promise<string|null> */
    prompt: function (label, value, opts) {
      opts = opts || {};
      return open(function (card, done) {
        title(card, opts.title);
        var f = document.createElement('div'); f.className = 'field';
        var lab = document.createElement('label'); lab.textContent = label || '';
        var input = document.createElement(opts.multi ? 'textarea' : 'input');
        if (!opts.multi) input.type = 'text';
        input.value = value == null ? '' : value;
        if (opts.placeholder) input.placeholder = opts.placeholder;
        f.appendChild(lab); f.appendChild(input);
        if (opts.hint) { var h = document.createElement('div'); h.className = 'hint'; h.textContent = opts.hint; f.appendChild(h); }
        card.appendChild(f);
        if (!opts.multi) input.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); done(input.value); } };
        buttons(card, [
          { label: tc('dlg.cancel', 'Cancel'), onClick: function () { done(null); } },
          { label: opts.ok || tc('dlg.ok', 'OK'), cls: 'primary', onClick: function () { done(input.value); } }
        ]);
        setTimeout(function () { input.focus(); if (input.select) input.select(); }, 30);
      });
    },

    /* choose(title, items:[{v,t}|string]) -> Promise<v|null> */
    choose: function (heading, items) {
      return open(function (card, done) {
        title(card, heading);
        var list = document.createElement('div'); list.className = 'dlg-list';
        (items || []).forEach(function (it) {
          var v = (it && typeof it === 'object') ? it.v : it;
          var t = (it && typeof it === 'object') ? it.t : it;
          var b = document.createElement('button');
          b.type = 'button'; b.className = 'dlg-item'; b.textContent = t;
          b.onclick = function () { done(v); };
          list.appendChild(b);
        });
        card.appendChild(list);
        buttons(card, [{ label: tc('dlg.cancel', 'Cancel'), onClick: function () { done(null); } }]);
      });
    },

    close: close
  };

  global.Dialog = Dialog;
})(typeof window !== 'undefined' ? window : globalThis);
