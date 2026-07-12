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

const PROGRAMS_URL="https://boatraceopenapi.github.io/programs/v2/today.json";
const PREVIEWS_URL="https://boatraceopenapi.github.io/previews/v2/today.json";
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
};

function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function boatsToArray(boats){ return Array.isArray(boats)?boats:Object.values(boats||{}); }
function unwrapToday(json,key){ return (json.today&&json.today[key])||json[key]||[]; }
function hhmmToMin(s){ const m=/(\d{1,2}):(\d{2})/.exec(s||''); return m?(+m[1]*60+ +m[2]):null; }

async function fetchJson(url){ const r=await fetch(url); return r.json(); }

async function fetchTide(sid,date,closedAt){
  const hb=TIDE_HARBOR[sid]; if(!hb) return null;
  const [y,mo,d]=date.split('-').map(Number);
  const url=`${TIDE_BASE}?pc=${hb.pc}&hc=${hb.hc}&yr=${y}&mn=${mo}&dy=${d}&rg=day`;
  try{
    const j=await fetchJson(url);
    const day=j.tide&&j.tide.chart&&j.tide.chart[date];
    const arr=day&&day.tide; if(!arr||!arr.length) return null;
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
  const [pgRaw,pvRaw]=await Promise.all([
    fetchJson(PROGRAMS_URL),
    fetchJson(PREVIEWS_URL).catch(()=>({previews:[]}))
  ]);
  const PROGRAMS=unwrapToday(pgRaw,'programs');
  const PREVIEWS=unwrapToday(pvRaw,'previews');
  if(!PROGRAMS.length){ console.log('出走表が見つからんかった。終了。'); return; }

  const date=PROGRAMS[0].race_date;
  const yr=date.slice(0,4), ymd=date.replace(/-/g,'');
  const resultsUrl=`https://boatraceopenapi.github.io/results/v3/${yr}/${ymd}.json`;
  let rs;
  try{ rs=await fetchJson(resultsUrl); }catch(e){ console.log('結果APIまだ無いみたい、終了。'); return; }
  const results = rs.results || (rs.today && rs.today.results) || [];

  const pvI={}; PREVIEWS.forEach(p=>pvI[p.race_stadium_number+'_'+p.race_number]=p);
  const rsI={}; results.forEach(r=>rsI[r.stadium_number+'_'+r.number]=r);

  const out=[];
  let aT=0,aH=0,aI=0,aR=0;
  const statBySt={};

  for(const p of PROGRAMS){
    const sid=p.race_stadium_number, rno=p.race_number;
    if(!TIDE_HARBOR[sid]) continue;
    const rr=rsI[sid+'_'+rno]; if(!rr||!rr.boats) continue;
    const pl={}; rr.boats.forEach(b=>{ if(b.racer_place_number) pl[b.racer_place_number]=b.racer_boat_number; });
    if(!pl[1]||!pl[2]||!pl[3]) continue;

    const prev=pvI[sid+'_'+rno];
    const pvBoats=prev?boatsToArray(prev.boats):[];
    const pvByNo={}; pvBoats.forEach(b=>pvByNo[b.racer_boat_number]=b);
    const hasPreview=!!prev && pvBoats.some(b=>b.racer_exhibition_time);

    const boats=boatsToArray(p.boats).map(b=>{
      const pv=pvByNo[b.racer_boat_number]||{};
      return {
        no:b.racer_boat_number, name:b.racer_name,
        cls:CLASS_NUM[b.racer_class_number]||'B1', ki:b.racer_branch_number,
        local2:b.racer_local_top_2_percent||0, national2:b.racer_national_top_2_percent||0,
        motor2:b.racer_assigned_motor_top_2_percent||0, flying:b.racer_flying_count||0,
        avgST:b.racer_average_start_timing,
        course:(hasPreview&&pv.racer_course_number)||b.racer_boat_number,
        exTime:(pv.racer_exhibition_time&&pv.racer_exhibition_time>0)?pv.racer_exhibition_time:null,
        st:(hasPreview&&pv.racer_start_timing!=null)?pv.racer_start_timing:null,
        tilt:pv.racer_tilt_adjustment
      };
    });

    const tide=await fetchTide(sid,date,p.race_closed_at);
    const race={sid,rno,date,hasPreview,wind:prev?prev.race_wind:p.race_wind,tide,closed:p.race_closed_at};
    const ranked=scoreBoats(boats,race);
    const pk=makePicks(ranked);
    const result=`${pl[1]}-${pl[2]}-${pl[3]}`;
    const hit=pk.combos.includes(result);
    let payoff=0;
    if(hit && rr.payouts && rr.payouts.trifecta){
      const t=rr.payouts.trifecta.find(x=>x.combination===result);
      payoff=t?t.amount:0;
    }

    aT++; aI+=600; if(hit){aH++; aR+=payoff;}
    if(!statBySt[sid]) statBySt[sid]={t:0,h:0,i:0,r:0};
    statBySt[sid].t++; statBySt[sid].i+=600; if(hit){statBySt[sid].h++; statBySt[sid].r+=payoff;}

    out.push({
      sid, stadium:SNAME[sid], rno, hasPreview, model:MODEL_VER,
      top3:[ranked[0].no,ranked[1].no,ranked[2].no], combos:pk.combos,
      tide:tide?tide.label:null, result, hit, payoff,
      snapshot:ranked.map(b=>({no:b.no,course:b.course,pct:b.pct,exTime:b.exTime,st:(b.st!=null?b.st:b.avgST),motor2:b.motor2,local2:b.local2,cls:b.cls}))
    });
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
