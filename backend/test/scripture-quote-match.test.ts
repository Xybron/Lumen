import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { WorshipLibrary } from '../src/worship-library.js';

const john = 'For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.';
const psalm = 'The LORD is my shepherd; I shall not want.';
function library(extra: {book:number;chapter:number;verse:number;text:string}[] = []) {
  const db = new WorshipLibrary(':memory:');
  db.importBible({version:{id:'KJV',name:'King James Version',attribution:'KJV'},verses:[
    {book:43,chapter:3,verse:16,text:john},
    {book:19,chapter:23,verse:1,text:psalm},
    {book:19,chapter:121,verse:7,text:'The LORD shall preserve thee from all evil: he shall preserve thy soul.'},
    {book:40,chapter:6,verse:33,text:'But seek ye first the kingdom of God, and his righteousness; and all these things shall be added unto you.'},
    ...extra,
  ]});
  return db;
}

test('listening quotation finds an exact distinctive phrase embedded in sermon filler', () => {
  const db=library();try {
    for(const text of [
      'For God so loved the world that he gave his only begotten Son',
      'Church listen to this now: FOR GOD SO LOVED THE WORLD, that he gave his only begotten Son. What a promise for us today!',
      'we are reminded again but seek ye first the kingdom of God and his righteousness then church let us pray',
      'For God so loved the world that he gave his only begotten Son amen',
      'Church remember this: For God so loved the world that he gave his only begotten Son. What a promise!',
    ]) {
      const match=db.matchScriptureQuote('KJV',text);
      assert.equal(match.eligible,true,`${text}: ${match.reason}`);
      assert.equal(match.selection?.book,text.includes('seek')?40:43);
      assert.ok(match.score>=.9);
      assert.match(match.reason,/exact quotation/);
    }
    assert.equal(db.workspace('scripture').live,null,'Lookup has no publishing side effects.');
    assert.equal(db.matchScriptureQuote('KJV',`${john} ${'church '.repeat(100)} not`).eligible,false,'An overlong window must not publish an unchecked truncated prefix.');
  } finally {db.close();}
});

test('short and approximate quotation evidence is review-only; weak pronoun substitutions are not suggested', () => {
  const db=library();try {
    const short=db.matchScriptureQuote('KJV','The Lord is my shepherd');
    assert.equal(short.selection?.book,19);assert.equal(short.eligible,false);assert.match(short.reason,/short|common/);
    const approximate=db.matchScriptureQuote('KJV','For God so loved the world that he give his only begotten Son');
    assert.equal(approximate.selection?.book,43);assert.equal(approximate.eligible,false);assert.match(approximate.reason,/different wording/);
    for(const text of ['the lord your shepherd','jeremia chapter twenty verse eleven','God love all people','" OR *']) {
      assert.equal(db.matchScriptureQuote('KJV',text).selection,null,text);
    }
  } finally {db.close();}
});

test('negative changes cannot publish the unchanged long prefix of a contradicted quotation', () => {
  const db=library();try {
    for(const text of [
      'For God so loved the world that he gave NOT his only begotten Son',
      'For God so loved the world that he gave his only begotten Son that whosoever believeth in him should perish but have everlasting life',
      'The Lord shall preserve thee from all evil he shall NOT preserve thy soul',
      'The Lord shall preserve thee from all evil not',
      'But seek ye first the kingdom of God and NOT his righteousness and all these things shall be added unto you',
      'For God so loved the world that he gave his only begotten Son they should perish',
      'For God so loved the world that he gave his only begotten Son they now believe they should perish',
      'For God so loved the world that he gave his only begotten Son. They should perish.',
    ]) {
      const result=db.matchScriptureQuote('KJV',text);
      assert.equal(result.eligible,false,`${text}: ${result.reason}`);
      if(result.selection) assert.match(result.reason,/negative wording|different wording/);
    }
    assert.equal(db.matchScriptureQuote('KJV',psalm).eligible,true,'An exact negative quotation is valid.');
  } finally {db.close();}
});

test('a terminal substituted word is not authorised by its long unchanged quotation prefix', () => {
  const db=library();try {
    for(const text of [
      'For God so loved the world that he gave his only begotten daughter',
      'For God so loved the world that he gave his only begotten daughter today',
      'For God so loved the world that he gave his only begotten daughter to us',
    ]) {
      const match=db.matchScriptureQuote('KJV',text);
      assert.equal(match.selection?.book,43);assert.equal(match.eligible,false);assert.match(match.reason,/different wording/);
    }
  } finally {db.close();}
});

