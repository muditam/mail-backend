import 'dotenv/config';
import {configFrom} from '../src/config.js';
import {Store} from '../src/store.js';
const [email,accountId]=process.argv.slice(2);
if(!email||!/^\S+@\S+\.\S+$/.test(email)||!accountId||accountId.length>255){console.error('Usage: npm run onboard -- employee@example.com STALWART_JMAP_ACCOUNT_ID');process.exit(1);}
const store=await Store.connect(configFrom(process.env));
try{await store.onboarding.mark(accountId,email);await store.revokeAccount(accountId);console.log('Password setup required. Existing webmail sessions revoked. No Stalwart password changed.');}finally{await store.close();}
