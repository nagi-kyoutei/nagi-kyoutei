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
// 2026-07-21: v2.5を試験導入。1690R(6/27-7/21)でco/ex/stの配分見直し+チルト調整量を新規追加した配分を
// TRAIN/TESTを両方向入れ替えて検証(A→B・B→Aどちらもv2実績を大きく上回り一貫性を確認、回収率69.4%→92.5%)。
// 全国率・ボート率・フライング回数・体重等も試したが片方向でしか効かず過学習と判断し不採用。
// v1/v2との比較は継続する(データが貯まるごとに再検証)ため、MODEL_VERで記録を分けておく。
//
// 2026-07-29: v2.6を試験導入。3480R(6/27-7/28)で以下2点を両方向検証:
// ①展示タイムを固定基準(6.60〜6.95秒)でなく「そのレース内での相対順位」に変更→A/B両方向で改善。
// ②その上でチルトの重みを60%→10%に下げると、さらに両方向で改善(相対展示と情報が重複していたため)。
// 「展示順位-モーター順位」等の追加案は計算ミスで一時的に有望に見えたが、修正後は効果なしと判明し不採用。
// 全期間確定: v2.5(回収77.8%) → v2.6(回収88.4%、的中率は21.6%→17.6%に低下=回収率とのトレードオフ)。
const MODEL_VER='v2.6';

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
function sleep(ms){ return new Promise(res=>setTimeout(res,ms)); }

// 2026-07-20: tide736.netが日単位でまるごと無応答/失敗になる現象(7/14,17,18,19)への対策でリトライを追加。
// 1回失敗しても即諦めず、3秒待って最大2回リトライする(Mac側カニの調査依頼)。
async function fetchJsonWithRetry(url, retries=2, delayMs=3000){
  let lastErr;
  for(let i=0;i<=retries;i++){
    try{ return await fetchJson(url); }
    catch(e){ lastErr=e; if(i<retries){ await sleep(delayMs); } }
  }
  throw lastErr;
}