test('duplicates and close rival verses remain review-only outside the ranked candidate cap', () => {
  const repeated=Array.from({length:260},(_,i)=>({book:1,chapter:Math.floor(i/100)+1,verse:i%100+1,text:'The Lord shall preserve thee from all evil he shall preserve thy soul'}));
  const db=library(repeated);try {
    const match=db.matchScriptureQuote('KJV','The Lord shall preserve thee from all evil he shall preserve thy soul');
    assert.equal(match.eligible,false);assert.ok(match.selection);assert.match(match.reason,/shared|multiple/);
    db.importBible({version:{id:'NIV',name:'Other edition',attribution:'Test'},verses:[{book:40,chapter:1,verse:1,text:john}]});
    assert.equal(db.matchScriptureQuote('KJV',john).eligible,true,'Other versions must not create false rivals.');
    assert.equal(db.matchScriptureQuote('NIV',john).selection?.book,40,'Selections use only their selected version.');
    assert.equal(db.matchScriptureQuote('NIV',psalm).selection,null,'Never substitute a missing edition quotation.');
  } finally {db.close();}
  const near=library([{book:1,chapter:1,verse:1,text:'For God so loved the world that he gave his only begotten daughter'}]);try {
    const match=near.matchScriptureQuote('KJV','For God so loved the world that he gave his only begotten Son');
    assert.equal(match.eligible,false);assert.match(match.reason,/shared|multiple/);
  } finally {near.close();}
  const shortRival=library([
    {book:1,chapter:1,verse:1,text:'Wisdom shall guide faithful people through every storm'},
    {book:1,chapter:1,verse:2,text:'Wisdom shall guide faithful people through every trial'},
  ]);try {
    const match=shortRival.matchScriptureQuote('KJV','Wisdom shall guide faithful people through every storm');
    assert.equal(match.eligible,false,'Seven of eight identical words needs a rival-margin check too.');
    assert.match(match.reason,/shared|multiple/);
  } finally {shortRival.close();}
});

test('punctuation and contractions keep FTS-compatible duplicate and negative-word checks', () => {
  const text="Trust in the Lord through every season: don't turn aside from his commandments";
  const db=library([{book:1,chapter:1,verse:1,text},{book:1,chapter:1,verse:2,text}]);try {
    const duplicated=db.matchScriptureQuote('KJV',text.replace("don't",'don’t'));
    assert.equal(duplicated.eligible,false);assert.match(duplicated.reason,/shared|multiple/);
    db.db.prepare('DELETE FROM verses WHERE versionId=? AND book=1 AND chapter=1 AND verse=2').run('KJV');
    assert.equal(db.matchScriptureQuote('KJV',text).eligible,true);
    const removed=db.matchScriptureQuote('KJV',text.replace("don't",'do'));
    assert.equal(removed.eligible,false);assert.match(removed.reason,/negative wording|different wording/);
  } finally {db.close();}
});

test('two independently quoted passages in one speech window require review', () => {
  const db=library();try {
    const result=db.matchScriptureQuote('KJV','For God so loved the world that he gave his only begotten son and remember this also the Lord shall preserve thee from all evil he shall preserve thy soul');
    assert.equal(result.eligible,false);assert.ok(result.selection);assert.match(result.reason,/More than one/);
  } finally {db.close();}
});

test('reordered paraphrase words prepare a bounded review suggestion without claiming a quotation',()=>{
  const text="God's gift of his begotten Son to a world he loved is how we receive everlasting life";
  const db=library();try {
    const match=db.matchScriptureQuote('KJV',text);
    assert.equal(match.selection?.book,43);assert.equal(match.selection?.verse,16);
    assert.equal(match.eligible,false);assert.match(match.reason,/Possible paraphrase/);
    assert.ok(match.score<=.85,'Lexical overlap must not be presented as strong exact-quotation evidence.');
    for(const prose of ['God loves us all and this is a beautiful morning at church','Please put the microphone beside the green chairs and turn the music down'])assert.equal(db.matchScriptureQuote('KJV',prose).selection,null,prose);
    db.importBible({version:{id:'OTHER',name:'Other',attribution:'Test'},verses:[{book:1,chapter:1,verse:1,text:'A separate sentence without those distinctive words.'}]});
    assert.equal(db.matchScriptureQuote('OTHER',text).selection,null,'Paraphrase retrieval also stays in the selected edition.');
  }finally{db.close();}
  const duplicate=library([{book:1,chapter:1,verse:1,text:john}]);try {
    const result=duplicate.matchScriptureQuote('KJV',text);
    assert.equal(result.eligible,false);assert.match(result.reason,/multiple passages/);
  }finally{duplicate.close();}
});

