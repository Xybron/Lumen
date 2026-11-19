import Database from 'better-sqlite3';
import { z } from 'zod';
import { ProductionError } from './production-store.js';
import { BackgroundSchema, TypographySchema } from './schema.js';
import type { NotesDocument, NotesDraft, NotesSegment } from '../../shared/notes.js';

export const NotesDraftSchema = z.object({ title:z.string().max(500), body:z.string().max(20000), reference:z.string().max(500), layout:z.enum(['general','statement','quote','key-points']),
  grouping:z.enum(['single','pointers']).optional(), background:BackgroundSchema.strict().optional(), typography:TypographySchema.strict().optional(),
}).strict();

// Rolling recognition windows overlap. Only remove a matching boundary, never
// an earlier occurrence elsewhere in the document or a single repeated word.
export function novelNotesText(previous:string, current:string):string {
  const words=current.trim().split(/\s+/).filter(Boolean), before=previous.trim().split(/\s+/).filter(Boolean);
  const normalized=(word:string)=>word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  const a=before.map(normalized),b=words.map(normalized);
  if(a.length&&a.join(' ')===b.join(' '))return '';
  for(let count=Math.min(a.length,b.length);count>=2;count--)
    if(a.slice(-count).every((word,index)=>word===b[index]))return words.slice(count).join(' ');
  return words.join(' ');
}

export class NotesStore {
  readonly db:Database.Database;
  constructor(filename:string) {
    this.db=new Database(filename);this.db.pragma('journal_mode = WAL');this.db.pragma('foreign_keys = ON');
    this.db.exec(`CREATE TABLE IF NOT EXISTS notes_documents (
      channelId TEXT NOT NULL,itemId TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,updatedAt TEXT NOT NULL,draft TEXT NOT NULL,
      PRIMARY KEY(channelId,itemId));
      CREATE TABLE IF NOT EXISTS notes_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,channelId TEXT NOT NULL,itemId TEXT NOT NULL,sessionId TEXT NOT NULL,sequence INTEGER NOT NULL,text TEXT NOT NULL,receivedAt TEXT NOT NULL,uncertain INTEGER NOT NULL,
      UNIQUE(channelId,itemId,sessionId,sequence),FOREIGN KEY(channelId,itemId) REFERENCES notes_documents(channelId,itemId) ON DELETE CASCADE);`);
  }
  private ensure(channelId:string,itemId:string,initial:Partial<NotesDraft>={}) {
    this.db.prepare('INSERT OR IGNORE INTO notes_documents(channelId,itemId,updatedAt,draft) VALUES(?,?,?,?)').run(channelId,itemId,new Date().toISOString(),JSON.stringify(NotesDraftSchema.parse({title:'',body:'',reference:'',layout:'key-points',...initial})));
  }
  segmentsSince(channelId:string,itemId:string,after=0):NotesSegment[] {
    const segments=this.db.prepare('SELECT id,sessionId,sequence,text,receivedAt,uncertain FROM notes_segments WHERE channelId=? AND itemId=? AND id>? ORDER BY id').all(channelId,itemId,after) as Array<Omit<NotesSegment,'uncertain'>&{uncertain:number}>;
    return segments.map(segment=>({...segment,uncertain:!!segment.uncertain}));
  }
  get(channelId:string,itemId:string,initial:Partial<NotesDraft>={}):NotesDocument {
    this.ensure(channelId,itemId,initial);
    return this.document(channelId,itemId,true);
  }
  private document(channelId:string,itemId:string,includeTranscript:boolean):NotesDocument {
    const row=this.db.prepare('SELECT * FROM notes_documents WHERE channelId=? AND itemId=?').get(channelId,itemId) as {revision:number;updatedAt:string;draft:string};
    return {channelId,itemId,revision:row.revision,updatedAt:row.updatedAt,draft:JSON.parse(row.draft),segments:includeTranscript?this.segmentsSince(channelId,itemId):[]};
  }
  saveDraft(channelId:string,itemId:string,revision:number,draft:NotesDraft,includeTranscript=true) {
    const next=NotesDraftSchema.parse(draft);this.ensure(channelId,itemId);
    const result=this.db.prepare('UPDATE notes_documents SET draft=?,revision=revision+1,updatedAt=? WHERE channelId=? AND itemId=? AND revision=?').run(JSON.stringify(next),new Date().toISOString(),channelId,itemId,revision);
    if(!result.changes)throw new ProductionError(409,'These private notes changed in another window. Reload them before saving.');
    // Autosave reads only the document row. Long sermon transcripts are fetched
    // independently by the incremental link endpoint, not on every keystroke.
    return this.document(channelId,itemId,includeTranscript);
  }
  append(channelId:string,itemId:string,sessionId:string,sequence:number,text:string,uncertain:boolean) {
    this.appendSegment(channelId,itemId,sessionId,sequence,text,uncertain);
    return this.get(channelId,itemId);
  }
  appendSegment(channelId:string,itemId:string,sessionId:string,sequence:number,text:string,uncertain:boolean):NotesSegment|undefined {
    this.ensure(channelId,itemId);
    if(text.trim()) {
      const prior=this.db.prepare('SELECT id,sessionId,sequence,text,receivedAt,uncertain FROM notes_segments WHERE channelId=? AND itemId=? AND sessionId=? AND sequence=?').get(channelId,itemId,sessionId,sequence) as (Omit<NotesSegment,'uncertain'>&{uncertain:number})|undefined;
      if(prior)return {...prior,uncertain:!!prior.uncertain};
      const count=(this.db.prepare('SELECT COUNT(*) AS count FROM notes_segments WHERE channelId=? AND itemId=?').get(channelId,itemId) as {count:number}).count;
      if(count>=10000)throw new ProductionError(409,'This transcript is full. Create a new Notes slide to continue.');
      // Transcript appends do not conflict with an operator editing the draft.
      const receivedAt=new Date().toISOString();
      const inserted=this.db.prepare('INSERT OR IGNORE INTO notes_segments(channelId,itemId,sessionId,sequence,text,receivedAt,uncertain) VALUES(?,?,?,?,?,?,?)').run(channelId,itemId,sessionId,sequence,text.trim().slice(0,12000),receivedAt,uncertain?1:0);
      if(inserted.changes)this.db.prepare('UPDATE notes_documents SET updatedAt=? WHERE channelId=? AND itemId=?').run(receivedAt,channelId,itemId);
      if(inserted.changes)return {id:Number(inserted.lastInsertRowid),sessionId,sequence,text:text.trim().slice(0,12000),receivedAt,uncertain};
    }
  }
  close(){this.db.close();}
}
