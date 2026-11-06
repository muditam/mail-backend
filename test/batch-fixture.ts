// A small result-reference-aware provider fixture, not production fallback code.
export function batchCalls(handler:(session:any,calls:any[])=>Promise<any[]>){
 return async(session:any,calls:any[])=>{
  const replies:any[]=[];
  for(const [name,original,tag] of calls){
   const args={...original};if(args['#ids']){const ref=args['#ids'];const index=calls.findIndex(c=>c[2]===ref.resultOf);args.ids=replies[index]?.ids;delete args['#ids'];}
   const [reply]=await handler(session,[[name,args,tag]]);replies.push(reply);
  }return replies;
 };
}
export async function batchHttp(input:any,init:any,handler:(input:any,init:any)=>Promise<Response>):Promise<Response|undefined>{
 const body=JSON.parse(String(init.body));if(body.methodCalls.length<2)return;
 const responses:any[]=[];
 for(const [name,original,tag] of body.methodCalls){
  const args={...original};if(args['#ids']){const ref=args['#ids'];const previous=responses.find(r=>r[2]===ref.resultOf);if(previous?.[0]!==ref.name||!Array.isArray(previous[1]?.ids)){responses.push(['error',{type:'invalidResultReference'},tag]);continue;}args.ids=previous[1].ids;delete args['#ids'];}
  const result=await handler(input,{...init,body:JSON.stringify({...body,methodCalls:[[name,args,tag]]})});if(!result.ok)return result;
  responses.push(...(await result.json()).methodResponses);
 }
 return new Response(JSON.stringify({methodResponses:responses}));
}
