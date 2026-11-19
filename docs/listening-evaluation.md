# Real-sermon listening evaluation

The listening pipeline needs evidence from the speakers, microphones and rooms where Lumen runs. A recognizer's token scores are diagnostics, not a measured probability that it heard a Ghanaian speaker correctly. Playing a sermon through the application does not train model weights. This workflow turns recordings into reviewed examples, compares installed recognizers and exports training data when there is enough labelled material.

All commands run locally from the repository root using the installed backend dependencies. Audio is never uploaded. Evaluation uses an isolated worker and a temporary snapshot of the Bible library; it cannot publish to the station's actual channels or change its selected model. Output paths must be new so a previous corpus/report cannot be overwritten accidentally. Put private recordings, clips, labels and reports under `data/ai/`, which is already ignored by Git.

## 1. Prepare representative audio

Start with several minutes from different parts of the sermon: clear citations, paraphrases, ordinary preaching, music/applause, silences and difficult microphone conditions. Keep false-positive examples, not just successful scripture mentions. Identify the actual speaker/languages; there is no single African accent.

```sh
backend/node_modules/.bin/tsx backend/scripts/listening-evaluate.ts prepare \
  --input '/absolute/path/to/sermon.mp4' \
  --out data/ai/corpus/speaker-a-sermon-1 \
  --speaker speaker-a --language en --split development \
  --start 600 --duration 120 --seconds 10
```

`--start` and `--duration` are optional seconds. Omitting duration processes the rest of the recording. Preparation selects the first audio track, converts it to mono 16 kHz/16-bit PCM and creates non-overlapping clips plus `manifest.json`. Clips can be 3–12 whole seconds; the default is 10. A final tail shorter than 0.1 seconds is omitted and reported. No labels are inferred from the audio. Source and clip SHA-256 hashes preserve provenance. Keep the original recording: a stereo mixdown is useful for repeatable evaluation but a clean preacher feed can be better than a full room mix.

The manifest is editable JSON. Each clip initially has `reviewed:false`, `transcript:null` and `expectedReferences:null`. A reviewer must listen and fill those fields:

```json
{
  "reviewed": true,
  "transcript": "John chapter three verse sixteen",
  "expectedReferences": [{"book":43,"chapter":3,"verse":16}],
  "automaticAllowed": true,
  "notes": "Clear complete citation."
}
```

This is an excerpt; retain the clip ID, path, hashes and timing fields. Books use the canonical 1–66 order. A range adds `endVerse`. Use `expectedReferences:[]` when no passage should be suggested, including ambiguous general religious statements. Silence has `transcript:""`; ordinary non-scripture speech still needs a verbatim transcript. Mark `automaticAllowed:false` for paraphrases or ambiguity needing review even when the expected suggestion is known. Do not repair spoken mistakes into the intended Bible wording: the transcript describes the audio, while reference labels describe the expected product outcome. Prefer a second reviewer for ambiguous examples.

When a word/citation crosses a clip boundary, retain the actual fragment in each transcript and label expected references in the order a listener should resolve them. Evaluation carries session context through consecutive clips within a manifest using source-audio timestamps, so inference speed cannot change reference continuity. Gaps and separate manifests reset context. For unintelligible material, leave it unreviewed until it can be resolved or create a separate documented set; do not guess gold labels. The evaluator requires every clip in a selected manifest to be reviewed.

## 2. Produce separate model drafts for review

```sh
backend/node_modules/.bin/tsx backend/scripts/listening-evaluate.ts draft \
  --manifest data/ai/corpus/speaker-a-sermon-1/manifest.json \
  --model base.en --out data/ai/reports/speaker-a-base-draft.json

backend/node_modules/.bin/tsx backend/scripts/listening-evaluate.ts draft \
  --manifest data/ai/corpus/speaker-a-sermon-1/manifest.json \
  --model large-v3-turbo-q5_0 --out data/ai/reports/speaker-a-turbo-draft.json
```

Drafts contain hypotheses, recognition diagnostics, processing times and model/worker hashes. They never fill or change manifest labels, publish verses, or calculate an accuracy score. Human review should start with the audio, since copying recognizer output as ground truth would conceal its mistakes. A model must already be installed; no command downloads one. `--model` also accepts an explicit compatible local model file and `--worker` accepts an explicit whisper-server executable.

