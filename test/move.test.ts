import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Stalwart} from '../src/stalwart.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {Store,Session} from '../src/store.js';

function fixture(){
 const config={APP_ORIGIN:'https://app.test',STALWART_URL:'https://mail.test',STALWART_JMAP_SESSION_URL:'https://mail.test/.well-known/jmap'} as Config;
 const session={id:'move-session',accountId:'A',email:'user@example.test',token:{access_token:'token',expires_at:Date.now()+3600000}} as Session;
 const boxes=[{id:'box-in',role:'inbox'},{id:'box-trash',role:'trash'},{id:'box-draft',role:'drafts'},{id:'box-sent',role:'sent'},{id:'box-junk',role:'junk'}];
 const message={id:'E1',mailboxIds:{'box-in':true} as Record<string,boolean>,keywords:{'$seen':true,'$flagged':true} as Record<string,boolean>,body:'keep this body',attachments:[{blobId:'blob1',name:'keep.pdf'}]};
 const calls:any[]=[];
 let setResult:any=undefined;
 const fetcher:typeof fetch=async(input,init)=>{
  let body:any;
  if(String(input).endsWith('/.well-known/jmap'))body={apiUrl:'https://mail.test/jmap',uploadUrl:'https://mail.test/upload/{accountId}',downloadUrl:'https://mail.test/download/{accountId}/{blobId}/{name}',accounts:{A:{accountCapabilities:{'urn:ietf:params:jmap:mail':{}}}},primaryAccounts:{'urn:ietf:params:jmap:mail':'A'},capabilities:{'urn:ietf:params:jmap:core':{},'urn:ietf:params:jmap:mail':{}}};
  else{
   const request=JSON.parse(String(init?.body));const [method,args,tag]=request.methodCalls[0];calls.push({method,args});assert.equal(args.accountId,'A');
   let result:any;
   if(method==='Mailbox/get')result={list:boxes.filter(b=>!args.ids||args.ids.includes(b.id)).map(b=>({...b,totalEmails:message.mailboxIds[b.id]?1:0,unreadEmails:message.mailboxIds[b.id]&&!message.keywords['$seen']?1:0}))};
   else if(method==='Email/get')result={state:'state-1',list:args.ids.includes(message.id)?[structuredClone(message)]:[]};
   else if(method==='Email/query')result={ids:message.mailboxIds[args.filter.inMailbox]?['E1']:[]};
   else if(method==='Email/set'){
    assert.equal(args.ifInState,'state-1');
    assert.deepEqual(Object.keys(args),['accountId','ifInState','update']);
    assert.ok(Object.keys(args.update.E1).every(key=>key==='mailboxIds'||key==='keywords/muditam-restore-sent'));
    result=setResult??{updated:{E1:null}};
    if(result.updated?.E1===null){message.mailboxIds=args.update.E1.mailboxIds;const marker=args.update.E1['keywords/muditam-restore-sent'];if(marker===true)message.keywords['muditam-restore-sent']=true;else if(marker===null)delete message.keywords['muditam-restore-sent'];}
   }else throw Error('Unexpected JMAP method '+method);
   body={methodResponses:[[method,result,tag]]};
  }
  return new Response(JSON.stringify(body),{status:200});
 };
 const store={get:async(id:string)=>id===session.id?session:null,checkCsrf:async(_id:string,value:string)=>value==='csrf'} as unknown as Store;
 const adapter=new Stalwart(config,store,fetcher);
 return {config,session,boxes,message,calls,store,adapter,fail:(result:any)=>{setResult=result;}};
}

