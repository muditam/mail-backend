import {config as loadEnv} from 'dotenv';
import {fileURLToPath} from 'node:url';
import {configFrom} from './config.js';
import {Store} from './store.js';
import {Stalwart} from './stalwart.js';
import {buildApp} from './app.js';
loadEnv({path:fileURLToPath(new URL('../.env',import.meta.url)),quiet:true});
const config=configFrom(process.env),store=await Store.connect(config),stalwart=new Stalwart(config,store),app=buildApp(config,store,stalwart);
const timer=setInterval(()=>{void store.prune().catch(error=>app.log.error({error},'MongoDB prune failed'));},15*60000);timer.unref();
let stopping=false,active:Promise<void>|undefined;
const tick=()=>{
 if(stopping||active)return;
 active=(async()=>{for(let n=0;n<10&&!stopping;n++){if(!await stalwart.retryOne())break;}})()
  .catch(()=>app.log.error('Delivery retry worker failed; uncertain submissions will not be resent.'))
  .finally(()=>{active=undefined;});
};
const retryTimer=setInterval(tick,(config.SEND_RETRY_POLL_SECONDS??30)*1000);retryTimer.unref();
async function stop(){stopping=true;clearInterval(timer);clearInterval(retryTimer);await app.close();await active;await store.close();}
process.once('SIGINT',()=>{void stop().then(()=>process.exit(0));});
process.once('SIGTERM',()=>{void stop().then(()=>process.exit(0));});
await app.listen({host:config.HOST,port:config.PORT});

tick();
