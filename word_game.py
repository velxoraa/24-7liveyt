"""Words-on-Stream inspired anagram game rendered into the live video."""
from __future__ import annotations
import json, os, random, time
from collections import Counter
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

VOTES_FILE = Path("word_votes.jsonl")
ROUND_SECONDS = 55
GOAL = 60
PUZZLES = [
 ("PLANETS", ["PLANETS","PLANET","PLANTS","STAPLE","PLATE","PLANE","PANEL","PETAL","SLANT","SLATE","STEAL","STALE","LEAST","TALES","TAPES","PASTE","LEAPS","PEALS","PALES","SEPAL","PANTS","PLANS","PATES","SEAT","EAST","EATS","TEAS","TAPE","PAST","LATE","TALE","Pale","PLAN","PANT","LENT","SENT","NEST","NEAT","EARN","NEAR","ANTS","SNAP","SPAT","STEP","PEAS","SALE","SEAL","LASE"]),
 ("ORANGES", ["ORANGES","ORANGE","RANGES","ANGER","RANGE","GROAN","ORGAN","SNORE","AROSE","GEARS","SAGER","GOERS","AGERS","SOAR","ROSE","EARS","ERAS","SAGE","RAGE","GEAR","EARN","NEAR","ONES","NOSE","SORE","SONG","GONE","GOES","AGES","EONS","RANG","RANG","GORE","EGO","ORE","RAN","NOR","SEA","AGE"]),
 ("TEACHER", ["TEACHER","CHEATER","HECTARE","TEACH","CHEAT","REACH","HEART","EARTH","THERE","THREE","CHEER","TRACE","REACT","CATER","CRATE","CARET","RACE","CARE","EACH","HEAR","HERE","TREE","RATE","TEAR","ACHE","CHAT","HEAT","HATE","EACH","EAT","TEA","THE","HER","ART","CAR","CAT"]),
 ("PAINTER", ["PAINTER","REPAINT","PERTAIN","PAINT","TRAIN","RETAIN","RETINA","PARENT","PIRATE","INERT","INTER","TAPER","PRATE","RIPEN","PAIRE","TIRE","TIER","RIPE","PINE","PANE","PAIR","PAIN","RAIN","RANT","RATE","TEAR","NEAR","EARN","TAPE","PART","TRAP","TARP","PANT","PINT","PATE","TAN","RAN","TAR","RAT"]),
 ("MONSTER", ["MONSTER","MENTORS","SERMON","MENTOR","TENORS","TONERS","TENOR","STONE","STORE","TONES","NOTES","ONSET","TERMS","METRO","MORE","MOST","NEST","SENT","TORN","ROSE","SOME","SORT","TONE","NOTE","REST","STEM","TERM","ONES","NORM","MORN","NOSE","NORE","TORE","ORES","ROTS","SORE","NETS","METS","MEN","ONE","TEN"]),
 ("CAUTION", ["CAUTION","AUCTION","ACTION","NATION","TONIC","COUNT","CANTO","TUNIC","COAT","COTAN","AUNT","UNIT","TUNA","CANT","ICON","INTO","ANTI","UNTO","COIN","CUTE","CUT","CAT","CAN","ACT","NOT","TON","NUT","OUT","OAT","TAN","TIN","ION","CON","ANT"]),
 ("FOLDERS", ["FOLDERS","FOLDER","OLDER","LOSER","ROLES","FOLDS","DOERS","REDOS","SORED","SOREL","FROSE","FROLS","FOLD","ROLE","ROSE","DOES","DOER","SOLD","LORD","ORES","RODS","DOSE","LORE","RODE","REDO","FORD","FOES","LODE","SLED","SELF","FLED","FLOE","SOLE","SORE","FORS","OLD","LED","RED","ORE"]),
 ("STATION", ["STATION","NATION","STAIN","SATIN","TOAST","TITAN","TAINT","STINT","SAINT","TINTS","ANTS","INTO","IONS","TANS","TOTS","STAT","TINS","SNOT","SITS","SNIT","TINS","TINT","SIT","SAT","TAN","TIN","ION","NOT","ANT","OAT","ITS","SON","TON","SIN"])
]

