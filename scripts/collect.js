// ナギちゃん自動集計スクリプト（GitHub Actionsで毎日実行される）
// index.htmlのscoreBoats/makePicksロジックをNode.js用に移植したもの。
// 海水場の全レースを予想し、結果と照合してdata/フォルダにJSONで保存する。

const fs = require('fs');
const path = require('path');

const SNAME=["","桐生","戸田","江戸川","平和島","多摩川","浜名湖","蒲郡","常滑","津","三国","びわこ","住之江","尼崎","鳴門","丸亀","児島","宮島","徳山","下関","若松","芦屋","福岡","唐津","大村"];
const CLASS_NUM={1:"A1",2:"A2",3:"B1",4:"B2"};
const CLASS_PT={"A1":100,"A2":72,"B1":45,"B2":25};
const COURSE_BASE=[0,100,62,50,44,32,22];
const SONTAKU_ON=false;
const MODEL_VER='v2';

// 2026-07-14: boatraceopenapiが出走表/直前情報/結果を1本にまとめた新API(v1)に移行。旧programs/v2・previews/v2は直前情報が空になる不具合が発生したため乗り換えた。
const API_URL="https://boatraceopenapi.github.io/api/v1/today.json";
const TIDE_BASE="https://tide736.net/api/get_tide.php";

const TIDE_HARBOR={
  3:{pc:13,hc:3,name:'羽田(東京湾)'},
  4:{pc:13,hc:3,name:'羽田(東京湾)'},
  6:{pc:22,hc:18,name:'舞阪'},
  7:{pc:23,hc:9,name:'蒲郡'},
  8:{pc:23,hc:15,name:'常滑'},
  9:{pc:24,hc:2,name:'津'},
  13:{pc:28,hc:6,name:'尼崎'},
  14:{pc:36,hc:5,name:'土佐泊(鳴門)'},
  15:{pc:37,hc:10,name:'丸亀'},
  16:{pc:33,hc:7,name:'下津井(児島)'},
  17:{pc:34,hc:23,name:'厳島'},
  18:{pc:35,hc:10,name:'徳山'},
  19:{pc:35,hc:19,name:'下関'},
  20:{pc:40,hc:10,name:'若松'},
  21:{pc:40,hc:26,name:'脇田(芦屋)'},
  22:{pc:40,hc:21,name:'福岡'},
  23:{pc:41,hc:1,name:'唐津'},
  24:{pc:42,hc:50,name:'大村'},
};

function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function boatsToArray(boats){ return Array.isArray(boats)?boats:Object.values(boats||{}); }
function hhmmToMin(s){ const m=/(\d{1,2}):(\d{2})/.exec(s||''); return m?(+m[1]*60+ +m[2]):null; }

// 15秒でタイムアウトさせる(夜間にtide736が遅い時、永遠に待たないため。2026-07-13の16分停滞の教訓)
async function fetchJson(url){ const r=await fetch(url,{signal:AbortSignal.timeout(15000)}); return r.json(); }

// 潮位チャートは「場×日付」ごとに1回だけ取得してキャッシュする。
// 以前はレースごとに取得していて同じデータを12回ずつ計144回もfetchし、夜間のAPI遅延と重なって実行が16分超になった。
const tideChartCache={};
async function getTideChart(sid,date){
  const key=sid+'_'+date;
  if(key in tideChartCache) return tideChartCache[key];
  const hb=TIDE_HARBOR[sid]; if(!hb){ tideChartCache[key]=null; return null; }
  const [y,mo,d]=date.split('-').map(Number);
  const url=`${TIDE_BASE}?pc=${hb.pc}&hc=${hb.hc}&yr=${y}&mn=${mo}&dy=${d}&rg=day`;
  try{
    const j=await fetchJson(url);
    const day=j.tide&&j.tide.chart&&j.tide.chart[date];
    const arr=day&&day.tide;
    tideChartCache[key]=(arr&&arr.length)?{hb,arr}:null;
  }catch(e){ console.error('潮位取得エラー', sid, e.message); tideChartCache[key]=null; }
  return tideChartCache[key];
}

