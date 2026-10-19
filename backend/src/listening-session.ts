import { randomUUID } from 'node:crypto';
import { ProductionError } from './production-store.js';
import { BOOK_NAMES,analyzeSpokenReferences } from './scripture-reference.js';
import type { WorshipLibrary } from './worship-library.js';
import type { CueSelection, ListeningSession, ListeningResult, WorshipWorkspace } from '../../shared/worship.js';

interface Lease extends ListeningSession { userId:string; lastSequence:number; candidateKey:string; hits:number; lastTakeAt:number; lastVoiceAt:number }
function selectionKey(selection:CueSelection){
  return selection.kind==='scripture'?JSON.stringify([selection.kind,selection.versionId,selection.book,selection.chapter,selection.verse,selection.endVerse??selection.verse]):JSON.stringify([selection.kind,selection.songId,selection.sectionId]);
}
export class ListeningSessions {
  private leases=new Map<string,Lease>();
  constructor(private library:WorshipLibrary, private changed:(state:WorshipWorkspace)=>void) {}
  start(channelId:string,userId:string,options:{mode:'assisted'|'automatic';language:string;commands:boolean}) {
    const existing=this.leases.get(channelId);
    if (existing && existing.expiresAt>Date.now()) throw new ProductionError(409,'This channel already has an active listener. Stop it before starting another.');
    const lease:Lease={...options,id:randomUUID(),channelId,userId,expiresAt:Date.now()+45000,lastSequence:-1,candidateKey:'',hits:0,lastTakeAt:0,lastVoiceAt:0};
    this.leases.set(channelId,lease); return this.public(lease);
  }
  private public(lease:Lease):ListeningSession { const {id,channelId,mode,language,commands,expiresAt}=lease;return {id,channelId,mode,language,commands,expiresAt}; }
  check(channelId:string,id:string,userId:string) {
    const lease=this.leases.get(channelId);
    if (!lease || lease.id!==id || lease.userId!==userId || lease.expiresAt<=Date.now()) throw new ProductionError(409,'Listening stopped or expired. Start listening again when ready.');
    return lease;
  }
  renew(channelId:string,id:string,userId:string) {const lease=this.check(channelId,id,userId);lease.expiresAt=Date.now()+45000;return this.public(lease);}
  stop(channelId:string) {this.leases.delete(channelId);}
  stopOwned(channelId:string,userId:string) {
    if(this.leases.get(channelId)?.userId!==userId)return false;
    this.leases.delete(channelId);return true;
  }
  hasActive() {
    const now=Date.now();
    for(const [id,lease] of this.leases)if(lease.expiresAt<=now)this.leases.delete(id);
    return this.leases.size>0;
  }
  accept(channelId:string,id:string,userId:string,sequence:number,kind:'scripture'|'lyrics',text:string,elapsedMs:number,baseRevision:number):ListeningResult {
    const lease=this.check(channelId,id,userId), workspace=this.library.workspace(channelId);
    if (sequence<=lease.lastSequence) throw new ProductionError(409,'Old listening window ignored.');
    lease.lastSequence=sequence;lease.expiresAt=Date.now()+45000;
    const result:ListeningResult={transcript:text,elapsedMs,candidate:null,match:'none',score:0,switched:false,decision:'listening',reason:kind==='scripture'?'Listening for a complete reference or a distinctive quotation.':'No reliable setlist match. Listening for more lyrics.',workspace};
    if (workspace.revision!==baseRevision) {lease.candidateKey='';lease.hits=0;result.decision='stale';result.reason='Channel changed while listening; stale result ignored.';return result;}
    const voice=/\blumen[ ,]+(next|previous|back)(?:\s+(?:verse|section|slide))?\b/i.exec(text);
    if (voice && lease.commands && lease.mode==='automatic' && workspace.live) {
      if (Date.now()-lease.lastVoiceAt<6000) {lease.candidateKey='';lease.hits=0;result.decision='cooldown';result.reason='Repeated voice command ignored while its audio window passes.';return result;}
      result.workspace=this.library.command(channelId,workspace.revision,{type:'step',direction:voice[1].toLowerCase()==='next'?1:-1});
      result.match='command';result.switched=true;result.decision='sent-live';result.reason='Armed voice command applied.';lease.lastVoiceAt=Date.now();lease.candidateKey='';lease.hits=0;this.changed(result.workspace);return result;
    }
    let eligible=false;
    if (kind==='scripture') {
      // Repeating the same citation is corroboration, not a conflict. A partial
      // lead-in is superseded only by a complete citation in that same chapter.
      const evidence=analyzeSpokenReferences(text);
      if(evidence.invalid||evidence.negated){lease.candidateKey='';lease.hits=0;result.decision='review';result.reason=evidence.negated?'A negated or corrected citation was heard. Waiting for a clear reference; nothing changed live.':'The citation is incomplete or invalid. Waiting for clarification; nothing changed live.';return result;}
      const references=[...new Map(evidence.references.map(reference=>[JSON.stringify([reference.book,reference.chapter,reference.verse,reference.endVerse??reference.verse,reference.complete]),reference])).values()];
      const complete=references.filter(reference=>reference.complete),partials=references.filter(reference=>!reference.complete);
      const reference=complete[0]??partials[0];
      const conflicting=complete.length>1||complete.length===1&&partials.some(partial=>partial.verse!==undefined||partial.book!==reference.book||partial.chapter!==undefined&&partial.chapter!==reference.chapter)||complete.length===0&&partials.length>1;
      if(conflicting){lease.candidateKey='';lease.hits=0;result.decision='conflict';result.reason='Different references heard. Listening for a clear citation; nothing changed live.';return result;}
      if (reference?.complete) {
        try {
          result.candidate=this.library.cue({kind:'scripture',versionId:workspace.versionId,book:reference.book,chapter:reference.chapter!,verse:reference.verse!,...(reference.endVerse?{endVerse:reference.endVerse}:{})});
          result.match='reference';result.score=1;eligible=true;
        } catch {result.decision='unavailable';result.reason='Reference heard, but that passage is unavailable in the selected version.';}
      } else if(reference) {
        result.suggestedQuery=`${BOOK_NAMES[reference.book-1]}${reference.chapter?' '+reference.chapter:''}`;
        result.decision='partial';
        result.reason=reference.verse!==undefined?'Reference is incomplete. Waiting for the rest of the citation or verse range.':'Partial reference heard. Chapter results are ready; waiting for a verse.';
        // A chapter lead-in can be corroborated by a strong quotation in that
        // chapter, but never fill in a dangling range or a different chapter.
        if(reference.verse===undefined){
          try{
            const quote=this.library.matchScriptureQuote(workspace.versionId,text);
            if(quote.selection){
              result.candidate=this.library.cue(quote.selection);result.match='phrase';result.score=quote.score;
              if(quote.selection.book===reference.book&&(reference.chapter===undefined||quote.selection.chapter===reference.chapter)){eligible=quote.eligible;result.reason=quote.reason;}
              else {result.decision='conflict';result.reason='The spoken reference and quoted words point to different passages. Prepared for review; nothing changed live.';}
            }
          }catch{result.decision='unavailable';result.reason='The selected Bible version is unavailable for quotation matching.';}
        }
      } else if (text.trim()) {
        try {
          const quote=this.library.matchScriptureQuote(workspace.versionId,text);
          result.reason=quote.reason;
          if(quote.selection){result.candidate=this.library.cue(quote.selection);result.match='phrase';result.score=quote.score;eligible=quote.eligible;result.decision='review';}
        } catch {result.decision='unavailable';result.reason='The selected Bible version is unavailable for quotation matching.';}
      }
    } else {
      const matches=this.library.matchLyrics(text,workspace.setlist), best=matches[0];
      if (best && best.score>=.6) {result.candidate=this.library.cue(best.selection);result.match='lyrics';result.score=best.score;eligible=best.score>=.9 && (!matches[1] || best.score-matches[1].score>=.15);}
      if (!workspace.setlist.length) result.reason='Add songs to this channel’s setlist to enable listening matches.';
    }
    if (!result.candidate) {lease.candidateKey='';lease.hits=0;return result;}
    const key=selectionKey(result.candidate.selection);
    if(lease.mode==='assisted'){result.decision='prepared';result.reason='Prepared for your review. Nothing changed on the public output.';return result;}
    if(!eligible){lease.candidateKey='';lease.hits=0;if(result.decision!=='conflict')result.decision='review';if(kind==='lyrics')result.reason='Lyrics match is not distinct enough. Prepared for operator review.';return result;}
    if(workspace.live&&!workspace.blanked&&selectionKey(workspace.live.selection)===key){lease.candidateKey='';lease.hits=0;result.decision='already-live';result.reason='This content is already live. Repeated audio will not publish it again.';return result;}
    // Lyrics retain their two-window confirmation. Scripture references and
    // strong exact quotations are complete evidence in one window: requiring
    // a second full copy loses citations spoken once across rolling boundaries.
    lease.hits=key===lease.candidateKey?lease.hits+1:1;lease.candidateKey=key;
    if(kind==='lyrics'){
      if(lease.hits<2){result.decision='prepared';result.reason='Waiting for the same distinct lyric match in two consecutive audio windows.';return result;}
      if(Date.now()-lease.lastTakeAt<=3000){result.decision='cooldown';result.reason='Lyrics confirmed; briefly holding to avoid rapid switching.';return result;}
    }
    result.workspace=this.library.command(channelId,workspace.revision,{type:'take',selection:result.candidate.selection});
    result.switched=true;result.decision='sent-live';result.reason=kind==='lyrics'?'Confirmed lyrics sent live.':result.match==='reference'?'Clear, valid reference sent live.':'Distinctive exact quotation matched and sent live.';lease.lastTakeAt=Date.now();this.changed(result.workspace);
    return result;
  }
}