def can_make(word: str, letters: str) -> bool:
    return not (Counter(word.upper()) - Counter(letters))

class WordGame:
    def __init__(self):
        self.started = time.monotonic()
        self.round_index = -1
        self.found = {}
        self.scores = {}
        self.names = {}
        self.seen_players = set()
        self.events = []
        self.total_found = 0
        self.last_notice = ""
        self.notice_until = 0.0
        self.puzzle_order = list(range(len(PUZZLES)))
        random.shuffle(self.puzzle_order)

    def current(self):
        elapsed = max(0, time.monotonic() - self.started)
        return int(elapsed // ROUND_SECONDS), int(elapsed % ROUND_SECONDS)

    def puzzle(self, round_no):
        idx = self.puzzle_order[round_no % len(self.puzzle_order)]
        letters, words = PUZZLES[idx]
        return letters, [word.upper() for word in words if can_make(word, letters)]

    def consume(self):
        if not VOTES_FILE.exists():
            return
        processing = VOTES_FILE.with_suffix(".processing")
        try:
            os.replace(VOTES_FILE, processing)
            lines = processing.read_text(encoding="utf-8").splitlines()
            processing.unlink(missing_ok=True)
        except OSError:
            return
        round_no, _ = self.current()
        letters, answers = self.puzzle(round_no)
        accepted = self.found.setdefault(round_no, set())
        for line in lines:
            try:
                event = json.loads(line)
                uid = str(event.get("id", "")).strip()
                name = str(event.get("name", "Viewer"))[:20]
                word = str(event.get("word", "")).strip().upper()
            except Exception:
                continue
            if not uid or not word or len(word) < 3 or len(word) > 7:
                continue
            if not can_make(word, letters) or word not in answers:
                self.notice(f"NOT ON THIS BOARD: {word}")
                continue
            if word in accepted:
                self.notice(f"{word} ALREADY FOUND")
                continue
            accepted.add(word)
            self.total_found += 1
            points = len(word) * 10
            if len(word) == 7:
                points += 50
            self.scores[uid] = self.scores.get(uid, 0) + points
            self.names[uid] = name
            self.notice(f"{name.upper()} FOUND {word}  +{points} PTS")
        if self.total_found >= GOAL:
            self.total_found = 0
            self.scores = {}
            self.names = {}
            self.found.clear()
            self.started = time.monotonic()
            self.puzzle_order = list(range(len(PUZZLES)))
            random.shuffle(self.puzzle_order)
            self.notice("60 WORD GOAL CLEARED! NEW GAME!")

    def notice(self, message):
        self.last_notice = message[:54]
        self.notice_until = time.monotonic() + 4.0

    def render(self, raw, width, height):
        self.consume()
        round_no, sec = self.current()
        letters, answers = self.puzzle(round_no)
        found = self.found.setdefault(round_no, set())
        image = Image.frombytes("RGB", (width, height), raw).convert("RGBA")
        layer = Image.new("RGBA", image.size, (0,0,0,0))
        d = ImageDraw.Draw(layer)
        try:
            regular = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 17)
            bold = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 22)
            big = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 39)
            small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 13)
        except OSError:
            regular = bold = big = small = ImageFont.load_default()
        purple=(65,18,120,238); deep=(35,8,72,245); lilac=(197,145,255,255)
        cyan=(20,244,226,255); white=(250,242,255,255); muted=(211,190,235,255)
        gold=(255,210,76,255)
        # Main arcade cabinet
        x,y,w,h=35,28,1210,664
        d.rounded_rectangle((x,y,x+w,y+h),radius=30,fill=purple,outline=lilac,width=5)
        d.rounded_rectangle((x+13,y+13,x+w-13,y+h-13),radius=23,outline=(239,190,255,190),width=2)
        d.rounded_rectangle((x+365,y+22,x+845,y+112),radius=20,fill=deep,outline=lilac,width=3)
        d.text((x+405,y+42),"BE THE FIRST TO FIND",font=bold,fill=white)
        d.text((x+475,y+72),"AN ANAGRAM!",font=bold,fill=white)
        # Goal / level HUD
        d.rounded_rectangle((x+930,y+24,x+1180,y+112),radius=18,fill=deep,outline=lilac,width=3)
        d.text((x+954,y+35),f"GOAL  {self.total_found:02d}/{GOAL}",font=bold,fill=cyan)
        level=1+(self.total_found//15)
        d.text((x+1080,y+77),f"LEVEL {level}",font=small,fill=gold)
        d.text((x+55,y+48),"WORDS",font=big,fill=white)
        d.text((x+62,y+91),"ON STREAM",font=small,fill=cyan)
        # Letter rack
        rack_x,rack_y=x+195,y+135
        d.rounded_rectangle((rack_x,rack_y,rack_x+820,rack_y+112),radius=25,fill=(197,145,255,255),outline=white,width=3)
        shuffled=list(letters); random.Random(round_no).shuffle(shuffled)
        for i,ch in enumerate(shuffled):
            tx=rack_x+18+i*112
            d.rounded_rectangle((tx,rack_y+10,tx+94,rack_y+101),radius=13,fill=(248,228,255,255),outline=(65,18,120,255),width=4)
            d.rounded_rectangle((tx+6,rack_y+16,tx+88,rack_y+95),radius=10,outline=(130,75,180,255),width=2)
            d.text((tx+27,rack_y+22),ch,font=big,fill=(47,12,85,255))
        # Timer rail
        bx,by=x+145,y+270; bw=920
        d.rounded_rectangle((bx,by,bx+bw,by+16),radius=8,fill=deep,outline=lilac,width=2)
        remaining=max(0,ROUND_SECONDS-sec)
        d.rounded_rectangle((bx,by,bx+int(bw*remaining/ROUND_SECONDS),by+16),radius=8,fill=cyan)
        d.text((bx,by+23),f"ROUND {round_no+1}     {remaining:02d}s LEFT     TYPE  !WORLD YOURWORD",font=small,fill=white)
        # Found word slots grouped by length, up to 4 rows
        groups={n:sorted(wd for wd in found if len(wd)==n) for n in (7,6,5,4)}
        col_x=[x+35,x+440,x+845]
        row_y=y+335
        layout=[7,6,5,4]
        for i,n in enumerate(layout):
            col=i%3; row=i//3
            px=col_x[col]; py=row_y+row*118
            d.rounded_rectangle((px,py,px+360,py+98),radius=13,fill=(91,31,158,230),outline=(150,85,220,255),width=2)
            d.text((px+15,py+10),f"{n}-LETTER WORDS",font=small,fill=muted)
            words=groups[n][:3]
            if words:
                d.text((px+15,py+43),"  •  ".join(words[:3]),font=bold,fill=cyan)
            else:
                slots=max(1,min(7,n))
                for j in range(slots):
                    sx=px+15+j*42
                    d.rounded_rectangle((sx,py+45,sx+34,py+82),radius=6,fill=deep,outline=lilac,width=2)
        # Leaderboard
        lbx,lby=x+845,y+465
        d.rounded_rectangle((lbx,lby,lbx+340,lby+145),radius=15,fill=deep,outline=lilac,width=2)
        d.text((lbx+17,lby+12),"TOP WORD HUNTERS",font=bold,fill=gold)
        top=sorted(self.scores.items(),key=lambda item:item[1],reverse=True)[:3]
        if not top:
            d.text((lbx+18,lby+64),"BE THE FIRST!",font=regular,fill=muted)
        for i,(uid,score) in enumerate(top):
            yy=lby+49+i*29
            d.text((lbx+18,yy),f"{i+1}. {self.names.get(uid,'Viewer')[:15]}",font=small,fill=white)
            d.text((lbx+265,yy),str(score),font=small,fill=cyan)
        # Notice strip
        if time.monotonic()<self.notice_until:
            d.rounded_rectangle((x+35,y+598,x+800,y+642),radius=12,fill=(22,10,49,245),outline=cyan,width=2)
            d.text((x+55,y+609),self.last_notice,font=bold,fill=cyan)
        d.text((x+35,y+650),"KAXMOK  •  FIND WORDS USING THE LETTERS ABOVE",font=small,fill=white)
        image.alpha_composite(layer)
        return image.convert("RGB").tobytes()