Both draft and evaluation use the station's installed Silero voice activity detector when available. `--speech-detection neural` requires it, `--speech-detection energy` disables it for a controlled comparison, and `--vad-model /path/model.bin` explicitly selects a compatible detector. Reports record the actual choice and detector hash, the shared runtime decoding/evidence/VAD configuration, application source hashes, Git revision/dirty status and Node/platform details. They flag source changes during the run. Keep these settings fixed when comparing speech models and regenerate a comparison if the source changed while it ran.

Create an offline audio review page to avoid editing JSON by hand:

```sh
backend/node_modules/.bin/tsx backend/scripts/listening-review.ts \
  --manifest data/ai/corpus/speaker-a-sermon-1/manifest.json \
  --draft data/ai/reports/speaker-a-base-draft.json \
  --draft data/ai/reports/speaker-a-turbo-draft.json \
  --out data/ai/corpus/speaker-a-review.html
```

Open the generated HTML in a browser. It has local audio controls, playback speed, editable human transcripts, expected references such as `John 3:16; Psalms 23:1`, and an explicit reviewed checkbox for each clip. Draft hypotheses are read-only and initially collapsed; they are never copied into human labels. Changing a label clears its reviewed check. Export each set and save the downloaded JSON **in that set's corpus folder beside the original manifest**, so its `clips/…` audio paths still resolve. Pass that new reviewed JSON to evaluation. Partial review can be exported and resumed by generating another review page from the saved labels and the same drafts. No page edits are saved until export.

Repeat `--manifest` to include multiple sample sets covered by the same draft reports. The generator checks local audio hashes and associates each draft with the exact source, speaker, clip, timestamp, duration and clip hash. Older drafts without direct clip hashes also require the original manifest hash. Changing audio requires a new draft. The page makes no network requests; keep it next to the corpus tree so its relative audio links continue to work.

## 3. Compare against human labels

```sh
backend/node_modules/.bin/tsx backend/scripts/listening-evaluate.ts evaluate \
  --manifest data/ai/corpus/speaker-a-sermon-1/manifest.json \
  --split development --model base.en --version KJV \
  --out data/ai/reports/speaker-a-base.json
```

Repeat with another installed model and a different output path, keeping the manifests, Bible edition and hardware fixed. The default library is `data/worship.db` (or `LUMEN_DATA_DIR/worship.db`); `--database` overrides it. Every labelled expected passage must exist in the selected edition. The evaluator uses the actual transcription and listening-session code with voice commands disabled, including review/abstention behavior and sequential context. It passes recognition diagnostics through the same publication gate as live listening.

Evaluation defaults to `--mode assisted` (Prepare only). Use `--mode automatic` explicitly to audit armed automatic publication; reports record the selected mode. The `automaticAllowed` gold label scores the outcome and never changes runtime mode. A correct verse sent in automatic mode against a review-only label is a policy mismatch, not a wrong-verse match. Compare publication counts only between runs with the same mode.

The installed Turbo profile allows acoustic markers such as `[Music]` instead of suppressing them. Other profiles retain suppression because the same change regressed Base on the development corpus. Recognised markers are excluded from transcript words; music mixed with words requires review even when decoder scores look strong. This is not speaker separation: music without markers and overlapping voices can still produce wrong words.

Reports include:

- Corpus word-error rate (substitutions + insertions + deletions / human transcript words), raw counts and inserted words on silent clips. Punctuation/case are normalized, but wrong number words remain errors. For example, `sixteen` versus `16` counts as one formatting/lexical difference; inspect reference metrics alongside WER.
- Exact scripture candidate precision and recall, false suggestions on clips labelled with no reference, and abstention on positive clips. A wrong verse range is an incorrect candidate. Multiple labelled references can lower recall because the product prepares one candidate at a time.
- Incorrect automatic publications: a wrong reference or a publication where `automaticAllowed` is false. A review-only correct paraphrase is a useful suggestion, not an automatic-publication failure.
- Processing latency p50/p95, real-time factor and separate model warmup. These timings exclude audio collection/window duration and do not claim live microphone end-to-end latency. A model slower than the audio it consumes cannot keep up indefinitely.
- Per-speaker results, worst speaker by WER, individual decisions and diagnostic data, corpus/model/worker/library hashes.

