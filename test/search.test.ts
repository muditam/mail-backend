import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Stalwart} from '../src/stalwart.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {Store,Session} from '../src/store.js';

function setup(){
 const config={STALWART_URL:'https://mail.test',APP_ORIGIN:'https://app.test'} as Config;
 const s={id:'search-session',accountId:'own-account'} as Session;
 const calls:any[]=[];
 const adapter=new Stalwart(config,{} as Store);
 const messages=Array.from({length:35},(_,i)=>({id:`E${i}`,mailboxIds:{[i%2?'sent':'inbox']:true},from:[{email:'alice@example.test'}],subject:'Quarterly budget',preview:'preview',body:'Need approval',receivedAt:new Date(2026,0,35-i).toISOString(),keywords:{}}));
 (adapter as any).call=async(session:Session,methods:any[])=>{
  assert.equal(session,s);const [method,args]=methods[0];assert.equal(args.accountId,'own-account');calls.push({method,args});
  if(method==='Mailbox/get')return [{list:args.ids[0]==='missing'?[]:[{id:args.ids[0]}]}];
  const matches=(m:any,filter:any):boolean=>!filter?true:filter.operator==='OR'?filter.conditions.some((c:any)=>matches(m,c)):filter.operator==='AND'?filter.conditions.every((c:any)=>matches(m,c)):filter.inMailbox?!!m.mailboxIds[filter.inMailbox]:filter.from?m.from[0].email.includes(filter.from):filter.subject?m.subject.includes(filter.subject):m.body.includes(filter.body);
  if(method==='Email/query')return [{ids:messages.filter(m=>matches(m,args.filter)).slice(args.position,args.position+args.limit).map(m=>m.id)}];
  if(method==='Email/get')return [{list:messages.filter(m=>args.ids.includes(m.id)).reverse()}];
  throw Error(method);
 };
 return {adapter,s,calls,config};
}

test('search uses sender, subject or body filters across folders and returns ordered metadata pages',async()=>{
 const {adapter,s,calls}=setup();
 for(const q of ['alice@example.test','Quarterly','approval']){
  const first=await adapter.messages(s,undefined,0,30,q);
  assert.equal(first.messages.length,30);assert.equal(first.nextCursor,'30');assert.equal(first.messages[0].id,'E0');assert.equal(first.messages[29].id,'E29');
  const query=calls.filter(c=>c.method==='Email/query').at(-1).args;
  assert.deepEqual(query.filter,{operator:'OR',conditions:[{from:q},{subject:q},{body:q}]});assert.deepEqual(query.sort,[{property:'receivedAt',isAscending:false}]);assert.equal(query.limit,31);
  assert.ok(!calls.filter(c=>c.method==='Email/get').at(-1).args.properties.includes('bodyValues'));
  const second=await adapter.messages(s,undefined,30,30,q);assert.equal(second.messages.length,5);assert.equal(second.nextCursor,undefined);
  assert.equal(new Set([...first.messages,...second.messages].map(m=>m.id)).size,35);
 }
 assert.equal(calls.some(c=>c.method==='Mailbox/get'),false);
});
test('folder search intersects mailbox and text, ordinary browsing stays unchanged',async()=>{
 const {adapter,s,calls}=setup();
 const result=await adapter.messages(s,'sent',0,30,'approval');assert.equal(result.messages.length,17);assert.ok(result.messages.every(m=>m.mailboxIds.includes('sent')));
 assert.deepEqual(calls.find(c=>c.method==='Email/query').args.filter,{operator:'AND',conditions:[{inMailbox:'sent'},{operator:'OR',conditions:[{from:'approval'},{subject:'approval'},{body:'approval'}]}]});
 await adapter.messages(s,'inbox',0,30);assert.deepEqual(calls.filter(c=>c.method==='Email/query').at(-1).args.filter,{inMailbox:'inbox'});
 await assert.rejects(adapter.messages(s,'missing',0,30,'approval'),{code:'MAILBOX_NOT_FOUND'});
});
test('empty matches avoid fetching message bodies and special characters remain literal query data',async()=>{
 const {adapter,s,calls}=setup();const q='a+b & <invoice> "quoted"';
 assert.deepEqual(await adapter.messages(s,undefined,0,30,q),{messages:[]});
 assert.equal(calls.length,1);assert.equal(calls[0].args.filter.conditions[0].from,q);
});
test('search API validates input, uses the signed-in account, and limits rapid searches',async()=>{
 const {config,s}=setup();let forwarded:any[]=[];
 const store={get:async(id:string)=>id==='search-session'?s:null} as unknown as Store;
 const adapter={messages:async(...args:any[])=>{forwarded.push(args);return {messages:[]};}} as unknown as Stalwart;
 const app=buildApp(config,store,adapter),headers={cookie:'webmail_sid=search-session'};
 try{
  const get=(params:string,h:any=headers)=>app.inject({method:'GET',url:`/api/app/v1/messages?${params}`,headers:h});
  assert.equal((await get('q=budget',{})).statusCode,401);
  for(const q of ['', 'q=%20%20','q='+ 'x'.repeat(257),'q=x&limit=101','q=x&cursor=-1','q=x&accountId=foreign','q=x&q=y'])assert.equal((await get(q)).statusCode,400,q);
  assert.equal(forwarded.length,0);
  assert.equal((await get('q=%20budget%20&cursor=30&limit=10')).statusCode,200);assert.deepEqual(forwarded[0],[s,undefined,30,10,'budget',undefined]);
  for(let i=1;i<20;i++)assert.equal((await get('q=budget')).statusCode,200);
  assert.equal((await get('q=budget')).statusCode,429);assert.equal(forwarded.length,20);
  assert.equal((await get('mailboxId=inbox')).statusCode,200);
 }finally{await app.close();}
});

