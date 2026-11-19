import type { ListeningResult } from '../../shared/worship.js';

/** Provisional ASR numbers are revisable even when the citation parses. */
export class StreamingEvidenceGate {
  private key='';
  private since=0;
  private turn=-1;
  apply(result:ListeningResult,final:boolean,turn:number,atMs:number):ListeningResult {
    if(turn!==this.turn){this.key='';this.turn=turn;}
    const selection=result.candidate?.selection;
    if(!selection){this.key='';return result;}
    if(result.match==='phrase'&&result.quoteAmbiguous)return {...result,candidate:null,match:'none',score:0,decision:'listening',reason:'These words are shared by multiple passages. Listening for a distinctive continuation.'};
    if(result.match!=='reference'||final)return result;
    const key=JSON.stringify(selection);
    if(key!==this.key){this.key=key;this.since=atMs;}
    else if(atMs-this.since>=300)return result;
    return {...result,candidate:null,match:'none',score:0,decision:'listening',reason:'Confirming the spoken book, chapter and verse as the words settle.'};
  }
}

export const cloudRecognition={status:'unavailable' as const,reason:'Streaming transcription is not calibrated confidence. Review the prepared passage.',avgLogprob:null,noSpeechProbability:null,rejectedSegments:0,totalSegments:0};
