export class WorshipRequestError extends Error { constructor(message:string,readonly status:number){super(message);} }
export async function worshipRequest<T>(path:string,options:RequestInit={}):Promise<T> {
  const response=await fetch(`/api/worship${path}`,{credentials:'include',...options,headers:{...(options.body && !(options.body instanceof Blob)?{'Content-Type':'application/json'}:{}),...options.headers}});
  const data=await response.json().catch(()=>({error:'The station returned an invalid response.'}));
  if (!response.ok) throw new WorshipRequestError(data.error??`Request failed (${response.status})`,response.status);
  return data;
}
