# Lumen

A live production and presentation workspace for churches and events.
**Studio** combines scenes, layered camera/media sources, independent public
outputs, audio mixing, and local recording. **Present** retains the existing
channel-based decks and presentation controls, with dedicated **Scripture** and
**Lyrics** workspaces using the same matte surfaces, compact controls and
restrained cyan-accented design.

Decks and Studio scenes live in JSON files alongside local media. SQLite stores
accounts, roles, offline Bible texts, songs and live worship cues. WebSockets synchronize controls; Studio uses a supervised
Chromium renderer and WebRTC to deliver composed video and audio to displays.

## Stack

- **Frontend** — Vue 3, Vite, TypeScript, Pinia, Vue Router, Tailwind, VueUse,
  Lucide icons, vue-draggable-plus, vue-sonner.
- **Backend** — Express, `ws`, Zod, SQLite, Multer, sharp, FFmpeg.
- **Studio renderer** — Playwright-managed Chrome/Chromium, Canvas, Web Audio,
  WebRTC, and MediaRecorder. No cloud account or API key required.
- **Data** — JSON manifests, SQLite identity, local media and recording chunks.

## Quick start

```bash
# from repo root
npm run install:all

npm run dev
```

This starts the Express API + WebSocket on `http://127.0.0.1:3000` and the
Vite dev server on `http://127.0.0.1:5173`. Open the dashboard at
[http://127.0.0.1:5173](http://127.0.0.1:5173).

To project: open [Studio](http://127.0.0.1:5173/studio), start the engine and
take a scene to Program. **Open Live View** in every workspace opens the same
final Program at `/studio/output/program`. Move that tab to your display and
press **F** for fullscreen. To project a channel independently, use its
**Open channel output** control instead.

## Scripture, Lyrics and local listening

Use **+** in the channel dock to create a Presentation, Scripture or Lyrics
channel. Presentation handles prayer marathons, announcements, media and normal
slides, with manual or timed progression. Existing prayer and announcement
channels/decks remain intact. Existing Scripture/Lyrics decks are preserved;
the dedicated workspaces use a separate library. Lyrics offers **Copy existing
slides to a song** to review and save older stanza-based slides.

### Presentation workspace

- **New presentation** creates a channel and its playlist together. Selecting
  a presentation opens that channel, keeping the slide editor, transport and
  edits pointed at the same playlist. Unlinked legacy playlists are preserved;
  **Open as presentation** explicitly creates their channel without moving or
  replacing the slides or starting playback.
- Use **Import** or drag media into the slide editor. List/grid view preferences
  are local to the controller. Current/Next labels show the playback order;
  double-click a slide (or press Enter on its focused card) to show it.
- Manual/Auto, blanking, audio and the current slide counter stay in the compact
  transport. **Open Live View** remains in the shared main header. The channel
  toolbar switches between channels and opens Studio through its clapperboard
  icon. It can be moved, collapsed or reset, with the same position and state
  retained across channels and Studio. Small-screen panels use closable drawers.

### Scripture

- Opening or returning to a Scripture channel focuses search automatically, so
  you can type immediately. This happens once on entry; results and cue updates
  do not reclaim focus, and an open dialog/menu or Multiview interaction is
  respected. Lyrics focus behavior is unchanged.
- Search a reference (`John 3:16`, `Jn3:16`, `Psalm 23`) or keywords. Partial
  references show chapter results while you type. Browse by book/chapter too.
  Short forms such as `jer20 11`, `jn3 16`, and `1cor13 4` work without colons.
  Partial book names and common misspellings (including `jeremia 20 11`) resolve
  locally, with the canonical reference shown above the results. Ambiguous
  shorthand such as `jo3 16` or `cor13 4` offers book choices with passages
  present in your selected edition; it never silently chooses a book or version.
  A few remembered words or word beginnings (`lord my sheph`) find ranked text
  matches. Exact phrases appear first; common connecting words are relaxed only
  after the full query finds nothing. Use **↑ / ↓** to highlight a result and
  **Enter** to prepare it. Typing, highlighting and choosing a book never send
  anything live. These tolerant manual-search rules do not alter AI listening.
- Click a result or press Enter to **prepare** it. This never changes the public
  output. **Send live** (Cmd/Ctrl+Enter) updates only the channel's
  live cue and Studio layers already following it. Scene switching stays in
  Studio; publishing never takes over Program. Previous/Next traverses
  verses; choose an end verse for passages of up to 12 verses. Long text scales
  down to fit; shorter passages remain easier to read at a distance.
- KJV includes all 66 books / 31,102 verses offline. The version catalogue also
  includes **NKJV, NIV, NLT, AMP (Amplified), GNT (Good News), TPT**. These other
  editions are **not bundled**: import authorised JSON using **Manage versions**.
  No cloud Bible API, scraped modern translation or generated verse fallback is
  used. Missing verses show an explicit error, including for partial editions.
- The Library dialog downloads a format example. Supply
  `{ version: { id, name, language, attribution }, verses: [{ book, chapter,
  verse, text }] }`. Book IDs are the 66-book canonical order (John = 43).
  Required publisher attribution is retained on the output. Importing or
  replacing texts is a deliberate action and requires an author role.

### Lyrics

Find songs with a short part of the title (`amaz gr`), a few remembered lyric
words, or common spelling slips (`amazng grcae`). Matching is local and indexed;
title matches come first, and lyric results show the original matching line and
section. Similar-spelling suggestions are labelled rather than rewriting your
query. Use **↑ / ↓** to highlight a song and **Enter** to prepare: a lyric hit
prepares its matching section, while a title hit prepares the first section.
Search covers the whole library, not just the first browse page. Typing,
highlighting, clicking, or double-clicking a song never publishes it. **Send
live** and **Cmd/Ctrl+Enter** remain separate actions; Studio scene switching
stays manual. Manual typo matching never changes automatic listening rules.

Add a song with named verse/chorus/bridge sections and the applicable writer /
copyright credit. Search by title or lyric words. Pin and reorder songs in the
channel's service setlist. Select a section to prepare, send it live, then use
Previous/Next within that song. Editing a song does not silently rewrite an
already-live cue. Only use lyrics you are authorised to display.

Each channel has its own live cue and content clearing. Design belongs to its
Studio layers; dedicated channel outputs are neutral text proofs. These cues
persist in `data/worship.db` across station restarts and feed both
`/live/:channelId` and Studio **Presentation channel** sources. Search/prepared
selections are local to each operator; only authorised live changes are shared.
Concurrent live edits reject stale revisions; another channel's output is not
affected. Back up `worship.db` with the station stopped (or use a SQLite online
backup), alongside `content.json`, `production.json`, `lumen.db` and media.

### Install and use local AI

```bash
npm run setup:ai  # one-time internet download + local build
npm run setup:ai -- --list-models
# Optional stronger English model (explicit download, about 466 MiB):
npm run setup:ai -- --model=small.en
npm run dev
```

The installer builds [whisper.cpp](https://github.com/ggml-org/whisper.cpp/tree/v1.9.5/examples/server)
v1.9.5 and downloads the
[base.en model](https://huggingface.co/ggerganov/whisper.cpp/blob/main/ggml-base.en.bin)
under `data/ai/` (ignored by Git). On macOS it can install a private CMake runtime
there too; Xcode Command Line Tools are required. Linux requires CMake, a C++
compiler and tar. Windows builds are not verified. Existing installations can
use `LUMEN_WHISPER_SERVER` and `LUMEN_WHISPER_MODEL`; `LUMEN_CMAKE` overrides the
installer's CMake executable. No global packages or background services are
installed. First model load may be slower than subsequent inference.

The default remains Base English. The installer also supports Small English,
Small multilingual, Medium English, Medium multilingual, and quantised
Large v3 Turbo. Downloads are checked against pinned sizes and SHA-256 hashes;
installing another model does not delete your existing models. Open **Local
listening → Listening settings → Local speech model** to select an installed
model. A station-wide author can change this shared setting only when all
listening sessions are stopped. The choice persists across station restarts;
an explicit `LUMEN_WHISPER_MODEL` environment override takes precedence. The
browser never downloads a model automatically or accepts arbitrary model paths.

1. Open **Listening settings**, allow microphone access to reveal device names,
   and choose your microphone or audio interface. Use localhost or HTTPS.
   **Test microphone** checks the input meter locally without recording,
   transcription or speaker playback; closing the dialog stops the test.
   Choose **Microphone · speech cleanup** for a microphone, or **Mixer / line
   input · clean feed** to request unprocessed mixer audio. Device processing
   support varies by browser/hardware. Input and processing preferences are
   saved in this browser and shared by Scripture and Lyrics. A disconnected
   selected device is shown as missing: Lumen stops capture and never silently
   changes to another microphone. Reconnect or choose another device, then
   explicitly click **Listen**. For a clean preacher signal, use the mixer's
   dedicated speech feed. This input does not change Studio's main audio.
2. **Prepare only** is the default: English speech is transcribed on the
   backend station, exact references or matching words are looked up locally,
   and the operator decides what goes live. Partial spoken references can open
   chapter results while the search box is not being edited. Phrase matches are
   suggestions.
3. **Auto publish** requires explicit confirmation in Lumen's **Enable Auto
   publish?** dialog. Cancel is focused by default; Cancel, Escape or a backdrop
   click dismisses without opening the microphone or starting a session.
   Navigating away also cancels a pending confirmation. In Scripture, one clear,
   complete, valid reference is enough to send the channel live; the speaker does
   not need to repeat it. Repeating an identical citation is not a conflict, and
   already-live content is not republished. A distinctive exact quotation can
   also go live when it uniquely matches the selected edition (at least eight
   consecutive words, enough meaningful content, and no close rival verse).
   Short, approximate, negation-changed, conflicting or shared quotations stay
   prepared for review. Invalid/incomplete references wait for clarification,
   never silently fall back to a guessed verse. Lyrics retains its two-window
   confirmation for a high-scoring unique setlist match. Match scores describe
   library-text matching, **not** calibrated speech-recognition confidence.
   The listener shows **Sent live**, **Already live**, **Needs review**, or the
   reason it is waiting. It never changes Studio scenes or main-audio routing.
4. Optionally arm **“Lumen next / previous”** voice commands. Ordinary “next”
   does not operate the screen. Commands are cooldown-limited and operate only
   an already-live cue. Bare commands and voice highlighting are not supported.
5. Any manual live/version/theme/setlist command stops listening. Ownership
   loss, expired sessions or repeated errors stop it too. Listening never
   automatically rearms after a reload/restart. Keep the capturing tab open;
   navigation within Lumen preserves capture and the channel dock shows which
   channels are listening/armed. Listening mode and voice-command controls stay
   with each channel when switching to Studio or another channel, and reflect
   the active session. They reset to Prepare only / commands off on reload;
   remembering a selection never rearms listening. Closing the tab releases the input
   and the server lease expires. You can stop listening at any time.

Audio windows (up to five seconds, every 2.5 seconds) travel only from the
operator browser to your configured station; the speech worker binds to
127.0.0.1. Audio is not retained and is not sent to a cloud transcription service.
Inference is serial to bound station load; busy windows are skipped, not queued.
This is near-live recognition, not word-by-word prediction. End-to-end delay
includes capture windows and model inference (plus a second confirmation window
for Lyrics). Scripture does not wait for a second copy of a clear reference.
English is the initial supported UI language. Singing, backing music, accents
and overlapping voices can reduce accuracy: rehearse with your actual mixer
feed and use Prepare only until it is reliable for your service. Song listening
matches words in your setlist; it is not music fingerprinting or a lyrics service.

The decoder uses unprompted beam search, no cross-request text context, and
conservative silence/low-confidence filtering. No Bible-book list is supplied:
on weak/noisy input that prompt could echo book names instead of speech. These changes
are not accent training. Ghanaian English is a priority for evaluation, but
accuracy improvements require testing with representative speaker recordings.
English mixed with Twi is **not yet supported or validated** by the installed
recogniser; selecting a multilingual Whisper model alone does not add Twi
support. A compatible trained model and code-switching evaluation are still
needed. Use Prepare only and operator review until your own service audio has
been checked.

```bash
npm test              # state, library, parser and automatic-switch safety tests
npm run test:worship  # isolated real-Chromium workspace/output smoke test
npm run test:ai       # same, plus actual local inference; macOS say + installed model
npm run test:ai:quality # installed Base: generated noise/hum and synthetic speech, no mic
npm run test:scripture:auto # one-detection publishing/review/public output; Studio/audio unchanged
npm run test:listening:input # device permissions, meters, profiles, hotplug and safeguards
npm run test:confirmations # shared dialogs, cancellation, focus and nested-modal safeguards
npm run test:studio   # isolated Studio/audio/recording regression test
```

The browser tests use temporary data, fake devices and generated audio, never
your physical microphone or service library. Recordings-to-clips/social posts,
multilingual recognition and production-grade sung-vocal separation remain
future work.

## Production Studio — Phase 1

### Channel content and Studio scenes

Scripture and Lyrics supply live text, not designs or Program routes:

1. Search and **prepare** a verse or lyric section privately.
   Scripture search results use single-click to prepare and double-click to
   send that exact verse directly to the channel. Double-click never switches
   Studio scenes and does not depend on an older prepared cue or a late preview
   response. An author controlling the channel is still required.
2. **Send live** (Cmd/Ctrl+Enter) publishes it to that channel only. Previous/Next
   also update its live content. This works without starting the Studio engine.
   The shortcut works directly after selecting a verse, recent passage, song,
   setlist entry or lyric section, as well as from search and Send live itself.
   Dialogs, menus, Multiview and unrelated controls cannot publish through it;
   pending preparation/publication and held-key repeats never queue a Take.
3. In Studio, add the channel as a source to the desired scene. Set its text
   color, typography, fill, opacity and exact placement in **Design**. Choose
   **Lower third**, **Upper third**, or **Full view**, then refine by dragging or
   entering dimensions. Add images, cameras or looping video as separate layers
   below the text. Dedicated Scripture/Lyrics layers always use Studio styling,
   including layers saved with the older slide-design mode.
4. **Cut/Fade** that scene to Program, or use its configured scene shortcut
   directly from the channel workspace. Publishing itself never switches scenes.

If a channel is already in the committed scene, Send live updates it in place
without moving layers, re-taking the scene, replaying entrances, or changing
camera/branding/audio. Otherwise the cue remains **Ready in Studio** until a
scene using it is taken. **Clear live content** removes the text and its layer
fill, revealing the scene underneath; it never blanks the whole Program or mutes
sound. Prepared/Live previews are neutral proofs, not a second design editor.
Fast actions are guarded: a new selection must finish preparing before Send
live, and a scene Take cannot overtake a local pending publication. A Studio
Take snapshots all visible text-channel revisions; the renderer retains the
previous picture until they arrive, then starts the requested fade/entrances.

Channel authors need control of their channel to publish; Studio scene Takes
require Studio author access. AI **Auto publish** follows the same boundary:
it may update the channel when explicitly armed, but never switches scenes.
Opening Live View or an independent channel output does not change routing.
Program-following outputs and recordings use the final Studio composition;
independently pinned displays retain their own scene snapshot and live sources.

Older active temporary channel overrides are retained on upgrade so the picture
does not unexpectedly change. Studio displays a notice; the next deliberate
Cut/Fade clears the old override. The former takeover endpoints now reject
without publishing a cue or changing Program.

### Recordings and Clips

Open **Recordings** from Studio, or the scissors button in the floating toolbar.
It opens `/recordings` in a separate tab so the publishing/control tab can stay
open. Completed recordings have a real thumbnail and open a full-window clip
editor; the original WebM download remains available. Interrupted recordings
retain their recovery controls for Studio authors.

The recordings library separates originals, your projects and team projects,
with searchable thumbnail grids or compact lists. Open a recording to start
a project, or continue an existing draft. Older archived exports remain under
Previous exports; new exports save to your device instead.

The full-window editor is independent of Studio. Import additional video,
images and audio into the private media bin; append clips to the main sequence
or add them as overlays. Split at the playhead, trim clip edges, rearrange clips,
drag between compatible tracks, duplicate/delete, and undo/redo edits. The
timeline supports drag-to-seek on the ruler, playhead and empty track space,
zoom, snapping, sequence reordering, track visibility, mute
and locking. Resize the timeline and collapse the inspector to make room for
the picture. Space plays/pauses, S splits, Delete removes, Cmd/Ctrl+Z undoes,
Cmd/Ctrl+Shift+Z redoes, Cmd/Ctrl+D duplicates, T opens transitions and Cmd/Ctrl+S saves. Shortcuts
respect text inputs and dialogs.

Video tracks show real frame strips; video and audio tracks show real stereo
source waveforms. These follow source in-points, splits and rearrangements, with
10 ms waveform detail and adaptive thumbnail spacing when zooming. Only visible
timeline sections are requested, with bounded private caches; waveform images
cover fixed 30-second windows so even long recordings do not need a full-file
browser audio decode. Muted clips keep a dimmed source waveform for editing;
silent videos are identified without inventing waveform data. These visuals
are editing aids and are not added to the exported video.

Preview generation shares the single low-priority media worker with exports.
Cached visuals remain available during live production; uncached visuals wait
and resume when the live engine and recording are idle. The editor shows this
state explicitly and keeps live audio and scene switching untouched.

Use landscape 16:9, portrait 9:16 or square 1:1; crop/fit and position each
visual element, change opacity, add styled text, and mix recorded/imported
audio with individual volume and mute controls. Drag or resize overlays on
the preview. Preview playback starts muted. Save a named project draft and
export a separate video or audio file. Drafts, imports and exports never modify original recordings,
Program, scene routing or Main audio; editor audio never uses a live input.
Clips can be 0.25 seconds to two hours long; each export is capped at 2 GiB.
The Export dialog offers MP4 and MOV (H.264/AAC), WebM (VP9/Opus), MP3
(192 kbps stereo) and WAV (16-bit PCM, 48 kHz stereo). Video exports use 30 fps
and either 1080p or 720p: landscape 1920 × 1080 / 1280 × 720,
portrait 1080 × 1920 / 720 × 1280, square 1080 × 1080 / 720 × 720.
These frame sizes may upscale a lower-resolution original; they do not restore
detail that was not recorded.

Choose the destination before starting an export. In supported secure-context
Chrome/Edge browsers, the system save dialog selects the filename and folder;
Lumen streams the finished file there without buffering the whole video in
browser memory. A collapsible progress overlay stays available across operator
channels, then shows a rendered thumbnail, saved confirmation and Open file.
It never appears on public/live output pages. Browser pages cannot reliably
reveal Finder/Explorer, so Open file is not a Show in folder command. Other
browsers use an explicit Download action and their Downloads settings; that
completion is marked Download requested, not a verified save.

New renders are temporary: the station copy is released only after the chosen
file closes successfully, or expires after 24 hours. Interrupted saves can be
retried before expiry. After a page reload, choose a location again; browser
file handles are not stored on the station. Temporary renders share a 4 GiB
scratch limit. Originals, saved projects and earlier archived exports are not
deleted by delivery cleanup.

Use Transitions in the editor rail, press T, or click a cut badge on the timeline
to join neighbouring video/image clips. Dissolve, left/right wipes and left/right
slides use actual overlapping source frames, not duplicated frozen frames.
Adjust 0.1–2 seconds (bounded to half of each clip), preview the cut, change the
preset, or remove it. The selected track ripples by the overlap amount; other
tracks stay at their existing times. Transitions survive draft saves, undo/redo,
splits and sequence rearrangement. Clip-level audio fade-in/out controls use
independent linear envelopes; visual transitions do not silently alter the mix.
Video and audio-only exports bake in the relevant edits and fades.
Apply to all cuts copies the selected transition and its exact duration across
eligible cuts on unlocked video tracks in one undoable edit. Short cuts, gaps,
locked tracks and incompatible overlaps are skipped and reported, rather than
silently using a different duration.

Signed-in teammates can make their own clip drafts without Studio-author
permissions. Teammates can view each other's drafts and make a copy; only the
draft owner or an administrator can update it. Revision checks reject stale
saves rather than silently overwriting another tab's changes. Share an editor
URL with an authenticated teammate connected to the same station. This does
not expose recordings through public projection or media URLs.

Exports are independent, immutable snapshots of saved drafts, with progress,
cancellation and downloads. One bounded FFmpeg worker runs at a time. Heavy
thumbnail/probe/export work waits while the live renderer is running or a
recording is being written/finalized. Starting the engine stops/requeues an
active export before the renderer launches. **Stop the live engine when the
service is over to let queued exports run.** Browsers can still preview media,
import media, frame clips and save drafts while production is live. This protects the live
workload; it is not a guarantee against exhausted hardware or storage.

Projects support up to 12 tracks, 120 timeline items and 64 enabled export
inputs, with up to eight visible elements and sixteen audible sources at one
time. Imports are capped at 512 MiB each and stay behind station authentication;
supported formats are MP4/WebM video, PNG/JPEG/WebP images and MP3/WAV/Ogg
audio (including browser-readable MP4/WebM audio). Export independently probes
source streams and validates trims before rendering. Existing single-range
drafts open as editable timelines.

This is the core non-destructive editing workflow, not full CapCut feature
parity. AI highlights, generated captions, advanced effects, speed ramps,
shared simultaneous timeline editing and direct social publishing are not
implemented yet. Teammates work in independent drafts without live-production
permissions; this is not real-time co-editing of one timeline.

### Persistent main audio

Open **Audio mixer** and choose **Set as Main** on the desired input. A compact
**Main** badge marks the selected feed; **Clear Main audio** removes the
selection. Sources also shows a read-only **Main** badge beside that feed's
name. That badge also flags muted/disconnected inputs (with text and warning
colors); its tooltip includes the input issue. Selection controls stay in the
mixer rows, not a separate panel. The
slim **Output** meter, volume and mute remain available on both Sources and
Audio mixer tabs, leaving more space for the source list.

The main feed is routed exactly once to Program, recordings and audio-enabled
Studio outputs, regardless of visual scene, layer
visibility, fades or independent output routing. Preview and outputs with audio
disabled stay silent. Per-input mute/gain/delay and final Output volume/mute
remain effective; picture blanking does not mute audio.

Selecting another main feed mutes the previous main and unmutes the new one,
without resetting final-output mute or deliberately enabled secondary inputs.
New sources always start muted, including imported videos/music and connected
cameras/microphones. Existing saved mixes are preserved; no source is selected
or silenced automatically on upgrade. To delete the chosen feed, select another
or **Clear Main audio** first. A disconnected main feed stays selected with a
compact warning in its mixer row and no automatic fallback—reconnect it or
explicitly choose another input.

### Requirements and first service

Use a current Node.js LTS release (Node 22 or newer), npm, and Chrome/Chromium
installed on the station. Chrome is discovered automatically on common desktop
paths; set `LUMEN_CHROME_PATH` to its executable when installed elsewhere.
Use Chrome or Edge for the operator browser. Camera/microphone and screen
capture require **localhost or HTTPS** and explicit browser permission.

1. Run `npm run install:all`, then `npm run dev` from the repository root.
2. Open `http://127.0.0.1:5173/studio` and sign in. A **new** data directory seeds
   `admin` / `admin`; change that password before exposing the station. Existing
   accounts are preserved. Studio needs an administrator or global author/owner.
3. Start the engine. Select a scene, add sources, and arrange layers in Preview.
   Drag/resize layers or enter exact values in the inspector. Text, shapes,
   transparent logos, artwork, videos, cameras, screen shares, microphones,
   audio files, and existing presentation channels are supported.
   File sources have play/pause, restart, and loop controls in Sources. They are
   shared live players: pausing or restarting affects every scene using them.
4. Use **Cut** (Space) for an instant switch or **Fade** (Shift+Space) for a
   smooth transition. The compact controls sit between Preview and Program;
   both exchange the two scenes: Preview goes live and the previous Program
   scene returns to Preview, ready to switch straight back. Saved scene drafts
   are never overwritten by this exchange. The first Take (or a Take after
   deleting the outgoing scene) keeps the incoming scene in Preview.
   Fade duration defaults to 300 ms and is saved for this browser (100–3000 ms).
   Shortcuts are inactive while typing or using a dialog. Draft edits do not
   change the live scene until the next Cut or Fade. Source audio controls are
   live, shared controls. Program, its following outputs, and recordings share
   the same transition; independently pinned outputs keep their picture.
5. Open an output from its card and move that window to the display. Press **F**
   or double-click for fullscreen. Each output can follow Program or hold its
   own scene snapshot, with independent picture blanking and audio enablement.
   Refresh a pinned output explicitly after editing its scene. Blanking does
   not mute audio; use the audio control when silence is required.
6. Open **Audio mixer** and click **Set as Main** on your sermon/mixer feed. It remains on the final
   mix through scene switches, even when absent from the picture. New inputs
   start muted; unmute additional sources deliberately in the mixer. Set gain
   and delay there too. Enable sound on public outputs only where intended;
   operator monitors remain silent unless explicitly monitored.
7. Take a scene, click **Record**, then **Stop recording** when finished.
   Download the finalized WebM from **Recordings**. It contains the Program
   canvas (1920×1080, target 30 fps) and master mix (Opus audio), not the UI.

### Studio editing controls

- **Add a source** uses a compact source sidebar and a searchable media browser,
  rather than a filename dropdown. Select an image/video thumbnail or an audio
  file to inspect the original media, dimensions/duration and file size before
  adding it. Video previews start muted; audio plays only when you press Play.
- Upload or drop one supported file (up to 200 MB) into the media browser.
  A local preview appears immediately while upload progress is shown; **Add to
  Studio** waits for the saved station file. Switching types or closing cancels
  the pending request and releases the local preview. A completed upload may
  remain in the library even if you cancel adding its source. Failed previews
  and uploads offer a clear retry path. Browsing and preview playback never
  take a scene or change Program. Every new source starts muted.
- Use the fullscreen button or **F** to expand Studio; press **F** again or
  **Esc** to leave fullscreen. The live-output window remains independent.
- The left-panel toggle hides or restores **Scenes**. Scenes and Design can
  collapse independently, and their layout preferences are saved locally.
- Inspector, animation-editor, mixer and output-name fields keep unfinished edits
  local while engine status or another controller updates the station. Press Enter or leave a
  text/number field to save, or Escape to cancel its draft. Colour and opacity
  controls update Preview as you adjust them; rapid picker changes coalesce
  without publishing to Program. A failed save restores the acknowledged value
  without reloading the workspace.
- **Find a scene** filters the scene browser without changing the current
  Preview or Program. Switch between thumbnails and a compact list for longer
  services; this view preference is saved on the controller, not the station.
- Open **Scene shortcuts** using the keyboard button beside Scenes. Record a
  shortcut for each desired scene and choose Cut or Fade (100–3000 ms). Nothing
  is assigned by default; start with Cmd/Ctrl+Shift+1, 2, 7, 8 or 9. Browser/OS
  shortcuts and duplicate assignments are rejected. Settings are local to this
  browser and follow scene IDs through renaming/reordering. Clear any binding
  individually or use **Clear all**. They work in all operator workspaces with
  Studio access and a running engine, but not while typing, using a dialog/menu,
  rehearsing, or viewing an output. They take the latest saved scene directly
  while returning the former Program scene to Preview. These shortcuts never
  send prepared channel content live; use Send live in its channel first.

### Multiview

Fullscreen and the standalone Multiview URL use a full-width control station:
large Preview and Program monitors with Cut, Fade and duration between them,
plus a smaller four-column scene shelf below. Narrow windows keep two columns
and move transitions below the monitors. The floating window stays compact.
The shelf rearranges the same silent atlas locally, without opening extra
video connections or changing Program, recording or audio routing.

- Open **Multiview** from the floating channel toolbar. It stays above
  Presentation, Scripture and Lyrics while you work, with live Preview/Program
  monitors and scene thumbnails. Returning to Studio collapses it back into
  the toolbar; reopen it whenever needed.
- Drag the Multiview title to move it, or drag its lower-right corner to resize.
  Arrow keys on these handles move/resize it; Shift makes larger steps and Home
  resets the layout. Position, size and open state survive channel changes and
  reloads, and stay within the screen after a window resize.
- Click a scene to prepare it in Preview, then **Cut** or **Fade** to swap buses.
  With Multiview focused, Space cuts, Shift+Space fades and 1–9 select scenes.
  Configured scene shortcuts work across channels and swap buses too. Typing,
  dialogs and animation rehearsal remain protected from accidental Takes.
- The grid uses pairs of slots: three scenes show four slots, with one empty
  placeholder until a scene is created in Studio. Cyan marks Preview and coral
  marks Program; the labels remain distinct when a scene is on both buses.
- Open `/studio/multiview` in another window, or use its pop-out button. Press
  **F** or the fullscreen button for a dedicated operator display. Sign-in and
  Studio author access are required; this is not a public projection URL.
- All Multiview monitors are silent. The scene grid shares one lightweight live
  thumbnail stream, allocated only while viewers are connected. Main audio,
  recording, channel cues and independently pinned output routes are unchanged.

### Layers and canvas

- Drag a layer's grip up or down in **Layers** to change its stacking order;
  the top row is the frontmost layer. Rename, duplicate, hide, lock, or delete
  layers directly from the list. Unlock a layer before changing its geometry
  or deleting it.
- Drag an element on Preview to move it; use its edge/corner handles to resize.
  Guides snap to canvas and neighbouring layer edges/centres. Hold **Alt** to
  bypass snapping, or **Shift** to constrain movement/keep aspect ratio.
  With the engine running, selection bounds move locally while the live feed
  stays uninterrupted; releasing the pointer commits one draft geometry edit.
  Without the engine, the design poster also follows the drag immediately.
- With the canvas focused, arrow keys nudge the selected layer by **1 pixel**;
  **Shift+Arrow** moves it by **10 pixels**. **Delete/Backspace** deletes an
  unlocked layer, and **Cmd/Ctrl+D** duplicates it.
- Right-click a layer on Preview or in Layers for alignment, stacking, and
  placement presets. **Design** also provides exact position and size in
  pixels or percentages. Editing controls only update the draft scene;
  **Cut/Fade** and explicitly refreshed pinned outputs are still deliberate.

### Element animations

- Select a layer and open **Design → Animation**. Choose Fade in, Slide up/down/
  left/right, or Scale in. Set duration, delay and easing; choose **None** to
  disable an entrance without losing its saved settings.
- **Preview** rehearses that layer locally. **Rehearse** beneath Preview plays
  all visible layer animations together, including their delays. Program and
  recordings are unaffected. **Return to layout** leaves rehearsal; Space
  pauses/resumes rehearsal rather than taking a scene live.
- Open **Editor** to scrub a timeline, play/pause/restart and add or remove
  intermediate keyframes. Custom frames control X/Y offsets in design pixels,
  scale, opacity and rotation. Up to 12 frames are supported, with durations
  from 100 ms to 10 seconds and delays up to 10 seconds. The final **Layout**
  keyframe is fixed to the layer's saved position, size and opacity.
- **Apply animation** saves the editor's draft; **Cancel** discards it. Editing
  or scrubbing never changes a committed Program or pinned output snapshot.
  Locked layers must be unlocked before their animation can be changed.
- **Save preset** in the inspector or editor stores a named animation in this
  station's **My presets** library. Saving an unsaved editor draft does not
  apply it to the layer. Presets retain timing, easing and keyframes, not the
  layer's position, content or source.
- Choose a saved preset from **Entrance**, or open **My presets** to search,
  preview and apply it to a layer in any scene. Inside the editor, a preset
  loads into the draft until **Apply animation**. Every application is an
  independent copy: tweaks, renaming or deleting the library entry never
  change other layers or committed live output. The library persists across
  restarts and is shared with other controllers on this station.
- **Cut/Fade** starts all enabled entrances in the newly committed scene.
  Re-taking that scene deliberately replays them. Program-following outputs
  and recordings share the same rendered motion. Explicitly pinning or
  refreshing a destination starts its own independent entrance.
- Draft saves, blank/unblank and opening an output do not replay entrances.
  Restarting the engine restores the final design pose rather than replaying
  an old service moment. Scene crossfades retain outgoing element timing.
- Local rehearsal can display uploaded images/videos and cameras published
  by this controller, without sound. Other-controller live inputs and channel
  sources use clearly marked placeholders; the live renderer still animates
  their real feeds. Local file playback is independent of Program playback.

### Engine, outputs, and safety

- The backend owns the renderer, not the control page. Media-based outputs and
  recording continue if the operator navigates away or closes the control page.
  **Cameras, microphones, and screen shares are supplied by the browser that
  connected them. Keep that tab open.** A warning appears before closing it;
  losing the tab removes those live feeds, not the entire program.
- OBS can be selected as a **Virtual Camera** input when installed/enabled.
  Add its audio through an available audio interface/loopback device separately.
  Studio does not start OBS or ingest native SRT/NDI feeds. Go Live sends the
  composed Program and its audio mix to Facebook/YouTube over RTMPS.
- Presentation sources mirror existing channel state. Keep the existing
  **Present** controls running for automated slide timing. Studio does not yet
  reproduce every legacy presentation effect or background music playlist.
- Up to six outputs have independent routing. Each output is a composed WebRTC
  stream; resolution/frame rate can adapt to CPU/network load. The render
  target is not a guarantee of sustained performance on all hardware.
- This first transport targets the station and reachable local-network devices.
  There is no TURN relay or internet-wide remote collaboration yet. Use HTTPS
  for capture from another device, and a trusted network for public output URLs.
  The dedicated renderer advertises direct local-IP ICE candidates so displays
  can connect even where mDNS hostname resolution is unavailable. Only Lumen's
  temporary renderer process uses this setting; user-browser privacy settings
  and device permissions are unchanged. Permitted output clients can see the
  station's local IP as part of WebRTC signaling.
  Named display outputs and independent channel URLs are intentionally public;
  the shared Program live view requires sign-in, while Preview/publishing require
  Studio author access. Controls and recording downloads require authentication.
  Do not expose the server directly
  to the internet without access controls at a reverse proxy.
- State changes use revision checks to prevent silent overwrites from two
  operators. Reloaded state and a message are shown on a conflict.
- Recording chunks are written in order with fsync and retry-safe sequence
  numbers. FFmpeg remuxes them into a seekable WebM. Interrupted recordings offer
  **Recover**; only chunks already received by the station can be salvaged.
  Stop recording before stopping the engine. Keep the station awake and maintain
  sufficient free disk space. Original chunks are retained alongside exports,
  so storage usage is greater than the downloaded file size.

`LUMEN_RENDERER_URL` gives the station renderer a preferred frontend origin.
In development, Studio detects the control page's actual local frontend port;
if that address is unavailable, it can use the built frontend served by the
backend. Production uses the backend origin by default. Candidates must connect
to this station and serve its display page before renderer authorization is
attached. If a reachable frontend cannot initialize its renderer and connect
this station's renderer WebSocket, Studio closes it and tries the next address.
Failed attempts and technical details are available to operators at
`/api/studio/diagnostics`; the workspace shows a short recovery message.
Reverse proxies must forward both `/ws` and `/studio/ws` WebSocket upgrades.

### Go Live and independent Lumen Watch

To test your actual Studio Program and Main audio with Watch on this computer,
stop `npm run dev` and run **`npm run dev:watch`** instead. It adds local Watch
alongside Facebook and YouTube, using your normal station data and a private
temporary copy of your saved streaming setup/keys. Choose destinations and
confirm Go Live as usual; social platforms stream publicly while Watch stays
local. Your normal saved streaming settings remain unchanged. See the
[local Studio + Watch instructions](watch-relay/README.md#run-studio-and-watch-together-locally).

The station allows only one backend at a time, even on different ports. Startup
automatically recovers a runtime lock only when its recorded process is confirmed
to have exited. A live or unverifiable owner stays protected. The private
`.lumen-runtime.lease.sqlite` file is an OS-backed coordination gate, not saved
scene data; leave it in place, including after shutdown. Never delete runtime
lease files to bypass a running backend.

Open **Go Live** from the Studio or channel top bar. Administrators configure
Facebook/YouTube stream keys, enable destinations, choose 720p or 1080p at 30 fps,
and set whether new broadcasts also record locally. Operators review the
prepared Program, existing Main audio and readiness checks, then deliberately
start sending. The engine starts if necessary; a scene must already be on
Program. This never chooses another scene or changes Main audio routing.

The compact button keeps the session timer across channel/Studio switches.
The panel automatically shows a muted Program preview when the engine is running.
It includes per-destination health, retry/stop controls and a copyable independent
Watch link. Settings are locked
while broadcasting. Ending defaults to **Keep recording**; choosing **Stop
stream and recording** explicitly ends both. The engine cannot be stopped
while recording or broadcasting.

Streaming is real FFmpeg H.264/AAC encoding of the compositor's Program stream,
not capture of the operator interface or the legacy channel page. One network
encode feeds independently bounded RTMPS remuxers and rolling HLS. Recording
retains its separate WebM encoder/storage path. A destination disconnect, slow
network queue or relay error cannot backpressure the renderer or stop local
recording. Studio/source/browser failures can still affect both; keep capture
tabs and the station awake, and check CPU, available disk and uplink headroom.
Post-production work remains deferred while the production engine is active.

720p streaming captures a dedicated 1280×720 feed instead of encoding 1080p and
then downscaling it. The Go Live confidence monitor is a shared, video-only
640×360/15 fps feed; public Program outputs and local recordings retain their
full resolution and frame rate. Apple VideoToolbox H.264 is used only after a
real hardware-only encode probe succeeds; other stations use the compatible
software encoder. Recording and streaming still require separate encoders, and
CPU usage depends on the scene, inputs, open monitors and recording activity.

Social destinations use a single-client loopback RTMP connection from FFmpeg
to a bounded Node.js TLS bridge. Only the two fixed platform ingest hosts are
reachable, and outgoing RTMPS uses normal certificate/hostname verification.
Plain RTMP never leaves loopback. This avoids the bundled macOS sender's native
TLS write stall. Connection errors are reduced to safe categories, not private
URLs or stream keys. Repeated failures pause automatic retries; if every
destination has failed, network encoding stops while local recording continues.

This first release sends Facebook and YouTube directly from the station and
publishes HLS to the independent Watch relay. **Upload use adds up across enabled
destinations**; the displayed estimate is not an internet speed test. A single
cloud upload with social restreaming, adaptive-bitrate viewing and Windows/Linux
hardware encoding are not implemented. Social status **Sending** confirms encoder output,
not that a platform has published an event; configure the provider's event,
visibility/auto-start and live permissions in its dashboard. Account OAuth,
event scheduling and platform viewer/chat APIs are not included yet.

No destination is enabled by default. Stream keys are stored in a private
mode-0600 station file and are never returned by the API or logged in FFmpeg
diagnostics. The fixed RTMPS authorities cannot be replaced with user-provided
URLs. Existing legacy sidecar credentials are preserved, but the simulated
sidecar streaming start/config/stop endpoints now return 410; use Go Live.

Lumen Watch is a separate public-only HLS service, not a YouTube/Facebook embed.
Deployment examples target **https://stream-lumen.xybron.com/watch/live**, while
the application remains at **https://lumen.xybron.com**. Nothing in a local build
creates DNS records, deploys to a VPS or starts an actual public broadcast.
See [the Watch relay deployment guide](watch-relay/README.md) for Docker, direct
Node.js, systemd and TLS-proxy examples. The relay package needs its own `npm ci`.

After provisioning the relay, configure the private station environment with
`LUMEN_WATCH_RELAY_URL`, `LUMEN_WATCH_RELAY_SLUG` and
`LUMEN_WATCH_RELAY_TOKEN`, matching the relay's private publish token. Do not put
the token in a public watch URL or browser bundle. The publisher requires HTTPS,
pins public DNS addresses and rejects redirects/private addresses. Watch stays
unconfigured until these settings exist. Do not publish the local station API
as a substitute. Remote viewers get only the Watch page and current HLS window;
media becomes Offline when stopped/stale and expires from the relay. This is
live-only delivery, not a VOD archive or private viewer-account system.

### Verification

```bash
npm test          # state isolation, routing, validation, and recording storage
npm run test:studio # build + real Chromium camera/audio/output/recording smoke test
npm run test:studio:properties # build + engine-heartbeat drafts, property persistence, queued saves and stale-response regression
npm run test:clips # build + recordings library, multitrack editing/imports, saved drafts, real MP4 exports and live-production isolation
npm run test:clips:previews # build + real filmstrips/waveforms, trim alignment, visible-only loading and preview safety
npm run test:clips:transitions # build + transition preview/render parity, audio fades and five real export formats
npm run test:clips:delivery # build + bulk transitions, destination-first saves, progress overlay and temporary-file delivery
npm run test:broadcast # build + actual Program/Main audio stream, simultaneous recording, independent Watch and Go Live UI
npm run test:watch # standalone relay security and real HLS playback (install watch-relay dependencies first)
npm run test:studio:animation # build + editor, live animation and recorded-motion regression
npm run test:studio:presets # build + reusable library, copy isolation, persistence and shared-controller regression
npm run test:workspaces # build + sign-in, scene navigation and desktop/tablet/touch layouts
npm run test:channels:layout # build + full-height Scripture/Lyrics panels and floating-toolbar scroll clearance
npm run test:scripture:doubleclick # build + exact-verse double-click publication, race guards and manual Studio routing
npm run test:scripture:search # build + short references, typo tolerance, book choices, keyword ranking and keyboard preparation
npm run test:scripture:focus # build + Scripture entry autofocus, navigation and focus-stealing safeguards
npm run test:lyrics:search # build + title/lyric fragments, typo matching, exact section preparation and keyboard/live safeguards
npm run test:presentation # build + presentation navigation, creation and isolated editing destinations
npm run test:channel-workflow # build + channel-only publication, real text output, camera and scene isolation
npm run test:studio:audio # build + persistent audio, ICE/RTP output connections, engine reconnect and recording regression
npm run test:studio:audio:status # build + focused read-only Main health badges and mobile layout
npm run test:studio:screen # build + generated screen/audio capture, reconnects and playback lifecycle regression
npm run test:studio:shortcuts # build + configurable global scene Takes, shortcut guards and responsive UI
npm run test:studio:multiview # build + persistent floating/standalone Multiview, real thumbnails, swaps, shortcuts and audio
npm run test:studio:media # build + media gallery, upload previews, cancellation and responsive source dialog
node backend/test/renderer-browser.mjs # after build: stale frontend fallback + renderer startup
```

The browser test uses a temporary data directory and fake camera/microphone
devices; it does not edit the real deck or access physical devices. Set
`LUMEN_CHROME_PATH` on non-macOS/custom installations and `LUMEN_TEST_PORT` if
3417 is occupied. Screenshots and recorded test media are retained in the
printed temporary directory. Perform a rehearsal with your actual capture
hardware, displays, and service duration before live use.

AI scripture listening, sermon clips, social publishing, native encoding,
cloud relays, and fine-grained remote team roles are subsequent phases.

## Production build

```bash
npm run build
npm start
```

The Express server serves the built SPA, the API, and the WebSocket on port
3000.

## Data folder

By default lives at `./data/`:

```text
data/
├── content.json           # the deck manifest — source of truth for content
├── lumen.db               # SQLite: accounts, sessions, roles, channel ownership
├── production.json        # Studio drafts, committed Program, and output snapshots
├── recordings/            # durable chunks, recovery metadata, finalized WebM files
├── clips/                 # private drafts, imported editing media, export snapshots and video/audio files
├── media/
│   ├── backgrounds/       # images & videos
│   ├── music/             # audio files
│   └── thumbnails/        # auto-generated, 320px JPEGs
└── backups/               # rolling 10 most recent content.json snapshots
```

`content.json` holds the deck content; identity/ops state lives in `lumen.db`.
Studio writes its own manifest and does not migrate or replace the deck.
Override the location with `LUMEN_DATA_DIR=/some/path npm start`.

The manifest is **never** written non-atomically: the backend writes to
`content.json.tmp` and renames into place, and snapshots the previous version
to `backups/` before every mutation (rolling 10).

## Operator controls

| Key             | Action                          |
| --------------- | ------------------------------- |
| Space           | play / pause                    |
| → / Enter       | next slide                      |
| Cmd/Ctrl+Enter  | Scripture/Lyrics: Send live to the channel only |
| ←               | previous slide                  |
| M               | toggle Auto / Manual            |
| B / L           | blank screen (audio continues)  |
| 1–9             | jump to slide N                 |
| F               | fullscreen (Live View)          |
| Esc             | exit fullscreen                 |
| ?               | show shortcut overlay           |

In **Auto** mode, the slide advances when its `durationMs` elapses. In
**Manual**, the timer never runs; you advance with → / ← / Enter.

## Sync & connectivity

Lumen uses two transports for state sync, fanned out from the same
`broadcast()` API in the frontend:

- **`BroadcastChannel`** — same-origin, same-browser. Zero latency, zero infra.
  Used when the dashboard and Live View are tabs in the same browser.
- **WebSocket relay** at `/ws` — cross-device. The Express server runs a
  stateless relay that forwards every message to all other connected peers.
  It also caches the most recent `state`, `music`, and `content-updated`
  messages, so a freshly-connected client (e.g. a Live View opened on a
  separate machine) catches up immediately without waiting for the dashboard
  to publish.

The Live View shows a small **reconnecting…** badge in the bottom-left when
the WebSocket isn't connected. The slide content stays frozen on the last
known state — the congregation never sees the UI flicker.

**Reconnect behavior:**

- Exponential backoff: 500ms → 1s → 2s → 5s → 10s (capped).
- Heartbeat ping every 20s; if no traffic for 25s, the socket is closed and
  reconnect kicks in.
- `navigator.onLine` is observed: when the OS reports the network is back,
  any pending backoff is aborted and a connection attempt fires immediately.
- On (re)connect the server replays cached state, so the Live View resyncs
  without operator intervention.

## Architecture notes

- **State origination.** Dashboard publishes `ProjectionState` snapshots and
  ~8 Hz `tick` messages. Live View is a pure mirror — it never originates
  state. Mounting fires `{ t: 'hello' }`; the dashboard responds with a full
  snapshot (and the WS server has a cache fallback).
- **Wall-clock timing.** Progress is computed against `performance.now()`, not
  a counted-up `setInterval`, so backgrounded tabs and CPU throttling don't
  drift the timer.
- **Wake Lock.** `useWakeLock('screen')` on the Live View prevents the
  projector laptop from sleeping during a service.
- **Atomic writes.** Manifest mutations: write to temp file → fsync → rename.
  POSIX guarantees rename atomicity on the same filesystem.
- **Optimistic UI.** Dashboard mutations apply locally and PUT in the
  background; on 4xx/5xx the local snapshot rolls back and a Sonner toast
  surfaces the error.
- **Cursor & UI.** Live View hides the cursor after 2s of idleness and listens
  for double-click → fullscreen so the operator can recover quickly if the
  hotkey didn't land in the right tab.
- **Reduced motion.** All transforms collapse to opacity-only fades when the
  OS reports `prefers-reduced-motion: reduce`.

## Project layout

```text
backend/
  src/
    server.ts      # Express + http server bootstrap
    routes.ts      # /api/content, /api/media/*
    ws.ts          # WebSocket relay (with snapshot cache)
    schema.ts      # Zod schemas mirroring the frontend types
    atomic.ts      # write-temp-then-rename + rolling backups
    thumbs.ts      # sharp/ffmpeg thumbnail generation
    paths.ts       # data dir resolution + traversal-safe joins

frontend/
  src/
    views/         # DashboardView, LiveView
    components/    # dashboard rails, live layers, shadcn-vue ui
    stores/        # content, playback, music (Pinia)
    lib/
      api.ts       # REST client
      broadcast.ts # fan-out: BroadcastChannel + WebSocket
      ws.ts        # singleton WS client (reconnect, heartbeat, status)
      timer.ts     # wall-clock timer used by the playback store
      keyboard.ts  # useShortcuts hook
      preload.ts   # next-slide media warmup
    types.ts       # Content / Item / ProjectionState / BroadcastMsg
```

## Deploy hardening

- Bind Express to `127.0.0.1` (default) and reverse-proxy through nginx or
  Caddy. Make sure to forward the WebSocket upgrade headers on `/ws`.
- Front it with HTTP basic auth at the proxy for over-the-internet use.
- Run with `pm2 start "npm start" --name lumen` (or systemd).
- Use HTTPS — browser secure-context APIs (Wake Lock, fullscreen) want it,
  and `wss://` is required when the page is served over `https://`.

### Caddy example

```caddyfile
lumen.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Caddy auto-upgrades WebSocket connections and provisions Let's Encrypt certs.

### Nginx example

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
}

location /ws {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 3600s;
}
```

## Channels, accounts & collaboration

Lumen runs multiple independent **channels** at once — each a presentation lane
with its own always-running playback engine and its own projection output at
`/live/:channelId`. Switching the focused channel in the operator UI never
interrupts the others (an unfocused channel keeps auto-advancing and driving its
own display). Channels are stored in `content.json` and reference playlists, so
the same deck content can back more than one channel.

The operator UI is gated behind **sign-in** (Live outputs stay public, read-only
mirrors). Accounts, sessions, per-channel roles (`owner` ⊃ `author` ⊃ `viewer`)
and channel ownership live in `lumen.db` (SQLite). On first run a default
`admin` / `admin` account is seeded — **change it after signing in.** Multiple
operators see **presence** (who's online, who controls each channel) and can
**take over** a channel with confirmation; the previous controller drops to
read-only. WebSocket connections are authenticated from the session cookie on
their upgrade request — the httpOnly cookie is never read by page JS.

### Station ↔ VPS bridge (optional)

The station is fully functional on its own LAN. To let off-LAN teammates reach
it without NAT config, set these env vars and the station opens a resilient
outbound bridge to a thin always-on VPS relay:

```bash
LUMEN_VPS_URL=wss://vps.example.com/station   # absent = local-only (default)
LUMEN_STATION_ID=my-church                     # room id the VPS routes
LUMEN_VPS_TOKEN=shared-secret                   # presented on connect
```

The station stays **authoritative** — auth and playback never depend on the VPS,
so the service keeps running if it's unreachable.

## What's intentionally not in v1

- A native compositor and hardware streaming encoder (Studio currently uses Chromium + FFmpeg)
- Cloud sync of the deck content (the VPS bridge relays control state, not files)
- Cloud Bible API integration (Scripture uses the local offline library instead)
- The VPS relay server itself — the station-side bridge ships; the VPS
  counterpart is provisioned per deployment
