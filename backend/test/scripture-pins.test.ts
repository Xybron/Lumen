import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorshipLibrary } from '../src/worship-library.js';

test('pins retain exact ranges and translations through station restarts; unpin is durable',()=>{
  const dir=mkdtempSync(join(tmpdir(),'lumen-pins-')),file=join(dir,'worship.db');
  let library=new WorshipLibrary(file);
  try {
    for(const id of ['KJV','TEST'])library.importBible({version:{id,name:id,attribution:'Synthetic test'},verses:[{book:43,chapter:3,verse:16,text:'First synthetic verse.'},{book:43,chapter:3,verse:17,text:'Second synthetic verse.'}]});
    const selection={kind:'scripture' as const,versionId:'KJV',book:43,chapter:3,verse:16,endVerse:17};
    const live=library.command('scripture',0,{type:'take',selection});
    library.pinScripture(selection);library.pinScripture(selection);
    library.pinScripture({...selection,versionId:'TEST'});
    assert.equal(library.scripturePins().length,2);
    assert.throws(()=>library.pinScripture({...selection,endVerse:18}),/not present/);
    assert.throws(()=>library.pinScripture({kind:'lyrics',songId:'x',sectionId:'x'}),/Scripture/);
    const saved=library.scripturePins();
    library.close();library=new WorshipLibrary(file);
    assert.deepEqual(library.scripturePins(),saved);
    assert.deepEqual(library.cue(saved[0].selection).selection,selection);
    assert.deepEqual(library.workspace('scripture'),live);
    library.unpinScripture(saved[0].id);library.unpinScripture(saved[0].id);
    library.close();library=new WorshipLibrary(file);
    assert.deepEqual(library.scripturePins(),[saved[1]]);
    library.db.prepare('DELETE FROM bible_versions WHERE id=?').run('TEST');
    assert.equal(library.scripturePins().length,1,'missing edition must not silently remove pins');
    assert.throws(()=>library.cue(saved[1].selection),/not installed/);
    library.unpinScripture(saved[1].id);
    assert.deepEqual(library.scripturePins(),[]);
  } finally {library.close();rmSync(dir,{recursive:true,force:true});}
});
