import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Store } from '../src/store.js';
import type { Config } from '../src/config.js';

test('MongoDB keeps encrypted sessions across backend restarts and reserves sends atomically', async () => {
  const mongo = await MongoMemoryServer.create();
  const config: Config = {
    NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 3000, APP_ORIGIN: 'http://localhost:5173',
    STALWART_URL: 'https://mail.example.test', STALWART_AUTH_URL: 'https://mail.example.test/api/auth', STALWART_TOKEN_URL: 'https://mail.example.test/auth/token', STALWART_JMAP_SESSION_URL: 'https://mail.example.test/.well-known/jmap', OAUTH_CLIENT_ID: 'test',
    OAUTH_REDIRECT_URI: 'https://webmail.example.test/callback',
    SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    MONGODB_URI: mongo.getUri(), MONGODB_DB_NAME: 'webmail_test',
    SESSION_IDLE_MINUTES: 30, SESSION_ABSOLUTE_HOURS: 12,
  };
  let store: Store | undefined;
  try {
    store = await Store.connect(config);
    const session = await store.create('a@example.test', 'account-a', {
      access_token: 'sensitive-access-token', refresh_token: 'sensitive-refresh-token',
      expires_at: Date.now() + 3600000,
    });
    const rawClient = new MongoClient(config.MONGODB_URI);
    try {
      await rawClient.connect();
      const raw = await rawClient.db(config.MONGODB_DB_NAME).collection('sessions').findOne({});
      assert.ok(raw);
      assert.equal(JSON.stringify(raw).includes('sensitive-access-token'), false);
      assert.equal(JSON.stringify(raw).includes('sensitive-refresh-token'), false);
      assert.notEqual(raw._id, session.id);
      // Simulate a pre-upgrade session whose current CSRF token was random.
      const legacy = await store.create('legacy@example.test', 'legacy-account', session.token);
      const legacyToken = 'existing-tab-random-csrf';
      await rawClient.db(config.MONGODB_DB_NAME).collection('sessions').updateOne(
        { _id: createHash('sha256').update(legacy.id).digest('hex') as any },
        { $set: { csrfHash: createHash('sha256').update(legacyToken).digest('hex') } },
      );
      const stableToken = store.csrfToken(legacy.id);
      assert.equal(await store.checkCsrf(legacy.id, legacyToken), true);
      assert.equal(await store.checkCsrf(legacy.id, stableToken), true);
      assert.equal(await store.checkCsrf(legacy.id, 'incorrect'), false);
      await store.delete(legacy.id);
      assert.equal(await store.checkCsrf(legacy.id, legacyToken), false);
      assert.equal(await store.checkCsrf(legacy.id, stableToken), false);

    } finally { await rawClient.close(); }

    await store.close();
    store = await Store.connect(config);
    const restored = await store.get(session.id);
    assert.equal(restored?.email, 'a@example.test');
    assert.equal(restored?.token.refresh_token, 'sensitive-refresh-token');
    assert.equal(await store.checkCsrf(session.id, session.csrf), true);
    const restoredCsrf = store.csrfToken(session.id);
    assert.equal(restoredCsrf, session.csrf);
    assert.equal(await store.checkCsrf(session.id, restoredCsrf), true);
    assert.equal(await store.checkCsrf(session.id, 'wrong'), false);
    const diagnosticClient=new MongoClient(config.MONGODB_URI);await diagnosticClient.connect();
    try{
      const collection=diagnosticClient.db(config.MONGODB_DB_NAME).collection('sessions');
      for(const reason of ['idle_timeout','absolute_timeout']){
        const expired=await store.create('expired@example.test',reason,session.token);
        await collection.updateOne({_id:createHash('sha256').update(expired.id).digest('hex') as any},{$set:reason==='idle_timeout'?{touchedAt:Date.now()-31*60000}:{absoluteExpiresAt:Date.now()-1}});
        let detail:any;assert.equal(await store.get(expired.id,d=>detail=d),undefined);assert.equal(detail.reason,reason);
      }
      const revoked=await store.create('revoked@example.test','revoked',session.token);
      const ref=store.sessionRef(revoked.id);assert.notEqual(ref,revoked.id);assert.notEqual(ref,store.csrfToken(revoked.id));
      await store.revokeAccount('revoked');let detail:any;
      assert.equal(await store.get(revoked.id,d=>detail=d),undefined);assert.equal(detail.reason,'password_changed');assert.equal(detail.sessionRef,ref);
      const audit=await diagnosticClient.db(config.MONGODB_DB_NAME).collection('session_revocations').findOne({accountId:'revoked'});
      assert.ok(audit?.expireAt instanceof Date);assert.equal(JSON.stringify(audit).includes(revoked.id),false);assert.equal(JSON.stringify(audit).includes('sensitive-access-token'),false);
      await store.get('not-a-session',d=>detail=d);assert.equal(detail.reason,'unknown_session');
    }finally{await diagnosticClient.close()}
    const other = await store.create('b@example.test', 'account-b', session.token);
    assert.notEqual(other.csrf, session.csrf);
    assert.equal(await store.checkCsrf(other.id, session.csrf), false);

    const upload = await store.addUpload(session.id, 'stalwart-blob', 'file.txt', 'text/plain', 10);
    assert.equal((await store.getUpload(session.id, upload.id))?.blobId, 'stalwart-blob');
    assert.equal(await store.getUpload('other-session', upload.id), undefined);

    const results = await Promise.all(Array.from({ length: 8 }, () => store!.reserveSend(session.id, 'payload-hash')));
    assert.equal(results.filter(Boolean).length, 1);
    await store.acceptSend(session.id, 'payload-hash', 'submission-1');
    assert.equal(await store.reserveSend(session.id, 'payload-hash'), false);
    await store.delete(session.id);
    let logoutDetail:any;assert.equal(await store.get(session.id,d=>logoutDetail=d), undefined);assert.equal(logoutDetail.reason,'logout');
    assert.equal(await store.getUpload(session.id, upload.id), undefined);
  } finally {
    await store?.close();
    await mongo.stop();
  }
});
