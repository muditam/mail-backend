import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Stalwart} from '../src/stalwart.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {Store,Session} from '../src/store.js';

async function setup(statuses:any, mode='normal'){
 const config={NODE_ENV:'test',STALWART_URL:'https://mail.test',APP_ORIGIN:'https://app.test',SESSION_IDLE_MINUTES:30,SESSION_ABSOLUTE_HOURS:12} as Config;
 const session={id:randomUUID(),email:'tester2@60brands.com',accountId:'A',touchedAt:Date.now(),absoluteExpiresAt:Date.now()+43200000} as Session;
 let reserved=false,submissions=0,moves=0,sequence=1;
 const payload={draftId:'D1',to:['tester3@60brands.com'],cc:[],bcc:['hidden@example.test'],subject:'Smoke',bodyText:'Preserve body',attachmentIds:['upload']};
 const messages=new Map<string,any>([['D1',{id:'D1',keywords:{$draft:true,$flagged:true},mailboxIds:{drafts:true}}]]);
 const store={get:async()=>session,checkCsrf:async()=>true,getUpload:async()=>({blobId:'blob',name:'file.txt',type:'text/plain',size:123}),reserveSend:async()=>{if(reserved)return false;reserved=true;return true;},releaseSend:async()=>{reserved=false;},acceptSend:async()=>{}} as unknown as Store;
 const adapter=new Stalwart(config,store);
 (adapter as any).call=async(s:Session,calls:any[])=>{
  assert.equal(s.accountId,'A');const [method,args]=calls[0];assert.equal(args.accountId,'A');
  if(method==='Mailbox/get')return [{list:[{id:'drafts',role:'drafts'},{id:'sent',role:'sent'}]}];
  if(method==='Identity/get')return [{list:[{id:'I1',email:session.email}]}];
  if(method==='Email/get')return [{list:args.ids.map((id:string)=>messages.get(id)).filter(Boolean)}];
  if(method==='Email/set'){
   if(args.create){const id=`D${++sequence}`;messages.set(id,{id,...structuredClone(args.create.draft)});return [{created:{draft:{id}}}];}
   if(args.destroy){for(const id of args.destroy)messages.delete(id);return [{destroyed:args.destroy}];}
   const patch=args.update.D2;assert.ok(patch);
   if(patch['mailboxIds/sent']){moves++;if(mode==='move-fails')return [{notUpdated:{D2:{type:'serverFail'}}}];const m=messages.get('D2');m.mailboxIds={sent:true};delete m.keywords.$draft;}
   else Object.assign(messages.get('D2'),structuredClone(patch));
   return [{updated:{D2:null}}];
  }
  if(method==='EmailSubmission/set'){
   submissions++;assert.equal(args.onSuccessUpdateEmail,undefined);
   assert.equal(args.create.send.emailId,`D${sequence}`);
   if(mode==='timeout')throw new Error('timeout');
   if(mode==='not-created')return [{notCreated:{send:{type:'forbiddenToSend'}}}];
   if(mode==='malformed-create')return [{}];
   return [{created:{send:{id:'bt'}}}];
  }
  if(method==='EmailSubmission/get'){
   assert.deepEqual(args.ids,['bt']);
   if(mode==='lookup-fails')throw new Error('network');
   return [{list:mode==='missing'?[]:[{id:'bt',emailId:mode==='wrong-email'?'other':`D${sequence}`,undoStatus:'final',deliveryStatus:statuses}]}];
  }
  throw new Error(method);
 };
 const app=buildApp(config,store,adapter);
 return {app,messages,payload,get reserved(){return reserved},get moves(){return moves},get submissions(){return submissions},send:()=>app.inject({method:'POST',url:'/api/app/v1/messages/send',headers:{origin:config.APP_ORIGIN,cookie:`webmail_sid=${session.id}`,'x-csrf-token':'csrf'},payload})};
}
const no={delivered:'no',smtpReply:'452 4.4.5 Rate limit exceeded, try again later.'};
const statuses=(a:any,b=a)=>({'tester3@60brands.com':a,'hidden@example.test':b});

test('production rate-limit fixture returns rejection, preserves edited draft and permits retry using returned draft ID',async()=>{
 const x=await setup(statuses(no));try{
  const r=await x.send();assert.equal(r.statusCode,422);assert.equal(r.json().error.code,'SEND_REJECTED');assert.match(r.json().error.message,/rate limit/);assert.equal(x.moves,0);assert.equal(x.reserved,false);
  const draft=x.messages.get('D2');assert.deepEqual(draft.mailboxIds,{drafts:true});assert.equal(draft.keywords.$draft,true);assert.equal(draft.keywords.$flagged,true);assert.equal(draft.bodyValues.body.value,x.payload.bodyText);assert.equal(draft.attachments[0].blobId,'blob');assert.deepEqual(draft.bcc,[{email:'hidden@example.test'}]);
  assert.equal(r.json().error.details.draftId,'D2');x.payload.draftId='D2';await x.send();assert.equal(x.submissions,2);
 }finally{await x.app.close()}
});
for(const delivered of ['yes','queued','unknown'])test(`${delivered} submission returns success and then moves to Sent`,async()=>{
 const x=await setup(statuses({delivered}));try{assert.equal((await x.send()).statusCode,202);assert.equal(x.moves,1);assert.deepEqual(x.messages.get('D2').mailboxIds,{sent:true});assert.equal(x.messages.get('D2').keywords.$draft,undefined);assert.equal(x.reserved,true);await x.send();assert.equal(x.submissions,1);}finally{await x.app.close()}
});
test('partial recipient failure is not success and identical retry cannot duplicate accepted recipients',async()=>{
 const x=await setup(statuses({delivered:'queued'},no));try{const r=await x.send();assert.equal(r.statusCode,409);assert.equal(r.json().error.code,'SEND_PARTIAL_FAILURE');assert.equal(JSON.stringify(r.json()).includes('hidden@example.test'),false);assert.equal(x.moves,1);await x.send();assert.equal(x.submissions,1);}finally{await x.app.close()}
});
for(const mode of ['lookup-fails','missing','wrong-email','malformed-create','timeout','move-fails'])test(`${mode} cannot report success or allow duplicate submission`,async()=>{
 const x=await setup(statuses({delivered:'queued'}),mode);try{const r=await x.send();assert.equal(r.statusCode,503);assert.equal(r.json().error.code,'SEND_STATUS_UNKNOWN');assert.equal(x.reserved,true);await x.send();assert.equal(x.submissions,1);}finally{await x.app.close()}
});
for(const value of [null,{},statuses({delivered:'invalid'}),{'tester3@60brands.com':no}])test('incomplete or malformed recipient status is uncertain',async()=>{
 const x=await setup(value);try{assert.equal((await x.send()).json().error.code,'SEND_STATUS_UNKNOWN');assert.equal(x.moves,0);assert.equal(x.reserved,true);}finally{await x.app.close()}
});
test('explicit submission creation rejection keeps Drafts and releases retry guard',async()=>{
 const x=await setup(null,'not-created');try{assert.equal((await x.send()).json().error.code,'SEND_REJECTED');assert.equal(x.reserved,false);assert.equal(x.moves,0);}finally{await x.app.close()}
});
