/* Frameless-window controls for the desktop (Electron) shell.
   Browser / Android builds never see window.ryzaShell, so nothing shows. */
(function (global) {
  'use strict';
  if (!global.ryzaShell) return;

  function build() {
    var bar = document.getElementById('topbar');
    if (!bar || document.getElementById('winctl')) return;

    var ctl = document.createElement('div');
    ctl.id = 'winctl';
    var mk = function (id, glyph, title) {
      var b = document.createElement('button');
      b.type = 'button';
      b.id = id;
      b.className = 'icon-btn win-btn';
      b.textContent = glyph;
      b.title = title;
      ctl.appendChild(b);
      return b;
    };
    var t = function (k, d) { return (global.I18n && I18n.t) ? I18n.t(k) : d; };
    var min = mk('win-min', '—', t('shell.minimize', 'Minimize'));
    var cls = mk('win-close', '✕', t('shell.close', 'Close'));
    var settingsBtn = document.getElementById('btn-settings');
    if (settingsBtn && settingsBtn.parentNode === bar) {
      bar.insertBefore(ctl, settingsBtn.nextSibling);
    } else {
      bar.appendChild(ctl);
    }

    min.onclick = function () { global.ryzaShell.minimize(); };
    cls.onclick = function () { global.ryzaShell.close(); };
    /* Drag the frameless window by the HUD strip; buttons stay clickable. */
    document.body.classList.add('shell-electron');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})(window);
