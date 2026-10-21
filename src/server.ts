import {configFrom} from './config.js';
import {Store} from './store.js';
import {Stalwart} from './stalwart.js';
import {buildApp} from './app.js';
const config=configFrom(process.env),store=new Store(config),app=buildApp(config,store,new Stalwart(config,store));
const timer=setInterval(()=>store.prune(),15*60000);timer.unref();
async function stop(){clearInterval(timer);await app.close();store.close();}
process.once('SIGINT',()=>{void stop().then(()=>process.exit(0));});
process.once('SIGTERM',()=>{void stop().then(()=>process.exit(0));});
await app.listen({host:config.HOST,port:config.PORT});
