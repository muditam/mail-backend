import {test} from 'node:test';
import assert from 'node:assert/strict';
import {attachmentName} from '../src/attachmentName.js';
import {Stalwart} from '../src/stalwart.js';
import type {Config} from '../src/config.js';
import type {Store,Session} from '../src/store.js';

test('report fallbacks are descriptive and supplied filenames are preserved',()=>{
 assert.equal(attachmentName(null,'message/delivery-status'),'Delivery failure details.txt');
 assert.equal(attachmentName('attachment','message/rfc822'),'Returned email.eml');
 assert.equal(attachmentName('  ','MESSAGE/RFC822'),'Returned email.eml');
 assert.equal(attachmentName('original.eml','message/rfc822'),'original.eml');
 assert.equal(attachmentName('report.txt','message/delivery-status'),'report.txt');
 assert.equal(attachmentName(undefined,'application/pdf'),'attachment');
});
test('message detail and downloads share descriptive names without changing blob bytes',async()=>{
 const rows=new Map<string,any>(),data=new Map([['status',Buffer.alloc(262,65)],['email',Buffer.alloc(1192,66)]]);
 const store={addUpload:async(sessionId:string,blobId:string,name:string,type:string,size:number)=>{
  const row={id:blobId,blobId,name,type,size,sessionId};rows.set(blobId,row);return row;
 },getUpload:async(sessionId:string,id:string)=>{const row=rows.get(id);return row?.sessionId===sessionId?row:undefined;}} as unknown as Store;
 const s={id:'session',accountId:'A'} as Session;
 const fetcher=async(input:any)=>{
  const url=new URL(input);const blob=url.pathname.split('/')[3];
  assert.equal(url.pathname.split('/')[2],'A');
  assert.equal(decodeURIComponent(url.pathname.split('/')[4]),rows.get(blob).name);
  return new Response(new Uint8Array(data.get(blob)!));
 };
 const adapter=new Stalwart({STALWART_URL:'https://mail.test'} as Config,store,fetcher as typeof fetch);
 (adapter as any).call=async()=>[{list:[{id:'bounce',attachments:[{blobId:'status',type:'message/delivery-status',size:262},{blobId:'email',name:'attachment',type:'message/rfc822',size:1192}]}]}];
 (adapter as any).context=async()=>({access:'token',session:{downloadUrl:'https://mail.test/download/{accountId}/{blobId}/{name}'}});
 const message=await adapter.message(s,'bounce');
 assert.deepEqual(message.attachments.map(a=>[a.name,a.size]),[['Delivery failure details.txt',262],['Returned email.eml',1192]]);
 for(const attachment of message.attachments){
  const download=await adapter.download(s,attachment.id);
  assert.equal(download.name,attachment.name);
  assert.deepEqual(Buffer.from(await new Response(download.body).arrayBuffer()),data.get(attachment.id));
 }
 await assert.rejects(adapter.download({...s,id:'other'},'status'),{code:'ATTACHMENT_NOT_FOUND'});
});
