/* Title + onboarding.
   Phase A (2026-09-13): onboarding is ONE step — name, birthday (month/day
   pickers), gender. The eight free-text/choice questions, the nine-part
   prologue and the tutorial coach-marks are gone: she learns hobbies and
   the rest by talking (Memory), and the tutorial described RPG systems that
   are hidden in companion-chat. */
(function (global) {
  'use strict';

  function questions() {
    return [
      {
        id: 'identity', type: 'identity',
        promptKey: 'onb.identity.prompt', subKey: 'onb.identity.sub'
      }
    ];
  }

  var MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  var Onboarding = {
    step: 0,
    answers: {},
    _onDone: null,

    isDone: function () {
      return !!(Config.section('state').onboardingDone);
    },

    showTitle: function (onStart) {
      var el = document.getElementById('overlay-title');
      var btn = document.getElementById('btn-title-start');
      document.body.classList.add('boot');       /* hide chrome behind title */
      el.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = I18n.t('title.start');
      btn.onclick = function () {
        if (window.Sound) Sound.unlock();
        el.classList.add('hidden');
        document.body.classList.remove('boot');
        onStart && onStart();
      };
    },

    start: function (onDone) {
      if (window.Sound) {
        Sound.unlock();
        Sound.setRoute('title');
      }
      Onboarding._onDone = onDone;
      Onboarding.step = 0;
      Onboarding.answers = {};
      document.getElementById('overlay-onboard').classList.remove('hidden');
      Onboarding._render();
    },

    skip: function () { Onboarding._finish(); },

    _finish: function () {
      Config.set('state.onboardingDone', true);
      document.getElementById('overlay-onboard').classList.add('hidden');
      Onboarding._onDone && Onboarding._onDone();
    },

    _render: function () {
      var qs = questions();
      var q = qs[Onboarding.step];
      var host = document.getElementById('onb-body');
      var prog = document.getElementById('onb-progress');
      var title = document.getElementById('onb-prompt');
      var sub = document.getElementById('onb-sub');
      document.getElementById('onb-skip').textContent = I18n.t('onb.skip');
      if (!q) { Onboarding._finish(); return; }
      prog.textContent = (Onboarding.step + 1) + ' / ' + qs.length;
      title.textContent = I18n.t(q.promptKey);
      sub.textContent = I18n.t(q.subKey);
      host.innerHTML = '';

      if (q.type === 'identity') {
        var p = Config.section('profile');
        host.appendChild(Onboarding._field(I18n.t('onb.name'), 'onb-name', 'text', p.name || ''));
        host.appendChild(Onboarding.birthdayPicker(I18n.t('onb.birthday'), 'onb-bday', p.birthday || ''));
        var g = document.createElement('div');
        g.className = 'field';
        g.innerHTML = '<label></label><div class="chips" id="onb-gender"></div>';
        g.querySelector('label').textContent = I18n.t('onb.gender');
        ['female', 'male', 'other'].forEach(function (v) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'chip' + (p.gender === v ? ' on' : '');
          b.textContent = I18n.t('onb.gender.' + v);
          b.onclick = function () {
            g.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('on'); });
            b.classList.add('on');
          };
          b.setAttribute('data-v', v);
          g.querySelector('#onb-gender').appendChild(b);
        });
        host.appendChild(g);
      } else if (q.type === 'text') {
        var ta = document.createElement('textarea');
        ta.id = 'onb-text';
        ta.rows = 4;
        ta.placeholder = q.phKey ? I18n.t(q.phKey) : '';
        host.appendChild(ta);
      } else if (q.type === 'multi' || q.type === 'single') {
        var chips = document.createElement('div');
        chips.className = 'chips';
        chips.id = 'onb-choices';
        q.choices.forEach(function (k) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'chip';
          b.textContent = I18n.t(k);
          b.setAttribute('data-k', k);
          b.onclick = function () {
            if (q.type === 'single') {
              chips.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('on'); });
              b.classList.add('on');
            } else b.classList.toggle('on');
          };
          chips.appendChild(b);
        });
        host.appendChild(chips);
      }

      document.getElementById('onb-next').textContent =
        Onboarding.step + 1 >= qs.length ? I18n.t('onb.finish') : I18n.t('onb.next');
    },

    _field: function (label, id, type, value) {
      var d = document.createElement('div');
      d.className = 'field';
      var lab = document.createElement('label');
      lab.textContent = label;
      var inp = document.createElement('input');
      inp.type = type; inp.id = id; inp.value = value || '';
      d.appendChild(lab); d.appendChild(inp);
      return d;
    },

    /* Month + day selects (the real app's wheel, no year, no typing). The
       value is "MM-DD"; a legacy ISO "YYYY-MM-DD" is read too. Shared with
       the player-profile form so both edit the same field the same way.
       `onChange(value)` is optional (the profile form saves live). */
    birthdayPicker: function (label, id, value, onChange) {
      var d = document.createElement('div');
      d.className = 'field';
      var lab = document.createElement('label');
      lab.textContent = label;
      var row = document.createElement('div');
      row.className = 'field-row';
      var mm = document.createElement('select'), dd = document.createElement('select');
      mm.id = id + '-m'; dd.id = id + '-d';
      var parts = Onboarding.parseBirthday(value);
      var opt = function (sel, v, text) {
        var o = document.createElement('option'); o.value = v; o.textContent = text; sel.appendChild(o);
      };
      opt(mm, '', I18n.tc('onb.month', 'Month'));
      MONTH_KEYS.forEach(function (k, i) {
        opt(mm, String(i + 1).padStart(2, '0'), I18n.tc('onb.month.' + k, k));
      });
      opt(dd, '', I18n.tc('onb.day', 'Day'));
      for (var n = 1; n <= 31; n++) opt(dd, String(n).padStart(2, '0'), String(n));
      mm.value = parts.m; dd.value = parts.d;
      var hidden = document.createElement('input');
      hidden.type = 'hidden'; hidden.id = id; hidden.value = Onboarding.joinBirthday(parts.m, parts.d);
      var sync = function () {
        hidden.value = Onboarding.joinBirthday(mm.value, dd.value);
        if (onChange) onChange(hidden.value);
      };
      mm.onchange = sync; dd.onchange = sync;
      row.appendChild(mm); row.appendChild(dd);
      d.appendChild(lab); d.appendChild(row); d.appendChild(hidden);
      return d;
    },

    parseBirthday: function (value) {
      var m = /(\d{2})-(\d{2})$/.exec(String(value || ''));
      return m ? { m: m[1], d: m[2] } : { m: '', d: '' };
    },
    joinBirthday: function (m, d) { return (m && d) ? m + '-' + d : ''; },

    next: function () {
      var qs = questions();
      var q = qs[Onboarding.step];
      if (q) Onboarding._save(q);
      Onboarding.step++;
      if (Onboarding.step >= qs.length) Onboarding._finish();
      else Onboarding._render();
    },

    _save: function (q) {
      if (q.type === 'identity') {
        var name = (document.getElementById('onb-name') || {}).value || '';
        var bday = (document.getElementById('onb-bday') || {}).value || '';
        var gEl = document.querySelector('#onb-gender .chip.on');
        Config.set('profile.name', name.trim());
        Config.set('profile.birthday', bday);
        Config.set('profile.gender', gEl ? gEl.getAttribute('data-v') : '');
        if (name.trim()) Config.set('chara.callMe', name.trim());
        return;
      }
      if (q.type === 'text') {
        var v = (document.getElementById('onb-text') || {}).value || '';
        Config.set(q.field, v.trim());
        return;
      }
      var picked = [];
      document.querySelectorAll('#onb-choices .chip.on').forEach(function (c) {
        picked.push(c.textContent);
      });
      Config.set(q.field, picked.join(', '));
    }
  };

  global.Onboarding = Onboarding;
})(window);
