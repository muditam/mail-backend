import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifySafety,safetyProperties} from '../src/safety.js';
const config={INTERNAL_EMAIL_DOMAINS:'muditam.com',STALWART_AUTHSERV_ID:'mx.muditam.com'};
const message=(email:string,auth='mx.muditam.com; dmarc=pass header.from=muditam.com')=>({from:[{email}],[safetyProperties[0]]:[auth]});
test('exact domain and uppercase pass; subdomains and lookalikes remain external',()=>{
 assert.equal(classifySafety(message('a@muditam.com'),config).classification,'internal');
 assert.equal(classifySafety(message('a@MUDITAM.COM'),config).classification,'internal');
 for(const d of ['sub.muditam.com','evil-muditam.com','muditam.com.evil.test','mudltam.com'])assert.equal(classifySafety(message(`a@${d}`),config).classification,'external');
});
test('malformed, multiple, missing or unverified senders fail closed',()=>{
 for(const m of [{},{from:[]},{from:[{email:'bad'}]},{from:[{email:'a@muditam.com'},{email:'b@muditam.com'}]},message('a@muditam.com','evil.test; dmarc=pass header.from=muditam.com'),message('a@muditam.com','mx.muditam.com; dmarc=fail header.from=muditam.com'),message('a@muditam.com','mx.muditam.com; dmarc=pass header.from=evil.test')])assert.equal(classifySafety(m,config).classification,'suspicious');
 assert.equal(classifySafety(message('a@muditam.com'),{}).classification,'suspicious');
 const m=message('a@muditam.com');m[safetyProperties[0]].push(m[safetyProperties[0]][0]);assert.equal(classifySafety(m,config).classification,'suspicious');
});
test('spam results raise a stronger warning',()=>{
 const m={...message('a@muditam.com'),[safetyProperties[1]]:['spam; score=12']};
 assert.deepEqual(classifySafety(m,config),{classification:'suspicious',fromDomain:'muditam.com',authentication:'aligned',spam:true});
});

import {Stalwart} from '../src/stalwart.js';
import type {Config} from '../src/config.js';
import type {Store,Session} from '../src/store.js';
import {buildApp} from '../src/app.js';
test('report reads only scoped metadata and sends no original content or attachments',async()=>{
 const adapter=new Stalwart({...config,STALWART_URL:'https://mail.test',IT_REPORT_EMAIL:'it@muditam.com'} as Config,{} as Store);
 const s={id:'session',email:'user@muditam.com',accountId:'A'} as Session;
 (adapter as any).call=async(session:Session,calls:any[])=>{assert.equal(session,s);assert.equal(calls[0][1].accountId,'A');assert.deepEqual(calls[0][1].ids,['E1']);assert.ok(!calls[0][1].properties.includes('bodyValues'));return [{list:[{...message('sender@outside.test'),id:'E1',subject:'Suspicious',bodyValues:{body:{value:'SECRET BODY'}},attachments:[{blobId:'SECRET BLOB'}],preview:'SECRET PREVIEW'}]}];};
 adapter.send=async(session,p)=>{assert.equal(session,s);assert.deepEqual(p.to,['it@muditam.com']);assert.deepEqual(p.attachmentIds,[]);assert.ok(!JSON.stringify(p).includes('SECRET'));assert.equal(JSON.parse(p.bodyText).messageId,'E1');return 'S1';};
 assert.equal(await adapter.report(s,'E1'),'S1');
 (adapter as any).call=async()=>[{list:[]}];await assert.rejects(adapter.report(s,'missing'),{code:'MESSAGE_NOT_FOUND'});
 const disabled=new Stalwart({STALWART_URL:'https://mail.test'} as Config,{} as Store);await assert.rejects(disabled.report(s,'E1'),{code:'REPORT_UNAVAILABLE'});
});
test('report route enforces session, CSRF, empty payload and propagates delivery failure',async()=>{
 let reports=0;
 const store={get:async(id:string)=>id==='valid'?{id,email:'user@muditam.com'}:null,checkCsrf:async(_id:string,t:string)=>t==='csrf'} as unknown as Store;
 const adapter={report:async(_s:Session,id:string)=>{reports++;if(id==='fail')throw new Error('upstream');return 'S1';}} as unknown as Stalwart;
 const app=buildApp({APP_ORIGIN:'https://app.test'} as Config,store,adapter);
 const headers={origin:'https://app.test',cookie:'webmail_sid=valid','x-csrf-token':'csrf'};
 try{
 const request=(h:any,payload:any={},id='E1')=>app.inject({method:'POST',url:`/api/app/v1/messages/${id}/report`,headers:h,payload});
 assert.equal((await request({origin:headers.origin})).statusCode,401);
 assert.equal((await request({...headers,'x-csrf-token':'wrong'})).statusCode,403);
 assert.equal((await request({...headers,origin:'https://evil.test'})).statusCode,403);
 assert.equal((await request(headers,{bodyText:'injected'})).statusCode,400);
 assert.equal(reports,0);
 const result=await request(headers);assert.equal(result.statusCode,202);assert.deepEqual(result.json(),{status:'queued',submissionId:'S1'});
 assert.equal((await request(headers,{},'fail')).statusCode,503);
 }finally{await app.close();}
});
test('header comments cannot forge DMARC alignment and yes spam is suspicious',()=>{
 assert.equal(classifySafety(message('a@muditam.com','mx.muditam.com; dmarc=pass ( header.from=muditam.com )'),config).classification,'suspicious');
 assert.equal(classifySafety({...message('a@muditam.com'),[safetyProperties[1]]:['Yes']},config).classification,'suspicious');
});
test('list and detail request authentication headers and expose the same safety shape',async()=>{
 const adapter=new Stalwart({...config,STALWART_URL:'https://mail.test'} as Config,{} as Store);
 const m={...message('a@muditam.com'),id:'E1',mailboxIds:{inbox:true}};
 (adapter as any).call=async(_s:Session,calls:any[])=>{const [method,args]=calls[0];
  if(method==='Mailbox/get')return [{list:[{id:'inbox'}]}];
  if(method==='Email/query')return [{ids:['E1']}];
  assert.ok(safetyProperties.every(p=>args.properties.includes(p)));return [{list:[m]}];
 };
 const s={accountId:'A'} as Session;
 const list=await adapter.messages(s,'inbox',0,30),detail=await adapter.message(s,'E1');
 assert.equal(list.messages[0].safety.classification,'internal');
 assert.deepEqual(detail.safety,list.messages[0].safety);
});
