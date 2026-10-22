# src/stt — streaming speech-to-text

Free and local by default: no API keys, nothing leaves the Mac (Apple's on-device model or whisper.cpp).
With `SONIOX_API_KEY` set, live listening uses Soniox's cloud stream instead (much better partials,
Mandarin/English mixed in one sentence, detected language per final) and keeps the local engines as fallback.

| engine | what | when |
|---|---|---|
| `soniox` | `soniox.ts` → Soniox real-time WebSocket (`stt-rt-v5`), cloud, ~$0.12/h of open stream | default whenever `SONIOX_API_KEY` is set and Soniox knows the language (60 languages, no Cantonese) |
| `apple` | `tools/speech/bin/g2speech` → **SpeechAnalyzer / SpeechTranscriber** (macOS 26), on-device | default for its 30 locales |
| `apple` (legacy) | same binary, `SFSpeechRecognizer` with on-device recognition, tasks rolled over every ≤50 s | only if Speech Recognition is authorized and the locale lacks SpeechTranscriber |
| `whisper` | shared `whisper-server` (whisper.cpp, Metal) on energy-VAD utterances; partials re-transcribe the open utterance every 700 ms | other languages, `translateToEnglish`, or if apple fails |

`engine: "auto"` (the default) picks soniox when its key is set, else apple when it supports the
locale, otherwise whisper. `STT_ENGINE=soniox|apple|whisper` forces one (then failures are errors,
not fallbacks). If soniox can't start or gives up (bad key, offline, out of credit, 6 failed
reconnects) the stream continues on apple/whisper with the audio Soniox hadn't finalized replayed, and
emits one `fallback` event (the hub toasts it). If apple fails to start it falls back to whisper and
replays the buffered audio (up to 30 s), so nothing is lost.

## Soniox (cloud)

Put the key in `.env` as `SONIOX_API_KEY=` (console.soniox.com, pay-as-you-go) and restart the hub;
at start it checks the key (`[stt] soniox: key OK` in `~/Library/Logs/g2-hub.log`). A rejected key
benches Soniox until restart, a billing error for 10 min, so sessions go straight to the local engines.

- Auth: `Authorization: Bearer` header on the upgrade (never `api_key` in the start message).
- Start message: `pcm_s16le` 16 kHz mono, `language_hints` = the stream's language + `alsoLangs`
  (default `["en"]`, so a `zh-CN` translate session hints `["zh","en"]`), language identification,
  endpoint detection at the docs' low-latency settings (1.5 s max delay, level 2, sensitivity 0.3),
  `context.terms` Claude/Codex (+ `SONIOX_TERMS`, comma-separated).
- Events: partial = this utterance's final tokens + current non-final ones; final on `<end>`/`<fin>`
  or end of stream, with `detectedLang` (majority over the utterance), `confidence`, and `speaker`
  with `SONIOX_DIARIZATION=1` (then also one final per speaker turn).
- Robustness: audio not final yet is kept (up to 120 s) so a dropped socket reconnects with backoff
  and re-sends exactly that (with nothing to re-send, it reconnects when audio next arrives); a socket
  has to stay up 20 s to reset the 6-reconnect budget, so a server that accepts and then fails can't
  cause a reconnect loop; keepalive after 8 s without audio; renews the stream before the 300 min
  limit; `close()` sends the empty text frame and waits for `finished`.
- Cost: billing counts open time, so after `SONIOX_IDLE_CLOSE_S` (default 120, 0 = never) without
  speech, or without any audio at all (phone asleep), it closes the socket and reopens on speech with
  ~1 s of lead-in.
- Push-to-talk: `transcribeClip` streams the clip through the same engine; the batch path in
  `src/hub/stt.ts` uses `sonioxTranscribe` (a stream run on the buffer; the async file API would need an
  upload, a job and polling).
- Other knobs: `SONIOX_MODEL` (default `stt-rt-v5`), `SONIOX_REGION` (`eu`/`jp`/`in`), `SONIOX_WS_URL`.

Tests: `node --import tsx --test scripts/stt-soniox-test.ts` (offline, mock server speaking the
documented schema); `node --env-file-if-exists=.env --import tsx scripts/stt-live-test.mjs` (real API,
English + Mandarin + mixed + push-to-talk; `--bad-key` checks the auth-failure fallback without a key).

