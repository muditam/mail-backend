import {test} from 'node:test';
import assert from 'node:assert/strict';
import {outgoingBody,companyFooterText} from '../src/companyFooter.js';

test('sending adds HTML and plain-text footer, escapes user text and preserves line breaks',()=>{
 const content='Hello <script>alert("x")</script> & team\nSecond line';
 const body=outgoingBody(content);
 assert.equal(body.bodyValues.body.value,content+'\n\n-- \n'+companyFooterText);
 assert.ok(body.bodyValues.html.value.includes('&lt;script&gt;'));
 assert.ok(!body.bodyValues.html.value.includes('<script>'));
 assert.ok(body.bodyValues.html.value.includes('white-space:pre-wrap'));
 assert.ok(body.bodyValues.html.value.includes('<br>Second line'));
 assert.ok(body.bodyValues.html.value.includes('mailto:hello@muditam.com'));
 assert.ok(body.bodyValues.html.value.includes('tel:+917011683883'));
 assert.ok(body.bodyValues.html.value.includes('alt="Muditam"'));
});
test('reopening a prepared message does not append duplicate footers',()=>{
 const first=outgoingBody('Hello');
 assert.deepEqual(outgoingBody(first.bodyValues.body.value),first);
 assert.deepEqual(outgoingBody(first.bodyValues.body.value.replace(/\n/g,'\r\n')),first);
 const quoted='Reply\n> '+companyFooterText.replace(/\n/g,'\n> ');
 assert.ok(outgoingBody(quoted).bodyValues.body.value.startsWith(quoted));
 assert.ok(outgoingBody('').bodyValues.body.value.includes(companyFooterText));
});
