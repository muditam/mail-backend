import {AsyncLocalStorage} from 'node:async_hooks';
import {performance} from 'node:perf_hooks';
// Request-local durations only: never record URLs, subjects, IDs or credentials.
export const requestTimings=new AsyncLocalStorage<Map<string,{ms:number;count:number}>>();
export async function timed<T>(stage:string,work:()=>Promise<T>):Promise<T>{
 const start=performance.now();try{return await work()}finally{
  const values=requestTimings.getStore();if(values){const previous=values.get(stage)||{ms:0,count:0};values.set(stage,{ms:previous.ms+performance.now()-start,count:previous.count+1})}
 }
}
export function timingSummary(){return Object.fromEntries([...requestTimings.getStore()||[]].map(([name,value])=>[name,{ms:Number(value.ms.toFixed(2)),count:value.count}]))}
