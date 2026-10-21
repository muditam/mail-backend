import {config as loadEnv} from 'dotenv';
import {fileURLToPath} from 'node:url';
import {configFrom} from './config.js';
import {Store} from './store.js';
import {Stalwart} from './stalwart.js';
import {buildApp} from './app.js';
loadEnv({path:fileURLToPath(new URL('../.env',import.meta.url)),quiet:true});
const config=configFrom(process.env),store=await Store.connect(config),app=buildApp(config,store,new Stalwart(config,store));
const timer=setInterval(()=>{void store.prune().catch(error=>app.log.error({error},'MongoDB prune failed'));},15*60000);timer.unref();
async function stop(){clearInterval(timer);await app.close();await store.close();}
process.once('SIGINT',()=>{void stop().then(()=>process.exit(0));});
process.once('SIGTERM',()=>{void stop().then(()=>process.exit(0));});
await app.listen({host:config.HOST,port:config.PORT});
