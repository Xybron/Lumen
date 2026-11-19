import {analyzeSpokenReferences} from './scripture-reference.js';
import type {WorshipLibrary} from './worship-library.js';
import type {ListeningResult} from '../../shared/worship.js';

interface Fragment {text:string;atMs:number}
const words=(text:string)=>text.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
const CONNECTORS=new Set('a an the and or but to of in on at for from by with as is are was were be been being it its that this these those which who whom whose i me my we our us you your he him his she her they them their thy thou thine thee so shall have has had do does did will would should could can may might must unto there then when where also all every any'.split(' '));
const content=(text:string)=>new Set(words(text).filter(word=>word.length>1&&!CONNECTORS.has(word)));

/** Restore review suggestions when a short provider turn splits a quotation.
 * This runs after automatic matching; retained words can never publish a cue
 * or replace the current turn's transcript sent to linked Notes. */
export class StreamingQuoteContext {
  private fragments:Fragment[]=[];
  private versionId='';
  private revision=-1;
  constructor(private library:WorshipLibrary) {}

  apply(result:ListeningResult,newFinal:boolean,atMs:number,versionId:string):ListeningResult {
    if(!newFinal)return result;
    if(versionId!==this.versionId||result.workspace.revision!==this.revision){this.fragments=[];this.versionId=versionId;this.revision=result.workspace.revision;}
    const text=result.transcript.trim(),evidence=analyzeSpokenReferences(text);
    if(!text||result.candidate||result.switched||result.recognition?.status==='no-speech'||evidence.references.length||evidence.invalid||evidence.negated){this.fragments=[];return result;}
    if(!Number.isFinite(atMs)||words(text).length>96||text.length>12000){this.fragments=[];return result;}
    const last=this.fragments.at(-1);
    if(last&&(atMs<last.atMs||atMs-last.atMs>8000))this.fragments=[];
    this.fragments=this.fragments.filter(fragment=>atMs-fragment.atMs<=12000).slice(-2);
    const combined=[...this.fragments,{text,atMs}];
    // Retain at most two finalized turns, never an unbounded sermon history.
    this.fragments=combined.slice(-2);
    if(words(combined.map(fragment=>fragment.text).join(' ')).length>96){this.fragments=[{text,atMs}];return result;}
    if(combined.length<2)return result;
    try {
      // Try contiguous suffixes only. Introductory words like "Look!" may
      // precede the quotation; never skip an unrelated turn in its middle.
      for(let start=0;start<=combined.length-2;start++){
        const adjacent=combined.slice(start);
        const quote=this.library.matchScriptureQuote(versionId,adjacent.map(fragment=>fragment.text).join(' '));
        if(!quote.selection||quote.ambiguous)continue;
        const candidate=this.library.cue(quote.selection),verseWords=content(candidate.text);
        // Each adjacent fragment must contribute evidence. A quotation on either
        // side of unrelated commentary is not one continuous quotation.
        if(adjacent.some(fragment=>[...content(fragment.text)].filter(word=>verseWords.has(word)).length<2))continue;
        this.fragments=[];
        return {...result,candidate,match:'phrase',score:quote.score,quoteAmbiguous:false,switched:false,decision:'review',reason:'Possible quotation across preceding finalized words. Review the passage before sending live.'};
      }
      return result;
    }catch{this.fragments=[];return result;}
  }
}
