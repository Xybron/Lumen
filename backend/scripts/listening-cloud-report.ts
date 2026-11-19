/** Render saved benchmark evidence; no network calls or credentials. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {BOOK_NAMES} from '../src/scripture-reference.js';
import {wordErrors} from '../src/listening-evaluation.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const directory=path.resolve(process.argv[2]??path.join(root,'data/ai/corpus/commercial-comparison-2026-11-18'));
const report=JSON.parse(await fs.readFile(path.join(directory,'comparison.json'),'utf8'));
const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const sec=(ms:number|null)=>ms===null?'—':`${(ms/1000).toFixed(2)} s`;
const position=(seconds:number)=>Number(seconds.toFixed(2));
const pct=(fraction:number|null)=>fraction===null?'—':`${(fraction*100).toFixed(1)}%`;
const ref=(r:any)=>r?`${BOOK_NAMES[r.book-1]} ${r.chapter}:${r.verse}${r.endVerse&&r.endVerse!==r.verse?`–${r.endVerse}`:''}`:'None';
const same=(a:any,b:any)=>!!a&&!!b&&a.book===b.book&&a.chapter===b.chapter&&a.verse===b.verse&&(a.endVerse??a.verse)===(b.endVerse??b.verse);
const correct=(r:any,reference:any)=>r.expectedReferences.some((g:any)=>same(g,reference));
const percentile=(values:number[],p:number)=>values.length?[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)]:null;
const names:Record<string,string>={assemblyai:'AssemblyAI',deepgram:'Deepgram',openai:'OpenAI'};
const providers=Object.keys(report.profiles);
const diagnostics:any={createdAt:report.createdAt,providers:{}};
const rows=report.rows;
for(const provider of providers){
  const selected=rows.filter((r:any)=>r.provider===provider);
  diagnostics.providers[provider]={
    completedClips:selected.length,
    audioSeconds:selected.reduce((s:number,r:any)=>s+r.audioSentSeconds,0),
    setupP50Ms:percentile(selected.map((r:any)=>r.setupMs),.5),
    finalizationP50Ms:percentile(selected.map((r:any)=>r.finalizationLagMs),.5),
    finalizationP95Ms:percentile(selected.map((r:any)=>r.finalizationLagMs),.95),
    clipsWithAnyWrongStreamingSuggestion:selected.filter((r:any)=>r.events.some((e:any)=>e.reference&&!correct(r,e.reference))).length,
    stableReferenceTimes:selected.filter((r:any)=>r.expectedReferences.length).map((r:any)=>({clipId:r.clipId,startSeconds:r.startSeconds,stableReferenceFromStartMs:r.stableReferenceFromStartMs})),
    // AssemblyAI bills connection duration. This uses measured connection time
    // as an approximation; handshake and shutdown can differ from billing.
    estimatedRunUsd:selected.reduce((s:number,r:any)=>s+(provider==='assemblyai'?r.sessionMs/1000:r.audioSentSeconds)/60*report.profiles[provider].ratePerMinute,0),
    estimatedTwoHourUsd:120*report.profiles[provider].ratePerMinute,
  };
}
const metrics=(group:string)=>`<div class="table-wrap"><table><thead><tr><th>Provider</th><th>Clips</th><th>Correct references</th><th>Wrong final suggestions</th><th>Word error rate ↓</th></tr></thead><tbody>${providers.map(p=>{const s=report.summary[p][group];return `<tr><th>${names[p]}</th><td>${s.clips}</td><td>${s.expectedReferences?`${s.correctCandidates}/${s.expectedReferences}`:'No positive references'}</td><td>${s.wrongCandidates}</td><td>${pct(s.wordErrorRate)}</td></tr>`;}).join('')}</tbody></table></div>`;
const timing=`<div class="table-wrap"><table><thead><tr><th>Provider</th><th>Finalization lag p50 / p95</th><th>Setup p50</th><th>Clips with any wrong streaming suggestion</th><th>Est. / 2-hour service</th></tr></thead><tbody>${providers.map(p=>{const d=diagnostics.providers[p];return `<tr><th>${names[p]}</th><td>${sec(d.finalizationP50Ms)} / ${sec(d.finalizationP95Ms)}</td><td>${sec(d.setupP50Ms)}</td><td>${d.clipsWithAnyWrongStreamingSuggestion}/${d.completedClips}</td><td>$${d.estimatedTwoHourUsd.toFixed(2)}</td></tr>`;}).join('')}</tbody></table></div>`;
const positiveClips=[...new Map(rows.filter((r:any)=>r.expectedReferences.length).map((r:any)=>[r.clipId,r])).values()] as any[];
const stable=`<div class="table-wrap"><table><thead><tr><th>Source interval</th><th>Expected reference</th>${providers.map(p=>`<th>${names[p]}</th>`).join('')}</tr></thead><tbody>${positiveClips.map(r=>`<tr><th>${position(r.startSeconds)}–${position(r.startSeconds+r.audioSeconds)} s</th><td>${r.expectedReferences.map(ref).join(', ')}</td>${providers.map(p=>{const found=rows.find((x:any)=>x.provider===p&&x.group===r.group&&x.clipId===r.clipId);return `<td>${found?sec(found.stableReferenceFromStartMs):'Missing'}</td>`;}).join('')}</tr>`).join('')}</tbody></table></div>`;
const clipKeys=[...new Set(rows.map((r:any)=>`${r.group}/${r.clipId}`))] as string[];
const clips=clipKeys.map(key=>{
  const selected=rows.filter((r:any)=>`${r.group}/${r.clipId}`===key),first=selected[0];
  const audio=path.relative(directory,path.join(root,'data/ai/corpus/ogyiri-asare-evaluation-2026-11-12',first.group,'clips',`${first.clipId}.wav`)).split(path.sep).join('/');
  return `<details class="clip"><summary>${escape(first.group)} · ${position(first.startSeconds)}–${position(first.startSeconds+first.audioSeconds)} s · Expected: ${escape(first.expectedReferences.map(ref).join(', ')||'no scripture')}</summary>
  <audio controls preload="none" src="${escape(audio)}"></audio><p class="gold"><strong>Reviewed transcript:</strong> ${escape(first.expectedTranscript)}</p>
  ${providers.map(p=>{const r=selected.find((r:any)=>r.provider===p);if(!r)return `<h3>${names[p]}</h3><p>Incomplete — see failures.</p>`;
    const errors=wordErrors(r.expectedTranscript,r.transcript);const status=r.predictedReference?(correct(r,r.predictedReference)?'correct':'wrong'):(r.expectedReferences.length?'missed':'correct');
    return `<section class="transcript"><h3>${names[p]} <span class="${status}">${escape(ref(r.predictedReference))}</span></h3><p>${escape(r.transcript)||'<em>Empty transcript</em>'}</p><p class="muted">${errors.errors} word errors / ${errors.referenceWords} reference words · Finalization ${sec(r.finalizationLagMs)} · Stable correct reference ${sec(r.stableReferenceFromStartMs)}</p><details><summary>Transcript and reference timeline (${r.events.length} updates)</summary><div class="table-wrap"><table><thead><tr><th>From start</th><th>Transcript</th><th>Candidate</th><th>Final event</th></tr></thead><tbody>${r.events.map((e:any)=>`<tr><td>${sec(e.atMs)}</td><td>${escape(e.text)}</td><td>${escape(ref(e.reference))}</td><td>${e.final?'Yes':'No'}</td></tr>`).join('')}</tbody></table></div></details></section>`;
  }).join('')}</details>`;
}).join('');
const totalCost=Object.values(diagnostics.providers).reduce((sum:number,d:any)=>sum+d.estimatedRunUsd,0);
const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LUMEN · Commercial listening comparison</title>
<style>:root{font-family:system-ui,sans-serif;color:#182b34;background:#f2f5f4;line-height:1.6}*{box-sizing:border-box}body{max-width:1180px;margin:auto;padding:36px 24px 80px}header{border-top:6px solid #167367;padding:24px 0}h1{font-size:clamp(28px,4vw,44px);line-height:1.15;margin:8px 0 20px}h2{font-size:23px;margin-top:38px}h3{font-size:17px}.eyebrow{color:#167367;text-transform:uppercase;font-size:13px;letter-spacing:2px;font-weight:700}.note{background:#fff4d8;border-left:4px solid #b78119;padding:14px 20px}.muted{color:#586b74;font-size:14px}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;background:white;margin:12px 0 22px;font-size:14px}th,td{padding:13px 15px;border-bottom:1px solid #dbe5e3;text-align:left;vertical-align:top}thead th{background:#183f3b;color:white}tbody th{white-space:nowrap}a{color:#086b62}details.clip{background:white;padding:18px 22px;border:1px solid #dbe5e3;border-radius:8px;margin:12px 0}summary{cursor:pointer;font-weight:600}audio{margin:18px 0 0;max-width:100%}.gold{background:#edf5f1;padding:16px}.transcript{padding:8px 0 20px;border-top:1px solid #dbe5e3}h3 span{font-size:13px;margin-left:12px;padding:3px 9px;border-radius:20px}.correct{background:#e0f2e6;color:#166239}.wrong,.missed{background:#fce3df;color:#963529}code{overflow-wrap:anywhere}footer{border-top:1px solid #ccd8d5;margin-top:38px;padding-top:18px}@media(max-width:600px){body{padding:20px 12px}th,td{padding:10px}details.clip{padding:14px}}</style>
<header><div class="eyebrow">LUMEN / Listening evidence</div><h1>Scripture accuracy comes first.</h1><p>AssemblyAI, Deepgram and OpenAI · Rev. Ogyiri Asare · ${escape(report.createdAt)}</p><p>15 reviewed clips, 150 seconds of source audio, streamed at normal speed. ElevenLabs excluded as requested.</p></header>
<p class="note"><strong>A development benchmark, not a general accuracy claim.</strong> All three positive clips concern <strong>1 Samuel 16:13</strong>; this is one preacher and one recording. These clips have already informed earlier LUMEN improvements. No model was fine-tuned. A different sermon and broader references are needed before choosing a production provider.</p>
<h2>Clearer clips</h2><p>12 clips · 120 seconds · Three positive references, nine negative clips. Final suggestions are scored against reviewed labels.</p>${metrics('baseline')}
<h2>Singing and overlapping voices</h2><p>Three scored clips · 30 seconds · No expected scripture references. Nine unscored clips from the stress collection were excluded. This set tests false suggestions and transcription, but cannot establish scripture recall over singing.</p>${metrics('stress')}
<h2>Speed and transient errors</h2>${timing}<p class="muted">Finalization lag measures the wait after sending the whole 10-second clip and requesting a final transcript. It is not the delay after a spoken citation. Setup is reported separately. All transcript updates, including provisional text and finalized segments, were checked for wrong suggestions. These suggestions were measured offline and never shown live. One pass per provider; p95 is descriptive for this small sample.</p>
<h2>When the correct scripture became stable</h2>${stable}<p class="muted">Seconds from clip playback start, including the time spent speaking. “Stable” is assessed retrospectively: the candidate stays correct through every remaining transcript update. It is not a production confidence score or a measured delay from the last scripture word. “—” means no stable correct candidate.</p>
<h2>Method and cost</h2><ul><li>Same 66 Bible-book hints for every provider. No expected chapter, verse or transcript supplied.</li><li>Same LUMEN matcher and frozen KJV library; each clip matched independently without cross-clip context. Assisted mode only.</li><li>AssemblyAI: ${escape(report.profiles.assemblyai.model)}, manual endpointing, Voice Focus near-field at 0.5.</li><li>Deepgram: Nova-3 English with keyterm prompting. OpenAI: gpt-live-transcribe, medium delay. All receive 100 ms chunks; OpenAI audio resampled to 24 kHz.</li><li>Estimated completed-run transcription usage: approximately $${totalCost.toFixed(2)} combined, excluding preflight, failed requests, taxes and credits. This is a rate-based estimate, not an invoice. AssemblyAI connection billing approximated using measured session duration.</li><li>Two-hour estimates use current published rates: <a href="https://www.assemblyai.com/pricing/">AssemblyAI</a> $0.45/hour + $0.10/hour Voice Focus; <a href="https://deepgram.com/pricing">Deepgram</a> $0.0048/minute + $0.0013/minute keyterms (promotional rate); <a href="https://developers.openai.com/api/docs/pricing">OpenAI</a> $0.017/minute. Hosting and any future semantic retrieval costs are additional.</li><li>Word error rate uses literal words; digit formatting versus spoken number words counts as an error. Reference accuracy is the primary outcome.</li></ul>
${report.failures.length?`<h2>Incomplete requests</h2><pre>${escape(JSON.stringify(report.failures,null,2))}</pre>`:''}
${report.recovery?`<p class="muted">${escape(report.recovery)} <a href="comparison-initial.json">Initial run</a> · <a href="recovery/comparison.json">Recovery run</a> · <a href="benchmark-recovery-source.ts">Repaired runner</a>.</p>`:''}
<h2>Inspect every clip</h2>${clips}
<footer><p><a href="comparison.json">Raw results and provenance</a> · <a href="diagnostics.json">Timing and cost calculations</a> · <a href="benchmark-source.ts">Executed benchmark source</a></p><p class="muted">Source changes during run: ${escape(report.sourceChanged.length?report.sourceChanged.join(', '):'none')}. Fingerprint: <code>${escape(report.fingerprint)}</code>. No output was published and LUMEN’s live provider was not changed.</p></footer></html>`;
await fs.writeFile(path.join(directory,'diagnostics.json'),JSON.stringify(diagnostics,null,2));
await fs.writeFile(path.join(directory,'comparison.html'),html);
console.log(JSON.stringify({report:path.join(directory,'comparison.html'),diagnostics},null,2));