async function fetchTide(sid,date,closedAt){
  const c=await getTideChart(sid,date); if(!c) return null;
  try{
    const hb=c.hb, arr=c.arr;
    const raceMin=hhmmToMin(closedAt&&closedAt.slice(11)) ?? 12*60;
    let now=arr[0],prev=arr[0],bestN=1e9,bestP=1e9;
    arr.forEach(s=>{
      const t=hhmmToMin(s.time); if(t==null) return;
      if(Math.abs(t-raceMin)<bestN){bestN=Math.abs(t-raceMin);now=s;}
      if(Math.abs(t-(raceMin-60))<bestP){bestP=Math.abs(t-(raceMin-60));prev=s;}
    });
    const slope=(+now.cm)-(+prev.cm);
    const trend = slope>=15?'満ち(上げ)' : slope<=-15?'引き(下げ)' : '横ばい';
    return {harbor:hb.name, slope, cm:Math.round(+now.cm), trend, label:`${trend} ${Math.round(+now.cm)}cm`};
  }catch(e){ console.error('潮位取得エラー', sid, e.message); return null; }
}

function scoreBoats(boats,race){
  const kis=boats.map(b=>b.ki).filter(v=>v!==null && v!==undefined);
  const bossKi=kis.length?Math.min(...kis):null;
  const strongWind=race.wind!=null && race.wind>=5;

  boats.forEach(b=>{
    const courseScore=COURSE_BASE[b.course]||30;
    const clsScore=CLASS_PT[b.cls]??45;
    const localScore=clamp(b.local2,0,100);
    const motorScore=clamp(b.motor2,0,100);

    let exScore=50;
    if(b.exTime){ exScore=clamp((6.95-b.exTime)/(6.95-6.60)*100,0,100); }

    let stScore=50; const stVal=(b.st!=null?b.st:b.avgST);
    if(stVal!=null){ stScore=clamp((0.20-stVal)/(0.20-0.05)*100,0,100); }
    if(b.flying>0){ stScore=Math.max(0,stScore-15); }

    let sontaku=0;
    if(SONTAKU_ON && bossKi!=null && b.ki!=null){
      if(b.ki===bossKi && kis.length>1){ sontaku=12; }
      else { const gap=b.ki-bossKi; if(gap>=20){ sontaku=-8; } else if(gap>0){ sontaku=-3; } }
    }

    let weather=0;
    if(strongWind){ if(b.course<=2){ weather=-6; } else if(b.course>=4){ weather=6; } }

    let tideAdj=0;
    if(race.tide && race.tide.slope!=null){
      const mag=clamp(race.tide.slope/60,-1,1)*8;
      tideAdj = (b.course<=2) ? mag : -mag*0.8;
    }

    const raw = courseScore*0.172 + clsScore*0.141 + localScore*0.125 + motorScore*0.125
              + exScore*0.219 + stScore*0.157 + sontaku + weather + tideAdj;
    b.score=Math.max(1,raw);
  });

  const max=Math.max(...boats.map(b=>b.score));
  boats.forEach(b=> b.pct=Math.round(b.score/max*100));
  return [...boats].sort((a,b)=>b.score-a.score);
}

function perm3(firsts,seconds,thirds){
  const out=[];
  firsts.forEach(f=>seconds.forEach(s=>thirds.forEach(t=>{
    if(f!==s && s!==t && f!==t){ const k=f+'-'+s+'-'+t; if(!out.includes(k)) out.push(k); }
  })));
  return out;
}

function makePicks(ranked){
  const n=ranked.map(b=>b.no);
  const A=n[0],B=n[1],C=n[2],D=n[3];
  const gap12=ranked[0].pct-ranked[1].pct;
  const gap14=ranked[0].pct-ranked[3].pct;
  const aOut=ranked[0].course>=4;
  const combos=perm3([A,B,C],[A,B,C],[A,B,C]);
  let level,label;
  if(!aOut && gap12>=12 && gap14>=22){ level='rock'; label='🔒 堅い'; }
  else if(aOut || gap12<=4){ level='rough'; label=aOut?'🌊 アウト本命':'🌊 荒れ注意'; }
  else { level='normal'; label='⚖️ 中穴'; }
  return {level,label,combos};
}

