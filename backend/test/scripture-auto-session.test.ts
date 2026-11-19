import test from 'node:test';
import assert from 'node:assert/strict';
import {WorshipLibrary} from '../src/worship-library.js';
import {ListeningSessions} from '../src/listening-session.js';
import {analyzeLocalRecognition} from '../src/listening-recognition.js';
import type {ListeningResult,WorshipWorkspace} from '../../shared/worship.js';

const john='For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.';
const preserve='The LORD shall preserve thee from all evil: he shall preserve thy soul.';
const shared="Their idols are silver and gold, the work of men's hands.";
function fixture(mode:'assisted'|'automatic'='automatic',commands=false) {
  const library=new WorshipLibrary(':memory:');
  library.importBible({version:{id:'KJV',name:'King James Version',attribution:'Public domain'},verses:[
    {book:43,chapter:3,verse:16,text:john},
    {book:43,chapter:3,verse:17,text:'For God sent not his Son into the world to condemn the world; but that the world through him might be saved.'},
    {book:43,chapter:3,verse:18,text:'He that believeth on him is not condemned: but he that believeth not is condemned already, because he hath not believed in the name of the only begotten Son of God.'},
    {book:43,chapter:4,verse:1,text:'When therefore the Lord knew how the Pharisees had heard that Jesus made and baptized more disciples than John.'},
    {book:19,chapter:23,verse:1,text:'The LORD is my shepherd; I shall not want.'},
    {book:19,chapter:121,verse:7,text:preserve},
    {book:19,chapter:115,verse:4,text:shared},
    {book:19,chapter:135,verse:15,text:shared},
    {book:40,chapter:6,verse:33,text:'But seek ye first the kingdom of God, and his righteousness; and all these things shall be added unto you.'},
  ]});
  const changes:WorshipWorkspace[]=[],sessions=new ListeningSessions(library,state=>changes.push(state));
  const session=sessions.start('scripture','operator',{mode,language:'en',commands});let sequence=0;
  const accept=(text:string,revision=library.workspace('scripture').revision)=>sessions.accept('scripture',session.id,'operator',sequence++,'scripture',text,42,revision);
  return {library,sessions,session,changes,accept,close:()=>library.close()};
}
function verse(result:ListeningResult){const selection=result.candidate?.selection;assert.equal(selection?.kind,'scripture');return selection?.kind==='scripture'?selection.verse:undefined;}

test('one clear complete citation publishes immediately without repeating it in another audio window',()=>{
  const f=fixture();try {
    const result=f.accept('Please turn to John chapter three, verse sixteen.');
    assert.equal(result.switched,true);assert.equal(result.decision,'sent-live');assert.equal(result.match,'reference');assert.equal(verse(result),16);assert.equal(result.score,1,'Reference score describes exact installed-library resolution, not ASR confidence.');
    assert.equal(f.changes.length,1);assert.equal(f.library.workspace('scripture').live?.reference,'John 3:16 · KJV');
    // The reference is spoken only once. Later quote/filler windows cannot undo
    // or delay that first take, or republish the same live selection.
    const quote=f.accept('For God so loved the world that he gave his only begotten Son');
    assert.equal(quote.decision,'already-live');assert.equal(quote.switched,false);
    assert.equal(f.accept('Let us all consider what this means for our lives today.').switched,false);
    assert.equal(f.changes.length,1);
  }finally{f.close();}
});

test('partial chapter can be prepared first, then a single full citation goes live as soon as it is heard',()=>{
  const f=fixture();try {
    const partial=f.accept('John chapter three.');assert.equal(partial.decision,'partial');assert.equal(partial.suggestedQuery,'John 3');assert.equal(partial.candidate,null);assert.equal(f.library.workspace('scripture').live,null);
    const complete=f.accept('John chapter three verse sixteen');assert.equal(complete.switched,true);assert.equal(verse(complete),16);assert.equal(f.changes.length,1);
  }finally{f.close();}
});

test('one complete available verse range publishes its exact range rather than only its first verse',()=>{
  const f=fixture();try {
    const result=f.accept('John chapter three verses sixteen through seventeen');
    assert.equal(result.switched,true,result.reason);assert.deepEqual(result.candidate?.selection,{kind:'scripture',versionId:'KJV',book:43,chapter:3,verse:16,endVerse:17});
    assert.match(result.workspace.live?.text??'',/^16 For God.*\n\n17 For God/s);assert.equal(f.changes.length,1);
  }finally{f.close();}
});