A metric with no denominator is `null`, not a perfect score. A small sample with zero errors is not proof of zero risk. Compare the difficult speakers and false publications, not only the average. This fixed-clip benchmark evaluates recognition/matching; it does not replace live rehearsal of browser capture, rolling window overlap, device disconnects and processing backlog.

## 4. Hold out speakers and recordings

Use three corpus splits: `train` for future weight adaptation, `development` for model/threshold selection, and `evaluation` for final checks after choices are fixed. Hold out entire speakers and source recordings. One sermon can establish a development baseline; it cannot establish generalization to other preachers.

Pass **all** manifests with repeated `--manifest` flags when evaluating or exporting. The tool rejects the same speaker, source recording or identical audio clip in different splits, as well as overlapping source intervals across manifests. It can only detect leakage among manifests supplied to that invocation; keep speaker IDs consistent across recordings. New transcodes of the same recording have different byte hashes, so preserve the original source identity in corpus administration. Do not repeatedly tune against the evaluation set and then present its results as independent validation.

## 5. Export reviewed training examples

```sh
backend/node_modules/.bin/tsx backend/scripts/listening-evaluate.ts export-training \
  --manifest data/ai/corpus/training-speaker/manifest.json \
  --manifest data/ai/corpus/held-out-speaker/manifest.json \
  --out data/ai/training/reviewed-train.jsonl
```

Only reviewed clips in the `train` split are exported. Each JSONL record contains a local audio path, human transcript, language, speaker/source identity, timing and clip hash. Development/evaluation clips are excluded. This is a dataset export, not a fine-tuning job; no model weights change. Choosing a trainer, supported languages, compute budget and export/runtime format comes after a sufficiently varied reviewed corpus exists. English mixed with Twi needs a recognizer actually trained/evaluated for those languages; a multilingual model name alone does not establish that capability.

## Maintaining accuracy over time

Keep capture quality, speech recognition and scripture retrieval separately measurable. Improve recognition using verified audio/transcript pairs; improve scripture retrieval using verified citation/paraphrase labels and the installed Bible text. Avoid feeding lists of desired Bible references into weak audio and treating the resulting words as evidence. Context should help resolve a partial citation without inventing a verse.

For every new recognizer or adaptation, rerun the held-out corpus, review regressions, then rehearse live on the target station. Keep model and report versions so an update can be rolled back. Future semantic retrieval should suggest passages from the actual library and be evaluated against confusable/negative examples; a language model's plausible verse name must not bypass that evidence. Only calibrate confidence or change automatic-publication thresholds using measured held-out outcomes. The replaceable local model/worker paths and versioned corpus provide an upgrade path without committing Lumen to one recognizer for the next five years.


### Sparse speech recovery and common-fragment rejection

Turbo Scripture listening now retries unusually sparse transcripts (at least 8 seconds, fewer than 0.5 words/second, nonempty speech and average decoder log probability at most -0.4) as two shorter windows. The first pass must already have detected words. Recovery bypasses the speech gate so shouted words are not discarded as nonspeech, skips digital silence, clears the prompt and resets VAD on every request. All passes share a 30-second deadline. Base and Lyrics recognition keep their previous path.

The recovered text must retain the first pass's words in order, add at least three words, and contain no repeated three-word loop or rejected/missing diagnostic segments. Accepted recovery always requires review. A failed recovery retains the original words under review. This is bounded acoustic recovery, not enrollment, speaker identification or voice separation. Sparse slow speech can also trigger it; additional words alone are not proof that the preacher was isolated.

Short quotation suggestions now need their ordered matching words to cover at least 50% of the utterance. This prevents a small common phrase inside a longer prayer/instruction from selecting a verse. Distinctive long quotations can still include sermon commentary. The threshold is a development operating rule, not a calibrated probability; assess it with held-out speakers and negative examples.

## AssemblyAI shared live listening

