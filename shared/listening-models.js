// Fixed local model catalogue. Sizes and LFS SHA-256 values verified against
// https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main .
// Keeping this list shared means the installer and worker accept the same IDs;
// browser input can never become a model filename or a download URL.
export const LISTENING_MODELS = Object.freeze([
  {id:'base.en',label:'Fast · Base English',description:'Lowest resource use. Less reliable with accents, names and noisy rooms.',multilingual:false,bytes:147964211,sha256:'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002'},
  {id:'small.en',label:'Balanced · Small English',description:'A stronger English model for varied accents. More processing than Base.',multilingual:false,bytes:487614201,sha256:'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d'},
  {id:'small',label:'Balanced · Small multilingual',description:'Broader language training; try alongside Small English with your speakers.',multilingual:true,bytes:487601967,sha256:'1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'},
  {id:'medium.en',label:'Accurate · Medium English',description:'Larger English model. Requires more memory and may be slower on this station.',multilingual:false,bytes:1533774781,sha256:'cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356'},
  {id:'medium',label:'Accurate · Medium multilingual',description:'Larger multilingual model. Requires more memory and processing time.',multilingual:true,bytes:1533763059,sha256:'6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208'},
  {id:'large-v3-turbo-q5_0',label:'Accurate · Turbo multilingual',description:'Quantized large-v3 Turbo. Broad training; speed and accuracy depend on your hardware and voice.',multilingual:true,bytes:574041195,sha256:'394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'},
].map(model=>Object.freeze({...model,filename:`ggml-${model.id}.bin`,downloadMiB:Math.ceil(model.bytes/1048576)})));

export function listeningModel(id) { return LISTENING_MODELS.find(model=>model.id===id); }
