const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
test('retention keeps the selected working app, protects data and refuses missing or linked backups',async t=>{
 const {pruneAppBackups}=await import('../scripts/update-retention.mjs');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-retention-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const old='Lumen-before-2026-11-18T10-00-00.000Z.app',keep='Lumen-before-2026-11-19T10-00-00.000Z.app';
 for(const name of [old,keep,'notes','media','preserved-station'])await fs.mkdir(path.join(dir,name));
 await fs.writeFile(path.join(dir,'notes','notes.db'),'private notes');
 await assert.rejects(pruneAppBackups(dir,'Lumen-before-2026-11-20T10-00-00.000Z.app'));
 assert.ok(await fs.stat(path.join(dir,old)));
 await fs.symlink(path.join(dir,'media'),path.join(dir,'Lumen-before-2026-11-17T10-00-00.000Z.app'));
 assert.deepEqual(await pruneAppBackups(dir,keep),[old]);
 assert.equal(await fs.readFile(path.join(dir,'notes','notes.db'),'utf8'),'private notes');
 assert.ok(await fs.stat(path.join(dir,keep)));assert.ok(await fs.stat(path.join(dir,'media')));
 await assert.rejects(pruneAppBackups(dir,'../notes'));
});
