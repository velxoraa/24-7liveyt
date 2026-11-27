import { chromium } from "playwright";
import sharp from "sharp";
import { appendFile, readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
const WIDTH=1280,HEIGHT=720,OUT=process.stdout;
const STREAM_WIDTH=854,STREAM_HEIGHT=480;
const OUTPUT_FPS=20, OVERLAY_FPS=5, DUPLICATE_FRAMES=OUTPUT_FPS/OVERLAY_FPS;
const QUEUE="word_messages.jsonl";
let browser,page,queueBusy=false;
async function consume(){
 if(queueBusy||!existsSync(QUEUE))return;queueBusy=true;
 try{
  const tmp=QUEUE+".processing";await rename(QUEUE,tmp).catch(()=>{});
  let lines=[];try{lines=(await readFile(tmp,"utf8")).split(/\r?\n/).filter(Boolean)}catch{}
  for(const line of lines){try{const e=JSON.parse(line);const r=await page.evaluate(({id,name,word})=>window.submitChatWord(id,name,word),e);if(r?.ok)console.error("WORD_ACCEPTED "+e.name+" "+r.word+" +"+r.points);else if(r?.reason==="duplicate")console.error("WORD_DUPLICATE "+e.word)}catch(err){console.error("Word event error",err.message)}}
  await import("node:fs/promises").then(m=>m.unlink(tmp).catch(()=>{}));
 }finally{queueBusy=false}
}
async function main(){
 browser=await chromium.launch({headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]});
 page=await browser.newPage({viewport:{width:WIDTH,height:HEIGHT},deviceScaleFactor:1});
 await page.goto("file://"+process.cwd()+"/overlay/anagram-game.html");
 console.error("HTML ANAGRAM RENDERER READY");
 let nextCapture=Date.now();
 while(true){
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
