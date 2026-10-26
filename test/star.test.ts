import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Stalwart} from '../src/stalwart.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {Store,Session} from '../src/store.js';

const config={STALWART_URL:'https://mail.test',APP_ORIGIN:'https://app.test'} as Config;
const session={id:'star-session',accountId:'A'} as Session;
test('starring and reading patch individual keywords and preserve other message state',async()=>{
 const adapter=new Stalwart(config,{} as Store),keywords:Record<string,boolean>={'$draft':true,'custom':true};const calls:any[]=[];
 (adapter as any).call=async(s:Session,methods:any[])=>{
  assert.equal(s,session);const [method,args]=methods[0];assert.equal(args.accountId,'A');calls.push({method,args});
  if(method==='Email/get')return [{list:[{id:'E1',keywords:{...keywords}}]}];
  assert.equal(method,'Email/set');assert.deepEqual(Object.keys(args),['accountId','update']);
  const patch=args.update.E1;assert.equal(Object.keys(patch).length,1);
  for(const [path,value] of Object.entries(patch)){assert.ok(path.startsWith('keywords/'));const keyword=path.slice(9);if(value===null)delete keywords[keyword];else keywords[keyword]=true;}
  return [{updated:{E1:null}}];
 };
 assert.deepEqual(await adapter.star(session,'E1',true),{id:'E1',isStarred:true});
 await adapter.read(session,'E1',true);
 assert.deepEqual(keywords,{'$draft':true,custom:true,'$flagged':true,'$seen':true});
 await adapter.star(session,'E1',false);await adapter.star(session,'E1',false);
 assert.deepEqual(keywords,{'$draft':true,custom:true,'$seen':true});
 assert.deepEqual(calls[0].args.update,{E1:{'keywords/$flagged':true}});
 assert.deepEqual(calls.at(-1).args.update,{E1:{'keywords/$flagged':null}});
});
test('star never reports a failed or missing update as successful',async()=>{
 const adapter=new Stalwart(config,{} as Store);
 for(const response of [{notUpdated:{E1:{type:'notFound'}}},{notUpdated:{E1:{type:'forbidden'}}},{}]){
  (adapter as any).call=async()=>[response];
  await assert.rejects(adapter.star(session,'E1',true),{code:response.notUpdated?.E1.type==='notFound'?'MESSAGE_NOT_FOUND':'UPSTREAM_UNAVAILABLE'});
 }
});
test('Starred uses server-side filtering, supports text intersection and keeps pagination',async()=>{
 const adapter=new Stalwart(config,{} as Store),calls:any[]=[];
 (adapter as any).call=async(s:Session,methods:any[])=>{
  assert.equal(s,session);const [method,args]=methods[0];assert.equal(args.accountId,'A');calls.push({method,args});
  if(method==='Email/query')return [{ids:['E1','E2']}];
  if(method==='Mailbox/get')return [{list:[{id:'inbox'}]}];
  return [{list:[{id:'E1',keywords:{'$flagged':true},mailboxIds:{inbox:true}}]}];
 };
 const result=await adapter.messages(session,undefined,0,1,undefined,true);
 assert.deepEqual(calls[0].args.filter,{hasKeyword:'$flagged'});assert.equal(result.nextCursor,'1');assert.equal(result.messages[0].keywords['$flagged'],true);
 await adapter.messages(session,'inbox',1,1,'budget',true);
 assert.deepEqual(calls.filter(c=>c.method==='Email/query').at(-1).args.filter,{operator:'AND',conditions:[{inMailbox:'inbox'},{operator:'OR',conditions:[{from:'budget'},{subject:'budget'},{body:'budget'}]},{hasKeyword:'$flagged'}]});
});
test('star route enforces session, origin, CSRF and boolean payload; starred listing is scoped',async()=>{
 const store={get:async(id:string)=>id===session.id?session:null,checkCsrf:async(_id:string,t:string)=>t==='csrf'} as unknown as Store;
 const stars:any[]=[],lists:any[]=[];
 const adapter={star:async(s:Session,id:string,isStarred:boolean)=>{stars.push([s,id,isStarred]);return {id,isStarred};},messages:async(...args:any[])=>{lists.push(args);return {messages:[]};}} as unknown as Stalwart;
 const app=buildApp(config,store,adapter),headers={origin:'https://app.test',cookie:'webmail_sid=star-session','x-csrf-token':'csrf'};
 try{
  const star=(payload:any,h:any=headers)=>app.inject({method:'PATCH',url:'/api/app/v1/messages/E1/star',headers:h,payload});
  assert.equal((await star({isStarred:true},{origin:headers.origin})).statusCode,401);
  assert.equal((await star({isStarred:true},{...headers,origin:'https://evil.test'})).statusCode,403);
  assert.equal((await star({isStarred:true},{...headers,'x-csrf-token':'wrong'})).statusCode,403);
  for(const payload of [{},{isStarred:'true'},{isStarred:true,accountId:'B'},{isStarred:null}])assert.equal((await star(payload)).statusCode,400);
  assert.equal(stars.length,0);
  assert.deepEqual((await star({isStarred:true})).json(),{message:{id:'E1',isStarred:true}});
  assert.deepEqual(stars[0],[session,'E1',true]);assert.equal((await star({isStarred:false})).statusCode,200);
  assert.equal((await app.inject({method:'GET',url:'/api/app/v1/messages?starred=true',headers})).statusCode,200);
  assert.deepEqual(lists[0],[session,undefined,0,30,undefined,true]);
  for(const value of ['false','1','yes'])assert.equal((await app.inject({method:'GET',url:`/api/app/v1/messages?starred=${value}`,headers})).statusCode,400);
 }finally{await app.close();}
});
test('saving a starred draft carries the star to its replacement',async()=>{
 const adapter=new Stalwart(config,{} as Store);
 (adapter as any).call=async(_s:Session,methods:any[])=>{
  const [method,args]=methods[0];
  if(method==='Mailbox/get')return [{list:[{id:'drafts',role:'drafts'}]}];
  if(method==='Email/get')return [{list:[{id:'D1',keywords:{'$draft':true,'$flagged':true}}]}];
  if(args.create){assert.equal(args.create.draft.keywords['$flagged'],true);assert.equal(args.create.draft.keywords['$draft'],true);return [{created:{draft:{id:'D2'}}}];}
  assert.deepEqual(args.destroy,['D1']);return [{destroyed:['D1']}];
 };
 assert.equal(await adapter.draft(session,{draftId:'D1',to:[],cc:[],bcc:[],subject:'Draft',bodyText:'Edited',attachmentIds:[]}),'D2');
});