## Wispr Flow and OpenRouter (push-to-talk finals)

Both are request/response, so they transcribe a whole push-to-talk clip on release; the live words
while the button is held still come from the streaming engine, and if the clip engine fails the
streamed words are kept. `clipEngine()` in `src/hub/stt.ts` picks it: `STT_BATCH_ENGINE=wispr |
openrouter:<model> | none`, unset = Wispr when `WISPR_API_KEY` is set (`WISPR_PTT=0` turns that off).
It is also the batch path's first try.

- `wispr.ts`: Wispr Flow's Voice Interface API (api-docs.wisprflow.ai), REST `POST /api` with a
  Bearer key, base64 16 kHz PCM16 wav, `language` (one ISO 639-1 code skips detection), `context.app.type
  = "ai"` and `dictionary_context` (her names, Claude, Codex + `WISPR_TERMS`). Max 25 MB / 6 min. Access
  is by approval only (enterprise@wisprflow.ai), billed per usage token. A rejected key (401/403) benches
  it until restart, 402/429 for a while. `GET /warmup_dash` warms the connection when a press begins.
  As a live engine (`STT_ENGINE=wispr,...`) each pause-cut utterance is one request, finals only.
- `openrouter.ts`: OpenRouter's `POST /v1/audio/transcriptions` (`input_audio` base64 wav + `model`,
  `language`), on `OPENROUTER_API_KEY`. On a 6 s `say` clip (Oct 2026): deepgram/nova-3 ~0.25 s,
  assemblyai/universal-3-6-pro ~0.55 s, elevenlabs/scribe-v2 ~0.7 s, all 1 word off; Apple on-device
  ~0.4 s, 2-3 words off. None of them take `keyterms` through OpenRouter.

Tests: `node --import tsx --test scripts/stt-wispr-test.ts` (offline mocks of both APIs).

## Setup (already done on this Mac)

```sh
tools/speech/build.sh                 # -> tools/speech/bin/g2speech  (Swift 6.3, macOS 26 SDK)
brew install whisper-cpp              # whisper-server, whisper-cli
mkdir -p ~/.g2-orchestrator/models && cd ~/.g2-orchestrator/models
curl -LO https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin        # 148 MB, English default
curl -LO https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin  # 190 MB, used for non-English
```

Overrides: `G2SPEECH_BIN`, `WHISPER_SERVER_BIN`, `WHISPER_MODEL` (forces one model for all languages).

## Authorization (TCC)

- **SpeechAnalyzer path (what runs now): no prompt, nothing to approve.** It works from a plain
  child process of node / Terminal / the Claude app. The first use of a locale whose model isn't
  installed downloads it from Apple automatically (you'll get a `status` event; es-ES took a few
  seconds). Installed now: en-*, es-*.
- **SFSpeechRecognizer path (legacy fallback) needs "Speech Recognition" permission.** macOS
  attributes a CLI's request to the *responsible* app (Terminal, node's parent, Claude…) and kills
  the process if that app lacks `NSSpeechRecognitionUsageDescription`. g2speech embeds its own
  Info.plist and re-execs itself with responsibility disclaimed, so the grant belongs to g2speech
  itself. To grant it once, run in Terminal and click **Allow**:
  `tools/speech/bin/g2speech --authorize`
  (check with `--auth-status`). Not granted on this Mac yet; not needed for the 30 SpeechTranscriber
  locales. Rebuilding changes the ad-hoc signature, which may make macOS ask again.

## Measured on this Mac (M-series, macOS 26.6.2), audio streamed in real time, 40 ms chunks

`npx tsx src/stt/selftest.ts [--long] [--engine apple|whisper] [--fast]` synthesizes speech with
`say`, converts with `afconvert`, streams it through `createStreamingSTT` and checks the words.
Last run: **SELFTEST PASS** (both engines, English + Spanish, plus a 78 s continuous stream).

| | first partial after speech onset* | final after last word | accuracy |
|---|---|---|---|
| apple, en-US | ~0.54 s | 1.5–1.7 s | exact |
| apple, es-ES | ~0.56 s | ~2.0 s | exact |
| apple, 78 s continuous | ~0.54 s | 0.45–1.5 s (22 finals) | exact, no gaps |
| whisper base, en | ~0.45 s | 0.61–0.65 s | exact |
| whisper small-q5_1, es | ~1.2 s | ~0.72 s | exact (base got 3 Spanish words wrong) |