// 潮位チャートは「場×日付」ごとに1回だけ取得してキャッシュする。
// 以前はレースごとに取得していて同じデータを12回ずつ計144回もfetchし、夜間のAPI遅延と重なって実行が16分超になった。
const tideChartCache={};
// 2026-07-20: リトライしても失敗した「場×日付」を記録する。淡水場(TIDE_HARBOR未登録)の「もともと潮なし」と、
// 海水場なのに取得失敗した「本当の障害」を区別できるようにする(Mac側カニの調査依頼)。
const tideFailedKeys=new Set();
async function getTideChart(sid,date){
  const key=sid+'_'+date;
  if(key in tideChartCache) return tideChartCache[key];
  const hb=TIDE_HARBOR[sid]; if(!hb){ tideChartCache[key]=null; return null; }
  const [y,mo,d]=date.split('-').map(Number);
  const url=`${TIDE_BASE}?pc=${hb.pc}&hc=${hb.hc}&yr=${y}&mn=${mo}&dy=${d}&rg=day`;
  try{
    const j=await fetchJsonWithRetry(url);
    const day=j.tide&&j.tide.chart&&j.tide.chart[date];
    const arr=day&&day.tide;
    if(arr&&arr.length){ tideChartCache[key]={hb,arr}; }
    else { tideChartCache[key]=null; tideFailedKeys.add(key); console.error('潮位取得失敗(データ空)', sid, date); }
  }catch(e){
    console.error('潮位取得エラー(リトライ後も失敗)', sid, date, e.message);
    tideChartCache[key]=null; tideFailedKeys.add(key);
  }
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

  // v2.6で新規追加。展示タイムを固定基準(6.60〜6.95秒)でなく「そのレース内での相対順位」で評価する。
  // 日や水面ごとにタイムの出方が違うため、固定基準より相対順位の方がA/B両方向の検証で一貫して回収率が改善した。
  const validEx=boats.map(b=>b.exTime).filter(t=>t!=null && t>0).sort((a,b)=>a-b);

  boats.forEach(b=>{
    const courseScore=COURSE_BASE[b.course]||30;
    const clsScore=CLASS_PT[b.cls]??45;
    const localScore=clamp(b.local2,0,100);
    const motorScore=clamp(b.motor2,0,100);

    let exScore=50;
    if(validEx.length>=4 && b.exTime){
      const rank=validEx.indexOf(b.exTime)+1; // 1=そのレースで最速
      exScore=clamp((6-rank)/5*100,0,100);
    } else if(b.exTime){
      exScore=clamp((6.95-b.exTime)/(6.95-6.60)*100,0,100);
    }

    let stScore=50; const stVal=(b.st!=null?b.st:b.avgST);
    if(stVal!=null){ stScore=clamp((0.20-stVal)/(0.20-0.05)*100,0,100); }
    if(b.flying>0){ stScore=Math.max(0,stScore-15); }

    // v2.5で新規追加、v2.6で重みを60%→10%に縮小。相対展示順位と情報が重複するため、
    // 重み60%のまま組み合わせるとA/B両方向で悪化することが判明した(2026-07-29検証)。
    const tiltScore=clamp(50+(b.tilt||0)*20,0,100);

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

    // v2.6配分(2026-07-29試験導入): コース34%・級別14%・当地15%・モーター15%・展示38%(相対順位)・ST6%・チルト10%。
    // 3480Rの実データで両方向検証済み(v2.5=回収77.8% → v2.6=回収88.4%、的中率は21.6%→17.6%に低下)。
    const raw = courseScore*0.34 + clsScore*0.14 + localScore*0.15 + motorScore*0.15
              + exScore*0.38 + stScore*0.06 + tiltScore*0.10 + sontaku + weather + tideAdj;
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
    // 2026-07-16: 海水場18場限定をやめ、淡水6場も含めた全24場を対象に変更(田中の希望)。
    // 淡水場はTIDE_HARBORに登録が無いのでfetchTideが自動でnullを返し、潮補正は従来通りかからない。
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

      // 2026-08-18 修正: 以前は course:(hasPreview&&pv.course_number)||b.entry_number という
      // レース単位のhasPreviewフラグでガードしていたが、これだと「レース全体は直前情報あり」でも
      // 「特定の1艇だけ欠場等でcourse_numberが無い」場合にその艇だけentry_numberへフォールバックし、
      // 別の艇の本物のcourse_numberと衝突してcourseが重複するバグがあった(実例: 2026-06-27 津6R、
      // 3号艇が欠場でcourse_number=undefined→entry_number=3にフォールバックした結果、本来course=3だった
      // 4号艇と衝突)。艇ごとに「その艇自身のcourse_numberが有効かどうか」で判定するよう修正。
      const boats=boatsToArray(race.racers).map(b=>{
        const pv=pvByNo[b.entry_number]||{};
        const validCourse = (pv.course_number!=null && pv.course_number>=1 && pv.course_number<=6);
        return {
          no:b.entry_number, name:b.name,
          regNo:b.number, // 選手登録番号
          cls:CLASS_NUM[b.rank_number]||'B1', ki:b.branch_number, branch:b.branch_number_source,
          age:b.age, weight:b.weight,
          local2:b.local_top_2_percent||0, localWinRate:b.local_win_rate,
          localTop3:b.local_top_3_percent,
          national2:b.national_top_2_percent||0, nationalWinRate:b.national_win_rate,
          nationalTop3:b.national_top_3_percent,
          motor2:b.motor_top_2_percent||0, motorNo:b.motor_number, motorTop3:b.motor_top_3_percent,
          boatNo:b.boat_number, boatTop2:b.boat_top_2_percent, boatTop3:b.boat_top_3_percent,
          flying:b.flying_count||0, late:b.late_count||0,
          avgST:b.average_start_timing,
          course:validCourse?pv.course_number:b.entry_number,
          courseSource: validCourse ? 'preview' : 'fallback_entry_number', // 由来を明示(不明な推測を避けるため)
          exTime:(pv.exhibition_time&&pv.exhibition_time>0)?pv.exhibition_time:null,
          st:(hasPreview&&pv.start_timing!=null)?pv.start_timing:null,
          tilt:pv.tilt_adjustment
        };
      });

      // 整合性チェック: courseの重複・艇番の重複・着順の重複を横断的に検出。
      // 検出したら削除せず excludeFlag を立てて保持する(過去レースは残したいが、信頼できないと分かる形で)。
      const courseVals=boats.map(b=>b.course);
      const noVals=boats.map(b=>b.no);
      const courseDup = new Set(courseVals).size !== courseVals.length;
      const noDup = new Set(noVals).size !== noVals.length;
      const allPlaces=Object.values(pl);
      const placeDup = new Set(allPlaces).size !== allPlaces.length;
      const excludeReasons=[];
      if(courseDup) excludeReasons.push('course_duplicate');
      if(noDup) excludeReasons.push('boat_no_duplicate');
      if(placeDup) excludeReasons.push('place_duplicate');
      const excludeFlag = excludeReasons.length>0;
      if(excludeFlag){ console.error(`⚠️整合性エラー sid=${sid} R${rno}: ${excludeReasons.join(',')}`); }

      const tide=await fetchTide(sid,race.date,race.closed_at);
      const raceCtx={sid,rno,date:race.date,hasPreview,wind:prev?prev.wind_speed:null,tide,closed:race.closed_at};
      const ranked=scoreBoats(boats,raceCtx);
      const pk=makePicks(ranked);
      const resultStr=`${pl[1]}-${pl[2]}-${pl[3]}`;
      const hit=pk.combos.includes(resultStr);

      // 2026-08-18 修正: 以前はpayoffを「自分の買い目(6点ボックス)が的中した時の3連単配当」のみ記録していたが、
      // 任意の買い方を後からバックテストできるよう、全券種の確定配当を無条件で保存する仕様に変更。
      const payouts = result.payouts || null;
      let payoff=0; // 後方互換: 自分の買い目的中時の3連単配当(旧仕様のまま残す)
      if(hit && payouts && payouts.trifecta){
        const t=payouts.trifecta.find(x=>x.combination===resultStr);
        payoff=t?t.amount:0;
      }

      // 全着順(1-6着)。以前はtop3までのresultStrしか保存していなかった。
      const fullPlaces={};
      boatsToArray(result.racers).forEach(b=>{ if(b.place_number) fullPlaces[b.place_number]=b.entry_number; });

      aT++; aI+=600; if(hit){aH++; aR+=payoff;}
      if(!statBySt[sid]) statBySt[sid]={t:0,h:0,i:0,r:0};
      statBySt[sid].t++; statBySt[sid].i+=600; if(hit){statBySt[sid].h++; statBySt[sid].r+=payoff;}

      // 潮位が無い理由が「淡水場でもともと対象外」か「海水場なのに取得失敗」かを区別する(2026-07-20、Mac側カニの調査依頼)。
      const tideError = !tide && !!TIDE_HARBOR[sid] && tideFailedKeys.has(sid+'_'+race.date);

      out.push({
        sid, stadium:SNAME[sid], rno, hasPreview, model:MODEL_VER,
        top3:[ranked[0].no,ranked[1].no,ranked[2].no], combos:pk.combos,
        tide:tide?tide.label:null, tideError: tideError||undefined, result:resultStr, hit, payoff,
        excludeFlag: excludeFlag||undefined, excludeReasons: excludeFlag?excludeReasons:undefined,
        fullResult: fullPlaces, // {1:艇番,2:艇番,...,6:艇番}
        technique: result.technique_number_source, // 決まり手
        grade: race.grade_number_source, dayNumber: race.day_number,
        weather: result.weather_number_source, airTemp: result.air_temperature, waterTemp: result.water_temperature,
        windDir: result.wind_direction_number_source, windSpeed: result.wind_speed, waveHeight: result.wave_height,
        payouts, // 全券種・全組み合わせの確定配当をそのまま保存
        snapshot:ranked.map(b=>({
          no:b.no, regNo:b.regNo, course:b.course, courseSource:b.courseSource, pct:b.pct,
          exTime:b.exTime, st:(b.st!=null?b.st:b.avgST), avgST:b.avgST,
          motor2:b.motor2, motorNo:b.motorNo, motorTop3:b.motorTop3,
          boatNo:b.boatNo, boatTop2:b.boatTop2, boatTop3:b.boatTop3,
          local2:b.local2, localWinRate:b.localWinRate, localTop3:b.localTop3,
          national2:b.national2, nationalWinRate:b.nationalWinRate, nationalTop3:b.nationalTop3,
          cls:b.cls, tilt:b.tilt, age:b.age, weight:b.weight, branch:b.branch,
          flying:b.flying, late:b.late
        }))
      });
    }
  }

  console.log(`確定 ${aT}R  的中 ${aH}件(${aT?Math.round(aH/aT*100):0}%)  回収率 ${aI?Math.round(aR/aI*100):0}%`);
  if(tideFailedKeys.size){
    console.error(`⚠️潮位取得失敗(リトライ後も): ${[...tideFailedKeys].join(', ')}`);
  }
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