test('quotation lookup remains indexed, bounded and responsive across the full installed Bible', () => {
  const db=new WorshipLibrary(':memory:');try {
    const books=JSON.parse(fs.readFileSync(new URL('../assets/kjv.source.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
    const verses=books.flatMap((book:any,index:number)=>book.chapters.flatMap((chapter:string[],chapterIndex:number)=>chapter.map((text:string,verseIndex:number)=>({book:index+1,chapter:chapterIndex+1,verse:verseIndex+1,text}))));
    db.importBible({version:{id:'KJV',name:'KJV',attribution:'KJV'},verses});
    const plan=db.db.prepare('EXPLAIN QUERY PLAN SELECT v.id FROM verses_fts f JOIN verses v ON v.id=f.rowid WHERE verses_fts MATCH ? AND v.versionId=? AND v.id<>? LIMIT 1').all('"for God so loved the world"','KJV',0) as {detail:string}[];
    assert.ok(plan.some(row=>/VIRTUAL TABLE INDEX/.test(row.detail)),JSON.stringify(plan));
    assert.ok(!plan.some(row=>/SCAN v\b/.test(row.detail)),JSON.stringify(plan));
    const start=performance.now();
    for(let i=0;i<10;i++) {
      const result=db.matchScriptureQuote('KJV','Now church remember for God so loved the world that he gave his only begotten son');
      assert.equal(result.eligible,true,result.reason);assert.equal(result.selection?.verse,16);
      assert.equal(db.matchScriptureQuote('KJV','qzxv '.repeat(5000)).eligible,false);
    }
    const duration=performance.now()-start;
    console.log(`Listening quotation lookup: ${(duration/20).toFixed(1)} ms/query against ${verses.length} verses.`);
    assert.ok(duration<5000,`20 bounded indexed lookups took ${duration.toFixed(0)} ms.`);
    for(const text of [
      'broken. I said let them',
      'broken. I said let the record be broken.',
      'You will not sit at the',
      'You will not sit at the same spot.',
      'And the Spirit of the Lord',
      'He breaks reconciliation in the name of Jesus.',
      'in the name of jesus receive it receive the power of the holy spirit',
      'You will not sit at the same spot. You will not be marking time at the same spot. After this conference it is forward march.',
      'Please keep your hands on the table while we sort out the sound and prepare for the next announcement',
    ])assert.equal(db.matchScriptureQuote('KJV',text).selection,null,'A short common fragment must not turn ordinary speech into a verse suggestion: '+text);
    for(const text of [
      'That Samwell took the harm of oil and an item David in the midst of his breath.',
      'And the spirit of the lock came upon David from that day. From that day. It looked like papa.',
    ]){
      const result=db.matchScriptureQuote('KJV',text);
      assert.deepEqual(result.selection,{kind:'scripture',versionId:'KJV',book:9,chapter:16,verse:13});
      assert.equal(result.eligible,false,'Garbled quotations remain review-only.');
    }
    const paraphrases:[string,number,number,number][]=[
      ["God's gift of his begotten Son to a world he loved is how we receive everlasting life",43,3,16],
      ['His kingdom and righteousness come first; seek these and the things you need are added',40,6,33],
      ['Death has cast a shadow over the valley I walk in; evil cannot cause me to fear',19,23,4],
    ];
    const paraphraseStart=performance.now();
    for(const [text,book,chapter,verse] of paraphrases){
      const result=db.matchScriptureQuote('KJV',text);
      assert.deepEqual(result.selection,{kind:'scripture',versionId:'KJV',book,chapter,verse},text);
      assert.equal(result.eligible,false);assert.match(result.reason,/Possible paraphrase/);
    }
    assert.ok(performance.now()-paraphraseStart<2000,'Three bounded paraphrase lookups should remain responsive against the whole installed Bible.');
  } finally {db.close();}
});