test('book-only and misspelled manual-style reference searches do not enable fuzzy automatic publication',()=>{
  for(const text of ['John','Jhon 3:16','Jonh chapter three verse sixteen','God loved all people']) {
    const f=fixture();try{const result=f.accept(text);assert.equal(result.switched,false,text);assert.equal(result.candidate,null);assert.equal(f.changes.length,0);}finally{f.close();}
  }
});

test('repeated canonical citations and agreeing partial lead-ins are corroboration, not conflicting references',()=>{
  for(const text of [
    'John 3:16. John chapter three verse sixteen.',
    'John chapter three. John chapter three verse sixteen.',
    'John 3:16 and John 3:16-16',
  ]) {
    const f=fixture();try{const result=f.accept(text);assert.equal(result.switched,true,`${text}: ${result.reason}`);assert.equal(verse(result),16);assert.equal(f.changes.length,1);}finally{f.close();}
  }
});

test('different complete citations or conflicting partial lead-ins never choose an arbitrary live passage',()=>{
  for(const text of [
    'John 3:16 and Psalm 23:1',
    'John 3:16 and John 3:17',
    'Romans chapter eight. John chapter three verse sixteen.',
    'John chapter four. John chapter three verse sixteen.',
    'John chapter three and Psalm chapter twenty three',
  ]) {
    const f=fixture();try{const result=f.accept(text);assert.equal(result.switched,false,text);assert.equal(result.decision,'conflict',`${text}: ${result.reason}`);assert.equal(result.candidate,null);assert.equal(f.changes.length,0);}finally{f.close();}
  }
});

test('unavailable passages, invalid bounds and incomplete ranges cannot become automatic takes',()=>{
  for(const text of ['John 3:99','John 0:16','John 3:0','John 999:16','John 3:16 through','John 3:16-','John 3:16-18:2','John 3:16-999','John 3:18-16']) {
    const f=fixture();try{const result=f.accept(text);assert.equal(result.switched,false,`${text}: ${result.reason}`);assert.equal(result.candidate,null,text);assert.equal(f.library.workspace('scripture').live,null);assert.equal(f.changes.length,0);}finally{f.close();}
  }
});

test('a removed selected edition stays unavailable for explicit references, quotes and partial reference quotations',()=>{
  for(const text of ['John 3:16',john,`John chapter three. ${john}`]) {
    const f=fixture();try {
      f.library.db.prepare('DELETE FROM bible_versions WHERE id=?').run('KJV');
      const result=f.accept(text);assert.equal(result.switched,false,text);assert.equal(result.candidate,null);assert.equal(result.decision,'unavailable');assert.equal(f.changes.length,0);
    }finally{f.close();}
  }
});

test('assisted mode keeps references and strong quotations private regardless of repetition',()=>{
  const f=fixture('assisted',true);try {
    for(const text of ['John 3:16',john,'John 3:16',preserve]) {
      const result=f.accept(text);assert.ok(result.candidate);assert.equal(result.switched,false);assert.equal(result.decision,'prepared');
    }
    assert.equal(f.library.workspace('scripture').live,null);assert.equal(f.changes.length,0);
  }finally{f.close();}
});

test('deduplicate against the current live verse, not the last reference ever taken',()=>{
  const f=fixture();try {
    assert.equal(f.accept('John 3:16').switched,true);
    assert.equal(f.accept('John 3:16-16').decision,'already-live');assert.equal(f.changes.length,1);
    assert.equal(f.accept('John 3:17').switched,true);
    assert.equal(f.accept('John 3:16').switched,true,'Returning to an earlier verse must not be suppressed by historic reference state.');
    assert.equal(f.changes.length,3);
    f.library.command('scripture',f.library.workspace('scripture').revision,{type:'blank',value:true});
    assert.equal(f.accept('John 3:16').switched,true,'Blanked content is not already visible; an explicit valid reference can restore it.');
    assert.equal(f.library.workspace('scripture').blanked,false);
  }finally{f.close();}
});

