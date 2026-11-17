import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Stalwart} from '../src/stalwart.js';
import type {Config} from '../src/config.js';
import type {Session,Store} from '../src/store.js';

test('message detail requests both MIME alternatives and preserves text, HTML, BCC and attachments',async()=>{
 const owner={id:'session',accountId:'A'} as Session;
 const adapter=new Stalwart({STALWART_URL:'https://mail.test'} as Config,{addUpload:async()=>({id:'download',name:'file.txt',type:'text/plain',size:20})} as unknown as Store);
 let htmlBody:any[]=[{partId:'html'}];let textBody:any[]=[{partId:'text'}];
 (adapter as any).call=async(session:Session,calls:any[])=>{
  assert.equal(session,owner);const [method,args]=calls[0];assert.equal(method,'Email/get');assert.equal(args.accountId,'A');assert.deepEqual(args.ids,['E1']);
  assert.ok(args.properties.includes('htmlBody'));assert.ok(args.properties.includes('textBody'));assert.equal(args.fetchTextBodyValues,true);assert.equal(args.fetchHTMLBodyValues,true);
  return [{list:[{id:'E1',mailboxIds:{inbox:true},textBody,htmlBody,bodyValues:{text:{value:'Visit https://example.test/?a=1&b=2'},html:{value:'<p>Visit <a href="https://example.test/?a=1&amp;b=2">the page</a></p>'}},bcc:[{email:'hidden@example.test'}],attachments:[{blobId:'blob',name:'file.txt',type:'text/plain',size:20}]}]}];
 };
 let m=await adapter.message(owner,'E1');assert.equal(m.bodyText,'Visit https://example.test/?a=1&b=2');assert.match(m.bodyHtml!,/<p>Visit/);assert.equal(m.bcc[0].email,'hidden@example.test');assert.equal(m.attachments[0]?.id,'download');
 textBody=[];m=await adapter.message(owner,'E1');assert.equal(m.bodyText,'');assert.ok(m.bodyHtml);
 htmlBody=[];textBody=[{partId:'text'}];m=await adapter.message(owner,'E1');assert.equal(m.bodyHtml,undefined);assert.match(m.bodyText,/Visit/);
});
