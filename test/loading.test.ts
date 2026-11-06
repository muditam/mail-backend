import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {MongoMemoryServer} from 'mongodb-memory-server';
import {Store} from '../src/store.js';
import {Stalwart} from '../src/stalwart.js';
import {buildApp} from '../src/app.js';
import {configFrom} from '../src/config.js';
const CORE='urn:ietf:params:jmap:core',MAIL='urn:ietf:params:jmap:mail';
const response=(value:any)=>new Response(JSON.stringify(value));

test('loading batches provider calls, avoids grant writes, preserves paging and emits isolated stage timings',async()=>{
 const mongo=await MongoMemoryServer.create();
 const config=configFrom({APP_ORIGIN:'https://app.test',STALWART_URL:'https://mail.test',STALWART_AUTH_URL:'https://mail.test/auth',STALWART_TOKEN_URL:'https://mail.test/token',STALWART_JMAP_SESSION_URL:'https://mail.test/session',OAUTH_CLIENT_ID:'test',OAUTH_REDIRECT_URI:'https://app.test/callback',SESSION_ENCRYPTION_KEY:randomBytes(32).toString('base64'),MONGODB_URI:mongo.getUri(),NODE_ENV:'test'});
 const store=await Store.connect(config);let app:ReturnType<typeof buildApp>|undefined;
 try{
  const s=await store.create('test@example.test','A',{access_token:'private-access',refresh_token:'private-refresh',expires_at:Date.now()+3600000});
  let discoveries=0,posts=0,renewals=0,mode='ok',grantWrites=0,grantReads=0,sessionWrites=0;
  const sessionRows=(store as any).sessions,sessionWrite=sessionRows.findOneAndUpdate.bind(sessionRows);
  sessionRows.findOneAndUpdate=async(...args:any[])=>{sessionWrites++;return sessionWrite(...args)};
  const rows=(store.oauth as any).rows,write=rows.updateOne.bind(rows),read=rows.findOne.bind(rows);
  rows.updateOne=async(...args:any[])=>{grantWrites++;return write(...args)};
  rows.findOne=async(...args:any[])=>{grantReads++;return read(...args)};
  const adapter=new Stalwart(config,store,async(url,init)=>{
   if(String(url).endsWith('/token')){renewals++;return response({access_token:'new',expires_in:3600})}
   if(String(url).endsWith('/session')){discoveries++;return response({apiUrl:'https://mail.test/jmap',uploadUrl:'https://mail.test/upload',downloadUrl:'https://mail.test/download',primaryAccounts:{[MAIL]:mode==='foreign'?'B':'A'},accounts:{A:{accountCapabilities:{[MAIL]:{}}},B:{accountCapabilities:{[MAIL]:{}}}},capabilities:{[CORE]:{},[MAIL]:{}}})}
   posts++;const request=JSON.parse(String(init?.body));assert.equal(request.methodCalls.length,3);
   assert.deepEqual(request.methodCalls.map((c:any)=>c[0]),['Mailbox/get','Email/query','Email/get']);
   for(const call of request.methodCalls)assert.equal(call[1].accountId,'A');
   assert.deepEqual(request.methodCalls[2][1]['#ids'],{resultOf:'q',name:'Email/query',path:'/ids'});
   assert.equal(request.methodCalls[1][1].limit,3);
   if(mode==='logout'){await store.delete(s.id);}
   const ids=['one','two','three'];
   return response({methodResponses:[['Mailbox/get',{list:mode==='missing'?[]:[{id:'inbox'}]},'m'],['Email/query',{ids},'q'],mode==='error'?['error',{type:'serverFail'},'e']:['Email/get',{list:ids.map(id=>({id,mailboxIds:{inbox:true},subject:'Private subject',keywords:{}})).reverse()},'e']]});
  });
  app=buildApp(config,store,adapter);
  const headers={cookie:'webmail_sid='+s.id};
  for(let n=0;n<2;n++){
   const r=await app.inject({url:'/api/app/v1/messages?mailboxId=inbox&limit=2',headers});
   assert.equal(r.statusCode,200);assert.deepEqual(r.json().messages.map((m:any)=>m.id),['one','two']);assert.equal(r.json().nextCursor,'2');
   const timings=String(r.headers['server-timing']);for(const stage of ['session','token','oauth','discovery','jmap','retry_summaries'])assert.match(timings,new RegExp(stage+';dur=\\d'));
   assert.ok(!timings.includes(s.id)&&!timings.includes('private')&&!timings.includes('Private subject'));
  }
  assert.equal(discoveries,2);assert.equal(posts,2);assert.equal(grantWrites,0);assert.equal(grantReads,2);assert.equal(renewals,0);assert.equal(sessionWrites,0);
  mode='missing';assert.equal((await app.inject({url:'/api/app/v1/messages?mailboxId=inbox&limit=2',headers})).statusCode,404);
  mode='error';assert.equal((await app.inject({url:'/api/app/v1/messages?mailboxId=inbox&limit=2',headers})).statusCode,503);
  mode='foreign';const before=posts;assert.equal((await app.inject({url:'/api/app/v1/messages?mailboxId=inbox&limit=2',headers})).statusCode,401);assert.equal(posts,before);
  assert.equal(await store.get(s.id),undefined);
 }finally{await app?.close();await store.close();await mongo.stop()}
});

test('registered missing credentials cannot be recreated from stale snapshots',async()=>{
 const {OAuthTokens}=await import('../src/oauthTokens.js');let writes=0;
 const rows={findOne:async()=>null,updateOne:async()=>{writes++;return {modifiedCount:1}}};
 const coordinator=new OAuthTokens({collection:()=>rows} as any,{SESSION_ENCRYPTION_KEY:randomBytes(32).toString('base64')} as any);
 await assert.rejects(coordinator.access('A',{credentialId:'missing',access_token:'stale',expires_at:Date.now()+3600000},Date.now()+1000,async()=>{throw Error('must not refresh')}),(e:any)=>e.status===503);
 assert.equal(writes,0);
});

test('request timings remain isolated during concurrent requests and report failed stages',async()=>{
 const {requestTimings,timed,timingSummary}=await import('../src/timings.js');
 const results=await Promise.all(['first','second'].map(name=>requestTimings.run(new Map(),async()=>{
  await assert.rejects(timed(name,async()=>{await new Promise(r=>setTimeout(r,5));throw Error('failed')}));return timingSummary();
 })));
 assert.deepEqual(Object.keys(results[0]),['first']);assert.deepEqual(Object.keys(results[1]),['second']);
 assert.equal(results[0].first.count,1);assert.ok(results[1].second.ms>=0);assert.deepEqual(timingSummary(),{});
});