test('new complete Scripture references are not blocked by the old three-second take cooldown',t=>{
  const now=Date.now();t.mock.method(Date,'now',()=>now);
  const f=fixture();try {
    assert.equal(f.accept('John 3:16').switched,true);assert.equal(f.accept('John 3:17').switched,true);assert.equal(f.accept('Psalm 23:1').switched,true);assert.equal(f.changes.length,3);
  }finally{f.close();t.mock.restoreAll();}
});

test('one strong exact distinctive quotation can publish from the selected edition',()=>{
  const f=fixture();try {
    const result=f.accept('Church remember this: For God so loved the world that he gave his only begotten Son. What a promise!');
    assert.equal(result.switched,true,result.reason);assert.equal(result.match,'phrase');assert.equal(result.decision,'sent-live');assert.equal(verse(result),16);assert.ok(result.score>=.9);assert.equal(f.changes.length,1);
  }finally{f.close();}
});

test('short, approximate, negated and shared quotations remain visible for review, never auto-published',()=>{
  for(const text of [
    'The Lord is my shepherd',
    'For God so loved the world that he give his only begotten Son',
    'For God so loved the world that he gave NOT his only begotten Son',
    shared,
    'The Lord shall preserve thee from all evil he shall NOT preserve thy soul',
  ]) {
    const f=fixture();try {
      const first=f.accept(text);assert.ok(first.candidate,`${text}: ${first.reason}`);assert.equal(first.match,'phrase');assert.equal(first.switched,false);assert.equal(first.decision,'review');
      assert.equal(f.accept(text).switched,false,'Repeating uncertainty must not convert it into automatic evidence.');assert.equal(f.changes.length,0);assert.equal(f.library.workspace('scripture').live,null);
    }finally{f.close();}
  }
});

test('partial chapter plus strong matching quotation can publish, but a different quoted chapter needs review',()=>{
  const f=fixture();try {
    const agree=f.accept(`John chapter three. ${john}`);assert.equal(agree.match,'phrase');assert.equal(agree.switched,true,agree.reason);assert.equal(verse(agree),16);
    const conflict=f.accept(`John chapter four. ${john}`);assert.equal(conflict.match,'phrase');assert.ok(conflict.candidate);assert.equal(conflict.switched,false);assert.equal(conflict.decision,'conflict');assert.equal(f.changes.length,1);
    const dangling=f.accept(`John 3:16 through. ${john}`);assert.equal(dangling.switched,false,'A quotation must not complete an unfinished explicit verse range.');assert.ok(['partial','review'].includes(dangling.decision));
  }finally{f.close();}
});

test('selected-edition quotation lookup never substitutes another edition or its verse location',()=>{
  const f=fixture();try {
    f.library.importBible({version:{id:'NIV',name:'Test edition',attribution:'Synthetic fixture'},verses:[{book:40,chapter:1,verse:1,text:john}]});
    f.library.command('scripture',0,{type:'version',versionId:'NIV'});
    const result=f.accept(john);assert.equal(result.switched,true);assert.deepEqual(result.candidate?.selection,{kind:'scripture',versionId:'NIV',book:40,chapter:1,verse:1});
    assert.equal(f.accept('John 3:16').decision,'unavailable','Never silently use the installed KJV verse in place of missing selected-edition text.');
  }finally{f.close();}
});

test('voice-command cooldown is separate from first explicit reference and allows returning to a voice-stepped verse',t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const f=fixture('automatic',true);try {
    assert.equal(f.accept('John 3:16').switched,true);
    const next=f.accept('Lumen next');assert.equal(next.switched,true,'A newly published explicit reference must not delay the first armed voice command.');assert.equal(next.match,'command');assert.equal(next.workspace.live?.reference,'John 3:17 · KJV');
    const duplicate=f.accept('Lumen next');assert.equal(duplicate.switched,false);assert.equal(duplicate.decision,'cooldown');
    assert.equal(f.accept('John 3:16').switched,true,'Explicit references remain immediate during a voice-command cooldown.');
    now+=6001;
    assert.equal(f.accept('Lumen next').switched,true);assert.equal(f.changes.length,4);
  }finally{f.close();t.mock.restoreAll();}
});

