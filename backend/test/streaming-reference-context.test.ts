import test from 'node:test';
import assert from 'node:assert/strict';
import {WorshipLibrary} from '../src/worship-library.js';
import {ListeningSessions} from '../src/listening-session.js';
import {cloudRecognition} from '../src/streaming-scripture.js';

function fixture(){
  const library=new WorshipLibrary(':memory:');
  library.importBible({version:{id:'KJV',name:'KJV',attribution:'test'},verses:[{book:43,chapter:3,verse:16,text:'For God so loved the world.'}]});
  let now=1000,sequence=0,published=0;
  const sessions=new ListeningSessions(library,()=>published++,()=>now);
  const lease=sessions.start('scripture','owner',{provider:'assemblyai',mode:'automatic',commands:false,language:'en'});
  const emit=(text:string,trusted=true,boundary=trusted)=>sessions.accept('scripture',lease.id,'owner',sequence++,'scripture',text,0,library.workspace('scripture').revision,cloudRecognition,trusted,boundary);
  return {library,sessions,emit,get published(){return published;},advance:(ms:number)=>{now+=ms;}};
}

test('a finalized chapter survives revisions of the next turn without publishing provisional numbers',()=>{
  const f=fixture();try{
    assert.equal(f.emit('John chapter three.').switched,false);
    assert.equal(f.emit('Verse sixty',false).switched,false);
    assert.equal(f.emit('Verse sixteen',false).switched,false);
    assert.equal(f.emit('Verse sixteen.').decision,'sent-live');
    assert.equal(f.published,1);
  }finally{f.library.close();}
});

for(const [name,text,trusted]of [
  ['unrelated','Let us welcome our visitors.',true],
  ['empty','',true],
  ['low confidence','Verse sixteen.',false],
  ['correction','Not John chapter three.',true],
] as const){
  test(`${name} finalized speech consumes old chapter context`,()=>{
    const f=fixture();try{
      f.emit('John chapter three.');f.emit('Verse',false);
      f.emit(text,trusted,true);
      assert.equal(f.emit('Verse sixteen.').switched,false);
      assert.equal(f.published,0);
    }finally{f.library.close();}
  });
}

test('interim revisions cannot extend the context deadline or restore a disarmed chapter',()=>{
  const f=fixture();try{
    f.emit('John chapter three.');f.advance(12001);f.emit('Verse sixteen',false);
    assert.equal(f.emit('Verse sixteen.').switched,false);
    f.emit('John chapter three.');f.sessions.disarm('scripture');
    f.emit('Verse sixteen',false);assert.equal(f.emit('Verse sixteen.').candidate,null);
    assert.equal(f.published,0);
  }finally{f.library.close();}
});
