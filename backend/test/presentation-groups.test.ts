import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaylistSchema, PresentationGraphicsSchema } from '../src/schema.js';
import { presentationOutline, orderPresentationGroups, groupDescendants } from '../../frontend/src/lib/presentation-groups.ts';
import { computePrayerLabels } from '../../frontend/src/lib/prayers.ts';
import type { Playlist, Item } from '../../frontend/src/types.ts';
const item = (id: string, groupId?: string, type:Item['type']='notes'):Item => ({ id, groupId, type, durationMs:30000 });
test('legacy flat decks retain ordering and prayer sub-numbering without migration', () => {
 const playlist:Playlist={id:'p',name:'Legacy',items:[item('welcome',undefined,'image'),item('prayer',undefined,'prayer'),item('sub',undefined,'prayer-sub'),item('end',undefined,'video')]};
 assert.deepEqual(presentationOutline(playlist).map(row=>row.item?.id),playlist.items.map(item=>item.id));
 assert.equal(computePrayerLabels(playlist.items).sub.display,'1a.');
 assert.equal(PlaylistSchema.safeParse(playlist).success,true);
});
test('mixed groups and nested groups follow flat playback order', () => {
 const playlist:Playlist={id:'p',name:'Mixed',groups:[{id:'opening',name:'Opening'},{id:'focus',name:'Focus',parentId:'opening'},{id:'message',name:'Message'}],items:[item('welcome'),item('prayer','opening','prayer'),item('pdf','focus','image'),item('notes','message'),item('video','opening','video')]};
 orderPresentationGroups(playlist);
 assert.deepEqual(playlist.items.map(item=>item.id),['welcome','prayer','pdf','video','notes']);
 const outline=presentationOutline(playlist);
 assert.deepEqual(outline.map(row=>row.key),['welcome','opening','prayer','focus','pdf','video','message','notes']);
 assert.equal(outline.find(row=>row.key==='pdf')?.depth,2);
 assert.deepEqual([...groupDescendants(playlist.groups!,'opening')],['opening','focus']);
 assert.equal(PlaylistSchema.safeParse(playlist).success,true);
});
test('invalid hierarchy is rejected instead of hiding slides', () => {
 const base={id:'p',name:'Test',items:[item('slide','a')]};
 assert.equal(PlaylistSchema.safeParse({...base,groups:[{id:'a',name:'A',parentId:'b'},{id:'b',name:'B',parentId:'a'}]}).success,false);
 assert.equal(PlaylistSchema.safeParse({...base,groups:[]}).success,false);
 assert.equal(PlaylistSchema.safeParse({...base,groups:[{id:'a',name:'A'},{id:'a',name:'Duplicate'}]}).success,false);
});
test('new graphics and document metadata survive validation',()=>{
 const parsed=PlaylistSchema.parse({id:'p',name:'Docs',items:[{...item('s'),type:'image',document:{type:'powerpoint',sourceName:'Sermon.pptx',page:2,totalPages:8},layout:'general'}]});
 assert.equal(parsed.items[0].document?.totalPages,8);
 const graphics=PresentationGraphicsSchema.parse({template:'flame',progress:true,timer:true,countdown:true,warning:false,timerMode:'remaining',position:'top',size:'medium',color:'#ff6a14',caption:false,thickness:5,tip:'icon',tipIcon:'cross',colorMode:'gradient',gradientColors:['#ff0000','#ffffff']});
 assert.equal(graphics.tipIcon,'cross');
});