test('stale workspace revisions, non-increasing sequences, wrong owners and stopped or expired sessions cannot publish',t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const f=fixture();try {
    assert.equal(f.accept('John 3:16').switched,true);
    const stale=f.accept('John 3:17',0);assert.equal(stale.decision,'stale');assert.equal(stale.switched,false);assert.equal(stale.candidate,null);
    assert.throws(()=>f.sessions.accept('scripture',f.session.id,'operator',1,'scripture','John 3:17',1,1),/Old listening window/);
    assert.equal(f.accept('John 3:17').switched,true,'A later fresh result can recover after discarding stale inference.');
    assert.throws(()=>f.sessions.accept('scripture',f.session.id,'other-owner',3,'scripture','John 3:17',1,2),/stopped or expired/);
    now+=45001;assert.throws(()=>f.accept('John 3:17'),/stopped or expired/);
    f.sessions.stop('scripture');assert.throws(()=>f.accept('John 3:17'),/stopped or expired/);assert.equal(f.changes.length,2);
  }finally{f.close();t.mock.restoreAll();}
});

test('Lyrics retain consecutive distinct-match confirmation and their independent rapid-switch cooldown',t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const library=new WorshipLibrary(':memory:'),changes:WorshipWorkspace[]=[],sessions=new ListeningSessions(library,state=>changes.push(state));
  try {
    const first='Mercy fills this house with joyful praise today',second='Hope rises as our voices sing together always';
    const song=library.saveSong({title:'Synthetic test song',sections:[{id:'verse',label:'Verse',text:first},{id:'chorus',label:'Chorus',text:second}]});
    library.command('lyrics',0,{type:'setlist',songIds:[song.id]});
    const lease=sessions.start('lyrics','operator',{mode:'automatic',language:'en',commands:false});let sequence=0;
    const accept=(text:string)=>sessions.accept('lyrics',lease.id,'operator',sequence++,'lyrics',text,42,library.workspace('lyrics').revision);
    assert.equal(accept(first).switched,false);
    assert.throws(()=>sessions.accept('lyrics',lease.id,'operator',0,'lyrics',first,42,library.workspace('lyrics').revision),/Old listening window/,'Retrying the same window cannot count as the second confirmation.');
    assert.equal(accept(first).switched,true);assert.equal(changes.length,1);
    assert.equal(accept(second).decision,'prepared');const cooling=accept(second);assert.equal(cooling.switched,false);assert.equal(cooling.decision,'cooldown');
    now+=3001;assert.equal(accept(second).switched,true);assert.equal(changes.length,2);
    now+=3001;assert.equal(accept(first).switched,false);assert.equal(accept('an unrelated phrase without a setlist match').candidate,null);assert.equal(accept(first).switched,false,'An unrelated window resets consecutive matching.');assert.equal(accept(first).switched,true);
    assert.equal(accept(first).decision,'already-live');assert.equal(changes.length,3);
    now+=3001;
    assert.equal(accept(second).switched,false);
    assert.equal(accept(first).decision,'already-live');
    assert.equal(accept(second).switched,false,'An already-live window also interrupts confirmation of a different lyric.');
    assert.equal(accept(second).switched,true);
  }finally{library.close();t.mock.restoreAll();}
});

test('invalid, negated or additional numeric references cannot escape into quote fallback',()=>{
  for(const reference of ['John 0:16','John zero verse sixteen','John 3:16,17','John 3:16/17','John 3:16.17','John 3:16 and 17','John 3:16 through 18 and 20','John 3:16 to John 3:17','John 3:16 and John 3:16 to','John 3:16 to and John 3:16','not John 3:16']){
    const f=fixture();try{
      const result=f.accept(`${reference}. ${john}`);
      assert.equal(result.switched,false,`${reference}: ${result.reason}`);assert.ok(['review','conflict','partial'].includes(result.decision),reference);assert.equal(result.candidate,null,reference);assert.equal(f.changes.length,0);
    }finally{f.close();}
  }
});

test('adjacent clear partial citations retain their chapter for an explicitly marked continuation',()=>{
  const f=fixture();try {
    assert.equal(f.accept('John chapter three').decision,'partial');
    const completed=f.accept('verse sixteen');
    assert.equal(completed.switched,true,completed.reason);assert.equal(verse(completed),16);
    assert.equal(completed.transcript,'verse sixteen','The UI must keep the actual transcript rather than fabricate a full spoken reference.');
    assert.equal(f.accept('verse seventeen').candidate,null,'A completed citation does not remain as reusable context.');
  }finally{f.close();}
  const book=fixture();try {
    assert.equal(book.accept('John').decision,'partial');
    assert.equal(book.accept('chapter three').decision,'partial');
    assert.equal(book.accept('verse sixteen').switched,true);
  }finally{book.close();}
});

