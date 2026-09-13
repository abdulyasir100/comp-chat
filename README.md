# companion-chat

A character-agnostic companion chat client, forked from [Ryza Chat](https://github.com/zeroa234/ryza-ai-revive).
The brain is an **embedded JavaScript engine** (`web/engine/`) — no backend to install. Each
character is a card (`web/assets/characters/<id>/character.json`) with its own persistent history,
long-term memory and affection; switching characters swaps all of it. The LLM is any
OpenAI-compatible endpoint (OpenRouter, Grok, Groq, Cerebras, LM Studio, a local Claude bridge)
and speech is [OmniVoice](https://github.com/k2-fsa/OmniVoice) with a per-character reference voice.

- One LLM call per turn returns JSON: the spoken line in every needed language (subtitle + dub),
  the face to make, and a verdict (`loved | liked | neutral | annoyed`) that moves affection by a
  fixed amount — the model picks the feeling, code picks the number.
- Design notes: `docs/superpowers/specs/2026-09-12-engine-design.md`. Tests: `node scripts/engine_regression.js`.
- **Renderers.** `web/renderers/` puts a small `Stage` interface over two backends: ryza's
  Spine rig (`spine.js`) and a Live2D Cubism backend (`cubism.js`, ported from live2d-companion).
  A character card's `pack.renderer` picks one; `pack.emotions` maps card emotions onto the
  model's expressions and motion prefixes, `pack.idle` / `pack.tap` drive idle life and pokes.
- **Live2D runtime.** `web/vendor/cubism-framework.js` is the Cubism Web Framework bundled once
  with esbuild from `scripts/cubism_bundle_entry.ts` (Live2D Open Software License, in git).
  The Cubism Core is proprietary and NOT in git: `python scripts/fetch_cubism_core.py`.
- **Importing your own Live2D character.** Character screen -> "Import .zip" / "Import folder"
  (a model3.json with its moc3, textures, expressions, motions). Files are stored in the app's
  IndexedDB (`web/engine/packfs.js`), never on disk, so it works the same in the browser, the
  Electron shell and the Android APK. `web/engine/capabilities.js` reads what the model
  declares and derives the emotion, idle and tap mapping automatically; models without hit
  areas get Head / Body / Legs zones from the drawn art. Edit persona and expression mapping
  in the same screen; delete removes the pack, history, memory and affection together.
- **Trimmed.** The shop, world map, quests, daily login, inventory, stamina HUD and skin views
  are hidden from the page (their modules still load, so nothing else had to change).
- **Claude as an API.** The companion `claude-bridge` project serves a Claude Code session as an OpenAI-compatible
  endpoint; set it as the LLM base URL like any other provider.
- **Sample model.** `python scripts/fetch_sample_model.py` downloads Live2D's free "Haru" into
  `web/assets/models/haru/` (used by the tests and handy as an import-test zip). Ryza's Spine
  assets are not shipped in public builds (see "Runtime resources" and "Personal full build").
  Everything under `web/assets/models/` is ignored by git.

Everything below is the upstream Ryza Chat README, still accurate for the hosts and build scripts.

---

# Ryza Chat

A local-first client for a conversational agent with a real-time 2D avatar.

The application is a static HTML/JavaScript runtime. Thin native hosts load the same tree on Windows (Electron) and Android (WebView). Language and speech models are attached at run time through operator-configured HTTP APIs (OpenAI-compatible chat completions, plus optional TTS backends).

面向实时二维立绘的本地对话客户端。应用核为静态 HTML/JavaScript；Windows（Electron）与 Android（WebView）仅提供宿主。语言模型与语音合成在运行时接入操作者配置的 HTTP API。

Version **1.2.15**. License: [MIT](LICENSE). Releases: [GitHub Releases](https://github.com/zeroa234/ryza-ai-revive/releases).

---

## Architecture

| Layer | Role |
|---|---|
| `web/` | Shared client: UI, avatar renderer, local state, i18n |
| `desktop/` | Frameless Electron host (`ryza://app/`) |
| `android/` | `Activity` + local `AssetServer` |
| `scripts/` | Dev server, indexes, packaging, regression tests |
| `config/` | Version pin (`version.json`) and provider templates |

The three hosts share one proxy contract, `GET/POST /_proxy`, so browser and WebView code can call operator endpoints without a CORS failure. The development server is `python scripts/serve.py` (`http://127.0.0.1:8765/`). A plain `http.server` is insufficient because it does not implement the proxy.

三端共用 `/_proxy`。开发请用 `scripts/serve.py`，不要用 `python -m http.server`。

Inference is not bundled. Settings require an OpenAI-compatible base URL, model identifier, and API key; TTS is optional and uses per-provider credential fields (`openai` / `qwen` / `fish`).

推理与语音不随仓库分发，由设置页配置。

Further module-level notes: [docs/PROJECT.md](docs/PROJECT.md).

---

## Capabilities

- Dialogue modes: chat, story, immersive, ASMR, text
- Spine 4.2 portrait and scene graph (posture, camera, tap hit-testing)
- Bring your own Live2D: import a zip/folder, it gets the shared motion library, automatic emotion/idle/tap mapping and a full character editor (see below)
- Two-layer session memory, independent of adventure logs
- Four language slots (UI, bundled voice, LLM output, TTS), seven UI locales
- Tagged replies for scene side effects; numeric deltas in a trailing `<state>` block (no function-calling requirement)

---

## Runtime resources

Structural tables (JSON, atlas, SVG) live in `web/assets/` and are versioned with the client. Large binaries (raster, audio, skeleton) are excluded from version control and restored before a full session or packaged build:

结构表随仓库版本管理；体积较大的栅格图、音频与骨骼二进制在完整运行或打包前本地恢复：

```powershell
python scripts/restore_media.py path\to\RyzaChat-1.2.15.apk
python scripts/restore_media.py path\to\win-unpacked\resources\web
```

If asset files change, regenerate indexes with `python scripts/build_indexes.py`.

### Voice reference clips (OmniVoice)

A character's `voice.ref_audio` is **not** a file in this app. It is a path on the PC that runs the
OmniVoice server, relative to the OmniVoice checkout, and the server only accepts files under its
`ref/`, `ref-voice-ai/` or `ref-voice-ai-pre-processed/` folders (no auth on that endpoint, so no
arbitrary paths). To give a character a voice:

1. copy a clean 5–15 s clip of the voice to `<OmniVoice>/ref/<name>.wav` on the voice PC;
2. in Settings → Character → "Voice reference clip" enter `ref/<name>.wav`.

Leave it empty to use whatever the server was started with (`--ref-audio`).

### Bring your own Live2D character

Settings → Character → **Import .zip** (or **Import folder** on desktop): any Cubism 3/4 model
(`.model3.json`, `.moc3`, textures, optional expressions/motions/physics). The files are stored in
the app's IndexedDB, so a single EXE/APK needs no writable asset folder, and the model appears as a
new card with:

- **Shared motion library** — `web/assets/motions/shared/` (190 clips, index in `index.json`) is
  merged after the pack's own motions for every Cubism card unless `pack.shared_motions` is `false`.
  The clips animate the standard Cubism parameters (head/body angles, eyes, mouth, breath); curves
  for parameters a model lacks are skipped by the framework, so any uploaded model gets emotion
  reactions, taps, ambient fidgets and an idle loop without shipping motions of its own. A pack's
  own clip wins over a shared clip of the same name.
- **Automatic mapping** (`engine/capabilities.js`) — expression names and motion prefixes are
  matched to the emotion list, idle loop/ambient clips and tap zones (hit areas, or the
  Head/Body/Legs bands when the model declares none). Card rules only override what they set: a
  bare expression string keeps the automatic motions.
- **Character editor** — persona fields, portrait (stored on the card), voice (reference clip,
  style hint, ASMR clip and effect, test button), framing (size, vertical position, anchor; applied
  live), per-emotion expression + motion prefixes with a ▶ preview, tap reactions per zone, idle
  loop/ambient/gap, and card JSON export/import (persona + mapping without the model files).

Dialogs (name on import, model picker, confirmations) are in-app (`js/dialog.js`): Electron has no
`window.prompt`, and the Android WebView needs `onShowFileChooser` for `<input type=file>` (wired in
`MainActivity.java`; the folder picker does not exist on Android, so it is zip-only there).

---

## Configuration and secrets

Copy `config/providers.example.json` to `config/providers.json` for local hydration. That file is gitignored. Packaged hosts do not embed it; keys remain in the app profile (`localStorage` or `%AppData%\RyzaChat`). `scripts/privacy_check.py` is a packaging gate: a non-zero exit aborts desktop and APK builds when a secret-shaped token or machine-local path would be included.

---

## Build

```powershell
python scripts/serve.py                          # browser
cd desktop; npm install; npx electron .          # desktop
powershell -File scripts/build_desktop.ps1       # NSIS installer
powershell -File scripts/setup_android_tools.ps1 # JDK 17 + SDK (once)
powershell -File scripts/build_apk.ps1           # APK
```

Android toolchain path: environment `RYZA_ANDROID_TOOLS`, or gitignored `config/android-tools.local.txt`.

---

## Personal full build (your own devices only)

```powershell
powershell -File scripts/build_desktop.ps1 -Full     # output/desktop/CompanionChat-Setup-<ver>-full.exe
powershell -File scripts/build_apk.ps1 -Full         # output/android/CompanionChat-<ver>-full.apk (~600 MB)
```

`-Full` stages **all** of `web/` verbatim: Ryza's Spine media, BGM and voice banks, backgrounds,
and every character card including the private ones. The privacy gates are skipped and the
artifacts get a `-full` suffix so they cannot be mistaken for a release. Never upload a `-full`
package anywhere. The plain builds stay scrubbed (tracked files + Cubism Core + fonts).

## Tests

```powershell
node scripts/boot_smoke.js
node scripts/game_logic_regression.js
node scripts/memory_regression.js
node scripts/motion_regression.js
node scripts/expression_coverage.js
python scripts/privacy_check.py web
```

Contribution rules: [CONTRIBUTING.md](CONTRIBUTING.md).

## Phase A notes (2026-09-13)

- Onboarding is one step (name, month/day birthday, gender). She learns the rest by talking; the
  old free-text questions, the prologue narration and the tutorial coach-marks are gone.
- Left drawer = destinations (Talk, Alarm, Language, Profile, Memories, New talk, Settings). The
  top-right grid button is quick access (Save data, Fullscreen, Show/hide character) and closes on
  an outside tap or by pressing it again.
- Dub language: Settings → "Dub language (voice)" wins over a card's `languages` pin; when the model
  omits the dub line the subtitle line is spoken in its own language instead.
- Live2D characters get Ryza's behaviours with their own clips: zone taps (Head/Body/Legs from
  `pack.tap`, hit areas first), a priority order idle < ambient < reaction, 0.5 s fades when a
  motion3 has none, and desktop cursor follow. Tap voice lines for non-Ryza packs are a Phase B item
  (pre-generate per pack with OmniVoice).
- Character import (zip/folder) stores the pack in IndexedDB; `voice.ref_audio` is a path on the
  OmniVoice host, set it in the character editor. See "Bring your own Live2D character".
- The daily login bonus is gone (module removed).
- Default card is Ryza (`assets/characters/index.json` order). The sample "Aria" card is gone.
  Public builds contain no licensed media, so Ryza shows the "media not installed" toast there;
  the personal `-Full` build (below) has everything.