async function main(){
  console.log('=== ナギちゃん 自動集計開始 ===');
  const raw=await fetchJson(API_URL);
  const stadiums=raw.programs&&raw.programs.stadiums;
  if(!stadiums){ console.log('出走表が見つからんかった。終了。'); return; }

  const out=[];
  let aT=0,aH=0,aI=0,aR=0;
  const statBySt={};
  let date=null;

  for(const sidStr of Object.keys(stadiums)){
    const sid=+sidStr;
    if(!TIDE_HARBOR[sid]) continue;
    const races=stadiums[sidStr].races||{};

    for(const rnoStr of Object.keys(races)){
      const rno=+rnoStr;
      const race=races[rnoStr];
      if(!date) date=race.date;

      const result=race.result;
      if(!result||!result.racers) continue;
      const pl={}; boatsToArray(result.racers).forEach(b=>{ if(b.place_number) pl[b.place_number]=b.entry_number; });
      if(!pl[1]||!pl[2]||!pl[3]) continue;

      const prev=race.preview;
      const pvBoats=prev?boatsToArray(prev.racers):[];
      const pvByNo={}; pvBoats.forEach(b=>pvByNo[b.entry_number]=b);
      const hasPreview=!!prev && pvBoats.some(b=>b.exhibition_time!=null);

      const boats=boatsToArray(race.racers).map(b=>{
        const pv=pvByNo[b.entry_number]||{};
        return {
          no:b.entry_number, name:b.name,
          cls:CLASS_NUM[b.rank_number]||'B1', ki:b.branch_number,
          local2:b.local_top_2_percent||0, national2:b.national_top_2_percent||0,
          motor2:b.motor_top_2_percent||0, flying:b.flying_count||0,
          avgST:b.average_start_timing,
          course:(hasPreview&&pv.course_number)||b.entry_number,
          exTime:(pv.exhibition_time&&pv.exhibition_time>0)?pv.exhibition_time:null,
          st:(hasPreview&&pv.start_timing!=null)?pv.start_timing:null,
          tilt:pv.tilt_adjustment
        };
      });

      const tide=await fetchTide(sid,race.date,race.closed_at);
      const raceCtx={sid,rno,date:race.date,hasPreview,wind:prev?prev.wind_speed:null,tide,closed:race.closed_at};
      const ranked=scoreBoats(boats,raceCtx);
      const pk=makePicks(ranked);
      const resultStr=`${pl[1]}-${pl[2]}-${pl[3]}`;
      const hit=pk.combos.includes(resultStr);
      let payoff=0;
      if(hit && result.payouts && result.payouts.trifecta){
        const t=result.payouts.trifecta.find(x=>x.combination===resultStr);
        payoff=t?t.amount:0;
      }

      aT++; aI+=600; if(hit){aH++; aR+=payoff;}
      if(!statBySt[sid]) statBySt[sid]={t:0,h:0,i:0,r:0};
      statBySt[sid].t++; statBySt[sid].i+=600; if(hit){statBySt[sid].h++; statBySt[sid].r+=payoff;}

      out.push({
        sid, stadium:SNAME[sid], rno, hasPreview, model:MODEL_VER,
        top3:[ranked[0].no,ranked[1].no,ranked[2].no], combos:pk.combos,
        tide:tide?tide.label:null, result:resultStr, hit, payoff,
        snapshot:ranked.map(b=>({no:b.no,course:b.course,pct:b.pct,exTime:b.exTime,st:(b.st!=null?b.st:b.avgST),motor2:b.motor2,local2:b.local2,cls:b.cls}))
      });
    }
  }

  console.log(`確定 ${aT}R  的中 ${aH}件(${aT?Math.round(aH/aT*100):0}%)  回収率 ${aI?Math.round(aR/aI*100):0}%`);
  Object.keys(statBySt).forEach(sid=>{
    const s=statBySt[sid];
    console.log(`  ${SNAME[sid]} ${s.t}R 的中${Math.round(s.h/s.t*100)}% 回収${Math.round(s.r/s.i*100)}%`);
  });

  if(!out.length){ console.log('海水場の確定レースが無かった。終了。'); return; }

  const payload={date, kind:'zenba_kaisuijo', model:MODEL_VER, note:'GitHub Actions自動集計', count:out.length, logs:out};
  const dir=path.join(__dirname,'..','data');
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,`nagi_zenba_${date}.json`);
  fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
  console.log('保存したで:', file);
}

main().catch(e=>{ console.error('エラーや:', e); process.exit(1); });
