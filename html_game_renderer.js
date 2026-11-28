import { chromium } from "playwright";
import sharp from "sharp";
import { appendFile, readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
const WIDTH=1280,HEIGHT=720,OUT=process.stdout;
const STREAM_WIDTH=854,STREAM_HEIGHT=480;
const OUTPUT_FPS=20, OVERLAY_FPS=5, DUPLICATE_FRAMES=OUTPUT_FPS/OVERLAY_FPS;
const QUEUE="word_messages.jsonl";
const GAME_COMMAND="game_command.txt";
let browser,page,queueBusy=false,scoreSyncQueue=Promise.resolve();
const ANAGRAM_API_URL=process.env.ANAGRAM_API_URL||"";
const INGEST_TOKEN=process.env.INGEST_TOKEN||"";
let scoreApiWarningShown=false;
async function postAnagramScore(event, result){
 if(!ANAGRAM_API_URL||!INGEST_TOKEN){if(!scoreApiWarningShown){console.error("ANAGRAM SCORE SYNC DISABLED: set ANAGRAM_API_URL and GitHub secret INGEST_TOKEN.");scoreApiWarningShown=true;}return;}
 const score={author_id:event.id,author:String(event.name||event.id).slice(0,80),points:result.total_points,ms:result.ms,word:result.word,event_id:`round${result.round}-${event.id}-${result.word}`};
 const payload={mode:"set",scores:[score]};
 for(let attempt=1;attempt<=3;attempt++){
  try{
   const response=await fetch(ANAGRAM_API_URL,{method:"POST",headers:{"Authorization":`Bearer ${INGEST_TOKEN}`,"Content-Type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)});
   if(!response.ok){const detail=(await response.text()).slice(0,300);throw new Error(`HTTP ${response.status}: ${detail}`);}
   console.error(`ANAGRAM SCORE SYNCED ${score.author} ${score.word} total=${score.points}`);return;
  }catch(error){if(attempt===3){console.error("ANAGRAM SCORE SYNC FAILED",score.event_id,error.message);return;}await new Promise(resolve=>setTimeout(resolve,attempt*1000));}
 }
}
async function consume(){
 if(queueBusy||!existsSync(QUEUE))return;queueBusy=true;
 try{
  const tmp=QUEUE+".processing";await rename(QUEUE,tmp).catch(()=>{});
  let lines=[];try{lines=(await readFile(tmp,"utf8")).split(/\r?\n/).filter(Boolean)}catch{}
  for(const line of lines){try{const e=JSON.parse(line);const r=await page.evaluate(({id,name,word})=>window.submitChatWord(id,name,word),e);if(r?.ok){console.error("WORD_ACCEPTED "+e.name+" "+r.word+" +"+r.points);scoreSyncQueue=scoreSyncQueue.then(()=>postAnagramScore(e,r)).catch(err=>console.error("Score sync queue error",err.message));}else if(r?.reason==="duplicate")console.error("WORD_DUPLICATE "+e.word)}catch(err){console.error("Word event error",err.message)}}
  await import("node:fs/promises").then(m=>m.unlink(tmp).catch(()=>{}));
 }finally{queueBusy=false}
}
async function consumeGameCommand(){
 if(!existsSync(GAME_COMMAND))return;
 const tmp=GAME_COMMAND+".processing";
 await rename(GAME_COMMAND,tmp).catch(()=>{});
 let command="";
 try{command=(await readFile(tmp,"utf8")).trim().toLowerCase()}catch{}
 await import("node:fs/promises").then(m=>m.unlink(tmp).catch(()=>{}));
 if(command==="off"||command==="anagram"){
  const enabled=command==="anagram";
  const result=await page.evaluate(value=>window.setGameVisible(value),enabled);
  console.error("GAME_VISIBILITY "+(enabled?"ON":"OFF")+" "+JSON.stringify(result));
 }
}
async function main(){
 browser=await chromium.launch({headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]});
 page=await browser.newPage({viewport:{width:WIDTH,height:HEIGHT},deviceScaleFactor:1});
 await page.goto("file://"+process.cwd()+"/overlay/anagram-game.html");
 console.error("HTML ANAGRAM RENDERER READY");
 let nextCapture=Date.now();
 while(true){
  await consumeGameCommand();
  await consume();
  // Capture on a fixed 200ms cadence (5 overlay FPS). Repeat each image
  // six times to feed the 30 FPS compositor without bursty frame batches.
  const png=await page.screenshot({type:"png",omitBackground:true});
  const raw=await sharp(png).resize(STREAM_WIDTH,STREAM_HEIGHT,{fit:"fill"}).ensureAlpha().raw().toBuffer();
  for(let i=0;i<DUPLICATE_FRAMES;i++){
   if(!OUT.write(raw))await new Promise(resolve=>OUT.once("drain",resolve));
  }
  nextCapture+=1000/OVERLAY_FPS;
  const delay=Math.max(0,nextCapture-Date.now());
  if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
  else nextCapture=Date.now();
 }
}
main().catch(e=>{if(e?.code!=="EPIPE")console.error("HTML GAME RENDERER ERROR",e);process.exit(e?.code==="EPIPE"?0:1)});
OUT.on("error",e=>{if(e?.code==="EPIPE")process.exit(0);console.error("Renderer output error",e);process.exit(1)});
process.on("SIGTERM",async()=>{await browser?.close();process.exit(0)});