test('a quotation in the next window cannot silently contradict a fresh chapter lead-in',()=>{
  const f=fixture();try {
    f.accept('John chapter four');
    const conflict=f.accept(john);assert.equal(conflict.switched,false);assert.equal(conflict.decision,'conflict');assert.equal(verse(conflict),16);
    f.accept('John chapter three');
    assert.equal(f.accept(john).switched,true,'A matching chapter and strong quotation remain immediate.');
  }finally{f.close();}
});

test('silence, unrelated speech, different chapters, gaps and workspace changes clear partial citation context',t=>{
  for(const interruption of ['', 'we have sixteen people here','not verse sixteen','chapter four verse one']) {
    const f=fixture();try {
      f.accept('John chapter three');assert.equal(f.accept(interruption).switched,false,interruption);
      assert.equal(f.accept('verse sixteen').candidate,null,interruption);assert.equal(f.changes.length,0);
    }finally{f.close();}
  }
  const gaps=fixture();try {
    gaps.accept('John chapter three');
    const result=gaps.sessions.accept('scripture',gaps.session.id,'operator',2,'scripture','verse sixteen',42,0);
    assert.equal(result.candidate,null,'Skipped windows cannot be assumed to preserve a citation.');
  }finally{gaps.close();}
  const changed=fixture();try {
    changed.accept('John chapter three');
    changed.library.command('scripture',0,{type:'blank',value:true});
    assert.equal(changed.accept('verse sixteen').candidate,null);
  }finally{changed.close();}
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const expired=fixture();try {
    expired.accept('John chapter three');now+=12001;
    assert.equal(expired.accept('verse sixteen').candidate,null,'Recent chapter context expires independently of the session lease.');
  }finally{expired.close();t.mock.restoreAll();}
});

test('uncertain and unavailable recognition never authorize automatic citations, quotations or voice commands',()=>{
  for(const status of ['uncertain','unavailable'] as const)for(const text of ['John 3:16',john,'Lumen next']) {
    const f=fixture('automatic',true);try {
      f.accept('John 3:16');const revision=f.library.workspace('scripture').revision;
      const recognition={status,reason:'Speech needs review.',avgLogprob:-1,noSpeechProbability:.4,rejectedSegments:0,totalSegments:1};
      const result=f.sessions.accept('scripture',f.session.id,'operator',1,'scripture',text,42,revision,recognition);
      assert.equal(result.switched,false,`${status}: ${text}`);assert.equal(result.decision,'review');assert.deepEqual(result.recognition,recognition);assert.equal(f.changes.length,1);
      if(text!=='Lumen next')assert.ok(result.candidate,'Current uncertain text can still prepare a suggestion.');
    }finally{f.close();}
  }
});

test('rejected or uncertain audio cannot bridge partial references or fabricate candidates from silence',()=>{
  for(const status of ['uncertain','unavailable','no-speech'] as const) {
    const f=fixture();try {
      f.accept('John chapter three');
      const recognition={status,reason:'Speech needs review.',avgLogprob:null,noSpeechProbability:null,rejectedSegments:1,totalSegments:1};
      const result=f.sessions.accept('scripture',f.session.id,'operator',1,'scripture','verse sixteen',42,0,recognition);
      assert.equal(result.candidate,null);assert.equal(result.switched,false);
      const after=f.sessions.accept('scripture',f.session.id,'operator',2,'scripture','verse sixteen',42,0);
      assert.equal(after.candidate,null);
    }finally{f.close();}
  }
  const f=fixture();try {
    const recognition={status:'no-speech' as const,reason:'No speech detected.',avgLogprob:null,noSpeechProbability:1,rejectedSegments:1,totalSegments:1};
    const result=f.sessions.accept('scripture',f.session.id,'operator',0,'scripture','John 3:16',42,0,recognition);
    assert.equal(result.candidate,null);assert.equal(result.switched,false);assert.equal(result.decision,'listening');
  }finally{f.close();}
});

test('paraphrase suggestions never become automatic evidence through repeated matches',()=>{
  const f=fixture();try {
    const text="God's gift of his begotten Son to a world he loved is how we receive everlasting life";
    for(let i=0;i<3;i++){
      const result=f.accept(text);assert.equal(verse(result),16);assert.equal(result.match,'phrase');
      assert.equal(result.decision,'review');assert.equal(result.switched,false);assert.match(result.reason,/Possible paraphrase/);
    }
    assert.equal(f.changes.length,0);
  }finally{f.close();}
});