test('trash and restore preserve content and keywords, use actual mailbox roles and are idempotent',async()=>{
 for(const source of [{'box-in':true},{'box-sent':true},{'box-junk':true},{'box-in':true,'custom-box':true}]){
  const x=fixture();x.message.mailboxIds=source;
  const original=structuredClone(x.message);
  assert.deepEqual(await x.adapter.moveMessage(x.session,'E1','trash'),{id:'E1',mailboxIds:['box-trash']});
  assert.deepEqual(x.message,{...original,mailboxIds:{'box-trash':true},keywords:{...original.keywords,...(source['box-sent']?{'muditam-restore-sent':true}:{})}});
  await x.adapter.moveMessage(x.session,'E1','trash');
  assert.equal(x.calls.filter(c=>c.method==='Email/set').length,1);
  const destination=source['box-sent']?'box-sent':'box-in';
  // Use a fresh adapter and session to prove restore does not rely on process/session memory.
  const fresh=new Stalwart(x.config,x.store,(x.adapter as any).fetcher);
  assert.deepEqual(await fresh.moveMessage({...x.session,id:'new-login'},'E1','restore'),{id:'E1',mailboxIds:[destination]});
  await x.adapter.moveMessage(x.session,'E1','restore');
  assert.equal(x.calls.filter(c=>c.method==='Email/set').length,2);
  assert.deepEqual(x.message,{...original,mailboxIds:{[destination]:true}});
 }
});
test('drafts restore to Drafts and a restore outside Trash leaves membership untouched',async()=>{
 const x=fixture();x.message.mailboxIds={'box-draft':true};x.message.keywords['$draft']=true;
 await x.adapter.moveMessage(x.session,'E1','trash');
 assert.deepEqual(await x.adapter.moveMessage(x.session,'E1','restore'),{id:'E1',mailboxIds:['box-draft']});
 x.message.mailboxIds={'box-sent':true};
 assert.deepEqual(await x.adapter.moveMessage(x.session,'E1','restore'),{id:'E1',mailboxIds:['box-sent']});
 assert.equal(x.calls.filter(c=>c.method==='Email/set').length,2);
});
test('missing messages and folders never issue an update',async()=>{
 const x=fixture();await assert.rejects(x.adapter.moveMessage(x.session,'other-account-id','trash'),{code:'MESSAGE_NOT_FOUND'});
 x.boxes.splice(x.boxes.findIndex(b=>b.role==='trash'),1);
 await assert.rejects(x.adapter.moveMessage(x.session,'E1','trash'),{code:'MAILBOX_NOT_FOUND'});
 assert.equal(x.calls.filter(c=>c.method==='Email/set').length,0);
 const y=fixture();y.message.mailboxIds={'box-trash':true};y.boxes.splice(y.boxes.findIndex(b=>b.role==='inbox'),1);
 await assert.rejects(y.adapter.moveMessage(y.session,'E1','restore'),{code:'MAILBOX_NOT_FOUND'});
 assert.equal(y.calls.filter(c=>c.method==='Email/set').length,0);
});
test('failed or unconfirmed JMAP updates never report success',async()=>{
 for(const failure of [{notUpdated:{E1:{type:'forbidden'}}},{notUpdated:{E1:{type:'notFound'}}},{}]){
  const x=fixture();x.fail(failure);
  await assert.rejects(x.adapter.moveMessage(x.session,'E1','trash'));
  assert.deepEqual(x.message.mailboxIds,{'box-in':true});
 }
});
test('authenticated HTTP flow moves and restores with fresh folder lists and counts',async()=>{
 const x=fixture(),app=buildApp(x.config,x.store,x.adapter);
 const headers={origin:'https://app.test',cookie:'webmail_sid=move-session','x-csrf-token':'csrf'};
 try{
  const move=(action:string,id='E1',h:any=headers,extra={})=>app.inject({method:'POST',url:`/api/app/v1/messages/${id}/move`,headers:h,payload:{action,...extra}});
  assert.equal((await move('trash','E1',{origin:headers.origin})).statusCode,401);
  assert.equal((await move('trash','E1',{...headers,origin:'https://evil.test'})).statusCode,403);
  assert.equal((await move('trash','E1',{...headers,'x-csrf-token':'bad'})).statusCode,403);
  assert.equal((await move('destroy')).statusCode,400);
  assert.equal((await move('trash','E1',headers,{accountId:'B'})).statusCode,400);
  assert.equal(x.calls.length,0);
  assert.equal((await move('trash','another-users-message')).statusCode,404);
  const moved=await move('trash');assert.equal(moved.statusCode,200);assert.deepEqual(moved.json(),{message:{id:'E1',mailboxIds:['box-trash']}});
  const list=async(box:string)=>(await app.inject({method:'GET',url:`/api/app/v1/messages?mailboxId=${box}`,headers})).json().messages;
  assert.equal((await list('box-in')).length,0);assert.equal((await list('box-trash')).length,1);
  const counts=(await app.inject({method:'GET',url:'/api/app/v1/mailboxes',headers})).json().mailboxes;
  assert.equal(counts.find((b:any)=>b.role==='trash').totalCount,1);assert.equal(counts.find((b:any)=>b.role==='inbox').totalCount,0);
  assert.equal((await move('restore')).statusCode,200);
  assert.equal((await list('box-trash')).length,0);assert.equal((await list('box-in')).length,1);
  x.fail({notUpdated:{E1:{type:'forbidden'}}});assert.equal((await move('trash')).statusCode,503);
 }finally{await app.close();}
});

test('Sent provenance survives re-login, preserves unread/star state and updates counts',async()=>{
 const x=fixture();x.message.mailboxIds={'box-sent':true};delete x.message.keywords['$seen'];
 const before=structuredClone(x.message);
 await x.adapter.moveMessage(x.session,'E1','trash');
 assert.equal(x.message.keywords['muditam-restore-sent'],true);
 const renewed={...x.session,id:'renewed-session'};
 const fresh=new Stalwart(x.config,x.store,(x.adapter as any).fetcher);
 assert.equal((await fresh.messages(renewed,'box-sent',0,30)).messages.length,0);
 assert.equal((await fresh.messages(renewed,'box-trash',0,30)).messages.length,1);
 await fresh.moveMessage(renewed,'E1','restore');
 assert.deepEqual(x.message,before);
 assert.equal((await fresh.messages(renewed,'box-in',0,30)).messages.length,0);
 assert.equal((await fresh.messages(renewed,'box-trash',0,30)).messages.length,0);
 assert.equal((await fresh.messages(renewed,'box-sent',0,30)).messages.length,1);
 const counts=await fresh.mailboxes(renewed);
 assert.equal(counts.find((b:any)=>b.role==='sent').totalCount,1);
 assert.equal(counts.find((b:any)=>b.role==='sent').unreadCount,1);
 assert.equal(counts.find((b:any)=>b.role==='trash').totalCount,0);
 // A later move from Inbox must not retain stale Sent provenance.
 x.message.mailboxIds={'box-in':true};
 await fresh.moveMessage(renewed,'E1','trash');await fresh.moveMessage(renewed,'E1','restore');
 assert.deepEqual(x.message.mailboxIds,{'box-in':true});
});
test('missing Sent folder or rejected restore leaves the message and origin marker in Trash',async()=>{
 const x=fixture();x.message.mailboxIds={'box-sent':true};
 await x.adapter.moveMessage(x.session,'E1','trash');const trashed=structuredClone(x.message);
 x.fail({notUpdated:{E1:{type:'forbidden'}}});
 await assert.rejects(x.adapter.moveMessage(x.session,'E1','restore'));
 assert.deepEqual(x.message,trashed);
 x.boxes.splice(x.boxes.findIndex(b=>b.role==='sent'),1);
 await assert.rejects(x.adapter.moveMessage(x.session,'E1','restore'),{code:'MAILBOX_NOT_FOUND'});
 assert.deepEqual(x.message,trashed);
});