The Scripture listening controls now offer **AssemblyAI** alongside the local model. Add `ASSEMBLYAI_API_KEY` to the project-root `.env` (or the backend process environment). Desktop users can instead keep a private `.env` in the station data folder, opened with **File → Open data folder**, so the key survives app updates and Finder launches. Lookup order is process environment, project-root `.env`, then station `.env`; only this provider's key is read. The station reads this server-side; the key is never sent to the browser. This path requires internet access and streams microphone audio through the station to AssemblyAI. It uses the tested `assemblyai-stt-3-7-realtime-agent` model with Bible-book keyterms, near-field Voice Focus and low-latency, speech-aware turn detection. Finalized speech can publish immediately after matching; provisional words never publish. A short finalized chapter lead-in survives interim revisions of the next turn, and bounded quotation continuation is available for review only. Use a close microphone or a clean preacher feed. The current feature recognizes English; Twi and broader accent accuracy still require separate evaluation.

After starting the updated platform:

1. Open Scripture → Listening and select **AssemblyAI**.
2. Choose the microphone or interface. For a direct mixer feed, choose **Mixer / line input · clean feed** in Settings. Use **Test microphone** to check levels locally.
3. Click **Listen**. Browser/system microphone permission is required. Streaming begins once the station confirms the provider connection. Watch the live transcript and prepared passage. Choose **Prepare only** for review, or **Auto publish** to publish clear finalized references and distinctive exact quotations. Provisional speech, ambiguous matches, low-confidence words, repeated final turns and stop-time finalization cannot publish. Manual scripture controls disarm automatic publication while shared transcription continues.
4. Use **Save last 12 seconds for review** when a match is right, wrong, missing or slow. No audio is saved to disk until this button is clicked. A bounded memory buffer holds the preceding audio while listening.
5. Open **Saved listening examples → Review**. Play the entire clip, supply a speaker label, correct the words, and enter complete expected references (blank means none). Record noise, singing, microphone and uncertain words in Notes. Check the review box only after listening and verifying all labels; otherwise save a draft. Do not guess inaudible words.
6. Use **Stop shared listening** to release the microphone and close the provider session. Shared AssemblyAI listening continues across navigation and ordinary Scripture Take/step actions. Loss of source-channel control, disconnection and missing audio stop the stream visibly.

Examples are private to their operator and stored in `data/ai/live-evaluation/` (or the configured station data directory): a PCM WAV and JSON record with model, session/sample offsets, transcript updates, provider word timing where supplied, predicted reference, and separate human labels. They survive reloads and can be downloaded or deleted from the review dialog. The latest 20 examples per channel are shown. These are evaluation records; saving or reviewing one does not fine-tune AssemblyAI or update model weights. Reviewed exports still need speaker/source separation before incorporation into the development or held-out corpus.

Provisional verse numbers require confirmation on a subsequent update (or provider finalization). Shared quotation prefixes wait for distinctive continuation. Revised or withdrawn candidates clear the prepared listening suggestion. This is an evidence policy, not a calibrated percentage confidence. The cloud path must not interpret provider confidence as permission to publish automatically.

Repeat the commercial test into a **new** directory so immutable earlier evidence is retained:

```sh
node --import ./backend/node_modules/tsx/dist/loader.mjs backend/scripts/listening-cloud-benchmark.ts run --provider=assemblyai --out=data/ai/corpus/assemblyai-next-run
```

An opt-in browser smoke test uses a reviewed sermon clip as a synthetic microphone on a disposable station. It checks the real capture/proxy/provider path and private review workflow without using the operator's physical microphone or real channel output:

```sh
npm run build
LUMEN_RUN_ASSEMBLYAI_SMOKE=1 node backend/test/assemblyai-live-browser.mjs
```

For a useful first live evaluation, include explicit references, quotations and paraphrases from several books, corrections ("not verse ten, verse thirteen"), ordinary non-scripture speech, silence and overlapping voices. Save successes as well as failures. Use different speakers and a fresh sermon for the final assessment. Measure exact reference precision/recall and false suggestions before optimizing word error rate; annotate the last relevant spoken word when assessing true response latency. Current clip-start timing includes speaking time and cannot stand in for that measurement.

### AssemblyAI in Notes