test('corrected verse numbers and discarded spoken corrections never publish the surviving first reference',()=>{
  const f=fixture();try {
    for(const text of ['John 3:16, sorry, verse seventeen','John 3:16 no seventeen','John 3:16 I mean seventeen']){
      const result=f.accept(text);assert.equal(result.switched,false,text);assert.equal(result.decision,'review');assert.equal(result.candidate,null);
    }
    f.accept('John chapter three');
    assert.equal(f.accept('verse sixteen, sorry seventeen').switched,false);
    const transcript=analyzeLocalRecognition({segments:[
      {text:'John three',avg_logprob:-.2,no_speech_prob:.01},
      {text:' no, not that verse',avg_logprob:-1.9,no_speech_prob:.1},
      {text:' verse sixteen',avg_logprob:-.3,no_speech_prob:.01},
    ]});
    const result=f.sessions.accept('scripture',f.session.id,'operator',6,'scripture',transcript.text,42,0,transcript.recognition);
    assert.equal(result.switched,false);assert.equal(result.decision,'review');assert.ok(result.candidate,'A surviving exact reference is review-only after discarded speech.');
    assert.equal(f.changes.length,0);
  }finally{f.close();}
});

test('an injected source clock makes offline context independent of inference wall time',t=>{
  const library=new WorshipLibrary(':memory:');let sourceTime=0,wallTime=Date.now();
  t.mock.method(Date,'now',()=>wallTime);
  try{
    library.importBible({version:{id:'KJV',name:'KJV',attribution:'KJV'},verses:[{book:43,chapter:3,verse:16,text:john}]});
    const sessions=new ListeningSessions(library,()=>{},()=>sourceTime);
    const lease=sessions.start('scripture','operator',{mode:'automatic',language:'en',commands:false});
    sourceTime=10000;
    assert.equal(sessions.accept('scripture',lease.id,'operator',0,'scripture','John chapter three',1,0).decision,'partial');
    // Simulate a slow decoder without sleeping; only ten seconds of source
    // audio elapsed, so the two citation fragments remain adjacent.
    wallTime+=90000;sourceTime=20000;
    sessions.renew('scripture',lease.id,'operator');
    assert.equal(sessions.accept('scripture',lease.id,'operator',1,'scripture','verse sixteen',90000,0).switched,true);
    sessions.stop('scripture');
    const restarted=sessions.start('scripture','operator',{mode:'automatic',language:'en',commands:false});
    assert.equal(sessions.accept('scripture',restarted.id,'operator',2,'scripture','verse sixteen',1,1).candidate,null,'Starting after a source gap has no inherited chapter.');
    sourceTime+=45001;assert.throws(()=>sessions.renew('scripture',restarted.id,'operator'),/stopped or expired/,'Lease checks use the same injected clock.');
  }finally{library.close();t.mock.restoreAll();}
});

test('Prepare only cannot move an existing live verse even with voice commands enabled',()=>{
  const f=fixture('assisted',true);try {
    const workspace=f.library.workspace('scripture');
    const live=f.library.command('scripture',workspace.revision,{type:'take',selection:{kind:'scripture',versionId:'KJV',book:43,chapter:3,verse:16}});
    for(const text of ['Lumen next verse','John 3:17','Lumen previous verse']) {
      assert.equal(f.accept(text).switched,false);
      assert.equal(f.library.workspace('scripture').revision,live.revision);
    }
    assert.equal(f.changes.length,0);
  }finally{f.close();}
});

test('a citation mixed with decoder music markers remains review-only in armed auto mode',()=>{
  const f=fixture();try {
    const result=analyzeLocalRecognition({segments:[{text:'[Music] John 3:16',avg_logprob:-.1,no_speech_prob:.01}]});
    const matched=f.sessions.accept('scripture',f.session.id,'operator',0,'scripture',result.text,1,f.library.workspace('scripture').revision,result.recognition);
    assert.ok(matched.candidate);assert.equal(matched.decision,'review');assert.equal(matched.switched,false);assert.equal(f.changes.length,0);
  }finally{f.close();}
});