test('provider search errors and malformed replies surface as errors, not no-match results',async()=>{
 const config={STALWART_URL:'https://mail.test',STALWART_JMAP_SESSION_URL:'https://mail.test/.well-known/jmap',APP_ORIGIN:'https://app.test',SESSION_IDLE_MINUTES:30} as Config;
 const session={id:'provider-search',accountId:'A',token:{access_token:'token',expires_at:Date.now()+3600000},touchedAt:Date.now(),absoluteExpiresAt:Date.now()+43200000} as Session;
 const store={get:async()=>session} as unknown as Store;
 let query:any={},get:any={list:[]},status=200,errorType='';
 const adapter=new Stalwart(config,store,async(input,init)=>{
  if(String(input).endsWith('/.well-known/jmap'))return new Response(JSON.stringify({apiUrl:'https://mail.test/jmap',uploadUrl:'https://mail.test/upload',downloadUrl:'https://mail.test/download',accounts:{A:{accountCapabilities:{'urn:ietf:params:jmap:mail':{}}}},primaryAccounts:{'urn:ietf:params:jmap:mail':'A'},capabilities:{'urn:ietf:params:jmap:core':{},'urn:ietf:params:jmap:mail':{}}}));
  const [method,args,tag]=JSON.parse(String(init?.body)).methodCalls[0];
  assert.equal(args.accountId,'A');
  if(method==='Email/query')assert.deepEqual(args.filter,{operator:'OR',conditions:[{from:'bodyonlytoken'},{subject:'bodyonlytoken'},{body:'bodyonlytoken'}]});
  return new Response(JSON.stringify({methodResponses:[[errorType?'error':method,errorType?{type:errorType}:method==='Email/query'?query:get,tag]]}),{status});
 });
 const app=buildApp(config,store,adapter);
 const search=()=>app.inject({method:'GET',url:'/api/app/v1/messages?q=bodyonlytoken',headers:{cookie:'webmail_sid=provider-search'}});
 try{
  for(const malformed of [{},null,{ids:null},{ids:'E1'},{ids:[1]}]){query=malformed;assert.equal((await search()).statusCode,503);}
  query={ids:[]};assert.deepEqual((await search()).json(),{messages:[]});
  for(const type of ['serverFail','unsupportedFilter','invalidArguments']){errorType=type;assert.equal((await search()).statusCode,503);}
  errorType='';status=500;assert.equal((await search()).statusCode,503);status=200;
  query={ids:['E1']};
  for(const malformed of [{},null,{list:null},{list:[null]},{list:[]}]){get=malformed;assert.equal((await search()).statusCode,503);}
  get={list:[],notFound:['E1']};assert.deepEqual((await search()).json(),{messages:[]});
  get={list:[{id:'E1',subject:'Unrelated subject',from:[{email:'sender@example.test'}],mailboxIds:{trash:true},preview:'bodyonlytoken appears only here'}]};
  const found=await search();assert.equal(found.statusCode,200);assert.equal(found.json().messages[0].id,'E1');assert.deepEqual(found.json().messages[0].mailboxIds,['trash']);
 }finally{await app.close();}
});

test('exact search-only URLs from the reported 400s are valid without a mailboxId',async()=>{
 const {config,s}=setup();s.id='screenshot-search';const calls:any[]=[];
 const store={get:async()=>s} as unknown as Store;
 const adapter={messages:async(...args:any[])=>{calls.push(args);return {messages:[]};}} as unknown as Stalwart;
 const app=buildApp(config,store,adapter);
 try{
  for(const q of ['hi','whats','Hi']){
   const r=await app.inject({method:'GET',url:`/api/app/v1/messages?limit=30&q=${q}`,headers:{cookie:'webmail_sid=screenshot-regression'}});
   assert.equal(r.statusCode,200);assert.deepEqual(calls.at(-1),[s,undefined,0,30,q,undefined]);
  }
 }finally{await app.close();}
});