Notes opens as a manual draft, without a transcript panel or microphone access. If Scripture is already using AssemblyAI, open **Transcript** and choose **Link live transcript** to append new completed phrases to that Note. A partly spoken phrase already in progress when you link is excluded, so earlier words are never copied. There is no second microphone or AssemblyAI request. You can link several Notes independently, unlink them, or use Scripture without creating any Notes.

To start from Notes, open **Transcript**, then **Audio settings** to select **AssemblyAI** and the microphone/audio interface. Click **Start shared listening**. The existing **Program · Main mix** source also works when the Program engine is running. This starts the shared session and links the current Note. Grant browser microphone access when prompted. Scripture consumes that same stream when opened. The local recognition option remains available as a separate workspace-bound flow; AssemblyAI does not require an installed local model.

Scripture and linked Notes consume the same AssemblyAI transcription and the same reference/quotation result, including Bible-book keyterms, Voice Focus and the streaming evidence gate. Provisional words appear separately from saved text. Finalized turns are appended once per linked Note; repeated words in different turns are retained. Only the latest transient text is kept in the shared session; there is no full transcript history unless a Note is linked. Incremental Notes updates avoid downloading its entire accumulated transcript on each phrase.

Closing the Notes dialog, navigating, updating slides or choosing **Unlink transcript** does not stop the shared microphone. Links remain active until explicitly unlinked or the shared session ends. **Stop shared listening** releases the microphone immediately and briefly waits for the provider to finalize the last words. An interrupted connection may leave an unfinished turn unsaved; it is never silently promoted to a finalized transcript. Deleting an optional Note removes its link, while deleting or losing control of the source channel stops the producer.

The detected scripture card shows the candidate passage for review. **Use reference** copies its citation into the private slide draft. It does not copy over the draft body, save a public slide or switch Program. Revised/ambiguous results clear the current suggestion. Notes previews edits immediately and saves drafts privately. The explicit **Update slide** or **Update slides** action saves presentation content while leaving the editor open; it does not switch Program or publish raw transcript automatically. There is no calibrated confidence percentage. The station permits one shared AssemblyAI producer; additional consumers reuse its words. Private subscription and destination permissions are rechecked without forwarding transcripts through the public output relay.

Saved Notes transcripts/drafts remain in `notes.db` behind the channel's author permissions. Notes does not record microphone audio to disk or automatically turn its transcript into reviewed training data. For a labeled audio example, use Scripture's **Save last 12 seconds for review** workflow. The Notes integration itself does not train AssemblyAI or alter model weights.

The dedicated opt-in test sends one reviewed sermon clip through a synthetic browser microphone into a disposable Notes workspace. It checks correct scripture detection, private final transcript persistence, explicit reference use, stop/finalization, microphone shutdown, unchanged public content and desktop/mobile layout:

```sh
npm run build
LUMEN_RUN_ASSEMBLYAI_SMOKE=1 node backend/test/notes-assemblyai-browser.mjs
LUMEN_RUN_ASSEMBLYAI_SMOKE=1 node backend/test/shared-listening-browser.mjs
```

### Measuring automatic publication latency

`backend/scripts/listening-latency-benchmark.ts run` explicitly streams the reviewed development clips to AssemblyAI at real-time speed through the production bridge and automatic matcher. It writes only to an isolated copy of the Bible library. `--profiles=fast-endpoint` selects the current profile; `manual-10s` reproduces the previous endpoint schedule. Use a fresh `--out=...` directory. Connection setup, the actual channel mutation, and any provider-word-aligned timing estimate are recorded separately. The harness includes silent tail audio so Stop does not create the measured publication.

Provider word timestamps are estimates, not human annotation. The citation metric starts at the first complete reference's word end; a quotation metric uses the matching turn's last word and may include commentary. Neither measures the Program renderer. Report every false publication and missed match, and keep singing clips separate. This small development corpus has one speaker and only one positive Bible passage; it cannot establish general precision or a guaranteed one-second maximum.

Short natural turns preserve a finalized chapter through the next turn's interim revisions. A new untrusted, empty, unrelated, or corrected final consumes that chapter context; the existing time, edition, revision, and manual-disarm boundaries remain. Quotation fragments may recover a review suggestion from adjacent finalized speech, bounded by time and word count, without changing the raw transcript appended to Notes. This fallback cannot automatically publish, even when its combined words resemble an exact quotation.
