# -*- coding: utf-8 -*-
"""333개 토큰 배정. 고정 시드로 결정적 — 같은 시드는 항상 같은 결과."""
import json,random,hashlib,os,sys
HERE=os.path.dirname(os.path.abspath(__file__))

def need(cond,msg):
    """-O 로 실행해도 살아남는 불변식 검사. assert 는 스트립된다."""
    if not cond: raise SystemExit("INVARIANT FAILED: "+msg)
from collections import Counter
from species import SPECIES,BODY,FIXED,NEON,EYE_KO,FADE_KO

SEED=333
N_PER=9
FOIL_KO={"matte":"무광","silver":"실버","holo":"홀로그램"}
COMP_KO={"none":"없음","animal":"동물","ghost":"귀신"}
# 시각은 연속값. 00:00~05:32 중 333개의 서로 다른 분(分) — 토큰마다 배경색이 다름
# 333분(00:00~05:32)을 9개 창에 정확히 37분씩. 종마다 각 창을 하나씩 가져가
# 배경이 절대 겹치지 않는다. 장식(달·별) 없이 색만으로 밤의 흐름과 고유성을 동시에 해결.
_W=37
WNAME=["깊은 밤","깊은 밤","한밤","한밤","새벽","새벽","여명 전","여명","일출"]
# 채도를 눌러 그리드가 한 덩어리로 보이게. 넓은 램프는 오른쪽 주황이 튀어
# 컬렉션이 둘로 갈려 보였다. 진행은 남기되 아무것도 소리치지 않게.
WCOL =["0D0A2B","221740","35204C","482952","5A3253","6B3B52","7C4550","8C4F50","9C5A52"]
WINDOWS=[(i*_W,(i+1)*_W-1,WCOL[i]) for i in range(9)]
def _m(x): return x
BANDS=[(WNAME[i],a,b) for i,(a,b,_) in enumerate(WINDOWS)]

def window_of(m):
    if not (0<=m<333): raise SystemExit("INVARIANT FAILED: minute %r out of range"%m)
    return m//_W
