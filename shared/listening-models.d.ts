export interface ListeningModelDefinition {
  readonly id:string; readonly label:string; readonly description:string;
  readonly multilingual:boolean; readonly bytes:number; readonly sha256:string;
  readonly filename:string; readonly downloadMiB:number;
}
export const LISTENING_MODELS:readonly ListeningModelDefinition[];
export function listeningModel(id:string):ListeningModelDefinition|undefined;
