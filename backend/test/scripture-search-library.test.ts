import test from 'node:test';
import assert from 'node:assert/strict';
import { WorshipLibrary } from '../src/worship-library.js';
import { ListeningSessions } from '../src/listening-session.js';

function library() {
  const db=new WorshipLibrary(':memory:');
  db.importBible({version:{id:'KJV',name:'Test KJV',language:'en',attribution:'Test text'},verses:[
    {book:24,chapter:20,verse:11,text:'But the LORD is with me as a mighty terrible one.'},
    {book:43,chapter:3,verse:16,text:'For God so loved the world.'},
    {book:43,chapter:3,verse:17,text:'For God sent not his Son into the world to condemn the world.'},
    {book:19,chapter:23,verse:1,text:'The LORD is my shepherd; I shall not want.'},
    {book:18,chapter:3,verse:16,text:'Or as an hidden untimely birth I had not been.'},
    {book:32,chapter:3,verse:1,text:'And the word of the LORD came unto Jonah the second time.'},
    {book:46,chapter:13,verse:4,text:'Charity suffereth long, and is kind.'},
    {book:47,chapter:13,verse:4,text:'For though he was crucified through weakness, yet he liveth by the power of God.'},
  ]});
  return db;
}

test('manual Scripture results explain tolerant references and never mutate the workspace',()=>{
  const db=library();try{
    const before=db.workspace('s');
    for(const query of ['jeremia 20 11','jer20.11','jeremaih20 11']){
      const result=db.searchScripture('KJV',query);
      assert.equal(result.verses.length,1,query);
      assert.equal(result.verses[0].book,24,query);
      assert.equal(result.resolution.label,'Jeremiah 20:11',query);
    }
    assert.equal(db.searchScripture('KJV','jeremaih20 11').resolution.match,'corrected');
    const range=db.searchScripture('KJV','jn3 16-17');
    assert.equal(range.verses.length,2);assert.equal(range.reference?.endVerse,17);
    assert.deepEqual(db.workspace('s'),before);
  }finally{db.close();}
});

test('ambiguous book choices contain only passages present in the selected edition',()=>{
  const db=library();try{
    const result=db.searchScripture('KJV','jo3 16');
    assert.equal(result.reference,null);assert.deepEqual(result.verses,[]);
    assert.equal(result.resolution.kind,'ambiguous');
    assert.deepEqual(result.resolution.suggestions.map(choice=>choice.label),['Job 3:16','John 3:16']);
    assert.ok(!result.resolution.suggestions.some(choice=>choice.reference.book===32),'Jonah has no installed verse3:16');
    assert.deepEqual(db.searchScripture('KJV','jo3 16-17').resolution.suggestions.map(choice=>choice.label),['John 3:16–17'],'A partial range cannot be suggested');
    assert.equal(db.searchScripture('KJV','jo3 16-18').resolution.suggestions.length,0,'No complete installed range means no offered passage');
    const family=db.searchScripture('KJV','cor13 4');
    assert.deepEqual(family.resolution.suggestions.map(choice=>choice.label),['1 Corinthians 13:4','2 Corinthians 13:4']);
    assert.equal(family.verses.length,0);
    assert.equal(db.searchScripture('KJV','jn316').resolution.kind,'invalid');
    assert.equal(db.searchScripture('KJV','John99:1').verses.length,0);
    assert.throws(()=>db.searchScripture('NIV','jn3 16'),/not installed/);
  }finally{db.close();}
});

test('manual keyword improvements cannot broaden listening or automatic-switch matching',()=>{
  const db=library();try{
    const manual=db.searchScripture('KJV','the lord your shepherd');
    assert.equal(manual.keywordMode,'relaxed');assert.equal(manual.verses[0].book,19);
    assert.deepEqual(db.searchScripture('KJV','the lord your shepherd','listening').verses,[]);
    assert.deepEqual(db.searchScripture('KJV','jeremia 20 11','listening').verses,[]);
    const changes:unknown[]=[],sessions=new ListeningSessions(db,state=>changes.push(state));
    const session=sessions.start('s','u',{mode:'automatic',language:'en',commands:false});
    for(let sequence=0;sequence<4;sequence++){
      const result=sessions.accept('s',session.id,'u',sequence,'scripture',sequence<2?'the lord your shepherd':'jeremia chapter twenty verse eleven',10,0);
      assert.equal(result.candidate,null);assert.equal(result.switched,false);
    }
    assert.equal(changes.length,0);assert.equal(db.workspace('s').live,null);
  }finally{db.close();}
});