\* includes the time to say the first word. Apple partials then update word-by-word (~3-4 per second);
whisper partials every ~0.7 s. Startup: apple ~0.1 s; whisper-server model load 0.5 s (base) /
3.5 s (small) once per hub process (call `warmUp()` at hub start to hide it).

Apple's finals come from its own endpointing (~1 s after a pause). Forcing an earlier finalize
(`g2speech --force-finalize 0.6`) cuts ~0.5 s but on macOS 26.6 the next utterance then sometimes
comes back as punctuation only, so it's off. For a copilot, display partials and treat finals as commits.

## Languages

`await listLanguages()` →
- `apple` (SpeechTranscriber, 30): de-AT/CH/DE, en-AU/CA/GB/IE/IN/NZ/SG/US/ZA, es-CL/ES/MX/US,
  fr-BE/CA/CH/FR, it-CH/IT, ja-JP, ko-KR, pt-BR/PT, yue-CN, zh-CN/HK/TW
- `appleLegacy` (SFSpeechRecognizer, 63, needs permission; only en-US is on-device here)
- `whisper` (~100 ISO codes). Pass a BCP-47 tag (`"ar-SA"` → `ar`) or `"auto"` to detect.

## API — exactly what the hub should call

```ts
import { createStreamingSTT, listLanguages, warmUp, stopWhisperServer } from "../stt/index.js";

const stt = createStreamingSTT({
  lang: "en-US",            // speaker's language (translation input: e.g. "es-ES")
  engine: "auto",           // "soniox" | "apple" | "whisper" | "auto"
  sampleRate: 16000,        // s16le mono
  // alsoLangs: ["en"],     // soniox: other languages in the audio (language hints for code-switching)
  // silenceMs: 600,        // whisper: pause that ends an utterance
  // translateToEnglish: true  // whisper's built-in X->English translation (forces whisper)
});
stt.on("partial", (e) => {/* e.text = whole open utterance so far: REPLACE the live line */});
stt.on("final",   (e) => {/* e.text = finished utterance: append to transcript */});
stt.on("ready",   (i) => {/* { engine: "apple"|"whisper"|"soniox", ... } — actual engine after any fallback */});
stt.on("status",  (m) => {/* e.g. model download, fallback notice, soniox reconnect */});
stt.on("fallback",(f) => {/* { from: "soniox", to, reason } — once, when the cloud engine hands over */});
stt.on("error",   (err) => {/* only fatal problems; safe to ignore */});
stt.write(pcmChunk);         // any chunk size; call as audio arrives
await stt.close();           // flushes the last utterance's final
```

Events: `{ type, text, start, end, lang, engine }` with `start`/`end` in seconds from stream start,
plus optional `detectedLang`, `speaker`, `confidence` from engines that report them (soniox).
`stt.engine` is a `Promise<"apple"|"whisper"|"soniox">` of the initial choice.

Live translation: transcribe with `lang` = the speaker's language (Apple gives the best Spanish/French/
German/Japanese/Chinese partials), then translate each `final` (and optionally debounced partials)
with the hub's LLM; or for "anything → English" without an LLM use `translateToEnglish: true`.

### How the hub uses it

`src/hub/listen.ts` `openSpeechStream(lang, sampleRate, handlers, { alsoLangs? })` wraps this module:
partials/finals go to the handlers, `final(text, info)` also gets `{ engine, detectedLang, speaker,
start, end }`, a `fallback` becomes one `error(...)` toast, `status` lines go to the hub log, and
`stream.engine` follows the engine actually in use. `warmUp()` runs at hub start, `stopWhisperServer()`
on shutdown. `transcribeClip` (push-to-talk) burst-writes the clip then `close()`s; apple and whisper
run faster than real time (Soniox's turnaround on a burst is printed by the live test).

Not wired yet (src/hub/jarvis.ts, owned elsewhere): a translate session could pass the wearer's
language explicitly, `openSpeechStream(theirs, sampleRate, h, { alsoLangs: [mine] })` (the default
`["en"]` already covers an English wearer), and route finals by `info.detectedLang` (e.g. "zh" = the
other person, "en" = you).
