import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeLocalRecognition,needsSpeechRecovery,chooseRecoveredSpeech} from '../src/listening-recognition.js';

test('recognition evidence stays distinct from an apparently valid scripture reference',()=>{
  const clear=analyzeLocalRecognition({segments:[{text:'John three sixteen',avg_logprob:-.2,no_speech_prob:.01}]});
  assert.equal(clear.text,'John three sixteen');assert.equal(clear.recognition.status,'clear');
  for(const diagnostic of [{avg_logprob:-1,no_speech_prob:.02},{avg_logprob:-.2,no_speech_prob:.9}]) {
    const uncertain=analyzeLocalRecognition({segments:[{text:'John three sixteen',...diagnostic}]});
    assert.equal(uncertain.text,clear.text);assert.equal(uncertain.recognition.status,'uncertain');
  }
});
test('a weak word cannot hide inside a high average segment score',()=>{
  const result=analyzeLocalRecognition({segments:[{text:'John three sixteen',avg_logprob:-.2,no_speech_prob:.01,words:[{word:'John',probability:.9},{word:'sixteen',probability:.02}]}]});
  assert.equal(result.recognition.status,'uncertain');
});
test('discarded corrections mark the surviving transcript uncertain',()=>{
  const result=analyzeLocalRecognition({segments:[{text:'John three',avg_logprob:-.2,no_speech_prob:.01},{text:' no, not that verse',avg_logprob:-1.9,no_speech_prob:.1},{text:' verse sixteen',avg_logprob:-.3,no_speech_prob:.01}]});
  assert.equal(result.text,'John three verse sixteen');assert.equal(result.recognition.status,'uncertain');assert.equal(result.recognition.rejectedSegments,1);
});
test('missing and malformed diagnostics cannot masquerade as clear recognition',()=>{
  for(const result of [
    {text:'John 3:16'},
    {segments:[{text:'John 3:16'}]},
    {segments:[{text:'John 3:16',avg_logprob:NaN,no_speech_prob:.1}]},
    {segments:[{text:'John 3:16',avg_logprob:-.1,no_speech_prob:1.5}]},
    {segments:[null,{text:'John 3:16',avg_logprob:-.1,no_speech_prob:.01}]},
    {segments:[{text:'John 3:16',avg_logprob:-.1,no_speech_prob:.01},{text:42,avg_logprob:-2,no_speech_prob:.9}]},
  ]) assert.equal(analyzeLocalRecognition(result).recognition.status,'unavailable');
  assert.equal(analyzeLocalRecognition(null).recognition.status,'no-speech');
  assert.equal(analyzeLocalRecognition({segments:[]}).recognition.status,'no-speech');
  assert.equal(analyzeLocalRecognition({segments:[{text:'...',avg_logprob:-.2,no_speech_prob:.01}]}).recognition.status,'no-speech');
});
test('a truncated response cannot hide a trailing correction behind a clear prefix',()=>{
  const result=analyzeLocalRecognition({segments:[{text:'John 3:16 '+'amen '.repeat(1000)+' no, that is wrong',avg_logprob:-.1,no_speech_prob:.01}]});
  assert.equal(result.text.length,4000);assert.equal(result.recognition.status,'uncertain');
});

test('music markers cannot become scripture words or clear automatic evidence',()=>{
  for(const text of ['[Music] John three sixteen','♪ John three sixteen ♫','(singing) John three sixteen']) {
    const result=analyzeLocalRecognition({segments:[{text,avg_logprob:-.1,no_speech_prob:.01}]});
    assert.equal(result.text.trim(),'John three sixteen');assert.equal(result.recognition.status,'uncertain');
  }
  const music=analyzeLocalRecognition({segments:[{text:'[Music] ♪',avg_logprob:-.1,no_speech_prob:.01}]});
  assert.equal(music.text,'');assert.equal(music.recognition.status,'no-speech');
  assert.equal(analyzeLocalRecognition({text:'[Music] John three sixteen'}).recognition.status,'uncertain');
  assert.equal(analyzeLocalRecognition({text:'[John] three sixteen'}).text,'[John] three sixteen');
});

test('sparse recovery keeps original words, rejects looping or contradictory passes, and always requires review',()=>{
  const result=(text:string)=>analyzeLocalRecognition({segments:[{text,avg_logprob:-.5,no_speech_prob:.01}]});
  const primary=result('every disappointment');
  assert.equal(needsSpeechRecovery(primary.text,primary.recognition,10),true);
  assert.equal(needsSpeechRecovery(primary.text,primary.recognition,5),false);
  assert.equal(needsSpeechRecovery('',primary.recognition,10),false);
  assert.equal(needsSpeechRecovery('these are clear words spoken throughout the entire audio window',primary.recognition,10),false);
  const recovered=chooseRecoveredSpeech(primary,[result('every disappointment receive'),result('the power to break new records')]);
  assert.equal(recovered.recognition.status,'uncertain');assert.match(recovered.text,/new records/);
  for(const text of ['a completely different sentence without original words','every disappointment let us go let us go let us go','every disappointment'])assert.equal(chooseRecoveredSpeech(primary,[result(text)]),primary);
});
