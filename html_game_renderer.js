import { chromium } from "playwright";
import sharp from "sharp";
import { appendFile, readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
const WIDTH=854,HEIGHT=480,CAPTURE_WIDTH=1280,CAPTURE_HEIGHT=720,OUT=process.stdout;
const OUTPUT_FPS=30, OVERLAY_FPS=5, DUPLICATE_FRAMES=OUTPUT_FPS/OVERLAY_FPS;
const QUEUE="word_messages.jsonl";
const GAME_COMMAND="game_command.txt";
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
async function applyGameCommand(){
 try{
  if(!existsSync(GAME_COMMAND))return;
  const command=(await readFile(GAME_COMMAND,"utf8")).trim().toLowerCase();
  await import("node:fs/promises").then(m=>m.unlink(GAME_COMMAND).catch(()=>{}));
  if(command==="off"||command==="anagram"){
   const result=await page.evaluate(enabled=>window.setGameVisible(enabled),command==="anagram");
   console.error("GAME_MODE "+(result?.enabled?"ANAGRAM":"OFF"));
  }
 }catch(err){console.error("Game command error",err.message)}
}
async function main(){
 browser=await chromium.launch({headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]});
 page=await browser.newPage({viewport:{width:CAPTURE_WIDTH,height:CAPTURE_HEIGHT},deviceScaleFactor:1});
 await page.goto("file://"+process.cwd()+"/overlay/anagram-game.html");
 console.error("HTML ANAGRAM RENDERER READY");
 let nextCapture=Date.now();
 while(true){
  await consume();
  await applyGameCommand();
  // Capture on a fixed 200ms cadence (5 overlay FPS). Repeat each image
  // six times to feed the 30 FPS compositor without bursty frame batches.
  const png=await page.screenshot({type:"png",omitBackground:true});
  const raw=await sharp(png).resize(WIDTH,HEIGHT).ensureAlpha().raw().toBuffer();
  for(let i=0;i<DUPLICATE_FRAMES;i++){
   if(!OUT.write(raw))await new Promise(resolve=>OUT.once("drain",resolve));
  }
  nextCapture+=1000/OVERLAY_FPS;
  const delay=Math.max(0,nextCapture-Date.now());
  if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
  else nextCapture=Date.now();
 }
}
main().catch(e=>{console.error("HTML GAME RENDERER ERROR",e);process.exit(1)});
process.on("SIGTERM",async()=>{await browser?.close();process.exit(0)});
