# Listening accuracy and long-term model development

Lumen must recognise speech, retrieve the intended passage, and decide whether the evidence warrants publication. These are separate problems. A confident recogniser can still transcribe the wrong book or number; a scripture similarity score does not measure whether a speaker said those words.

## Implemented foundation

- AudioWorklet capture follows the sample clock, with 2.5 seconds of preceding context. Inference backpressure extends the next window up to 12 seconds. Overload and failed windows stop visibly rather than silently losing speech. Silence breaks partial-reference continuity.
- Local Whisper runs without a list of Bible names in its prompt: the prior prompt produced invented words on synthetic noise. Installed Silero VAD accepts or rejects a whole window before decoding. Padding covers the full 12-second window and extra overlap is disabled: ordinary VAD trimming removed real speech in the supplied sermon, so speech-containing windows retain their original audio. Existing installations without the detector remain usable and can install it using `npm run setup:ai -- --vad-only`, then restart the station.
- Decoder evidence travels separately from scripture scores. Missing, uncertain, rejected, malformed or truncated recognition evidence prevents automatic publication and voice commands. The thresholds are operating rules, not a calibrated percentage accuracy or a promise of accent support.
- Fresh adjacent partial citations can be joined when the continuation explicitly supplies a chapter or verse. Gaps, uncertainty, corrections, conflicts, unrelated speech and workspace changes invalidate that context.
- Exact references and distinctive quotations resolve against the installed Bible edition. Shared-word paraphrases can produce review suggestions; they cannot publish automatically. This is lexical retrieval, not a general semantic model.
- Local corpus preparation, draft transcription, human review, evaluation and training export are distinct steps. Reports identify model/runtime/audio hashes and preserve source/speaker splits. See [the evaluation workflow](listening-evaluation.md).

## First corpus

`training/LEAD CONFERENCE.mp4` is the supplied Rev. Ogyiri Asare recording (77 minutes, 24 seconds). Initial development samples are six minutes total: 05:00–07:00, 30:00–32:00 and 60:00–62:00. They include different sections of the service; the named preacher is source metadata, not verified diarisation of every voice. Mark clips containing another speaker, music, prayer or code-switching during review.

Generated clips, drafts and reports live under ignored `data/ai/corpus/`. They are not training labels. Do not copy machine transcripts into the gold labels without listening and correcting them. English is the initial decoder setting; mixed languages need explicit annotation and a separately validated recognition path.

## Model choice

Base English remains the installer default. Turbo is installed and selected for the development station's next restart after a preliminary comparison on the supplied sermon; this is not a claim of measured accent accuracy. Compare the same human-labelled clips and actual capture conditions before promoting a station configuration for unattended use. Keep a known-good model available for rollback.

The [Whisper Turbo model card](https://huggingface.co/openai/whisper-large-v3-turbo) describes a reduced decoder for faster inference and a quality tradeoff relative to large-v3. Its broader training is a reason to evaluate it, not proof of accuracy on Ghanaian sermons. [Parakeet v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) is another candidate for a future runtime adapter; its 25 supported languages are European languages, so it is not evidence of Twi support. The existing [whisper.cpp server](https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/examples/server/README.md) supports local VAD without introducing a cloud service.

## Next measured improvements

1. **Establish gold data.** Review explicit citations, paraphrases, corrections, ordinary speech, audience responses, music and silence. Include multiple microphones, rooms and speaker accents. Keep entire speakers and source recordings separate across train, development and final evaluation. One recording cannot establish generalisation to African speakers or languages.
2. **Compare pretrained recognisers first.** Measure word errors, book/chapter/verse errors, missed references, wrong suggestions, incorrect automatic publications and processing latency. Review results by speaker and noise condition, not just one overall average. Live capture timing and long-session stability need their own rehearsal; offline processing milliseconds exclude window accumulation.
3. **Add semantic retrieval behind a replaceable interface.** Build an embedding index per installed edition, keyed by embedding-model revision and corpus checksum. Combine bounded lexical and vector candidates, optionally rerank them, and always resolve final verse text from the canonical library. Use multi-verse passages where the quotation spans verse boundaries. Keep semantic matches review-only until evidence supports a stronger policy. This layer is not implemented in the current change.
4. **Fine-tune only from corrected speech.** If stronger pretrained recognisers still make systematic errors, export reviewed training clips and fine-tune an ASR model on suitable hardware. Use separate development data for model/threshold selection and untouched speakers for final evaluation. Include general speech to check for regression and avoid teaching every utterance to become scripture. A corpus export does not update any model weights.
5. **Calibrate action decisions.** Use held-out labels to relate decoder evidence, reference ambiguity and retrieval evidence to actual errors. Track abstention as well as accuracy; confidently wrong book names and chapter numbers matter more than harmless punctuation. A single fixed confidence threshold cannot certify a new model.

## Keep the system replaceable

Retain a stable audio/result contract while recognisers change. Version the corpus, model, decoder settings, retrieval index and decision policy together. Require a reproducible evaluation and live rehearsal before promoting a new release. Store a rollback model and migrate indexes independently of Bible content. Periodically test new recognisers against the same held-out corpus; add newly observed failure cases to development data without repeatedly tuning on final evaluation speakers.

The five-year asset is the reviewed corpus, repeatable evaluation, canonical scripture library and replaceable pipeline. No particular model can be promised to remain the best choice for five years.
