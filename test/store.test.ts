import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
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
    } finally { await rawClient.close(); }

    await store.close();
    store = await Store.connect(config);
    const restored = await store.get(session.id);
    assert.equal(restored?.email, 'a@example.test');
    assert.equal(restored?.token.refresh_token, 'sensitive-refresh-token');
    assert.equal(await store.checkCsrf(session.id, session.csrf), true);
    const rotated = await store.rotateCsrf(session.id);
    assert.equal(await store.checkCsrf(session.id, session.csrf), false);
    assert.equal(await store.checkCsrf(session.id, rotated), true);

    const upload = await store.addUpload(session.id, 'stalwart-blob', 'file.txt', 'text/plain', 10);
    assert.equal((await store.getUpload(session.id, upload.id))?.blobId, 'stalwart-blob');
    assert.equal(await store.getUpload('other-session', upload.id), undefined);

    const results = await Promise.all(Array.from({ length: 8 }, () => store!.reserveSend(session.id, 'payload-hash')));
    assert.equal(results.filter(Boolean).length, 1);
    await store.acceptSend(session.id, 'payload-hash', 'submission-1');
    assert.equal(await store.reserveSend(session.id, 'payload-hash'), false);
    await store.delete(session.id);
    assert.equal(await store.get(session.id), undefined);
    assert.equal(await store.getUpload(session.id, upload.id), undefined);
  } finally {
    await store?.close();
    await mongo.stop();
  }
});
