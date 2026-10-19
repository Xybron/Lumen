import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WorshipLibrary } from '../src/worship-library.js';
import { parseReference,parseReferences,normalizeReference } from '../src/scripture-reference.js';
import { ListeningSessions } from '../src/listening-session.js';
import { LocalListener } from '../src/local-listener.js';

function library(){const db=new WorshipLibrary(':memory:');db.importBible({version:{id:'KJV',name:'King James Version',attribution:'KJV'},verses:[{book:43,chapter:3,verse:16,text:'For God so loved the world, that he gave his only begotten Son.'},{book:43,chapter:3,verse:17,text:'For God sent not his Son into the world to condemn the world.'},{book:43,chapter:4,verse:1,text:'When therefore the Lord knew how the Pharisees had heard'},{book:19,chapter:23,verse:1,text:'The LORD is my shepherd; I shall not want.'}]});return db;}
test('English references, abbreviations, partial references and ambiguous speech',()=>{
  for(const input of ['John 3:16','Jn3:16','John chapter three verse sixteen','John three sixteen'])assert.deepEqual(parseReference(input),{book:43,chapter:3,verse:16,endVerse:undefined,complete:true},input);
  assert.equal(normalizeReference('Psalm one hundred and thirty nine verse twenty three'),'psalm 139 verse 23');
  assert.equal(parseReference('First John chapter two verse four')?.book,62);
  assert.equal(parseReference('1Jn2:4')?.book,62);
  assert.equal(parseReference('John 3')?.complete,false);
  assert.equal(parseReference('John')?.book,43);
  assert.equal(parseReference('John 3:16-17')?.endVerse,17);
  assert.equal(parseReference('the Lord is my shepherd'),null);
  assert.equal(parseReference('I am the way'),null);
  assert.equal(parseReferences('John 3:16 and Romans 8:28').length,2);
  assert.equal(parseReferences('1 John 3:16').length,1);
  assert.equal(parseReference('John 0:16'),null);
  assert.equal(parseReference('Jude 5')?.verse,5);
  assert.equal(parseReference('Jude 5')?.chapter,1);
  assert.equal(parseReference('Jude chapter one')?.complete,false);
});
test('offline corpus integrity and all seven requested version slots',()=>{
  const books=JSON.parse(fs.readFileSync(new URL('../assets/kjv.source.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
  assert.equal(books.length,66);assert.equal(books.flatMap((b:any)=>b.chapters.flat()).length,31102);
  assert.match(books[42].chapters[2][15],/^For God so loved the world/);
  const db=library();try{assert.deepEqual(db.versions().map(v=>v.id),['NKJV','KJV','NIV','NLT','AMP','GNT','TPT']);assert.equal(db.versions().filter(v=>v.installed).length,1);assert.throws(()=>db.searchScripture('NIV','John 3:16'),/not installed/);}finally{db.close();}
});
test('FTS lookup, exact verse ranges, edition import atomicity and revision control',()=>{
  const db=library();try{
    assert.equal(db.searchScripture('KJV','John 3').verses.length,2);
    assert.equal(db.searchScripture('KJV','the Lord is my shepherd').verses[0].book,19);
    assert.equal(db.searchScripture('KJV','" OR *').verses.length,0);
    const selection={kind:'scripture' as const,versionId:'KJV',book:43,chapter:3,verse:16,endVerse:17};
    assert.match(db.cue(selection).text,/16 For God.*\n\n17 For God/s);
    assert.throws(()=>db.cue({...selection,endVerse:18}),/not present/);
    assert.throws(()=>db.cue({...selection,endVerse:30}),/1–12/);
    let state=db.command('scripture',0,{type:'take',selection});assert.equal(state.revision,1);
    assert.throws(()=>db.command('scripture',0,{type:'blank',value:true}),/changed/);
    state=db.command('scripture',1,{type:'step',direction:1});assert.equal((state.live!.selection as any).chapter,4);
    state=db.command('scripture',2,{type:'step',direction:-1});assert.equal((state.live!.selection as any).verse,17);
    assert.throws(()=>db.importBible({version:{id:'KJV',name:'Invalid',attribution:'test'},replace:true,verses:[{book:43,chapter:3,verse:16,text:'one'},{book:43,chapter:3,verse:16,text:'two'}]}),/Duplicate/);
    assert.match(db.cue(selection).text,/God so loved/);
  }finally{db.close();}
});
test('song editing, setlists and section navigation preserve live snapshots',()=>{
  const db=library();try{
    const song=db.saveSong({title:'A test song',sections:[{id:'verse',label:'Verse 1',text:'Mercy fills this house today'},{id:'chorus',label:'Chorus',text:'Let every voice sing out with joy'}]});
    assert.equal(db.songs('mercy')[0].id,song.id);
    assert.equal(db.matchLyrics('Mercy fills this house today',[song.id])[0].selection.sectionId,'verse');
    assert.equal(db.matchLyrics('Mercy fills this house today',[]).length,0);
    let state=db.command('lyrics',0,{type:'setlist',songIds:[song.id,song.id]});assert.equal(state.setlist.length,1);
    state=db.command('lyrics',1,{type:'take',selection:{kind:'lyrics',songId:song.id,sectionId:'verse'}});
    db.saveSong({...song,title:'Updated song'});assert.equal(state.live!.title,'A test song');
    assert.throws(()=>db.saveSong({...song,title:'Stale edit'}),/another device/);
    state=db.command('lyrics',2,{type:'step',direction:1});assert.equal(state.live!.reference,'Chorus');
    assert.throws(()=>db.command('lyrics',3,{type:'step',direction:1}),/end of this song/);
  }finally{db.close();}
});
test('assisted listening never switches; automatic publishes a clear reference once without repeating live content',()=>{
  const db=library(),changes:any[]=[];try{
    const sessions=new ListeningSessions(db,s=>changes.push(s));
    const assisted=sessions.start('s','u',{mode:'assisted',language:'en',commands:false});
    assert.equal(sessions.accept('s',assisted.id,'u',0,'scripture','John chapter three',100,0).suggestedQuery,'John 3');
    for(let i=1;i<4;i++)assert.equal(sessions.accept('s',assisted.id,'u',i,'scripture','John chapter three verse sixteen',100,0).switched,false);
    assert.equal(db.workspace('s').live,null);sessions.stop('s');
    const automatic=sessions.start('s','u',{mode:'automatic',language:'en',commands:false});
    assert.equal(sessions.accept('s',automatic.id,'u',0,'scripture','John 3:16',100,0).switched,true);
    assert.equal(sessions.accept('s',automatic.id,'u',1,'scripture','John 3:16 and Psalm 23:1',100,1).candidate,null);
    assert.equal(sessions.accept('s',automatic.id,'u',2,'scripture','John 3:16',100,1).decision,'already-live');
    assert.equal(sessions.accept('s',automatic.id,'u',3,'scripture','John 3:17',100,1).switched,true);
    assert.equal(changes.length,2);
    assert.throws(()=>sessions.accept('s',automatic.id,'u',3,'scripture','John 3:17',100,2),/Old/);
    assert.throws(()=>sessions.check('s',automatic.id,'other'),/stopped/);
    sessions.stop('s');assert.throws(()=>sessions.accept('s',automatic.id,'u',4,'scripture','John 3:17',100,1),/stopped/);
  }finally{db.close();}
});
test('stale inference and ordinary next/previous speech cannot change output',()=>{
  const db=library();try{
    db.command('s',0,{type:'take',selection:{kind:'scripture',versionId:'KJV',book:43,chapter:3,verse:16}});
    const sessions=new ListeningSessions(db,()=>{}),session=sessions.start('s','u',{mode:'automatic',language:'en',commands:true});
    assert.equal(sessions.accept('s',session.id,'u',0,'scripture','next',1,1).switched,false);
    assert.equal(sessions.accept('s',session.id,'u',1,'scripture','Lumen next',1,0).switched,false);
    assert.equal(sessions.accept('s',session.id,'u',2,'scripture','Lumen next',1,1).switched,true);
    assert.equal(sessions.accept('s',session.id,'u',3,'scripture','Lumen next',1,2).switched,false);
  }finally{db.close();}
});
test('local worker rejects invalid audio before invoking a model',async()=>{
  const listener=new LocalListener();try{await assert.rejects(()=>listener.transcribe(Buffer.from('not a WAV'),'en'),/16 kHz/);}finally{listener.close();}
});
