import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Stalwart} from '../src/stalwart.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {Store,Session} from '../src/store.js';

test('draft API preserves multiple BCC recipients and attachments across reopen and submission',async()=>{
 const config={NODE_ENV:'test',STALWART_URL:'https://mail.test',APP_ORIGIN:'https://app.test',SESSION_IDLE_MINUTES:30,SESSION_ABSOLUTE_HOURS:12} as Config;
 const session={id:'bcc-session',email:'sender@example.test',accountId:'A',touchedAt:Date.now(),absoluteExpiresAt:Date.now()+43200000} as Session;
 const attachment={id:'upload',blobId:'blob',name:'notes.txt',type:'text/plain',size:12};
 const store={get:async(id:string)=>id===session.id?session:undefined,checkCsrf:async(_id:string,token:string)=>token==='csrf',getUpload:async(sid:string,id:string)=>sid===session.id&&id===attachment.id?attachment:undefined,addUpload:async()=>attachment,reserveSend:async()=>true,acceptSend:async()=>{}} as unknown as Store;
 const messages=new Map<string,any>();let sequence=0,submitted:any;
 const adapter=()=>{
  const value=new Stalwart(config,store);
  (value as any).call=async(s:Session,methods:any[])=>{
   assert.equal(s.accountId,'A');const [method,args]=methods[0];assert.equal(args.accountId,'A');
   if(method==='Mailbox/get')return [{list:[{id:'drafts',role:'drafts'},{id:'sent',role:'sent'}]}];
   if(method==='Email/get')return [{list:args.ids.filter((id:string)=>messages.has(id)).map((id:string)=>Object.fromEntries(args.properties.map((key:string)=>[key,messages.get(id)[key]])))}];
   if(method==='Email/query')return [{ids:[...messages.keys()]}];
   if(method==='Email/set'){
    if(args.create){const id=`D${++sequence}`;messages.set(id,{id,...structuredClone(args.create.draft)});return [{created:{draft:{id}}}];}
    for(const id of args.destroy)messages.delete(id);return [{destroyed:args.destroy}];
   }
   if(method==='Identity/get')return [{list:[{id:'identity',email:session.email}]}];
   if(method==='EmailSubmission/set'){
    // Submission references the stored email, which contains distinct To/CC/BCC fields.
    submitted=messages.get(args.create.send.emailId);
    assert.equal(args.create.send.identityId,'identity');
    return [{created:{send:{id:'submission'}}}];
   }
   throw new Error(`Unexpected ${method}`);
  };
  return value;
 };
 let app=buildApp(config,store,adapter());
 const headers={origin:config.APP_ORIGIN,cookie:`webmail_sid=${session.id}`,'x-csrf-token':'csrf'};
 const original={to:['to@example.test'],cc:['cc@example.test'],bcc:['hidden1@example.test','hidden2@example.test'],subject:'Draft subject',bodyText:'Draft body',attachmentIds:['upload']};
 try{
  const save=await app.inject({method:'POST',url:'/api/app/v1/drafts',headers,payload:original});assert.equal(save.statusCode,200);
  const draftId=save.json().draftId;
  assert.deepEqual(messages.get(draftId).bcc,original.bcc.map(email=>({email})));
  // Recreate the app/adapter: reopening must use server data, not composer memory.
  await app.close();app=buildApp(config,store,adapter());
  const detail=await app.inject({method:'GET',url:`/api/app/v1/messages/${draftId}`,headers});assert.equal(detail.statusCode,200);
  const message=detail.json().message;
  for(const field of ['to','cc','bcc'] as const)assert.deepEqual(message[field].map((a:any)=>a.email),original[field]);
  assert.equal(message.subject,original.subject);assert.equal(message.bodyText,original.bodyText);
  assert.deepEqual(message.attachments,[{id:'upload',name:'notes.txt',type:'text/plain',size:12}]);
  const list=await app.inject({method:'GET',url:'/api/app/v1/messages?mailboxId=drafts',headers});
  assert.equal(JSON.stringify(list.json()).includes('hidden1@example.test'),false);
  const send=await app.inject({method:'POST',url:'/api/app/v1/messages/send',headers,payload:{draftId,to:message.to.map((a:any)=>a.email),cc:message.cc.map((a:any)=>a.email),bcc:message.bcc.map((a:any)=>a.email),subject:message.subject,bodyText:message.bodyText,attachmentIds:message.attachments.map((a:any)=>a.id)}});
  assert.equal(send.statusCode,202);
  for(const field of ['to','cc','bcc'] as const)assert.deepEqual(submitted[field].map((a:any)=>a.email),original[field]);
  assert.equal(submitted.attachments[0].blobId,'blob');assert.equal(submitted.bodyValues.body.value,original.bodyText);
  assert.equal(JSON.stringify(send.json()).includes('hidden1@example.test'),false);
 }finally{await app.close();}
});