def hhmm(m): return "%02d:%02d"%(m//60,m%60)
def band(m): return WNAME[window_of(m)]
def ground(m): return WINDOWS[window_of(m)][2]

# 포일 × 동행 교차 목표 (합 333)
# 희귀도는 한 축이다 — 마감 하나로 읽힌다.
TIERS={"color":233,"mono":67,"holo":33}
TIER_KO={"color":"색깔","mono":"흑백","holo":"홀로그램"}
APEX_MIN=3*60+33                       # 03:33 — 컬렉션 이름 333과 같은 시각
# 창립자 몫 3장은 여기서 정하지 않는다.
# 지금 정하면 만든 사람이 어떤 카드를 받을지 미리 알게 되어 무작위가 아니게 된다.
# 이 파일은 '아트 333장의 순서'만 고정하고, 토큰번호 → 아트 매핑은
# 민팅 시작 시 블록해시로 뽑은 offset 으로 온체인에서 정해진다.
#   아트 인덱스 = (tokenId + offset) mod 333
# 따라서 창립자가 예약한 토큰번호가 어떤 그림이 될지는 아무도 미리 모른다.

NEON_KEYS=list(NEON.keys())
GHOST_KINDS={"flame":7,"sheet":4,"blob":2}   # 귀신 13장의 내부 분화

def build():
    rng=random.Random(SEED)
    tiers=[k for k,n in TIERS.items() for _ in range(n)]
    need(len(tiers)==333,"tiers != 333: %d"%len(tiers))

    # 창마다 37개의 서로 다른 분
    per_window=[]
    for a,b,_ in WINDOWS:
        span=list(range(a,b+1))
        need(len(span)==N_PER*0+37,"window width != 37: %d"%len(span))
        rng.shuffle(span); per_window.append(span)
    minutes=[x for w in per_window for x in w]
    need(sorted(minutes)==list(range(333)),"minutes not a permutation")

    # 정점: 홀로 한 장에 03:33을 준다
    holo_idx=[i for i,t in enumerate(tiers) if t=="holo"]
    need(len(holo_idx)==TIERS["holo"],"holo count mismatch")
    other=[m for m in minutes if m!=APEX_MIN]; rng.shuffle(other)
    assigned=[None]*333
    assigned[holo_idx[0]]=APEX_MIN
    for i in range(333):
        if assigned[i] is None: assigned[i]=other.pop()
    need(not other,"minute pool not exhausted")
    tokens=[{"tier":tiers[i],"min":assigned[i]} for i in range(333)]

    # 종마다 9개 창을 하나씩 — 배경 중복을 구조적으로 차단
    need(len(SPECIES)*N_PER==333,"SPECIES(%d) x %d != 333"%(len(SPECIES),N_PER))
    by_w=[[i for i in range(333) if window_of(tokens[i]["min"])==w] for w in range(len(WINDOWS))]
    for w in by_w:
        need(len(w)==len(SPECIES),"window bucket != %d"%len(SPECIES))
        rng.shuffle(w)
    order=[]
    for i in range(len(SPECIES)):
        for w in range(len(WINDOWS)): order.append(by_w[w][i])
    need(len(set(order))==333,"order not a permutation")
    sid=[s[0] for s in SPECIES]
    slots={s:[] for s in sid}
    for n,ti in enumerate(order): slots[sid[n//N_PER]].append(ti)
    for s in sid:
        ws=sorted(window_of(tokens[ti]["min"]) for ti in slots[s])
        need(ws==list(range(len(WINDOWS))),"species %d window set != 0..8: %s"%(s,ws))

    out=[];tid=0
    for sp in SPECIES:
        s_id,ko,job,wear,sil,body,eye,fade=sp
        for ti in slots[s_id]:
            t=tokens[ti];tid+=1
            m=t["min"]
            out.append({"art_index":tid,"species_id":s_id,"species":ko,"job":job,"wear":wear,
                "silhouette":sil,"body_color":body,"body_hex":BODY[body],
                "eye":eye,"eye_ko":EYE_KO[eye],
                "minute":m,"time":hhmm(m),"band":band(m),"window":window_of(m),
                "ground_hex":ground(m),
                "tier":t["tier"],"tier_ko":TIER_KO[t["tier"]]})
    apex=[r for r in out if r["tier"]=="holo" and r["minute"]==APEX_MIN]
    need(len(apex)==1,"apex must be exactly 1, got %d"%len(apex))
    return out,0

tokens,dup=build()

with open(os.path.join(HERE,"tokens.json"),"w",encoding="utf-8") as f: json.dump(tokens,f,ensure_ascii=False,indent=1)
prov=hashlib.sha256(json.dumps(tokens,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
with open(os.path.join(HERE,"provenance.txt"),"w",encoding="utf-8") as f:
    f.write(f"seed={SEED}\nsha256={prov}\ncount={len(tokens)}\n")
    f.write("# 이 해시는 '아트 333장의 순서'를 고정한다. 최종본이다 — 이 값을 온체인에 커밋한다.\n")
    f.write("# 토큰번호 -> 아트 매핑은 판매 종료 후 미리 예약한 미래 블록의 해시로 온체인에서 정해진다:\n")
    f.write("#   artIndex = (tokenId + offset) mod 333\n")

print(f"토큰 {len(tokens)}개 · 종 내부 중복 {dup}건")
print("티어  :",dict(Counter(t['tier_ko'] for t in tokens)))
print("창립자: 사전 배정 없음 — 배포 시 offset 으로 결정")
print("시간대:",dict(Counter(t['band'] for t in tokens)))
print("고유 시각:",len({t['time'] for t in tokens}),"/ 고유 배경색:",len({t['ground_hex'] for t in tokens}))
print("눈    :",dict(Counter(t['eye_ko'] for t in tokens)))


per=Counter(t['species'] for t in tokens)
print("종당 장수:",set(per.values()))
ap=[t for t in tokens if t['tier']=='holo' and t['minute']==APEX_MIN]
print(f"\n정점 {len(ap)}장 → #{ap[0]['art_index']} {ap[0]['species']}({ap[0]['job']}) "
      f"· {ap[0]['time']} · {ap[0]['tier_ko']}")

print("provenance sha256:",prov[:32],"…")
