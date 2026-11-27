"""In-stream KAXMOK quiz overlay and local live leaderboard."""
from __future__ import annotations
import json, time, os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

VOTES_FILE = Path("quiz_votes.jsonl")
ROUND_SECONDS = 25
QUESTIONS = [
 ("SCIENCE","Which planet has the most confirmed moons?",["Mars","Saturn","Earth","Venus"],1),
 ("MUSIC","How many keys are on a full-size piano?",["76","80","88","92"],2),
 ("TECH","What does HTTP stand for?",["HyperText Transfer Protocol","High Transfer Text Process","Host Text Transit Program","Hyperlink Tracking Tool"],0),
 ("NATURE","Largest living mammal?",["African elephant","Blue whale","Giraffe","Orca"],1),
 ("GEOGRAPHY","Smallest country by area?",["Monaco","Malta","Vatican City","San Marino"],2),
 ("SPACE","Our Solar System is in which galaxy?",["Andromeda","Milky Way","Whirlpool","Sombrero"],1),
 ("SPORTS","Players per team on a basketball court?",["4","5","6","7"],1),
 ("FOOD","Which spice comes from a crocus flower?",["Turmeric","Cardamom","Saffron","Cinnamon"],2),
 ("HISTORY","Petra is in which modern country?",["Egypt","Jordan","Greece","Turkey"],1),
 ("MATH","Square root of 144?",["10","11","12","14"],2),
]
class QuizGame:
 def __init__(self):
  self.started=time.monotonic(); self.round_no=0; self.votes={}; self.scores={}; self.names={}; self.seen=set(); self.last_vote=0; self.scored_rounds=set()
 def current(self):
  elapsed=time.monotonic()-self.started
  return int(elapsed//ROUND_SECONDS), int(elapsed%ROUND_SECONDS)
 def consume_votes(self):
  if not VOTES_FILE.exists(): return
  processing=VOTES_FILE.with_suffix(".processing")
  try:
   os.replace(VOTES_FILE,processing)
   lines=processing.read_text(encoding="utf-8").splitlines()
   processing.unlink(missing_ok=True)
  except OSError: return
  for line in lines:
   try: ev=json.loads(line)
   except Exception: continue
   uid=str(ev.get("id","")); ans=str(ev.get("answer","")).upper(); name=str(ev.get("name","Viewer"))[:24]
   if not uid or ans not in "ABCD": continue
   r,_=self.current(); key=f"{r}:{uid}"
   if key in self.seen: continue
   self.seen.add(key); self.votes.setdefault(r,{})[uid]=ans; self.names[uid]=name
   self.last_vote=time.monotonic()
 def update_scores(self):
  r,sec=self.current()
  if sec < ROUND_SECONDS-1: return
  q=QUESTIONS[r%len(QUESTIONS)]
  for uid,ans in self.votes.get(r,{}).items():
   if ans== "ABCD"[q[3]]:
    self.scores[uid]=self.scores.get(uid,0)+100
 def render(self, raw, width, height):
  self.consume_votes()
  r,sec=self.current(); q=QUESTIONS[r%len(QUESTIONS)]
  self.update_scores()
  image=Image.frombytes("RGB",(width,height),raw).convert("RGBA")
  layer=Image.new("RGBA",image.size,(0,0,0,0)); d=ImageDraw.Draw(layer)
  try: font=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",21); bold=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",24); small=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",15)
  except OSError: font=bold=small=ImageFont.load_default()
  gold=(245,199,107,255); cyan=(125,232,255,255); white=(247,248,252,255); muted=(165,176,194,255)
  x,y=42,42; w=770; h=350
  d.rounded_rectangle((x,y,x+w,y+h),radius=24,fill=(8,12,21,220),outline=(255,255,255,35),width=2)
  d.rounded_rectangle((x,y,x+5,y+h),radius=3,fill=gold)
  d.text((x+28,y+24),"✦ KAXMOK  /  QUIZ ARENA",font=small,fill=gold)
  d.text((x+w-160,y+26),"● LIVE ROUND",font=small,fill=(104,237,165,255))
  d.text((x+28,y+62),f"ROUND {r+1:02d}  •  {q[0]}",font=small,fill=cyan)
  d.text((x+28,y+95),q[1],font=bold,fill=white)
  for i,a in enumerate(q[2]):
   ax=x+28+(i%2)*350; ay=y+155+(i//2)*66
   d.rounded_rectangle((ax,ay,ax+330,ay+52),radius=12,fill=(255,255,255,18),outline=(255,255,255,32))
   d.rounded_rectangle((ax+10,ay+10,ax+42,ay+42),radius=8,fill=(245,199,107,35))
   d.text((ax+19,ay+14),"ABCD"[i],font=small,fill=gold)
   d.text((ax+54,ay+15),a[:34],font=font,fill=white)
  barw=int((w-56)*max(0,(ROUND_SECONDS-sec)/ROUND_SECONDS))
  d.rounded_rectangle((x+28,y+h-30,x+w-28,y+h-24),radius=4,fill=(255,255,255,30))
  d.rounded_rectangle((x+28,y+h-30,x+28+barw,y+h-24),radius=4,fill=gold)
  d.text((x+28,y+h-52),f"ANSWER IN CHAT: A / B / C / D     •     {max(0,ROUND_SECONDS-sec)}s",font=small,fill=muted)
  bx,by,bw,bh=842,42,320,350
  d.rounded_rectangle((bx,by,bx+bw,by+bh),radius=24,fill=(8,12,21,220),outline=(255,255,255,35),width=2)
  d.text((bx+24,by+24),"♛  QUIZ LEADERBOARD",font=small,fill=gold)
  top=sorted(self.scores.items(),key=lambda z:z[1],reverse=True)[:6]
  if not top: d.text((bx+24,by+82),"Be the first to score!",font=font,fill=muted)
  for i,(uid,pts) in enumerate(top):
   yy=by+68+i*42
   d.rounded_rectangle((bx+16,yy,bx+bw-16,yy+34),radius=9,fill=(255,255,255,13))
   d.text((bx+27,yy+8),f"{i+1:02d}",font=small,fill=muted)
   d.text((bx+63,yy+7),self.names.get(uid,"Viewer")[:18],font=small,fill=white)
   d.text((bx+bw-75,yy+7),str(pts),font=small,fill=gold)
  d.text((bx+24,by+bh-32),"CORRECT ANSWER  +100 PTS",font=small,fill=muted)
  image.alpha_composite(layer)\n  return image.convert("RGB").tobytes()
