/* Main controller: boots straight into the game (no login, no official
   backend), wires the talk loop, the RPG layer (game.js / quests.js) and
   the settings/chara forms. This module only orchestrates:
   state lives in Config/Game/Quests, rendering of the avatar in
   Avatar, sound in Sound, map in World. */
(function (global) {
  'use strict';

  var MEM_KEY = 'ryza.memory.v1';
  var SAVE_KEY = 'ryza.saves.v1';
  var HOME_STAGE = 'stage_01_001_04';       // ライザの家 — the safe place to sleep
  var TEXT_SPEEDS = [
    { v: 30, icon: 'text_speed_1x' },
    { v: 18, icon: 'text_speed_15x' },
    { v: 12, icon: 'text_speed_2x' },
    { v: 8,  icon: 'text_speed_3x' }
  ];
  var RPG_MODES = { chat: 1, story: 1, immersive: 1 };

  var App = {
    history: [],
    memory: [],
    audio: null,
    speaking: false,
    _typeTimer: null,
    _ringAlarm: null,
    _inTutorial: false,
    _lastText: '',
    _invBag: 'you',

    /* ------------------------------------------------------------- utils */
    toast: function (msg, isErr) {
      var host = document.getElementById('toast-host');
      var el = document.createElement('div');
      el.className = 'toast' + (isErr ? ' err' : '');
      el.textContent = msg;
      host.appendChild(el);
      setTimeout(function () {
        el.style.transition = 'opacity .3s'; el.style.opacity = '0';
        setTimeout(function () { el.remove(); }, 320);
      }, isErr ? 4200 : 2400);
    },

    buzz: function (ms) {
      if (!Config.section('app').vibration) return;
      if (navigator.vibrate) { try { navigator.vibrate(ms || 18); } catch (e) {} }
    },

    _ensureVoiceGraph: function () {
      if (App._voiceAnalyser || !App.audio) return;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        App._voiceCtx = new AC();
        var src = App._voiceCtx.createMediaElementSource(App.audio);
        var an = App._voiceCtx.createAnalyser();
        an.fftSize = 512;
        src.connect(an);
        an.connect(App._voiceCtx.destination);
        App._voiceAnalyser = an;
      } catch (e) {}
    },

    /* HTML escaper for the few places that build innerHTML around dynamic
       (LLM-authored) text — e.g. the quest title row in the status sheet. */
    esc: function (s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    /* Desktop UI zoom. #phone now fills the window (no more letterbox), so a
       small window must scale the fixed-px chrome instead of letting it
       crowd/overflow. CSS zoom scales the whole layout as one; pointer math
       divides it back out via Avatar._cssZoom, and the canvas backing store
       multiplies dpr by it (see avatar.js). Electron-only: phones keep zoom
       1 and rely on the fluid full-viewport layout. */
    /* How much of the screen the bottom log panel covers — the camera's
       plate clamp lets the window sink below the painted art by exactly
       this much (the panel hides the seam). FROZEN at the expanded height:
       tracking the collapsed strip re-solved the window on every toggle —
       the background zoomed and she slid ~180px down (worse than the seam
       it hid). At the current framing factors the hideout's collapsed
       exposure is a ~4% sliver right above the strip, dressed by the
       #stage bottom gradient. The hideout is the ONLY stage with a seam
       to hide: its art is split far_bg (ends at world 629) + floor
       (starts at −1064) with a 1693u gap; every other scene ships one
       full-coverage backdrop quad. */
    _syncPanelFrac: function () {
      if (!window.Avatar || Avatar._panelFrac) return;   // measure once
      var vh = window.innerHeight || 1;
      Avatar._panelFrac = Math.min(0.55, Math.min(340, Math.max(240, 0.34 * vh)) / vh);
    },

    /* companion-chat: switch the active character everywhere at once —
       engine (history/memory/affection), stage (renderer + pack), and the
       chrome that names her (log head, drawer, title, input placeholder). */
    setCharacter: function (id) {
      var card = Engine.switchCharacter(id) || Engine.active();
      App.applyCharacter(card);
      return Stage.loadPack(card).then(function () {
        App._applyPackBackground(card);
        App.renderMemory();
        return card;
      });
    },

    applyCharacter: function (card) {
      card = card || Engine.active();
      if (!card) return;
      var name = I18n.characterName();
      ['log-name', 'drawer-name', 'title-name'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.textContent = name;
      });
      var ts = document.getElementById('title-sub');
      if (ts) ts.textContent = card.description ? String(card.description).split(/[.!?]/)[0] : 'Companion Chat';
      var inp = document.getElementById('input');
      if (inp) inp.placeholder = I18n.tc('input.hint', 'Say something\u2026');
      var src = card.pfp || App._initialAvatar(name);
      ['log-avatar', 'drawer-avatar'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.src = src;
      });
      document.body.classList.toggle('phone-frame', Config.section('app').phoneFrame !== false);
    },

    /* A round initial-letter badge for characters without a portrait. */
    _initialAvatar: function (name) {
      var c = document.createElement('canvas');
      c.width = c.height = 96;
      var g = c.getContext('2d');
      if (!g) return 'assets/icons/chara.svg';
      var h = 0, i;
      for (i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
      g.fillStyle = 'hsl(' + (h % 360) + ' 45% 38%)';
      g.beginPath(); g.arc(48, 48, 48, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff';
      g.font = 'bold 44px system-ui, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(name || '?').trim().charAt(0).toUpperCase(), 48, 52);
      return c.toDataURL('image/png');
    },

    /* pack.background: a scene image behind a Live2D character (built-in
       packs only for now; the Spine rig draws its own scenes). */
    _applyPackBackground: function (card) {
      var stage = document.getElementById('stage');
      if (!stage) return;
      var pk = (card && card.pack) || {};
      var bg = pk.renderer === 'cubism' && pk.background && pk.source !== 'idb'
        ? (pk.path ? pk.path + '/' : '') + pk.background : '';
      stage.style.backgroundImage = bg ? 'url("' + bg + '")' : '';
      stage.classList.toggle('has-bg', !!bg);
    },

    /* companion-chat: the RPG surfaces (shop, world map, quests,
       inventory, stamina HUD, skins) were removed from the markup. Their code
       paths still exist in ryza's modules; this returns an inert stand-in for
       any of those elements so nothing has to know they are gone. */
    _el: function (id) {
      var el = document.getElementById(id);
      if (el) return el;
      var stub = App._stubs[id];
      if (!stub) {
        stub = App._stubs[id] = {
          id: id, style: {}, dataset: {}, textContent: '', innerHTML: '', value: '', hidden: true,
          classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return true; } },
          appendChild: function () {}, removeChild: function () {}, insertBefore: function () {},
          querySelector: function () { return null; }, querySelectorAll: function () { return []; },
          addEventListener: function () {}, getBoundingClientRect: function () { return { width: 0, height: 0, left: 0, top: 0 }; }
        };
      }
      return stub;
    },
    _stubs: {},

    _fitUi: function () {
      var el = document.getElementById('phone');
      if (!el) return;
      if (!window.ryzaShell) { el.style.zoom = ''; return; }
      /* MUST use innerWidth/innerHeight, never #phone.clientWidth: clientWidth
         is already divided by the active zoom, which feeds back and
         oscillates the scale between zoomed and 1.0 on every check. */
      var w = window.innerWidth || el.clientWidth;
      var h = window.innerHeight || el.clientHeight;
      if (!w || !h) return;
      var z = Math.min(w / 420, h / 860);
      z = Math.max(0.8, Math.min(1.25, z));
      if (Math.abs(z - (App._uiZoom || 1)) > 0.02) {
        App._uiZoom = z;
        el.style.zoom = String(z);
        if (window.Avatar && Avatar.resize) Stage.resize();
      }
    },

    /* -------------------------------------------------------------- boot */
    init: function () {
      I18n.setLang(Config.section('app').lang || 'zh');
      I18n.apply(document);
      var inpEl = document.getElementById('input');
      if (inpEl) inpEl.placeholder = I18n.tc('input.hint', inpEl.placeholder);
      document.getElementById('overlay-title').classList.remove('hidden');
      document.getElementById('btn-title-start').disabled = true;

      App.audio = new Audio();
      App.audio.preload = 'auto';
      App.audio.crossOrigin = 'anonymous';
      try { App.memory = JSON.parse(localStorage.getItem(MEM_KEY) || '[]'); }
      catch (e) { App.memory = []; }

      Game.load();
      Quests.ensure();
      /* companion-chat: renderers of removed views become no-ops */
      ['Quests', 'Welcome'].forEach(function (m) {
        var M = window[m];
        if (!M || !M.render || M._trimmed) return;
        var orig = M.render;
        M.render = function (el) { if (!el || App._stubs[el.id] === el) return; return orig.apply(M, arguments); };
        M._trimmed = true;
      });
      try { if (window.Memory) Memory.load(); } catch (e) {}

      App._bindChrome();
      App._bindTalk();
      App._bindOverlays();
      Game.on(function () { App.refreshHud(); App._syncOpenViews(); });

      Promise.all([Config.hydrate(), World.init(), VoiceBank.load(), Sound.init(), Engine.init()]).then(function () {
        Sound.setCatalog(Object.keys(World.scenes || {}));
        var st = Config.section('state');
        Sound.setPlace(st.stage, st.tod, World.backgroundFor(st.stage));
        App._tickDay();
        App._syncPanelFrac();
        Avatar.init(function () {
          App._loadSceneFor(st.stage, st.tod);
          App._tickTime();          // adopt the wall/flow clock once the scene is up
          /* companion-chat: the active character decides which renderer draws
             the avatar (Spine Ryza, a Live2D pack, or nothing). */
          App.setCharacter(Characters.activeId());
        });
        setInterval(App._tickTime, 30000);
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) App._tickTime();
        });
        App.updateHud();
        App.renderWorld();
        Alarm.load(); Alarm.render(document.getElementById('alarm-list'), App.playFile);
        Alarm.start(App._onAlarm);
        Quests.render(App._el('quest-list'), {});
        App.renderSkins();
        App.buildSettings();
        App.buildCharaForm();
        App.renderMemory();
        Welcome.render(App._el('welcome-body'));
        if (window.Fx) Fx.init();
        App._fitUi();
        window.addEventListener('resize', function () {
          App._fitUi();
          App._syncPanelFrac();
        });

        Onboarding.showTitle(function () {
          /* onboarding is one identity step now; she greets right after */
          if (!Onboarding.isDone()) Onboarding.start(function () { App.enterGame(false); });
          else App.enterGame(false);
        });
      }).catch(function (e) {
        App.toast('Asset index failed: ' + e.message, true);
      });
    },

    enterGame: function (fromOnboard) {
      var bar = document.getElementById('input-bar');
      if (bar) bar.classList.remove('spot');
      var st = Config.section('state');
      Sound.setPlace(st.stage, st.tod, World.backgroundFor(st.stage));
      Sound.setRoute('talk');
      App._showDisclosure();
      if (fromOnboard) return;
      App.greet();
    },

    _tickDay: function () {
      var st = Config.section('state');
      var today = new Date().toDateString();
      if (st.lastDayDate && st.lastDayDate !== today) {
        Config.set('state.day', (st.day || 1) + 1);
      }
      if (st.lastDayDate !== today) Config.set('state.lastDayDate', today);
    },



    _showDisclosure: function () {
      if (App._disclosed) return;
      App._disclosed = true;
      App.toast(I18n.t('toast.ai'));
    },

    _loadSceneFor: function (stageId, tod) {
      var curtain = document.getElementById('scene-curtain');
      if (curtain) curtain.classList.add('on');
      var bg = World.backgroundFor(stageId);
      Avatar.loadScene(bg, tod, function (err) {
        if (err) { /* stage without a built scene is fine — bg stays dark */ }
        setTimeout(function () {
          if (curtain) curtain.classList.remove('on');
        }, 280);
        /* Sit/stand is a choice that only exists on stages whose scene lists
           both postures. Walking away resets it to the source default
           (standing), so the next visit to that stage starts on her feet. */
        if (window.Avatar && !Avatar.supportsBothPostures() &&
            Config.section('state').posture !== 'posture_standing') {
          Config.set('state.posture', 'posture_standing');
        }
        App.updateHud();   /* posture chip only shows on dual-posture stages */
      });
    },

    /* touch_ripple_overlay (source module): a light ring where the avatar
       was tapped, under the reaction voice. */
    _ripple: function (x, y) {
      var layer = document.getElementById('ripple-layer');
      if (!layer) return;
      var el = document.createElement('div');
      el.className = 'tap-ripple';
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      layer.appendChild(el);
      setTimeout(function () { if (el.remove) el.remove(); }, 720);
    },

    /* ------------------------------------------------------------ chrome */
    _bindChrome: function () {
      var drawer = document.getElementById('drawer');
      var scrim = document.getElementById('scrim');
      var open = function (on) {
        drawer.classList.toggle('open', on);
        scrim.classList.toggle('on', on);
      };
      App._el('btn-menu').onclick = function () { open(true); };
      scrim.onclick = function () { open(false); };

      document.querySelectorAll('.drawer-list li').forEach(function (li) {
        li.onclick = function () {
          var act = li.getAttribute('data-action');
          if (act === 'newTalk') { open(false); App._confirmNewTalk(); return; }
          if (act === 'lang') { open(false); App._openLangSheet(); return; }
          document.querySelectorAll('.drawer-list li').forEach(function (x) {
            x.classList.remove('active');
          });
          li.classList.add('active');
          App.showView(li.getAttribute('data-view'));
          open(false);
        };
      });

      var st = Config.section('state');
      document.querySelectorAll('.mode-pill[data-mode]').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-mode') === st.mode);
        b.onclick = function () {
          var prevMode = st.mode;
          Config.set('state.mode', b.getAttribute('data-mode'));
          document.querySelectorAll('.mode-pill[data-mode]').forEach(function (x) {
            x.classList.toggle('active', x === b);
          });
          App.updateHud();
          if (window.Avatar && Avatar.resize) Stage.resize();
          if (window.Avatar && Avatar.onModeChange &&
              b.getAttribute('data-mode') !== prevMode) {
            Avatar.onModeChange();
          }
          App._el('sheet-mode').classList.add('hidden');
        };
      });
      document.querySelectorAll('.mode-pill[data-style]').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-style') === st.style);
        b.onclick = function () {
          Config.set('state.style', b.getAttribute('data-style'));
          document.querySelectorAll('.mode-pill[data-style]').forEach(function (x) {
            x.classList.toggle('active', x === b);
          });
          if (App._syncVoicePill) App._syncVoicePill();
        };
      });

      /* Official voice/text pill: it toggles state.style
         (voice ↔ text), exactly like the shipped screenshots — orange speaker
         「ボイス」 while she talks, dark document 「テキスト」 in text mode.
         The master mute stays where it always was: settings → app.voice. */
      var vbtn = document.getElementById('btn-voice');
      var vcanvas = document.getElementById('lottie-voice');
      var vsync = function () {
        var a = Config.section('app'), st = Config.section('state');
        var talking = !!a.voice && st.style === 'voice';
        vbtn.classList.toggle('on', talking);
        vbtn.classList.toggle('off', !talking);
        var lab = document.getElementById('voice-pill-label');
        if (lab) lab.textContent = I18n.t(talking ? 'voice.on' : 'voice.off');
        if (vcanvas) vcanvas.classList.toggle('hidden', !talking);
        var tico = document.getElementById('voice-text-ico');
        if (tico) tico.classList.toggle('hidden', talking);
        if (window.Fx) Fx.setVoice(!!a.voice);
      };
      vbtn.onclick = function () {
        var st = Config.section('state');
        Config.set('state.style', st.style === 'voice' ? 'text' : 'voice');
        vsync();
        document.querySelectorAll('.mode-pill[data-style]').forEach(function (x) {
          x.classList.toggle('active', x.getAttribute('data-style') === st.style);
        });
        if (st.style !== 'voice' && App.audio) App.audio.pause();
      };
      App._syncVoicePill = vsync;
      vsync();

      /* » — the official right side menu. Each row jumps to the screen the
         source names: shop/skin/save/fullscreen/chara-toggle/settings/map. */
      var side = document.getElementById('side-menu');
      var sideScrim = App._el('side-scrim');
      /* the button shows the grid glyph closed and an X while open; the scrim
         is a sibling (not ::before inside the menu) so an outside tap closes */
      var setSide = function (on) {
        side.classList.toggle('open', on);
        sideScrim.classList.toggle('open', on);
        App._el('btn-expand').classList.toggle('open', on);
      };
      var sideClose = function (fn) {
        return function () { setSide(false); fn(); };
      };
      App._el('btn-expand').onclick = function () { setSide(!side.classList.contains('open')); };
      sideScrim.onclick = function () { setSide(false); };
      document.addEventListener('click', function (e) {
        if (!side.classList.contains('open')) return;
        if (e.target.closest && e.target.closest('#side-menu,#btn-expand')) return;
        setSide(false);
      }, true);
      App._el('sm-save').onclick = sideClose(function () {
        /* the save slots live at the bottom of the player-profile form */
        App.showView('chara');
      });
      App._el('sm-full').onclick = sideClose(function () { App._toggleFullscreen(); });
      App._el('sm-chara').onclick = sideClose(function () { App._toggleChara(); });

      /* Posture button — visible only on stages whose scene lists both sitting
         and standing midgroundPostures (e.g. stage_01_002_01). */
      var postureBtn = App._el('btn-posture');
      if (postureBtn) postureBtn.onclick = function () {
        App.setPosture(Avatar.postureKey() === 'posture_standing'
          ? 'posture_sitting' : 'posture_standing');
      };
      var skinBtn = document.getElementById('btn-chara-skin');
      if (skinBtn) skinBtn.onclick = function () { App.showView('skin'); };
      /* place / tod / mode / map now live inside the mode sheet (the » row
         of chips under the pills) */
      var hudMode = document.getElementById('hud-mode');
      if (hudMode) hudMode.onclick = function () { /* current-mode label */ };
      App._el('hud-place').onclick = function () { App.showView('world'); };
      App._el('btn-map').onclick = function () { App.showView('world'); };
      App._el('btn-quest-sheet').onclick = function () { App.showView('quest'); };
      /* ⇧ — official behaviour: collapse the conversation area down to the
         input row (the whole stage opens up), tap again to bring it back.
         The running transcript (talk_conversation_log) opens by tapping the
         line itself. */
      var logT = document.getElementById('btn-log-toggle');
      if (logT) logT.onclick = function () {
        var phone = document.getElementById('phone');
        var open = phone.classList.toggle('panel-collapsed');
        var arrow = document.querySelector('#btn-log-toggle img');
        if (arrow) arrow.style.transform = open ? 'rotate(180deg)' : '';
        /* no camera re-solve — the window is frozen (see _syncPanelFrac) */
      };
      var spd = document.getElementById('btn-speed');
      if (spd) spd.onclick = function () { App._cycleTextSpeed(); };
      var nt = document.getElementById('btn-newtalk');
      if (nt) nt.onclick = function () { App._confirmNewTalk(); };
      /* tapping her name/subtitle opens the mode sheet (mode lives there now) */
      var logHead = document.getElementById('log-head');
      if (logHead) logHead.onclick = function () {
        App._el('sheet-mode').classList.toggle('hidden');
      };
      ['hud-stamina', 'hud-money', 'hud-level'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.onclick = function () { App.renderStatus(); App._el('sheet-status').classList.remove('hidden'); };
      });
      App._el('btn-bag').onclick = function () {
        App.renderInv();
        App._el('sheet-inv').classList.toggle('hidden');
      };
      document.querySelectorAll('#inv-tabs [data-bag]').forEach(function (b) {
        b.onclick = function () {
          App._invBag = b.getAttribute('data-bag');
          document.querySelectorAll('#inv-tabs [data-bag]').forEach(function (x) {
            x.classList.toggle('active', x === b);
          });
          App.renderInv();
        };
      });
      App._el('btn-tod').onclick = function () {
        var next = World.nextTod(Config.section('state').tod);
        App._setTod(next);
        Config.set('state.todManualUntil', Date.now() + 30 * 60000);  // don't auto-clobber for 30 min
        if ((Config.section('app').timeMode) === 'flow') {
          Config.set('state.gameHour', World.todStartHour(next));
          Config.set('state.gameClockAt', Date.now());
        }
      };
      App._el('world-area').onchange = function (e) {
        World.jumpArea(e.target.value, Config.section('state').stage, App.gotoStage);
      };
      App._el('btn-quest-new').onclick = function () {
        var hasKey = !!(Config.section('llm').apiKey);
        if (hasKey) App.toast(I18n.t('toast.questGen'));
        Quests.generate(hasKey).then(function (q) {
          App.toast(I18n.t('quest.newOk') + '「' + q.title + '」');
          Quests.render(App._el('quest-list'), {});
        });
      };
      App._el('btn-alarm-new').onclick = function () { App._newAlarm(); };
      /* area_bottom_sheet.dart: who is around at the level you're looking at. */
      var peopleBtn = document.getElementById('btn-world-people');
      if (peopleBtn) peopleBtn.onclick = function () { App._showPeople(); };
      App._el('btn-memory-clear').onclick = function () {
        Dialog.confirm(I18n.t('memory.clearLogAsk'), { danger: true }).then(function (ok) {
          if (!ok) return;
          App.memory = []; App.saveMemory(); App.renderMemory();
        });
      };
      var addBtn = document.getElementById('btn-memory-add');
      if (addBtn) addBtn.onclick = function () { App._editMemory(null); };
      var flushBtn = document.getElementById('btn-memory-flush');
      if (flushBtn) flushBtn.onclick = function () {
        if (!window.Memory) return;
        Memory.flushNow().then(function () {
          App.toast(I18n.t('toast.memFlushed'));
          App.renderMemory();
        });
      };
      App._el('btn-settings-reset').onclick = function () {
        Dialog.confirm(I18n.tc('settings.resetConfirm', 'Reset all settings to defaults?'), { danger: true }).then(function (ok) {
          if (!ok) return;
          Config.reset(); App.buildSettings(); App.buildCharaForm();
          App.toast(I18n.t('toast.saved'));
        });
      };
    },

    showView: function (name) {
      document.querySelectorAll('.view').forEach(function (v) {
        v.classList.toggle('active', v.id === 'view-' + name);
      });
      document.getElementById('sheet-mode').classList.add('hidden');
      App._el('sheet-inv').classList.add('hidden');
      App._el('sheet-status').classList.add('hidden');
      var npcSheet = App._el('sheet-npc');
      if (npcSheet) npcSheet.classList.add('hidden');
      var langSheet = document.getElementById('sheet-lang');
      if (langSheet) langSheet.classList.add('hidden');
      if (name === 'world') {
        Welcome.mark('map');
        Sound.setRoute('world');
        App.renderWorld();
      } else {
        Sound.setRoute('talk');
      }
      if (name === 'memory') App.renderMemory();
      if (name === 'skin') { Welcome.mark('skin'); App.renderSkins(); }
      if (name === 'welcome') Welcome.render(App._el('welcome-body'));
      if (name === 'alarm') Welcome.mark('alarm');
      if (name === 'quest') Quests.render(App._el('quest-list'), {});
    },

    _syncOpenViews: function () {
      var q = document.getElementById('view-quest');
      if (q && q.classList.contains('active')) {
        Quests.render(App._el('quest-list'), {});
      }
      if (!App._el('sheet-status').classList.contains('hidden')) App.renderStatus();
      if (!App._el('sheet-inv').classList.contains('hidden')) App.renderInv();
      App.refreshHud();
    },

    /* Single write path for the sit/stand choice: store it, cross-fade the
       skeleton swap (the skin_change SE + veil are the source's own costume
       feedback), and let Stage.resize() re-solve the camera for the new
       posture. Only meaningful on the dual-posture stage. */
    setPosture: function (posture) {
      if (posture !== 'posture_standing' && posture !== 'posture_sitting') return;
      Config.set('state.posture', posture);
      var veil = document.getElementById('skin-veil');
      if (veil) veil.classList.add('veil-on');
      if (window.Sound) Sound.se('skin_change');
      Avatar.loadSkin(Config.section('state').skin, function () {
        setTimeout(function () { if (veil) veil.classList.remove('veil-on'); }, 260);
        App.updateHud();
      });
    },

    updateHud: function () {
      var st = Config.section('state');
      /* the same localized names the mode sheet shows (source key family
         conversationMode.*) — this used to be a hardcoded Japanese map, so the
         HUD chip stayed 雑談/物語 even in an English UI */
      document.getElementById('hud-mode').textContent = I18n.t('mode.' + st.mode) || st.mode;
      var place = World.find(st.stage);
      App._el('hud-place').textContent =
        place ? World.placeLabel(st.stage, place.stage) : st.stage;
      document.getElementById('hud-tod').textContent = World.todLabel(st.tod);
      var postureBtn = App._el('btn-posture');
      if (postureBtn) {
        var both = window.Avatar && Avatar.supportsBothPostures && Avatar.supportsBothPostures();
        postureBtn.classList.toggle('hidden', !both);
        /* ACTION semantics, not state: the chip is a button, so it names what
           the tap will do. Labelling it with the current posture (standing →
           「立つ」) read as "pressing this makes her stand" while she was
           already standing — the reported 「按站立却变坐」 confusion. */
        postureBtn.textContent = both
          ? (Avatar.postureKey() === 'posture_standing'
              ? I18n.t('posture.sit') : I18n.t('posture.stand'))
          : '';
      }
      var todBtn = App._el('btn-tod-label');
      if (todBtn) todBtn.textContent = World.todLabel(st.tod);
      var dd = document.getElementById('drawer-day');
      if (dd) dd.textContent = I18n.tf('drawer.days', 'Day {n} together', { n: (st.day || 1) });
      /* log panel identity line — official shows her name + the current
         mode's description under the avatar (e.g. ASMR: 耳元で震える声で) */
      var ln = document.getElementById('log-name');
      if (ln) ln.textContent = I18n.characterName();
      var ls = document.getElementById('log-sub');
      if (ls) ls.textContent = I18n.t('mode.sub.' + st.mode) || I18n.t('mode.' + st.mode) || st.mode;
      App._syncSpeedBtn();
      App.refreshHud();
    },

    /* RPG strip: apples (StaminaAppleRow) + coin + level. */
    refreshHud: function () {
      var chip = App._el('hud-stamina');
      if (chip) {
        var a = Game.apples();
        var html = '';
        for (var i = 0; i < a.slots; i++) {
          html += '<img alt="" src="assets/icons/' +
            (i < a.filled ? 'stamina_apple_filled' : 'stamina_apple_empty') + '.svg">';
        }
        html += ' <b>' + (Game.cheat() ? '∞' : Game.s.stamina) + '</b>';
        chip.innerHTML = html;
      }
      var m = App._el('hud-money-n');
      /* official purse pill groups thousands: 43,000 */
      if (m) m.textContent = Game.cheat() ? '∞'
        : String(Game.s.money).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      var lv = App._el('hud-level');
      if (lv) lv.textContent = 'Lv' + Game.level();
    },

    gotoStage: function (stageId) {
      var st = Config.section('state');
      Config.set('state.stage', stageId);
      App._loadSceneFor(stageId, st.tod);
      Sound.setPlace(stageId, st.tod, World.backgroundFor(stageId));
      Sound.setRoute('talk');
      App.renderWorld();
      App.updateHud();
      var place = World.find(stageId);
      if (place) App.toast(I18n.tf('talk.mapMove', 'Arrived: {name}', {
        name: World.placeLabel(stageId, place.stage)
      }));
      var npcs = World.npcsAt(stageId, st.day || 1);
      var names = Game.meetCharas(npcs, st.day);
      if (names.length) Game.remember('Met ' + names.join(', ') + '.');
      Quests.progressEvent('explore');
      App.showView('talk');
    },

    _setTod: function (tod) {
      if (!World.isTod(tod)) return;
      var s = Config.section('state');
      var prev = s.tod;
      if (tod === prev) return;
      Config.set('state.tod', tod);
      if (prev === 'ngt' && tod === 'mor' && s.stage === HOME_STAGE) {
        Game.refill();
        Game.remember('Slept soundly at home.');
        App.toast(I18n.t('stamina.slept'));
      }
      App._loadSceneFor(s.stage, tod);
      Sound.setPlace(s.stage, tod, World.backgroundFor(s.stage));
      App.updateHud();
    },

    /* Time passage. 'real' mirrors the official AppServerClock (the scene
       follows the device wall clock); 'flow' runs an in-game clock that ticks
       at app.flowSpeed in-game minutes per real minute and that the LLM can
       also push (see _applySceneDelta); 'manual' leaves it to the 🌤 button.
       A manual tap suppresses auto-sync briefly so a hand-set time isn't
       immediately clobbered. */
    _tickTime: function () {
      if (!window.World || !window.Config) return;
      var app = Config.section('app'), s = Config.section('state');
      var mode = app.timeMode || 'real';
      if (mode === 'manual') return;
      var now = Date.now();
      if ((s.todManualUntil | 0) > now) return;
      var target;
      if (mode === 'real') {
        target = World.hourToTod(new Date().getHours());
      } else {
        var nh = World.flowHour(s.gameHour, s.gameClockAt, now, app.flowSpeed);
        Config.set('state.gameHour', nh);
        Config.set('state.gameClockAt', now);
        target = World.hourToTod(nh);
      }
      if (target && target !== s.tod) App._setTod(target);
    },

    /* The clock line fed to the LLM every turn: day count + current band +
       hour. Official scene.time_bucket is a FACT pushed TO marionette, not a
       command; only local flow mode teaches/accepts a clock write. */
    _clockBlock: function (st) {
      var mode = (Config.section('app').timeMode) || 'real';
      var hour = mode === 'flow' ? Math.floor(Number(st.gameHour) || 12)
               : mode === 'manual' ? World.todStartHour(st.tod)
               : new Date().getHours();
      return '## 現在時刻\n- 同伴 ' + (st.day || 1) + '日目／' +
        World.todLabel(st.tod) + '（約' + hour + '時）';
    },

    /* Talk → map / time of day / sleep. Source: detectEntryMapMove,
       scene.current_stage, scene.time_bucket. Game.applyDelta does not
       know World, so App applies this after the numeric reducer. */
    _applySceneDelta: function (d) {
      if (!d || typeof d !== 'object' || !window.World) return;
      var scene = (d.scene && typeof d.scene === 'object') ? d.scene : {};
      var sleep = d.sleep === true || d.sleep === 'true' || d.sleep === 1 ||
                  scene.sleep === true;
      if (sleep) {
        App._sleepHome();
        return;
      }
      var raw = d.current_stage || d.stage || d.map_move || scene.current_stage;
      if (d.map_moved && !raw) raw = scene.current_stage;
      var s = Config.section('state');
      var fromStage = s.stage, fromTod = s.tod;
      var dest = fromStage;
      if (raw != null && String(raw).trim()) {
        var id = World.resolveStage(String(raw).trim());
        if (id) {
          if (World.locked(World.areaOf(id))) App.toast(I18n.t('world.lockedToast'), true);
          else dest = id;
        }
      }
      /* Official: time_bucket is pushed TO the model (AppServerClock), never
         written back. real/manual ignore LLM tod/time_advance/game_hour.
         flow is the local extension where the LLM may drive one shared clock. */
      var nextTod = fromTod;
      if (World.llmDrivesClock()) {
        var tod = d.tod || d.time_bucket || scene.time_bucket;
        var gh = Number(d.game_hour != null ? d.game_hour : NaN);
        var adv = Number(d.time_advance != null ? d.time_advance :
                         (d.advance_hours != null ? d.advance_hours : NaN));
        var cur = Number(s.gameHour); if (!(cur >= 0 && cur < 24)) cur = 12;
        var nowMs = Date.now();
        if (!isNaN(gh)) cur = ((gh % 24) + 24) % 24;
        else if (!isNaN(adv)) cur = ((cur + adv) % 24 + 24) % 24;
        else if (tod && World.isTod(tod) && tod !== fromTod) cur = World.todStartHour(tod);
        else cur = World.flowHour(cur, s.gameClockAt, nowMs, Config.section('app').flowSpeed);
        Config.set('state.gameHour', cur);
        Config.set('state.gameClockAt', nowMs);
        nextTod = World.hourToTod(cur);
      }
      if (fromTod === 'ngt' && nextTod === 'mor' && dest === HOME_STAGE) {
        Game.refill();
        Game.remember('Slept soundly at home.');
        App.toast(I18n.t('stamina.slept'));
      }
      if (nextTod !== fromTod) Config.set('state.tod', nextTod);
      if (dest !== fromStage) App.gotoStage(dest);
      else if (nextTod !== fromTod) {
        App._loadSceneFor(fromStage, nextTod);
        Sound.setPlace(fromStage, nextTod, World.backgroundFor(fromStage));
        App.updateHud();
      }
    },

    renderWorld: function () {
      if (!document.getElementById('view-world')) return;
      var st = Config.section('state');
      var sel = document.getElementById('world-area');
      World.fillAreaSelect(sel, st.stage);
      World.render(document.getElementById('world-fields'),
                   document.getElementById('world-npcs'),
                   st.stage, App.gotoStage);
    },

    /* source: world_map/widgets/area_bottom_sheet.dart + character_avatar */
    _showPeople: function () {
      var st = Config.section('state');
      var day = st.day || 1;
      var list = [], title;
      if (World.mapLevel === 'stages' && World.mapFieldId) {
        list = World.npcsInField(World.mapFieldId, day);
        var pack = World.findField(World.mapFieldId);
        title = pack ? World.placeLabel(pack.field.id, pack.field.name) : I18n.t('world.here');
        list.forEach(function (n) { if (!n.where) n.where = n.stage; });
      } else if (World.mapLevel === 'fields' && World.mapAreaId) {
        list = World.npcsInArea(World.mapAreaId, day);
        var area = World.areas().filter(function (a) { return a.id === World.mapAreaId; })[0];
        title = area ? World.placeLabel(area.id, area.name) : I18n.t('world.areas');
        list.forEach(function (n) { n.where = (n.where || []).join(' / '); });
      } else {
        list = World.npcsAt(st.stage, day);
        var place = World.find(st.stage);
        title = place ? World.placeLabel(st.stage, place.stage) : I18n.t('world.here');
      }
      var sheet = App._el('sheet-npc');
      var root = document.getElementById('npc-sheet-list');
      var head = document.getElementById('npc-sheet-title');
      if (!sheet || !root) return;
      head.textContent = I18n.t('world.peopleOf') + '：' + title;
      root.innerHTML = '';
      if (!list.length) {
        root.innerHTML = '<div class="empty">' + I18n.t('world.empty') + '</div>';
      }
      list.forEach(function (n) {
        var row = document.createElement('div');
        row.className = 'npc-sheet-row';
        var img = document.createElement('img');
        img.src = World.iconFor(n.id);
        img.onerror = function () { img.style.visibility = 'hidden'; };
        var box = document.createElement('div');
        box.className = 'npc-sheet-box';
        var nm = document.createElement('div');
        nm.className = 'npc-name';
        var seen = Game.s.met_charas.indexOf(n.id) !== -1;
        nm.textContent = n.name + (seen ? '' : ' ？');
        var nt = document.createElement('div');
        nt.className = 'npc-note';
        nt.textContent = [n.note, n.where].filter(Boolean).join(' · ');
        box.appendChild(nm); box.appendChild(nt);
        row.appendChild(img); row.appendChild(box);
        row.onclick = function () {
          /* 会ったことのない人には "?" を残す — meeting happens by going there */
          App.toast(n.name + (n.note ? '：' + n.note : ''));
        };
        root.appendChild(row);
      });
      sheet.classList.remove('hidden');
    },

    /* -------------------------------------------------------------- talk */
    _bindTalk: function () {
      var input = document.getElementById('input');
      var send = document.getElementById('btn-send');
      /* play glyph while empty, arrow-up once there is text (real app) */
      var bar = document.getElementById('input-bar');
      var syncSend = function () { bar.classList.toggle('has-text', !!input.value.trim()); };
      input.oninput = syncSend;
      var go = function () {
        var text = input.value.trim();
        if (!text || App.speaking) return;
        input.value = ''; syncSend();
        App.say(text);
      };
      send.onclick = go;
      input.onkeydown = function (e) { if (e.key === 'Enter') go(); };
      App._el('avatar-hit').onclick = function (ev) {
        var rect = ev.target.getBoundingClientRect();
        /* rect is in viewport px; layout px need the zoom divided out
           (identity when zoom is 1 — phones/browser). */
        var z = (window.Avatar && Avatar._cssZoom) ? Avatar._cssZoom(ev.target) : 1;
        var x = (ev.clientX - rect.left) / z, y = (ev.clientY - rect.top) / z;
        var part = Stage.hitPartAt(x, y);
        if (!part) return;   /* miss = no ripple, no SE, no reaction */
        App._ripple(x, y);
        var overlay = Stage.poke(part);
        App.buzz();
        if (window.Sound) {
          Sound.se('touch_start');
          if (overlay) Sound.tapVoice(overlay);
        }
      };
      var retry = document.getElementById('btn-retry');
      if (retry) retry.onclick = function () {
        App._el('retry-bar').classList.add('hidden');
        if (App._lastText) App.say(App._lastText);
      };
    },

    _bindOverlays: function () {
      App._el('onb-next').onclick = function () { Onboarding.next(); };
      App._el('onb-skip').onclick = function () { Onboarding.skip(); };
      App._el('ring-dismiss').onclick = function () { App._dismissAlarm(); };
      App._el('ring-snooze').onclick = function () { App._snoozeAlarm(); };
      App._el('qc-ok').onclick = function () {
        App._el('overlay-quest-clear').classList.add('hidden');
        if (Quests.pendingAdvance()) {
          Quests.takeNext();
          Quests.render(App._el('quest-list'), {});
          Welcome.mark('quest');
          var st = Config.section('state');
          var clip = VoiceBank.pick('wellDone', st.mode === 'asmr' ? 'whisper' : 'normal',
                                    Alarm.todForHour(new Date().getHours()));
          setTimeout(function () { clip && App.playFile(clip); }, 500);
        }
      };
      App._el('faint-cancel').onclick = function () {
        App._el('overlay-faint').classList.add('hidden');
      };
      App._el('faint-sleep').onclick = function () { App._sleepHome(); };
      App._el('faint-cheat').onclick = function () {
        if (!Game.cheat()) {
          Config.set('app.cheat', true);
          App.toast(I18n.t('cheat.on'));
        }
        Game.refill();
        App._el('overlay-faint').classList.add('hidden');
        App.buildSettings();
      };
      document.querySelectorAll('.sheet-handle').forEach(function (h) {
        h.onclick = function () {
          var sheet = h.parentElement;
          if (sheet) sheet.classList.add('hidden');
        };
      });
    },

    _showFaint: function () {
      var ov = App._el('overlay-faint');
      var cheatBtn = App._el('faint-cheat');
      if (cheatBtn) cheatBtn.classList.toggle('hidden', !Game.cheat());
      if (ov) ov.classList.remove('hidden');
      Stage.setEmotion('crying', 'deny');
    },

    _sleepHome: function () {
      var st = Config.section('state');
      var tod = st.tod;
      Config.set('state.stage', HOME_STAGE);
      /* flow: sleeping skips the in-game clock to morning. real/manual keep
         the current band (real stays on the wall clock; official sleep does
         not jump AppServerClock). Stamina refill is independent of lighting. */
      if (World.llmDrivesClock()) {
        tod = 'mor';
        Config.set('state.tod', 'mor');
        Config.set('state.gameHour', World.todStartHour('mor'));
        Config.set('state.gameClockAt', Date.now());
      }
      App._loadSceneFor(HOME_STAGE, tod);
      Sound.setPlace(HOME_STAGE, tod, World.backgroundFor(HOME_STAGE));
      Game.refill();
      Game.remember('Slept soundly at home.');
      App._el('overlay-faint').classList.add('hidden');
      App.showView('talk');
      App.toast(I18n.t('stamina.slept'));
      App.updateHud();
    },

    _onSailed: function () {
      Game.remember('Set sail from Kurken Island!');
      App.toast(I18n.t('toast.sailed'));
      App.showView('world');
      App.renderWorld();
    },

    /* ------------------------------------------------------- status sheet */
    renderStatus: function () {
      var root = App._el('status-body');
      if (!root) return;
      root.innerHTML = '';
      var a = Game.apples();
      var appleHtml = '';
      for (var i = 0; i < a.slots; i++) {
        appleHtml += '<img class="apple-mini" alt="" src="assets/icons/' +
          (i < a.filled ? 'stamina_apple_filled' : 'stamina_apple_empty') + '.svg">';
      }
      var e = Game.expIntoLevel();
      function row(k, v) {
        var d = document.createElement('div');
        d.className = 'st-row';
        var kk = document.createElement('span'); kk.className = 'st-k'; kk.textContent = k;
        var vv = document.createElement('span'); vv.className = 'st-v'; vv.innerHTML = v;
        d.appendChild(kk); d.appendChild(vv);
        root.appendChild(d);
        return d;
      }
      function sect(t) {
        var d = document.createElement('div');
        d.className = 'st-sect'; d.textContent = t;
        root.appendChild(d);
      }
      sect(I18n.t('st.level') + ' ' + Game.level());
      row(I18n.tc('stamina', 'Stamina'), appleHtml + ' <b>' + (Game.cheat() ? '∞' : Game.s.stamina + '/' + Game.max()) + '</b>');
      row(I18n.t('st.exp'), e.into + ' / ' + e.span + '（' + Game.s.exp_total + '）');
      row('G', Game.cheat() ? '∞' : String(Game.s.money));
      var q = Quests.active();
      if (q) row(I18n.t('quest.goal'),
        '「' + App.esc(q.title) + '」 ' + (q.step | 0) + '/' + q.need);
      row(I18n.t('st.met'), String(Game.s.met_charas.length));
      if (Game.s.met_charas.length && window.World && World.npcs) {
        var names = Game.s.met_charas.slice(-12).reverse()
          .map(function (id) { return World.npcName(id); }).join('、');
        var nr = document.createElement('div');
        nr.className = 'st-mem';
        nr.textContent = names;
        root.appendChild(nr);
      }
      row(I18n.t('quest.ship'), Game.flag('ship_parts', 0) + ' / 4' + (Game.s.sailed ? ' ⛵' : ''));

      sect(I18n.t('st.memory'));
      var mems = Game.s.memory.slice(-12).reverse();
      if (!mems.length) {
        var e2 = document.createElement('div');
        e2.className = 'empty'; e2.textContent = I18n.t('memory.empty');
        root.appendChild(e2);
      }
      mems.forEach(function (m) {
        var d = document.createElement('div');
        d.className = 'st-mem'; d.textContent = m.text;
        root.appendChild(d);
      });
    },

    /* ------------------------------------------------------ inventory sheet */
    renderInv: function () {
      var which = App._invBag;
      var root = App._el('inv-list');
      root.innerHTML = '';
      var list = Game.bagList(which);
      if (!list.length) {
        root.innerHTML = '<div class="empty">' + I18n.t('inv.empty') + '</div>';
      }
      list.forEach(function (it) {
        var row = document.createElement('div');
        row.className = 'inv-row';
        row.innerHTML = '<span class="inv-name"></span><span class="inv-n"></span>';
        var name = (Game.ITEMS[it.id] && Game.ITEMS[it.id].name) || it.id;
        row.querySelector('.inv-name').textContent = name;
        row.querySelector('.inv-n').textContent = '×' + (it.count || 1);
        row.onclick = function () {
          var inp = document.getElementById('input');
          inp.value = ((inp.value || '') + ' ' + name).trim();
          App._el('sheet-inv').classList.add('hidden');
          App.showView('talk');
          inp.focus();
        };
        root.appendChild(row);
      });
      var cap = document.getElementById('inv-cap');
      if (cap) cap.textContent = I18n.t('inv.cap')
        .replace('{u}', String(Game.bagUsed(which)))
        .replace('{c}', String(Game.bagCap(which)));
      var up = App._el('btn-bag-up');
      if (up) {
        var order = Game.BAG_ORDER;
        var cur = which === 'ryza' ? Game.s.bagRyza : Game.s.bagYou;
        var idx = order.indexOf(cur);
        var next = idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null;
        var price = next ? (Game.BAG_UPGRADE_COST[next] || 0) : 0;
        up.classList.toggle('hidden', !next);
        if (next) {
          up.textContent = I18n.t('inv.upgrade').replace('{p}', String(price));
          up.onclick = function () {
            if (Game.upgradeBag(which)) {
              App.toast(I18n.t('inv.upgraded'));
              if (window.Sound) Sound.se('quest_clear');
            } else {
              App.toast(I18n.t('inv.tooSmall'), true);
            }
            App.renderInv();
          };
        }
      }
    },

    /* Scene facts every talk mode gets (source marionette_injection:
       scene.current_stage / time_bucket / cast). Location is on screen
       even in ASMR — without this block the model cannot name a place
       or emit current_stage. */
    _sceneContext: function () {
      var st = Config.section('state');
      var parts = [];
      if (window.World && World.promptBlock) parts.push(World.promptBlock(st));
      parts.push(App._peopleBlock(st));
      if (window.World) parts.push(App._clockBlock(st));
      return parts.filter(Boolean).join('\n\n');
    },

    /* Numeric RPG (stamina / bags / quests) — chat/story/immersive only.
       ASMR/text still receive _sceneContext so they can travel/sleep. */
    _rpgContext: function () {
      var st = Config.section('state');
      if (!RPG_MODES[st.mode]) return '';
      return [Game.promptBlock(), Quests.promptBlock()].filter(Boolean).join('\n\n');
    },

    /* met_charas / npcs here — the official game state fed these to the
       model so Ryza can reference other islanders by name. */
    _peopleBlock: function (st) {
      if (!window.World || !World.npcs) return '';
      var L = ['## この世界の人々（ライザ以外）'];
      var here = World.npcsAt(st.stage, st.day || 1);
      L.push('- いま同じ場所にいる人：' +
        (here.length ? here.map(function (n) {
          return World.npcName(n.id) + (n.note ? '（' + n.note + '）' : '');
        }).join('、') : 'いない'));
      var known = {};
      (World.npcs.npcs || []).forEach(function (n) { known[n.id] = n; });
      var met = (Game.s.met_charas || [])
        .map(function (id) { return known[id]; })
        .filter(Boolean).slice(0, 16);
      if (met.length) {
        L.push('- これまでに会った人：' + met.map(function (n) {
          return World.npcName(n.id) + (n.note ? '（' + n.note + '）' : '');
        }).join('、'));
      }
      return L.join('\n');
    },

    /* re-paint every localized surface after a language change */
    _relocalize: function () {
      App.buildSettings();
      App.buildCharaForm();
      App.updateHud();
      var inp = document.getElementById('input');
      if (inp) inp.placeholder = I18n.tc('input.hint', inp.placeholder);
      Quests.render(App._el('quest-list'), {});
      Welcome.render(App._el('welcome-body'));
      App.renderWorld();
      App.renderStatus();
      /* the three panels that also carry UI strings must re-render too, or
         they keep the old language until you happen to reopen them */
      if (App._el('skin-grid')) App.renderSkins();
      if (document.getElementById('memory-list')) App.renderMemory();
      if (window.Alarm && Alarm.render) {
        var al = document.getElementById('alarm-list');
        if (al) Alarm.render(al, App.playFile);
      }
      if (App._syncVoicePill) App._syncVoicePill();
      App._syncSpeedBtn();
    },

    _openLangSheet: function () {
      var sheet = document.getElementById('sheet-lang');
      var list = document.getElementById('lang-list');
      if (!sheet || !list) return;
      list.innerHTML = '';
      (I18n.LANGS || []).forEach(function (item) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'mode-pill' + (I18n.lang === item.id ? ' active' : '');
        b.textContent = item.label;
        b.onclick = function () {
          Config.set('app.lang', item.id);
          I18n.setLang(item.id);
          I18n.apply(document);
          App._relocalize();
          sheet.classList.add('hidden');
        };
        list.appendChild(b);
      });
      sheet.classList.remove('hidden');
    },

    _toggleChara: function () {
      /* Stage owns the hidden state for whichever renderer is active (Spine
         or Cubism); reading Avatar._hideChara here broke every Live2D card. */
      var on = !Stage.hidden();
      Stage.setHidden(on);
      var ico = document.getElementById('ico-toggle-chara');
      if (ico) ico.src = on ? 'assets/icons/chara_show.svg' : 'assets/icons/chara_hide.svg';
    },

    /* Fullscreen per host. Electron: the window itself goes fullscreen through
       the shell bridge, so the phone-frame column stays centred (the HTML
       fullscreen API on #phone used to let the UA stylesheet force it to
       100% width - "stretched"). Android: the WebView cannot enter HTML
       fullscreen without host support, so the bridge hides the system bars
       (immersive). Plain browser: the document root, never #phone. */
    _toggleFullscreen: function () {
      var on = !Config.section('app').fullscreen;
      if (window.ryzaShell && window.ryzaShell.setFullscreen) {
        window.ryzaShell.setFullscreen(on);
      } else if (window.companionShell && window.companionShell.setFullscreen) {
        window.companionShell.setFullscreen(on);
      } else {
        var cur = document.fullscreenElement || document.webkitFullscreenElement;
        var el = document.documentElement;
        var req = el.requestFullscreen || el.webkitRequestFullscreen;
        var exit = document.exitFullscreen || document.webkitExitFullscreen;
        on = !cur;
        if (on) { req && req.call(el); } else { exit && exit.call(document); }
      }
      Config.set('app.fullscreen', on);
      setTimeout(function () { if (window.Stage && Stage.resize) Stage.resize(); }, 350);
    },

    _confirmNewTalk: function () {
      App.openModal({
        title: I18n.t('talk.resetTitle'),
        okLabel: I18n.t('talk.resetOk'),
        build: function (body) {
          var p = document.createElement('p');
          p.className = 'onb-sub';
          p.textContent = I18n.t('talk.resetMsg');
          body.appendChild(p);
        },
        onOk: function () {
          App.history = [];
          if (window.Nsfw) Nsfw.reset();
          App._pages = []; App._pageSel = -1;
          var dots = document.getElementById('log-dots');
          if (dots) dots.innerHTML = '';
          var bub = document.getElementById('bubble');
          if (bub) bub.classList.remove('hidden');
          var bt = document.getElementById('bubble-text');
          if (bt) bt.textContent = '';
          App.showView('talk');
          App.greet();
        }
      });
    },

    greet: function () {
      var st = Config.section('state');
      var line = st.day > 1 ? I18n.tc('greet.n', '\u2026Hey, there you are.')
                            : I18n.tc('greet.1', '\u2026Hey. Nice to meet you.');
      App.showBubble(line);
      Stage.setEmotion('happy', 'agree');
    },

    say: function (text) {
      var st = Config.section('state');
      if (!Config.section('llm').apiKey) {
        App.toast(I18n.t('toast.needKey'), true);
        App.showView('settings');
        return;
      }
      App._lastText = text;
      var retryBar = document.getElementById('retry-bar');
      if (retryBar) retryBar.classList.add('hidden');
      App.speaking = true;
      document.getElementById('btn-send').disabled = true;
      App.showTyping();
      Welcome.mark('talk');

      /* companion-chat: the embedded engine owns prompt, history, memory and
         affection. The app only renders what comes back. */
      Engine.chat(text, { mode: st.mode, style: st.style, profile: Config.section('profile') })
        .then(function (reply) {
          App.speaking = false;
          document.getElementById('btn-send').disabled = false;
          App.remember('user', text);
          App.remember('ryza', reply.text);

          if (reply.state && typeof reply.state === 'object') {
            Game.applyDelta(reply.state, 'llm');
            App._applySceneDelta(reply.state);
          }

          if (window.Nsfw) Nsfw.onTurn(reply);
          /* Omit = keep. A missed field must not snap the face back to neutral. */
          if (reply.emotion) Stage.setEmotion(reply.emotion, null);
          if (reply.rank_up) App.toast('\u2665 ' + reply.rank_up.name);
          App.typeBubble(reply.text, function () {
            App.speakThen(reply.dubText || reply.text, reply.emotion);
          });

          if (!(reply.state && reply.state.quest)) Quests.progressEvent('talk');
          Quests.render(App._el('quest-list'), {});
        })
        .catch(function (e) {
          App.speaking = false;
          document.getElementById('btn-send').disabled = false;
          var bar = document.getElementById('retry-bar');
          if (bar && e.message !== 'NO_KEY') bar.classList.remove('hidden');
          App.toast(e.message === 'NO_KEY' ? I18n.t('toast.needKey')
                                           : I18n.t('toast.llmFail') + e.message, true);
          App.showBubble('(\u2026I didn\u2019t catch that. Say it again?)');
        });
    },

    speakThen: function (text, emotion) {
      var st = Config.section('state');
      var app = Config.section('app');
      if (!app.voice || st.style === 'text' || Config.section('tts').mode === 'off') return;
      /* The engine already produced the line in the dub language (one LLM call
         for sub + dub), so there is no translate pass any more. */
      Engine.speak(text).then(function (url) {
        /* Talking starts when the audio actually exists - before that the
           mouth sat closed (RMS target 0) for the whole TTS latency, and a
           failed synth left _talking stuck true forever. */
        if (!url) return;
        App.playUrl(url, Api.MODE_PLAY_FX[st.mode] || null);
      }).catch(function (e) {
        App.toast(e.message === 'NO_KEY' ? I18n.t('toast.needKey')
              : e.message === 'NO_MODEL' ? I18n.t('toast.needModel')
              : I18n.t('toast.ttsFail') + e.message, true);
      });
    },

    /* fx: optional { rate, gain } per-mode playback shaping (see
       Api.MODE_PLAY_FX — ASMR slows and softens even on endpoints that
       ignore voice instructions). */
    playUrl: function (url, fx) {
      App._ensureVoiceGraph();
      if (App._voiceCtx && App._voiceCtx.state === 'suspended') {
        App._voiceCtx.resume().catch(function () {});
      }
      var a = App.audio;
      a.src = url;
      var base = (window.Sound && Sound._gain) ? Sound._gain('voice')
        : (Number(Config.section('app').volume) || 0.9);
      a.volume = Math.max(0, Math.min(1, base * ((fx && fx.gain) || 1)));
      a.playbackRate = (fx && fx.rate) || 1;
      a.onended = function () {
        a.playbackRate = 1;
        Stage.setTalking(false);
        URL.revokeObjectURL(url);
        App._bubbleHold(1600);   /* done talking → bubble steps aside */
      };
      Stage.setTalking(true);
      App._bubbleKeep();         /* stay put while she talks */
      a.play().catch(function () { Stage.setTalking(false); });
      App.buzz();
    },

    _pauseVoice: function () {
      if (App.audio) { try { App.audio.pause(); } catch (e) {} }
      if (Avatar && Avatar.setTalking) Stage.setTalking(false);
    },

    playFile: function (path, vol, force) {
      if (!force && !Config.section('app').voice) return;
      App._ensureVoiceGraph();
      if (App._voiceCtx && App._voiceCtx.state === 'suspended') {
        App._voiceCtx.resume().catch(function () {});
      }
      var a = App.audio;
      a.src = path;
      a.volume = vol != null ? vol : ((window.Sound && Sound._gain) ? Sound._gain('voice')
        : (Number(Config.section('app').volume) || 0.9));
      Stage.setTalking(true);
      if (window.Alarm && Alarm.loadEnv) {
        Alarm.loadEnv(path).then(function (env) {
          if (env && Avatar.setTalkingEnvelope) Stage.setTalkingEnvelope(env);
        });
      }
      a.onended = function () { Stage.setTalking(false); };
      a.play().catch(function () { Stage.setTalking(false); });
      App.buzz();
    },

    /* ------------------------------------------------- log panel lifecycle
       2026-09-07 UI pass: the floating auto-fading bubble is gone. The
       official talk screen keeps a bottom log panel — avatar + name + mode
       description, the current line, page dots for the last few replies, and
       a ⇧ that expands the whole running conversation. _bubbleKeep/_bubbleHold
       stay as no-op seams (playUrl/speakThen still call them); nothing
       self-hides anymore, so the old fade race is structurally impossible. */
    _pages: [],
    _pageSel: -1,
    _typeGen: 0,
    _bubbleKeep: function () {
      if (App._bubbleTimer) { clearTimeout(App._bubbleTimer); App._bubbleTimer = null; }
    },
    _bubbleHold: function () { /* panel is persistent — no scheduled fade */ },
    _bubbleReveal: function () { /* no-op seam */ },

    /* the pill's own two official placeholder states (input.hint lives in
       the CONTENT table → tc; input.waiting is a UI key → t) */
    _inputHint: function (waiting) {
      var inp = document.getElementById('input');
      if (!inp) return;
      inp.placeholder = waiting ? I18n.t('input.waiting')
                                : I18n.tc('input.hint', inp.placeholder);
    },

    _pushPage: function (text) {
      if (!text) return;
      var last = App._pages[App._pages.length - 1];
      if (last === text) return;
      App._pages.push(text);
      if (App._pages.length > 5) App._pages.shift();
      App._pageSel = App._pages.length - 1;
      App._renderDots();
    },
    _renderDots: function () {
      var host = document.getElementById('log-dots');
      if (!host) return;
      host.innerHTML = '';
      if (App._pages.length < 2) return;
      App._pages.forEach(function (t, i) {
        var d = document.createElement('i');
        if (i === App._pageSel) d.className = 'on';
        d.title = (i + 1) + ' / ' + App._pages.length;
        d.onclick = function () {
          App._pageSel = i;
          document.getElementById('bubble-text').textContent = App._pages[i];
          var lb = document.getElementById('log-body');
          if (lb) lb.scrollTop = 0;   // reviewing an older message: read from its top
          App._renderDots();
        };
        host.appendChild(d);
      });
    },
    _cycleTextSpeed: function () {
      var cur = Number(Config.section('app').textSpeed) || 28;
      var idx = 0;
      TEXT_SPEEDS.forEach(function (o, i) { if (o.v === cur) idx = i; });
      var nxt = TEXT_SPEEDS[(idx + 1) % TEXT_SPEEDS.length];
      Config.set('app.textSpeed', nxt.v);
      App._syncSpeedBtn();
    },
    _syncSpeedBtn: function () {
      var b = document.getElementById('btn-speed');
      if (!b) return;
      var cur = Number(Config.section('app').textSpeed) || 28;
      var label = { 30: '×1', 18: '×1.5', 12: '×2', 8: '×3' };
      b.textContent = label[cur] || (cur <= 10 ? '×3' : cur <= 15 ? '×2' : cur <= 24 ? '×1.5' : '×1');
    },

    /* a new line always brings the panel back (official: she never talks
       into a collapsed strip) */
    _panelUp: function () {
      var phone = document.getElementById('phone');
      if (phone && phone.classList.contains('panel-collapsed')) {
        phone.classList.remove('panel-collapsed');
        var arrow = document.querySelector('#btn-log-toggle img');
        if (arrow) arrow.style.transform = '';
      }
    },

    showTyping: function () {
      App._panelUp();
      var b = document.getElementById('bubble');
      var vig = document.getElementById('vignette');
      if (b) {
        b.classList.remove('hidden');
        b.classList.add('typing', 'speaking');
      }
      document.getElementById('bubble-text').innerHTML =
        '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>';
      if (vig) vig.classList.add('talk-glow');
      App._inputHint(true);
    },

    showBubble: function (text) {
      App._panelUp();
      var vig = document.getElementById('vignette');
      if (vig) vig.classList.remove('talk-glow');
      var b = document.getElementById('bubble');
      if (b) b.classList.remove('typing', 'speaking', 'hidden');
      if (Config.section('app').showBubble === false) return;
      document.getElementById('bubble-text').textContent = text;
      App._pushPage(text);
      App._inputHint(false);
    },

    typeBubble: function (text, done) {
      App._panelUp();
      if (App._typeTimer) clearTimeout(App._typeTimer);
      /* generation token: a second chain (retry/alarm while the first line is
         still typing) kills the old one instead of interleaving writes */
      var gen = ++App._typeGen;
      var b = document.getElementById('bubble');
      var span = document.getElementById('bubble-text');
      var vig = document.getElementById('vignette');
      if (b) {
        b.classList.remove('hidden');
        b.classList.remove('typing');
        b.classList.add('speaking');
      }
      if (vig) vig.classList.add('talk-glow');
      var speed = Number(Config.section('app').textSpeed) || 28;
      var i = 0;
      (function step() {
        if (gen !== App._typeGen) return;
        if (i >= text.length) {
          if (b) b.classList.remove('speaking');
          if (vig) vig.classList.remove('talk-glow');
          App._pushPage(text);
          App._inputHint(false);
          done && done();
          return;
        }
        span.textContent = text.slice(0, ++i);
        App._scrollLog();
        App._typeTimer = setTimeout(step, speed);
      })();
    },
    /* a long reply scrolls inside the panel (dots switch between messages;
       scrolling reads THIS one when it overflows) — keeps up with the typewriter */
    _scrollLog: function () {
      var b = document.getElementById('log-body');
      if (b) b.scrollTop = b.scrollHeight;
    },

    /* ------------------------------------------------------------ alarms */
    _onAlarm: function (a, clip) {
      App._ringAlarm = a;
      var ov = document.getElementById('overlay-alarm');
      document.getElementById('ring-time').textContent = a.time || '';
      document.getElementById('ring-type').textContent = I18n.t('alarm.type.' + a.type);
      ov.classList.remove('hidden');
      App.showBubble('（' + I18n.t('alarm.type.' + a.type) + '）');
      Stage.setEmotion('happy', 'agree');
      var gain = (window.Sound && Sound._gain) ? Sound._gain('voice') : 0.9;
      var vol = Math.max(0, Math.min(1, gain * (Number(a.volume) || 1)));
      if (clip) App.playFile(clip, vol);
      if (a.vibrate !== false) App.buzz([30, 60, 30, 60, 30]);
    },

    _dismissAlarm: function () {
      document.getElementById('overlay-alarm').classList.add('hidden');
      if (App.audio) { try { App.audio.pause(); } catch (e) {} }
      Stage.setTalking(false);
      App._ringAlarm = null;
    },

    _snoozeAlarm: function () {
      if (App._ringAlarm) Alarm.snooze(App._ringAlarm);
      App._dismissAlarm();
      App.toast(I18n.t('alarm.snooze'));
    },

    /* -------------------------------------------------------- modal forms */
    closeModal: function () {
      document.getElementById('modal-scrim').classList.add('hidden');
    },

    openModal: function (opts) {
      opts = opts || {};
      var scrim = document.getElementById('modal-scrim');
      var form = document.getElementById('modal');
      var body = document.getElementById('modal-body');
      document.getElementById('modal-title').textContent = opts.title || '';
      document.getElementById('modal-ok').textContent = opts.okLabel || I18n.t('form.ok');
      document.getElementById('modal-cancel').textContent = I18n.t('form.cancel');
      body.innerHTML = '';
      (opts.build || function () {})(body);
      I18n.apply(form);
      scrim.classList.remove('hidden');

      var cancel = function () {
        App.closeModal();
        opts.onCancel && opts.onCancel();
      };
      document.getElementById('modal-cancel').onclick = cancel;
      scrim.onclick = function (e) { if (e.target === scrim) cancel(); };
      form.onsubmit = function (e) {
        e.preventDefault();
        if (opts.onOk && opts.onOk(body) === false) return;
        App.closeModal();
      };
    },

    _fieldEl: function (label, innerHtml) {
      var d = document.createElement('div');
      d.className = 'field';
      var lab = document.createElement('label');
      lab.textContent = label;
      d.appendChild(lab);
      var wrap = document.createElement('div');
      wrap.innerHTML = innerHtml;
      while (wrap.firstChild) d.appendChild(wrap.firstChild);
      return d;
    },

    _newAlarm: function () { App._alarmForm(null); },
    _editAlarm: function (id) { App._alarmForm(id); },

    _alarmForm: function (id) {
      var existing = id ? Alarm.get(id) : null;
      var now = new Date();
      var defTime = existing ? existing.time : (
        String(now.getHours()).padStart(2, '0') + ':' +
        String(now.getMinutes()).padStart(2, '0'));
      var defType = (existing && existing.type) || 'goodMorning';
      var defStyle = (existing && existing.style) || 'normal';
      var defDays = (existing && existing.days) ? existing.days.slice() : [];
      var defSnooze = (existing && existing.snoozeMin != null) ? existing.snoozeMin : 5;
      var defVol = (existing && existing.volume != null) ? existing.volume : 1;
      var defVib = existing ? existing.vibrate !== false : true;
      /* defTime is interpolated into the form's innerHTML — an imported save
         slot could carry Alarm.items with arbitrary strings. Whitelist the
         HH:MM shape before it reaches the DOM. */
      if (!/^\d{1,2}:\d{2}$/.test(defTime)) {
        defTime = String(now.getHours()).padStart(2, '0') + ':' +
                  String(now.getMinutes()).padStart(2, '0');
      }

      App.openModal({
        title: existing ? I18n.t('alarm.edit') : I18n.t('alarm.new'),
        okLabel: I18n.t('form.ok'),
        build: function (body) {
          body.appendChild(App._fieldEl(I18n.t('alarm.time'),
            '<input type="time" id="f-alarm-time" value="' + defTime + '" required>'));

          var typeOpts = Alarm.TYPES.map(function (t) {
            return '<option value="' + t + '"' + (t === defType ? ' selected' : '') + '>' +
                   I18n.t('alarm.type.' + t) + '</option>';
          }).join('');
          body.appendChild(App._fieldEl(I18n.t('alarm.kind'),
            '<select id="f-alarm-type">' + typeOpts + '</select>'));

          var styleOpts = Alarm.STYLES.map(function (s) {
            return '<option value="' + s + '"' + (s === defStyle ? ' selected' : '') + '>' +
                   I18n.t('alarm.style.' + s) + '</option>';
          }).join('');
          body.appendChild(App._fieldEl(I18n.t('alarm.tone'),
            '<select id="f-alarm-style">' + styleOpts + '</select>'));

          var days = document.createElement('div');
          days.className = 'field';
          var lab = document.createElement('label');
          lab.textContent = I18n.t('alarm.days');
          days.appendChild(lab);
          var chips = document.createElement('div');
          chips.className = 'day-chips';
          chips.id = 'f-alarm-days';
          Alarm.WEEK.forEach(function (label, i) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'chip' + (defDays.indexOf(i) >= 0 ? ' on' : '');
            b.setAttribute('data-day', String(i));
            b.textContent = label;
            b.onclick = function () { b.classList.toggle('on'); };
            chips.appendChild(b);
          });
          days.appendChild(chips);
          var hint = document.createElement('div');
          hint.className = 'hint';
          hint.textContent = I18n.t('alarm.everyday') + ' — ' +
            (I18n.lang === 'en' ? 'leave all off' : (I18n.lang === 'ja' ? '未選択で毎日' : '全不选即每天'));
          days.appendChild(hint);
          body.appendChild(days);

          body.appendChild(App._fieldEl(I18n.t('alarm.snooze') + ' (' + I18n.t('alarm.min') + ')',
            '<input type="number" id="f-alarm-snooze" min="1" max="30" value="' + defSnooze + '">'));
          body.appendChild(App._fieldEl(I18n.t('alarm.volume'),
            '<input type="range" id="f-alarm-vol" min="0" max="1" step="0.05" value="' + defVol + '">'));
          var vib = document.createElement('label');
          vib.className = 'switch-row';
          vib.innerHTML = '<span></span><input type="checkbox" id="f-alarm-vib"' +
            (defVib ? ' checked' : '') + '>';
          vib.querySelector('span').textContent = I18n.t('alarm.vibrate');
          body.appendChild(vib);
        },
        onOk: function (body) {
          var time = (body.querySelector('#f-alarm-time').value || '').slice(0, 5);
          if (!/^\d{2}:\d{2}$/.test(time)) { App.toast('Please set a time', true); return false; }
          var type = body.querySelector('#f-alarm-type').value;
          var style = body.querySelector('#f-alarm-style').value;
          var days = [];
          body.querySelectorAll('#f-alarm-days .chip.on').forEach(function (c) {
            days.push(parseInt(c.getAttribute('data-day'), 10));
          });
          var payload = {
            time: time, type: type, style: style, days: days,
            snoozeMin: parseInt(body.querySelector('#f-alarm-snooze').value, 10) || 5,
            volume: parseFloat(body.querySelector('#f-alarm-vol').value) || 1,
            vibrate: !!body.querySelector('#f-alarm-vib').checked
          };
          if (existing) Alarm.update(existing.id, payload);
          else Alarm.add(payload);
          Alarm.render(document.getElementById('alarm-list'), App.playFile);
          App.toast(I18n.t('toast.saved'));
        }
      });
    },

    /* ------------------------------------------------------------ memory */
    remember: function (who, text) {
      App.memory.push({ who: who, text: text, at: Date.now() });
      if (App.memory.length > 400) App.memory = App.memory.slice(-400);
      App.saveMemory();
    },
    saveMemory: function () {
      try { localStorage.setItem(MEM_KEY, JSON.stringify(App.memory)); } catch (e) {}
    },
    renderMemory: function () {
      var root = document.getElementById('memory-list');
      if (!root) return;
      root.innerHTML = '';
      var T = function (k) { return I18n.t(k); };
      if (window.Memory) {
        var bag = Memory.list();
        var pend = Memory.pendingTurns();
        if (pend) {
          var p = document.createElement('div');
          p.className = 'hint';
          p.textContent = I18n.tf('memory.pending', '{n} turns not yet summarised', { n: pend });
          root.appendChild(p);
        }
        function section(title, items) {
          if (!items.length) return;
          var h = document.createElement('div');
          h.className = 'mem-layer';
          h.textContent = title;
          root.appendChild(h);
          items.slice().reverse().forEach(function (c) {
            var el = document.createElement('div');
            el.className = 'card';
            el.innerHTML = '<div class="card-sub t-text"></div>' +
              '<div class="card-acts">' +
              '<button type="button" class="mini-btn t-edit"></button>' +
              '<button type="button" class="mini-btn t-del"></button></div>';
            el.querySelector('.t-text').textContent = c.text;
            el.querySelector('.t-edit').textContent = T('memory.edit');
            el.querySelector('.t-del').textContent = T('memory.del');
            el.querySelector('.t-edit').onclick = function () { App._editMemory(c.id); };
            el.querySelector('.t-del').onclick = function () {
              Dialog.confirm(T('memory.delAsk'), { danger: true }).then(function (ok) {
                if (!ok) return;
                Memory.remove(c.id);
                App.renderMemory();
              });
            };
            root.appendChild(el);
          });
        }
        section(T('memory.summaries'), bag.summaries);
        section(T('memory.sessions'), bag.sessions);
      }
      if (App.memory && App.memory.length) {
        var h2 = document.createElement('div');
        h2.className = 'mem-layer';
        h2.textContent = T('memory.log');
        root.appendChild(h2);
        App.memory.slice().reverse().slice(0, 40).forEach(function (m) {
          var el = document.createElement('div');
          el.className = 'card';
          el.innerHTML = '<div class="card-title"><span class="tag' +
            (m.who === 'ryza' ? '' : ' leaf') + ' t-who"></span></div>' +
            '<div class="card-sub t-text"></div>';
          el.querySelector('.t-who').textContent = m.who === 'ryza' ? I18n.characterName() : I18n.tc('chara.you', 'You');
          el.querySelector('.t-text').textContent = m.text;
          root.appendChild(el);
        });
      }
      if (!root.firstChild) {
        root.innerHTML = '<div class="empty">' + T('memory.empty') + '</div>';
      }
    },

    _editMemory: function (id) {
      var existing = id && window.Memory ? Memory.get(id) : null;
      App.openModal({
        title: existing ? I18n.t('memory.edit') : I18n.t('memory.add'),
        okLabel: I18n.t('form.ok'),
        build: function (body) {
          var ta = document.createElement('textarea');
          ta.id = 'mem-edit-text';
          ta.rows = 6;
          ta.value = existing ? existing.text : '';
          body.appendChild(ta);
          if (!existing) {
            var sel = document.createElement('select');
            sel.id = 'mem-edit-layer';
            [['session', I18n.t('memory.sessions')],
             ['summary', I18n.t('memory.summaries')]].forEach(function (p) {
              var o = document.createElement('option');
              o.value = p[0]; o.textContent = p[1];
              sel.appendChild(o);
            });
            body.appendChild(sel);
          }
        },
        onOk: function (body) {
          var text = (body.querySelector('#mem-edit-text') || {}).value || '';
          if (!window.Memory) return;
          if (existing) Memory.update(existing.id, text);
          else {
            var layer = (body.querySelector('#mem-edit-layer') || {}).value || 'session';
            Memory.add(text, layer);
          }
          App.renderMemory();
        }
      });
    },

    _llmModels: [],

    _applyPickedModel: function (id) {
      Config.set('llm.model', id);
      var hit = (App._llmModels || []).filter(function (m) { return m.id === id; })[0];
      if (hit && window.Api && typeof Api.setModelMeta === 'function') Api.setModelMeta(hit);
      if (hit && hit.context && !(Number(Config.section('llm').contextWindow) > 0)) {
        Config.set('llm.contextWindow', hit.context);
        App.buildSettings();
      }
    },

    _fetchModels: function () {
      var llm = Config.section('llm');
      if (!llm.apiKey) { App.toast(I18n.t('toast.needKey'), true); return; }
      if (!llm.baseUrl) { App.toast(I18n.t('toast.needUrl'), true); return; }
      App.toast(I18n.t('toast.modelsWait'));
      Api.listModels().then(function (list) {
        App._llmModels = list || [];
        var hit = App._llmModels.filter(function (m) { return m.id === llm.model; })[0];
        if (hit && hit.context && !(Number(llm.contextWindow) > 0)) {
          Config.set('llm.contextWindow', hit.context);
        }
        App.toast(I18n.tf('toast.modelsOk', 'Fetched {n} models', { n: App._llmModels.length }));
        App.buildSettings();
      }).catch(function (e) {
        App.toast(I18n.t('toast.modelsFail') + (e && e.message ? e.message : ''), true);
      });
    },

    /* ------------------------------------------------------------- skins */
    renderSkins: function () {
      if (!document.getElementById('skin-grid')) return;
      fetch('assets/_index/skins.json').then(function (r) { return r.json(); })
        .then(function (skins) {
          var root = App._el('skin-grid');
          var cur = Avatar.outfitOf(Config.section('state').skin);
          var seen = {}, outfits = [];
          skins.forEach(function (s) {
            var oid = Avatar.outfitOf(s.id);
            if (seen[oid]) {
              if (s.hasSpine) seen[oid].hasSpine = true;
              if (!seen[oid].preview && s.preview) seen[oid].preview = s.preview;
              return;
            }
            seen[oid] = { id: oid, hasSpine: !!s.hasSpine, preview: s.preview };
            outfits.push(seen[oid]);
          });
          root.innerHTML = '';
          outfits.forEach(function (s) {
            var el = document.createElement('div');
            var wearable = !!s.hasSpine;
            el.className = 'skin-card' + (s.id === cur ? ' active' : '') + (wearable ? '' : ' locked');
            el.innerHTML = '<img><div class="skin-cap"><span class="t-name"></span>' +
                           '<span class="skin-id"></span></div>';
            var img = el.querySelector('img');
            img.src = s.preview || 'assets/images/chara_placeholder.png';
            img.onerror = function () { img.src = 'assets/images/chara_placeholder.png'; };
            el.querySelector('.t-name').textContent = wearable
              ? I18n.t('skin.wear') : I18n.t('skin.previewOnly');
            el.querySelector('.skin-id').textContent = s.id.replace('crf_skn_002_', '');
            el.onclick = function () {
              if (!wearable) {
                App.toast(I18n.t('skin.previewOnly'), true);
                return;
              }
              Config.set('state.skin', s.id);
              App._switchSkin(s.id);
              App.renderSkins();
            };
            root.appendChild(el);
          });
        });
    },

    _switchSkin: function (id) {
      var veil = document.getElementById('skin-veil');
      veil.classList.add('veil-on');
      if (window.Sound) Sound.se('skin_change');
      setTimeout(function () {
        Avatar.loadSkin(id, function () {
          setTimeout(function () { veil.classList.remove('veil-on'); }, 280);
        });
      }, 160);
    },

    /* -------------------------------------------------------------- forms */
    _field: function (wrap, labelKey, value, onInput, opts) {
      opts = opts || {};
      var d = document.createElement('div');
      d.className = 'field';
      var lab = document.createElement('label');
      lab.textContent = labelKey;
      var input = document.createElement(opts.multi ? 'textarea' : 'input');
      if (!opts.multi) input.type = opts.password ? 'password' : (opts.type || 'text');
      input.value = value == null ? '' : value;
      var suggestions = opts.suggestions || [];
      if (opts.list || suggestions.length) {
        var listId = opts.list || ('dl-' + String(labelKey || 'field').replace(/\W+/g, ''));
        input.setAttribute('list', listId);
        var dl = document.createElement('datalist');
        dl.id = listId;
        suggestions.forEach(function (s) {
          if (!s) return;
          var o = document.createElement('option');
          o.value = s;
          dl.appendChild(o);
        });
        d.appendChild(dl);
      }
      input.oninput = function () { onInput(input.value); };
      d.appendChild(lab); d.appendChild(input);
      if (opts.hint) {
        var h = document.createElement('div');
        h.className = 'hint'; h.textContent = opts.hint;
        d.appendChild(h);
      }
      wrap.appendChild(d);
      return d;
    },

    _select: function (wrap, labelKey, value, options, onChange) {
      var d = document.createElement('div');
      d.className = 'field';
      var lab = document.createElement('label');
      lab.textContent = labelKey;
      var sel = document.createElement('select');
      options.forEach(function (o) {
        var op = document.createElement('option');
        op.value = o.v; op.textContent = o.t;
        if (o.v === value) op.selected = true;
        sel.appendChild(op);
      });
      sel.onchange = function () { onChange(sel.value); };
      d.appendChild(lab); d.appendChild(sel);
      wrap.appendChild(d);
      return d;
    },

    _switch: function (wrap, labelKey, value, onChange) {
      var row = document.createElement('div');
      row.className = 'switch-row';
      var span = document.createElement('span');
      span.textContent = labelKey;
      var sw = document.createElement('div');
      sw.className = 'switch' + (value ? ' on' : '');
      sw.onclick = function () {
        var next = !sw.classList.contains('on');
        sw.classList.toggle('on', next);
        onChange(next);
      };
      row.appendChild(span); row.appendChild(sw);
      wrap.appendChild(row);
      return row;
    },

    _range: function (wrap, label, value, onInput, opts) {
      opts = opts || {};
      var d = document.createElement('div');
      d.className = 'field';
      var lab = document.createElement('label');
      lab.textContent = label;
      var input = document.createElement('input');
      input.type = 'range';
      input.min = String(opts.min != null ? opts.min : 0);
      input.max = String(opts.max != null ? opts.max : 1);
      input.step = String(opts.step != null ? opts.step : 0.01);
      input.value = value == null ? (opts.def != null ? opts.def : 1) : value;
      input.oninput = function () { onInput(parseFloat(input.value)); };
      d.appendChild(lab); d.appendChild(input);
      wrap.appendChild(d);
      return d;
    },

    _title: function (wrap, text) {
      var h = document.createElement('div');
      h.className = 'section-title'; h.textContent = text;
      wrap.appendChild(h);
    },

    buildSettings: function () {
      var w = document.getElementById('settings-form');
      w.innerHTML = '';
      var T = function (k) { return I18n.t(k); };

      /* ---------------- character (companion-chat engine) */
      App._title(w, I18n.tc('settings.character', 'Character'));
      var chars = (window.Characters ? Characters.list() : []);
      if (chars.length) {
        App._select(w, I18n.tc('settings.character.active', 'Active character'), Characters.activeId(),
          chars.map(function (c) { return { v: c.id, t: c.name + (c.pack && c.pack.media_required ? ' *' : '') }; }),
          function (v) {
            App.setCharacter(v).then(function () { App.buildSettings(); App.buildCharaForm(); });
            App.toast(Characters.get(v).name);
          });
        var aff = window.Affection ? Affection.state(Characters.activeId()) : null;
        if (aff) {
          var affRow = document.createElement('div');
          affRow.className = 'hint';
          affRow.textContent = aff.name + ' \u00b7 ' + aff.points + (aff.next ? ' / ' + aff.next.at + ' \u2192 ' + aff.next.name : '');
          w.appendChild(affRow);
        }
      }

      App._switch(w, I18n.tc('settings.phoneFrame', 'Phone frame on wide screens'), Config.section('app').phoneFrame !== false,
        function (v) { Config.set('app.phoneFrame', !!v); document.body.classList.toggle('phone-frame', !!v); Stage.resize(); });

      App._title(w, T('settings.llm'));
      App._field(w, T('settings.baseUrl'), Config.section('llm').baseUrl,
        function (v) { Config.set('llm.baseUrl', v); },
        { hint: 'OpenAI-compatible base URL ending in /v1 (OpenRouter, Groq, LM Studio, a Claude bridge\u2026); config/providers.json can pre-fill it' });
      var models = App._llmModels || [];
      if (models.length) {
        var cur = Config.section('llm').model || '';
        var opts = models.map(function (m) {
          return { v: m.id, t: m.context ? (m.id + ' · ' + m.context) : m.id };
        });
        if (cur && !opts.filter(function (o) { return o.v === cur; }).length) {
          opts.unshift({ v: cur, t: cur });
        }
        App._select(w, T('settings.model'), cur, opts, function (v) {
          App._applyPickedModel(v);
        });
      } else {
        App._field(w, T('settings.model'), Config.section('llm').model,
          function (v) { Config.set('llm.model', v); },
          { hint: T('settings.model.hint') });
      }
      var fetchRow = document.createElement('div');
      fetchRow.className = 'btn-row';
      var bFetch = document.createElement('button');
      bFetch.type = 'button'; bFetch.className = 'btn';
      bFetch.textContent = T('settings.fetchModels');
      bFetch.onclick = function () { App._fetchModels(); };
      fetchRow.appendChild(bFetch);
      w.appendChild(fetchRow);
      App._field(w, T('settings.apiKey'), Config.section('llm').apiKey,
        function (v) { Config.set('llm.apiKey', v); },
        { password: true, hint: T('settings.apiKey.hint') });
      App._field(w, T('settings.temp'), Config.section('llm').temperature,
        function (v) { Config.set('llm.temperature', parseFloat(v) || 0.9); });
      App._field(w, T('settings.maxTokens'), Config.section('llm').maxTokens,
        function (v) { Config.set('llm.maxTokens', Math.max(64, parseInt(v, 10) || 400)); });
      App._field(w, T('settings.historyTurns'), Config.section('llm').historyTurns,
        function (v) { Config.set('llm.historyTurns', Math.max(2, parseInt(v, 10) || 12)); });
      App._field(w, T('settings.context'), Config.section('llm').contextWindow || '',
        function (v) {
          var n = parseInt(v, 10);
          Config.set('llm.contextWindow', n > 0 ? n : 0);
        },
        { hint: T('settings.context.hint') + ' · auto=' + Api.resolvedContext() });
      App._select(w, T('settings.thinking'), Config.section('llm').thinking || 'auto', [
        { v: 'auto', t: T('settings.thinking.auto') },
        { v: 'off', t: T('settings.thinking.off') },
        { v: 'on', t: T('settings.thinking.on') }
      ], function (v) { Config.set('llm.thinking', v); });
      var effort = (window.Api && Api.normalizeEffort)
        ? Api.normalizeEffort(Config.section('llm').thinkingEffort)
        : (Config.section('llm').thinkingEffort || 'default');
      if (effort === 'xhigh') effort = 'max';
      if (['default', 'off', 'low', 'medium', 'high', 'max'].indexOf(effort) === -1) {
        effort = 'default';
      }
      App._select(w, T('settings.thinkingEffort'), effort, [
        { v: 'default', t: T('settings.thinkingEffort.default') },
        { v: 'off', t: T('settings.thinkingEffort.off') },
        { v: 'low', t: T('settings.thinkingEffort.low') },
        { v: 'medium', t: T('settings.thinkingEffort.medium') },
        { v: 'high', t: T('settings.thinkingEffort.high') },
        { v: 'max', t: T('settings.thinkingEffort.max') }
      ], function (v) { Config.set('llm.thinkingEffort', v); });
      App._select(w, T('settings.thinkingStyle'), Config.section('llm').thinkingStyle || 'auto', [
        { v: 'auto', t: T('settings.thinkingStyle.auto') },
        { v: 'none', t: T('settings.thinkingStyle.none') },
        { v: 'openai', t: T('settings.thinkingStyle.openai') },
        { v: 'openrouter', t: T('settings.thinkingStyle.openrouter') },
        { v: 'qwen', t: T('settings.thinkingStyle.qwen') },
        { v: 'glm', t: T('settings.thinkingStyle.glm') }
      ], function (v) { Config.set('llm.thinkingStyle', v); });

      App._title(w, T('settings.memory'));
      var mem = Config.section('memory') || {};
      App._switch(w, T('settings.memoryOn'), mem.enabled !== false,
        function (v) { Config.set('memory.enabled', v); });
      App._field(w, T('settings.turnsPerSession'), mem.turnsPerSession,
        function (v) { Config.set('memory.turnsPerSession', Math.max(2, parseInt(v, 10) || 8)); });
      App._field(w, T('settings.sessionCap'), mem.sessionCap,
        function (v) { Config.set('memory.sessionCap', Math.max(2, parseInt(v, 10) || 8)); });
      App._field(w, T('settings.summaryCap'), mem.summaryCap,
        function (v) { Config.set('memory.summaryCap', Math.max(2, parseInt(v, 10) || 8)); });

      App._title(w, T('settings.tts'));
      var ttsNames = (window.Providers ? Providers.names('tts') : ['omnivoice']);
      App._select(w, T('settings.tts.provider'), Config.section('engine').tts || 'omnivoice',
        ttsNames.map(function (n) { return { v: n, t: n === 'omnivoice' ? 'OmniVoice' : n }; }),
        function (v) { Config.set('engine.tts', v); App.buildSettings(); });
      if ((Config.section('engine').tts || 'omnivoice') === 'omnivoice') {
        var ov = Config.section('omnivoice');
        App._field(w, T('settings.baseUrl'), ov.baseUrl,
          function (v) { Config.set('omnivoice.baseUrl', v); },
          { hint: 'OmniVoice server, e.g. http://127.0.0.1:9192 on this PC or http://<voice-pc>:9192 on the LAN/tailnet (reached through /_proxy)' });
        App._field(w, I18n.tc('settings.omnivoice.guidance', 'Guidance scale'), ov.guidanceScale,
          function (v) { Config.set('omnivoice.guidanceScale', parseFloat(v) || 2.0); });
        App._field(w, I18n.tc('settings.omnivoice.lang', 'Language hint'), ov.language,
          function (v) { Config.set('omnivoice.language', v || 'auto'); },
          { hint: 'auto = let OmniVoice detect; otherwise en / ja / id' });
        var vc = (window.Characters && Characters.active() && Characters.active().voice) || {};
        var vrow = document.createElement('div');
        vrow.className = 'hint';
        vrow.textContent = 'Voice: ' + (vc.ref_audio || '(server default reference)') + (vc.instruct ? ' \u00b7 ' + vc.instruct : '');
        w.appendChild(vrow);
      }
      App._select(w, T('settings.ttsMode'), Config.section('tts').mode === 'off' ? 'off' : 'preset', [
        { v: 'preset', t: I18n.tc('settings.ttsMode.on', 'On') },
        { v: 'off', t: T('settings.ttsMode.off') }
      ], function (v) { Config.set('tts.mode', v); App.buildSettings(); });

      /* ---------------- language matrix: UI / recorded voice / reply / TTS */
      App._title(w, T('nav.lang'));
      var langOpts = Langs.ALL.map(function (o) { return { v: o.v, t: T(o.k) }; });
      App._select(w, T('settings.lang.ui'), Config.section('app').lang, langOpts,
        function (v) {
          Config.set('app.lang', v); I18n.setLang(v); I18n.apply(document);
          App._relocalize();
        });
      App._select(w, T('settings.lang.voice'), (Config.section('voice') || {}).lang || 'auto', langOpts,
        function (v) { Config.set('voice.lang', v); });
      App._select(w, T('settings.lang.llm'), (Config.section('llm') || {}).lang || 'auto', langOpts,
        function (v) { Config.set('llm.lang', v); });
      App._select(w, T('settings.lang.tts'), (Config.section('tts') || {}).lang || 'auto', langOpts,
        function (v) { Config.set('tts.lang', v); });
      var lh = document.createElement('div');
      lh.className = 'hint'; lh.textContent = T('settings.lang.ttsHint');
      w.appendChild(lh);

      App._title(w, T('settings.app'));
      App._range(w, T('settings.volume'), Config.section('app').volume,
        function (v) {
          Config.set('app.volume', v);
          if (window.Sound) Sound.applyVolumes();
        });
      App._range(w, T('vol.bgm'), (Config.section('audio') || {}).bgm, function (v) {
        Config.set('audio.bgm', v); if (window.Sound) Sound.applyVolumes();
      });
      App._range(w, T('vol.ambient'), (Config.section('audio') || {}).ambient, function (v) {
        Config.set('audio.ambient', v); if (window.Sound) Sound.applyVolumes();
      });
      App._range(w, T('vol.voice'), (Config.section('audio') || {}).voice, function (v) {
        Config.set('audio.voice', v);
      });
      App._range(w, T('vol.se'), (Config.section('audio') || {}).se, function (v) {
        Config.set('audio.se', v);
      });
      /* talk speed: the official sheet is icon pills, not a raw ms input. */
      var sp = document.createElement('div');
      sp.className = 'field';
      var spl = document.createElement('label');
      spl.textContent = T('settings.speed');
      sp.appendChild(spl);
      var seg = document.createElement('div');
      seg.className = 'speed-seg';
      TEXT_SPEEDS.forEach(function (o) {
        var b = document.createElement('button');
        b.type = 'button';
        var cur = Number(Config.section('app').textSpeed) || 28;
        b.className = Math.abs(cur - o.v) < 3 ? 'on' : '';
        b.innerHTML = '<img alt="" src="assets/icons/' + o.icon + '.svg">';
        b.onclick = function () {
          Config.set('app.textSpeed', o.v);
          App.buildSettings();
        };
        seg.appendChild(b);
      });
      sp.appendChild(seg);
      w.appendChild(sp);
      App._switch(w, T('settings.voice'), Config.section('app').voice,
        function (v) { Config.set('app.voice', v); if (App._syncVoicePill) App._syncVoicePill(); });
      App._switch(w, T('settings.bubble'), Config.section('app').showBubble !== false,
        function (v) { Config.set('app.showBubble', v); });
      App._switch(w, T('settings.vibration'), Config.section('app').vibration,
        function (v) { Config.set('app.vibration', v); });
      App._switch(w, T('settings.rim'), Config.section('app').rim !== false,
        function (v) { Config.set('app.rim', v); });

      /* ---------------- time passage (official drove it from AppServerClock) */
      App._title(w, T('settings.time'));
      App._select(w, T('settings.timeMode'), Config.section('app').timeMode || 'real', [
        { v: 'real',   t: T('time.real') },
        { v: 'flow',   t: T('time.flow') },
        { v: 'manual', t: T('time.manual') }
      ], function (v) {
        Config.set('app.timeMode', v);
        if (v === 'flow') {
          Config.set('state.gameHour', new Date().getHours());
          Config.set('state.gameClockAt', Date.now());
          Config.set('state.todManualUntil', 0);
        }
        App.buildSettings();
        App._tickTime();
      });
      if ((Config.section('app').timeMode) === 'flow') {
        App._select(w, T('settings.flowSpeed'), String(Config.section('app').flowSpeed || 60), [
          { v: '15',  t: T('speed.slow') },
          { v: '60',  t: T('speed.mid') },
          { v: '180', t: T('speed.fast') },
          { v: '360', t: T('speed.vfast') }
        ], function (v) {
          Config.set('app.flowSpeed', Number(v));
          App._tickTime();
        });
      }

      /* ---------------- game balance / cheat (user-side replacement for
         the official paywall: limits stay, but can be switched off freely) */
      App._title(w, T('settings.cheat'));
      var cheatHint = document.createElement('div');
      cheatHint.className = 'hint';
      cheatHint.textContent = T('cheat.desc');
      w.appendChild(cheatHint);
      App._switch(w, T('cheat.title') + (Config.section('app').cheat ? ' 🍎∞' : ''),
        Config.section('app').cheat,
        function (v) {
          Config.set('app.cheat', v);
          App.toast(v ? T('cheat.on') : T('cheat.off'));
          App.refreshHud();
          App.buildSettings();
        });
      var g = document.createElement('div');
      g.className = 'hint';
      g.textContent = T('stamina.faintMsg');
      w.appendChild(g);

      App._title(w, T('settings.data'));
      var row = document.createElement('div');
      row.className = 'btn-row';
      var bTest = document.createElement('button');
      bTest.className = 'btn'; bTest.textContent = T('settings.testLlm');
      bTest.onclick = function () { App._testLlm(); };
      var bTts = document.createElement('button');
      bTts.className = 'btn'; bTts.textContent = T('settings.testTts');
      bTts.onclick = function () { App._testTts(); };
      row.appendChild(bTest); row.appendChild(bTts);
      w.appendChild(row);

      var row2 = document.createElement('div');
      row2.className = 'btn-row';
      var bExp = document.createElement('button');
      bExp.className = 'btn'; bExp.textContent = T('settings.export');
      bExp.onclick = function () {
        var txt = Config.exportJSON();
        if (navigator.clipboard) navigator.clipboard.writeText(txt);
        App.toast(I18n.t('toast.copied'));
        console.log(txt);
      };
      var bImp = document.createElement('button');
      bImp.className = 'btn'; bImp.textContent = T('settings.import');
      bImp.onclick = function () {
        Dialog.prompt(T('settings.import'), '', { multi: true, placeholder: '{ ... }' }).then(function (txt) {
          if (!txt) return;
          try { Config.importJSON(txt); App.buildSettings(); App.buildCharaForm();
                App.toast(I18n.t('toast.saved')); }
          catch (e) { App.toast('Could not parse: ' + e.message, true); }
        });
      };
      row2.appendChild(bExp); row2.appendChild(bImp);
      w.appendChild(row2);

      /* local_save_data_eraser.dart equivalent. */
      var bErase = document.createElement('button');
      bErase.className = 'btn danger'; bErase.textContent = T('settings.erase');
      bErase.onclick = function () {
        App.openModal({
          title: T('settings.erase'),
          okLabel: T('settings.eraseOk'),
          build: function (body) {
            var p = document.createElement('p');
            p.className = 'onb-sub';
            p.textContent = T('settings.eraseMsg');
            body.appendChild(p);
          },
          onOk: function () {
            Config.eraseAll();
            location.reload();
          }
        });
      };
      var row3 = document.createElement('div');
      row3.className = 'btn-row';
      row3.appendChild(bErase);
      w.appendChild(row3);
    },

    _testLlm: function () {
      var llm = Config.section('llm');
      if (!llm.baseUrl) { App.toast(I18n.t('toast.needUrl'), true); return; }
      App.toast('...');
      Engine.complete('You are a friendly voice.', 'Say hello in one short spoken line.')
        .then(function (r) { App.toast('OK: ' + String(r || '').slice(0, 80)); })
        .catch(function (e) { App.toast('FAIL: ' + e.message, true); });
    },

    _testTts: function () {
      App.toast('...');
      Engine.speak('Hey, can you hear me?').then(function (url) {
        if (!url) { App.toast('voice off'); return; }
        App.playUrl(url);
        App.toast('OK');
      }).catch(function (e) { App.toast('FAIL: ' + e.message, true); });
    },

    /* ---------------------------------------------- character editor
       companion-chat: the active card is editable (persona fields), a Live2D
       folder or zip can be imported as a new character, and the emotion ->
       expression/motion mapping the renderer uses can be overridden per card.
       Built-in cards edited here become custom copies (Characters.upsert). */
    _buildCharacterEditor: function (w) {
      var card = Characters.active();
      if (!card) return;
      var tc = function (k, f) { return I18n.tc(k, f); };
      App._title(w, tc('chara.card', 'Character') + ' \u2014 ' + card.name);
      var hint = document.createElement('div');
      hint.className = 'hint';
      var pk = card.pack || {};
      hint.textContent = (card.builtin ? 'built-in' : 'custom') + ' \u00b7 renderer: ' + (pk.renderer || 'none') +
        (pk.source === 'idb' ? ' \u00b7 imported pack (' + Math.round((pk.bytes || 0) / 1048576) + ' MB)' : '') +
        (pk.media_required ? ' \u00b7 media: ' + (pk.media_note || 'restore required') : '');
      w.appendChild(hint);

      var edit = function (field) {
        return function (v) {
          var cur = Characters.get(card.id) || card;
          var next = JSON.parse(JSON.stringify(cur));
          delete next.builtin;
          next[field] = v;
          Characters.upsert(next);
        };
      };
      App._field(w, tc('chara.name', 'Name'), card.name, edit('name'));
      App._field(w, tc('chara.nickname', 'Nickname'), card.nickname || '', edit('nickname'));
      App._field(w, tc('chara.description', 'About'), card.description || '', edit('description'));
      App._field(w, tc('chara.personality', 'Personality'), card.personality || '', edit('personality'));
      App._field(w, tc('chara.speech', 'Speech style'), card.speech_style || '', edit('speech_style'));
      App._field(w, tc('chara.likes', 'Likes'), card.likes || '', edit('likes'));
      App._field(w, tc('chara.dislikes', 'Dislikes'), card.dislikes || '', edit('dislikes'));
      App._portraitRow(w, card, edit('pfp'));

      /* ---- voice (OmniVoice): normal + asmr presets, see providers/tts-omnivoice.js */
      App._title(w, tc('chara.voice', 'Voice'));
      var voiceEdit = function (key) {
        return function (v) {
          var cur = Characters.get(card.id) || card;
          edit('voice')(Object.assign({}, cur.voice || {}, (function () { var o = {}; o[key] = v || null; return o; })()));
        };
      };
      var vc = card.voice || {};
      App._field(w, tc('chara.voiceRef', 'Voice reference clip'), vc.ref_audio || '', voiceEdit('ref_audio'),
        { hint: tc('chara.voiceRefHint', 'The clip lives on the PC running OmniVoice, not in this app. Copy it into the OmniVoice folder’s ref/ (or ref-voice-ai/) and enter the path relative to that folder, e.g. ref/mychar.wav. Empty = the server’s default voice.') });
      App._field(w, tc('chara.voiceInstruct', 'Voice style (no clip)'), vc.instruct || '', voiceEdit('instruct'),
        { hint: tc('chara.voiceInstructHint', 'Only used when there is no reference clip, e.g. "female, young adult".') });
      App._field(w, tc('chara.asmrRef', 'ASMR (whisper) reference clip'), vc.asmr_ref || '', voiceEdit('asmr_ref'),
        { hint: tc('chara.asmrRefHint', 'A whispered recording of the same voice, same folder rule. Empty = ASMR mode uses the normal voice with the effect below.') });
      App._select(w, tc('chara.asmrFx', 'ASMR effect'), vc.asmr_fx || 'close',
        ['close', 'room', 'drift'].map(function (x) { return { v: x, t: x }; }), voiceEdit('asmr_fx'));
      var bTest = document.createElement('button'); bTest.type = 'button'; bTest.className = 'btn';
      bTest.textContent = tc('chara.voiceTest', 'Test voice');
      bTest.onclick = function () { App._testTts(); };
      var tr = document.createElement('div'); tr.className = 'btn-row'; tr.appendChild(bTest); w.appendChild(tr);

      /* ---- Live2D: framing, motions per emotion, taps, idle (Cubism packs) */
      if (pk.renderer === 'cubism') App._buildCubismEditor(w, card);

      /* import + delete */
      App._title(w, tc('chara.import', 'Import a Live2D character'));
      var h3 = document.createElement('div'); h3.className = 'hint';
      h3.textContent = tc('chara.import.hint', 'A folder or .zip with a .model3.json, its .moc3, textures, expressions and motions. Stored in this app only.');
      w.appendChild(h3);
      var row = document.createElement('div'); row.className = 'btn-row';
      var zipIn = document.createElement('input'); zipIn.type = 'file'; zipIn.accept = '.zip,application/zip'; zipIn.style.display = 'none';
      var dirIn = document.createElement('input'); dirIn.type = 'file'; dirIn.style.display = 'none';
      dirIn.setAttribute('webkitdirectory', ''); dirIn.setAttribute('directory', ''); dirIn.multiple = true;
      var bZip = document.createElement('button'); bZip.type = 'button'; bZip.className = 'btn'; bZip.textContent = tc('chara.import.zip', 'Import .zip');
      var bDir = document.createElement('button'); bDir.type = 'button'; bDir.className = 'btn'; bDir.textContent = tc('chara.import.folder', 'Import folder');
      bZip.onclick = function () { zipIn.click(); };
      bDir.onclick = function () { dirIn.click(); };
      zipIn.onchange = function () { if (zipIn.files[0]) App._importPack(PackFS.fromZip(zipIn.files[0]), zipIn.files[0].name); zipIn.value = ''; };
      dirIn.onchange = function () { if (dirIn.files.length) App._importPack(PackFS.fromFileList(dirIn.files), dirIn.files[0].webkitRelativePath.split('/')[0]); dirIn.value = ''; };
      row.appendChild(bZip);
      /* the Android file picker has no folder mode */
      if (!/Android/i.test(navigator.userAgent)) row.appendChild(bDir);
      row.appendChild(zipIn); row.appendChild(dirIn);
      w.appendChild(row);

      /* card JSON in/out: share a persona without the model files */
      var row2 = document.createElement('div'); row2.className = 'btn-row';
      var bExp = document.createElement('button'); bExp.type = 'button'; bExp.className = 'btn';
      bExp.textContent = tc('chara.export', 'Export card JSON');
      bExp.onclick = function () {
        var cur = JSON.parse(JSON.stringify(Characters.get(card.id) || card));
        delete cur.builtin;
        var txt = JSON.stringify(cur, null, 2);
        if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(function () {});
        Dialog.prompt(tc('chara.exportHint', 'Copied to the clipboard. Paste it into another install with \u201cImport card JSON\u201d.'), txt, { multi: true, title: cur.name, ok: tc('dlg.ok', 'OK') });
      };
      var bCard = document.createElement('button'); bCard.type = 'button'; bCard.className = 'btn';
      bCard.textContent = tc('chara.importCard', 'Import card JSON');
      bCard.onclick = function () {
        Dialog.prompt(tc('chara.importCardHint', 'Paste a card exported from this app. The model files stay as they are; persona, voice and mapping are replaced.'), '', { multi: true, title: tc('chara.importCard', 'Import card JSON') }).then(function (txt) {
          if (!txt) return;
          var obj;
          try { obj = JSON.parse(txt); } catch (e) { App.toast('Could not parse: ' + e.message, true); return; }
          if (!obj || typeof obj !== 'object') { App.toast('not a card', true); return; }
          var cur = Characters.get(card.id) || card;
          var next = Object.assign({}, obj, { id: cur.id, pack: Object.assign({}, cur.pack || {}, (obj.pack && cur.pack) ? {
            emotions: obj.pack.emotions, idle: obj.pack.idle, tap: obj.pack.tap,
            scale: obj.pack.scale, offsetY: obj.pack.offsetY, anchor: obj.pack.anchor } : {}) });
          delete next.builtin;
          Object.keys(next.pack).forEach(function (k) { if (next.pack[k] === undefined) delete next.pack[k]; });
          Characters.upsert(next);
          App.setCharacter(card.id).then(function () { App.buildCharaForm(); App.buildSettings(); App.toast(I18n.t('toast.saved')); });
        });
      };
      row2.appendChild(bExp); row2.appendChild(bCard);
      w.appendChild(row2);

      if (!card.builtin) {
        var row3 = document.createElement('div'); row3.className = 'btn-row';
        var bDel = document.createElement('button'); bDel.type = 'button'; bDel.className = 'btn danger';
        bDel.textContent = tc('chara.delete', 'Delete this character');
        bDel.onclick = function () {
          Dialog.confirm(tc('chara.deleteConfirm', 'History, memory and the imported model go with it.'), { title: card.name, danger: true, ok: tc('chara.delete', 'Delete this character') }).then(function (ok) {
            if (!ok) return;
            return Importer.remove(card.id).then(function () {
              return App.setCharacter(Characters.activeId());
            }).then(function () {
              App.buildCharaForm(); App.buildSettings();
              App.toast('deleted');
            });
          });
        };
        row3.appendChild(bDel);
        w.appendChild(row3);
      }
    },

    /* Portrait: an image file, shrunk to 256 px and stored on the card as a
       data URL (card.pfp — the log/drawer avatar). */
    _portraitRow: function (w, card, save) {
      var tc = function (k, f) { return I18n.tc(k, f); };
      var row = document.createElement('div'); row.className = 'pfp-row';
      var img = document.createElement('img');
      img.src = card.pfp || App._initialAvatar(card.name);
      var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.style.display = 'none';
      var bPick = document.createElement('button'); bPick.type = 'button'; bPick.className = 'btn';
      bPick.textContent = tc('chara.portrait', 'Portrait');
      bPick.onclick = function () { inp.click(); };
      inp.onchange = function () {
        var f = inp.files[0]; inp.value = '';
        if (!f) return;
        var url = URL.createObjectURL(f);
        var im = new Image();
        im.onload = function () {
          var side = 256, c = document.createElement('canvas'); c.width = side; c.height = side;
          var k = Math.max(side / im.width, side / im.height);
          var dw = im.width * k, dh = im.height * k;
          c.getContext('2d').drawImage(im, (side - dw) / 2, (side - dh) / 2, dw, dh);
          URL.revokeObjectURL(url);
          var data = c.toDataURL('image/jpeg', 0.85);
          img.src = data; save(data); App.applyCharacter(Characters.get(card.id));
        };
        im.onerror = function () { URL.revokeObjectURL(url); App.toast('not an image', true); };
        im.src = url;
      };
      var bClr = document.createElement('button'); bClr.type = 'button'; bClr.className = 'btn';
      bClr.textContent = tc('chara.portraitClear', 'Clear');
      bClr.onclick = function () { save(null); img.src = App._initialAvatar(card.name); App.applyCharacter(Characters.get(card.id)); };
      row.appendChild(img); row.appendChild(bPick); row.appendChild(bClr); row.appendChild(inp);
      w.appendChild(row);
    },

    /* Live2D section of the character editor. Everything edits card.pack and
       is applied live: framing through CubismBackend.setFraming, mappings by
       reloading the pack. Prefix lists are comma separated; a "play" button
       previews a random clip matching the list, exactly as a reaction would. */
    _buildCubismEditor: function (w, card) {
      var tc = function (k, f) { return I18n.tc(k, f); };
      var live = Stage.kind() === 'cubism' && Characters.activeId() === card.id && window.CubismBackend && CubismBackend.model;
      if (!live) {
        App._title(w, tc('chara.live2d', 'Live2D'));
        var h = document.createElement('div'); h.className = 'hint';
        h.textContent = tc('chara.mapping.none', 'Load this character on the stage to edit its expressions.');
        w.appendChild(h);
        return;
      }
      var pk = card.pack || {};
      var maps = CubismBackend.maps || { emotions: {}, idle: {}, tap: {} };
      var caps = Stage.capabilities() || { emotions: [], parts: [] };
      var editPack = function (fn, reload) {
        var cur = Characters.get(card.id) || card;
        var next = JSON.parse(JSON.stringify(cur));
        delete next.builtin;
        next.pack = next.pack || {};
        fn(next.pack);
        Characters.upsert(next);
        if (reload) Stage.loadPack(Characters.get(card.id));
        return next.pack;
      };
      var parseList = function (v) { return String(v || '').split(/[,\s]+/).filter(Boolean); };
      var prefixesOf = function (names) {
        var seen = {};
        names.forEach(function (n) {
          var m = /^([A-Za-z]+[-_])/.exec(n);
          if (m) seen[m[1]] = true;
        });
        return Object.keys(seen).sort();
      };
      var prefixRow = function (label, value, onChange) {
        var row = document.createElement('div'); row.className = 'field-row tight';
        var f = App._field(row, label, (value || []).join(', '), function (v) { onChange(parseList(v)); });
        var b = document.createElement('button'); b.type = 'button'; b.className = 'btn';
        b.textContent = '\u25B6';
        b.title = tc('chara.play', 'Play a matching motion');
        b.onclick = function () {
          var list = parseList(f.querySelector('input').value);
          var name = CubismBackend.previewMotion(list);
          App.toast(name || tc('chara.noMotion', 'no motion matches'), !name);
        };
        row.appendChild(b);
        w.appendChild(row);
      };

      /* framing */
      App._title(w, tc('chara.framing', 'Framing'));
      var framing = function (key, v) { editPack(function (p) { p[key] = v; }); CubismBackend.setFraming((Characters.get(card.id) || card).pack); };
      App._range(w, tc('chara.scale', 'Size'), pk.scale != null ? pk.scale : 1.35, function (v) { framing('scale', v); }, { min: 0.5, max: 3, step: 0.01 });
      App._range(w, tc('chara.offsetY', 'Vertical position'), pk.offsetY || 0, function (v) { framing('offsetY', v); }, { min: -1, max: 1, step: 0.01, def: 0 });
      App._select(w, tc('chara.anchor', 'Anchor'), pk.anchor || 'top',
        [{ v: 'top', t: tc('chara.anchor.top', 'Top (head under the bar, body cropped)') }, { v: 'fit', t: tc('chara.anchor.fit', 'Fit (whole model visible)') }],
        function (v) { framing('anchor', v); });

      /* motions available (own + shared) */
      var names = CubismBackend.motionNames();
      var hint = document.createElement('div'); hint.className = 'hint'; hint.style.marginBottom = '12px';
      hint.textContent = tc('chara.prefixes', 'Motion prefixes available') + ': ' + prefixesOf(names).join(' ');
      App._title(w, tc('chara.mapping', 'Expressions and motions'));
      w.appendChild(hint);

      /* emotions: expression + motion prefixes */
      var exprs = caps.emotions || [];
      (card.emotions || []).forEach(function (emo) {
        var rule = maps.emotions[emo] || {};   /* effective (pack rules merged onto the automatic mapping) */
        var setRule = function (patch) {
          editPack(function (p) {
            p.emotions = p.emotions || {};
            var prev = p.emotions[emo];
            if (typeof prev === 'string') prev = { expression: prev };
            p.emotions[emo] = Object.assign({ expression: rule.expression || null, motions: rule.motions || [] }, prev || {}, patch);
          }, true);
        };
        var opts = [{ v: '', t: '(none)' }].concat(exprs.map(function (e) { return { v: e, t: e }; }));
        App._select(w, emo, rule.expression || '', opts, function (v) { setRule({ expression: v || null }); });
        prefixRow(emo + ' \u00b7 ' + tc('chara.motions', 'motions'), rule.motions || [], function (list) { setRule({ motions: list }); });
      });

      /* taps */
      App._title(w, tc('chara.taps', 'Tap reactions'));
      var parts = (caps.parts && caps.parts.length) ? caps.parts : Capabilities.ZONES.map(function (z) { return z.name; });
      parts.forEach(function (part) {
        var cur = maps.tap[part] || [];
        prefixRow(part, cur, function (list) { editPack(function (p) { p.tap = p.tap || {}; p.tap[part] = list; }, true); });
      });

      /* idle */
      App._title(w, tc('chara.idle', 'Idle'));
      var idle = maps.idle || {};
      prefixRow(tc('chara.idleLoop', 'Loop'), idle.loop || [], function (list) { editPack(function (p) { p.idle = p.idle || {}; p.idle.loop = list; }, true); });
      prefixRow(tc('chara.idleAmbient', 'Ambient (random clips)'), idle.ambient || [], function (list) { editPack(function (p) { p.idle = p.idle || {}; p.idle.ambient = list; }, true); });
      var gap = idle.gap || [9, 24];
      App._range(w, tc('chara.idleGap', 'Seconds between ambient clips') + ' (' + gap[0] + '\u2013' + gap[1] + ')', gap[1], function (v) {
        editPack(function (p) { p.idle = p.idle || {}; p.idle.gap = [Math.max(3, Math.round(v / 2.5)), Math.round(v)]; }, true);
      }, { min: 6, max: 90, step: 1 });
      App._switch(w, tc('chara.sharedMotions', 'Use the shared motion library'), pk.shared_motions !== false, function (on) {
        editPack(function (p) { if (on) delete p.shared_motions; else p.shared_motions = false; }, true);
      });
    },

    _importPack: function (filesP, label) {
      var tc = function (k, f) { return I18n.tc(k, f); };
      var name;
      Dialog.prompt(tc('chara.name', 'Name'), String(label || '').replace(/\.zip$/i, ''), { title: tc('chara.import', 'Import a Live2D character') }).then(function (v) {
        name = (v || '').trim();
        if (!name) throw new Error('cancelled');
        App.toast('importing\u2026');
        return filesP;
      }).then(function (files) {
        var m3 = PackFS.findModel3(files);
        if (!m3.length) throw new Error('no .model3.json in the pack');
        var pickP = m3.length > 1 ? Dialog.choose(tc('chara.whichModel', 'Which model?'), m3) : Promise.resolve(m3[0]);
        return pickP.then(function (model) {
          if (!model) throw new Error('cancelled');
          return Importer.fromFiles(files, { name: name, model: model });
        });
      }).then(function (r) {
        return App.setCharacter(r.card.id).then(function () { return r; });
      }).then(function (r) {
        App.buildCharaForm(); App.buildSettings();
        App.toast(r.card.name + ': ' + r.caps.expressions.length + ' expressions, ' + r.motions + ' motions');
      }).catch(function (e) {
        if (e && e.message === 'cancelled') return;
        App.toast('import failed: ' + (e && e.message ? e.message : e), true);
      });
    },

    buildCharaForm: function () {
      var w = document.getElementById('chara-form');
      w.innerHTML = '';
      var T = function (k) { return I18n.t(k); };
      var c = Config.section('chara'), p = Config.section('profile');
      App._buildCharacterEditor(w);

      App._title(w, I18n.tc('profile.title', 'You (player profile)'));
      App._field(w, T('onb.name'), p.name,
        function (v) { Config.set('profile.name', v); });
      w.appendChild(Onboarding.birthdayPicker(T('onb.birthday'), 'pf-bday', p.birthday,
        function (v) { Config.set('profile.birthday', v); }));
      App._select(w, T('onb.gender'), p.gender || '', [
        { v: '', t: '—' },
        { v: 'female', t: T('onb.gender.female') },
        { v: 'male', t: T('onb.gender.male') },
        { v: 'other', t: T('onb.gender.other') }
      ], function (v) { Config.set('profile.gender', v); });
      App._field(w, T('profile.appearance'), p.appearance,
        function (v) { Config.set('profile.appearance', v); });
      App._field(w, T('profile.background'), p.background,
        function (v) { Config.set('profile.background', v); });
      App._field(w, T('profile.hobby'), p.hobby,
        function (v) { Config.set('profile.hobby', v); });
      App._field(w, T('profile.interest'), p.interest,
        function (v) { Config.set('profile.interest', v); });
      App._field(w, T('profile.futureGoals'), p.futureGoals,
        function (v) { Config.set('profile.futureGoals', v); });
      App._field(w, T('profile.personality'), p.personality,
        function (v) { Config.set('profile.personality', v); });

      App._title(w, T('slot.title'));
      App._renderSlots(w);

      var row = document.createElement('div');
      row.className = 'btn-row';
      var b = document.createElement('button');
      b.className = 'btn primary'; b.textContent = I18n.tc('chara.save', 'Save and back to chat');
      b.onclick = function () { App.toast(I18n.t('toast.saved')); App.showView('talk'); };
      row.appendChild(b);
      var b2 = document.createElement('button');
      b2.className = 'btn danger'; b2.textContent = I18n.tc('chara.clearHistory', 'Clear conversation history');
      b2.onclick = function () {
        Dialog.confirm(I18n.tc('memory.clearConfirm', 'Clear this character\u2019s conversation history?'), { danger: true }).then(function (ok) {
          if (ok) { App.history = []; if (window.Engine) Engine.clearHistory(); App.toast('Cleared'); }
        });
      };
      row.appendChild(b2);
      w.appendChild(row);
    },

    /* -------------------------------------------------------- save slots */
    _loadSlots: function () {
      var slots;
      try { slots = JSON.parse(localStorage.getItem(SAVE_KEY) || '[]'); }
      catch (e) { slots = []; }
      while (slots.length < 3) slots.push(null);
      return slots.slice(0, 3);
    },

    _writeSlots: function (slots) {
      try { localStorage.setItem(SAVE_KEY, JSON.stringify(slots)); } catch (e) {}
    },

    _snapshot: function () {
      var st = Config.section('state');
      var place = World.find(st.stage);
      return {
        at: Date.now(),
        day: st.day,
        label: place ? (place.area + ' / ' + place.stage) : st.stage,
        settings: JSON.parse(Config.exportJSON()),
        history: App.history,
        memory: App.memory,
        longmem: window.Memory ? Memory.snapshot() : null,
        game: Game.snapshot(),
        alarms: Alarm.items
      };
    },

    _applySnapshot: function (snap) {
      if (!snap || !snap.settings) return;
      Config.importJSON(JSON.stringify(snap.settings));
      App.history = snap.history || [];
      App.memory = snap.memory || [];
      App.saveMemory();
      if (window.Memory) Memory.restore(snap.longmem);
      Game.restoreSnapshot(snap.game);
      Quests.ensure();
      Alarm.items = snap.alarms || [];
      Alarm.save();
      var st = Config.section('state');
      Avatar.loadSkin(st.skin);
      App._loadSceneFor(st.stage, st.tod);
      if (window.Sound) {
        Sound.setPlace(st.stage, st.tod, World.backgroundFor(st.stage));
        Sound.setRoute('talk');
      }
      App.updateHud();
      App.renderWorld();
      Alarm.render(document.getElementById('alarm-list'), App.playFile);
      Quests.render(App._el('quest-list'), {});
      App.renderMemory();
      App.buildSettings();
      App.buildCharaForm();
      App.renderSkins();
      I18n.setLang(Config.section('app').lang);
      I18n.apply(document);
    },

    _renderSlots: function (wrap) {
      var slots = App._loadSlots();
      slots.forEach(function (s, i) {
        var row = document.createElement('div');
        row.className = 'slot-row';
        var info = document.createElement('div');
        info.className = 'slot-info';
        if (s) {
          var d = new Date(s.at);
          info.textContent = (i + 1) + '. ' + (s.label || '') +
            ' · day ' + (s.day || 1) + ' · ' +
            'Lv' + (s.game ? 1 + Math.floor(Math.sqrt((s.game.exp_total || 0) / 30)) : '?') + ' · ' +
            d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
        } else {
          info.textContent = (i + 1) + '. ' + I18n.t('slot.empty');
        }
        var save = document.createElement('button');
        save.type = 'button';
        save.className = 'mini-btn';
        save.textContent = I18n.t('slot.save');
        save.onclick = function () {
          var all = App._loadSlots();
          all[i] = App._snapshot();
          App._writeSlots(all);
          App.buildCharaForm();
          App.toast(I18n.t('toast.saved'));
        };
        var load = document.createElement('button');
        load.type = 'button';
        load.className = 'mini-btn';
        load.textContent = I18n.t('slot.load');
        load.disabled = !s;
        load.onclick = function () {
          var all = App._loadSlots();
          if (!all[i]) return;
          App._applySnapshot(all[i]);
          App.toast(I18n.t('slot.load'));
          App.showView('talk');
        };
        row.appendChild(info);
        row.appendChild(save);
        row.appendChild(load);
        wrap.appendChild(row);
      });
    }
  };

  global.App = App;
  document.addEventListener('DOMContentLoaded', function () { App.init(); });
})(window);
