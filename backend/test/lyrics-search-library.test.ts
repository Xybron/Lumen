import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { WorshipLibrary } from '../src/worship-library.js';
import { ListeningSessions } from '../src/listening-session.js';

function library(){
  const library=new WorshipLibrary(':memory:');
  const song=library.saveSong({id:'river',title:'River of Mercy',sections:[
    {id:'verse',label:'Verse 1',text:'A quiet morning starts this song.'},
    {id:'chorus',label:'Chorus',text:'Your mercy follows me through deepest waters.'},
  ]});
  return {library,song};
}

test('manual Lyrics search remains read-only and preserves the original song API',()=>{
  const {library:db,song}=library();try{
    const workspace=db.workspace('lyrics'),before=db.db.prepare('SELECT total_changes() AS count').get();
    assert.deepEqual(db.songs(),[song]);
    assert.deepEqual(db.songs('mercy'),[song]);
    assert.deepEqual(db.searchSongs().map(hit=>hit.song),[song]);
    const hit=db.searchSongs('deep wat')[0];
    assert.equal(hit.song.id,song.id);assert.equal(hit.match.sectionId,'chorus');
    assert.equal(hit.match.kind,'lyrics');assert.match(hit.match.excerpt,/deepest waters/);
    assert.deepEqual(db.workspace('lyrics'),workspace);
    assert.deepEqual(db.db.prepare('SELECT total_changes() AS count').get(),before);
  }finally{db.close();}
});

test('editing a song atomically refreshes manual title, typo and section search',()=>{
  const {library:db,song}=library();try{
    assert.equal(db.searchSongs('folows watres')[0].match.sectionId,'chorus');
    const changed=db.saveSong({...song,title:'Morning Lantern',sections:[{id:'bridge',label:'Bridge',text:'Lanterns shine across the hillside.'}]});
    assert.equal(db.searchSongs('folows watres').length,0);
    const hit=db.searchSongs('lantrns hillsid')[0];
    assert.equal(hit.song.revision,changed.revision);assert.equal(hit.match.sectionId,'bridge');
    assert.throws(()=>db.saveSong({...song,title:'Stale edit'}),/another device/);
    assert.equal(db.searchSongs('lantrns hillsid')[0].song.title,'Morning Lantern');
    assert.equal((db.db.prepare('SELECT COUNT(*) AS count FROM song_sections_fts WHERE songId=?').get(song.id) as {count:number}).count,1);
  }finally{db.close();}
});

test('manual typo suggestions cannot broaden Lyrics listening or automatically publish',()=>{
  const {library:db,song}=library();try{
    const query='mercy folows deepest watres';
    assert.equal(db.searchSongs(query)[0].match.corrected,true);
    assert.deepEqual(db.matchLyrics(query,[song.id]),[]);
    const state=db.command('lyrics',0,{type:'setlist',songIds:[song.id]});
    const changed:unknown[]=[],sessions=new ListeningSessions(db,workspace=>changed.push(workspace));
    const session=sessions.start('lyrics','u',{mode:'automatic',language:'en',commands:false});
    for(let sequence=0;sequence<3;sequence++){
      const result=sessions.accept('lyrics',session.id,'u',sequence,'lyrics',query,5,state.revision);
      assert.equal(result.candidate,null);assert.equal(result.switched,false);
    }
    assert.deepEqual(db.workspace('lyrics'),state);assert.equal(changed.length,0);
  }finally{db.close();}
});

test('existing labels stay visible after migration while songs can hide or omit their section names', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-lyrics-labels-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'worship.db'), old = new Database(file);
  old.exec('CREATE TABLE songs (id TEXT PRIMARY KEY, revision INTEGER, title TEXT, author TEXT, copyright TEXT, sections TEXT, updatedAt TEXT)');
  old.prepare('INSERT INTO songs VALUES(?,?,?,?,?,?,?)').run('legacy', 1, 'First Light', 'Choir', 'Test credit',
    JSON.stringify([{ id: 'chorus', label: 'Chorus', text: 'A new day is here' }]), new Date().toISOString());
  old.close();
  const db = new WorshipLibrary(file);
  try {
    const initial = db.song('legacy');
    const selection = { kind: 'lyrics' as const, songId: 'legacy', sectionId: 'chorus' };
    const before = db.command('lyrics', 0, { type: 'take', selection });
    assert.equal(initial.showSectionLabels, true);
    assert.equal(before.live!.reference, 'Chorus');
    const hidden = db.saveSong({ ...initial, showSectionLabels: false, sections: [
      ...initial.sections, { id: 'end', text: 'An unnamed final section' },
    ] });
    assert.equal(hidden.sections[1].label, '');
    assert.equal(db.songs('new day')[0].showSectionLabels, false);
    assert.deepEqual(db.searchSongs('unnamed final')[0].song, hidden);
    assert.equal(db.cue(selection).reference, '');
    assert.equal(db.cue(selection).attribution, 'Choir · Test credit');
    assert.deepEqual(db.workspace('lyrics'), before);
    const { showSectionLabels: _, ...legacyEdit } = hidden;
    const updated = db.saveSong({ ...legacyEdit, title: 'New Title' });
    assert.equal(updated.showSectionLabels, false, 'Older clients editing a title preserve visibility');
    db.saveSong({ ...updated, showSectionLabels: true });
    assert.equal(db.cue(selection).reference, 'Chorus');
    assert.equal(db.cue({ ...selection, sectionId: 'end' }).reference, '');
  } finally { db.close(); }
});
