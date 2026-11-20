import {City} from "./world.js";
import {Simulation,phaseName} from "./simulation.js";
import {airWaypoint,orderFromText,stations} from "./navigation.js";
import {Lecture} from "./lecture.js";
import {FlightAudio} from "./audio.js";

const $=id=>document.getElementById(id);
const fmt=t=>[Math.floor(t/60),Math.floor(t%60)].map(n=>String(n).padStart(2,"0")).join(":");
let city,sim,mode="course",avoid=[],priority=1,trial=null,comparisons=[],trace=[],lastUI=0,shownFrame=null,modelHash=null,segmentHashes=null,lecture;
const factorLabels={active_observation:["关闭观察","开启观察"],checkpoint:["第 1 轮","验证最佳"],gps:["关闭 GPS","开启 GPS"],policy:["规则策略","学习策略"]};
let policyHash,backendName="torch";
const sound=new FlightAudio();
const tip=text=>{$("stage-tip").textContent=text;};
function options(){return {station:Number($("station").value),chapter:Number($("chapter").value),
  fleet:$("fleet").checked||$("chapter").value==="5",weather:$("weather").value,gps:$("gps").checked,avoid:[...avoid],
  secondRoute:$("second-route").value,link:$("link").value,worksite:$("worksite").value,zoneSeconds:Number($("zone-time").value),
  rangeLimit:Number($("range-limit").value),depthNoise:Number($("depth-noise").value),dropRate:Number($("drop-rate").value),
  linkRange:Number($("link-range").value),departure:Number($("departure").value),
  lowBattery:$("low-battery").checked,learned:$("policy").value==="learned",priority};}
function note(e){
  const text=fmt(e.time)+"　AM–0"+(e.unit+1)+"　"+e.reason;$("events").textContent=text;sound.cue(e);
  const item=document.createElement("li");item.textContent=text;
  const list=$("decision-events");list.prepend(item);if(list.children.length>7)list.lastChild.remove();
}
function reset(o=options()){
  sim.reset(o);trace=[];shownFrame=null;city.showFrame(null);tip("");$("replay").hidden=true;$("launch").disabled=false;$("pause").disabled=true;
  $("pause").textContent="暂停";$("speed").textContent="1×";$("manual").checked=false;
  $("barrier").checked=$("moving").checked=$("occupied").checked=false;
  $("switch-unit").disabled=sim.units.length<2;$("events").textContent="等待选择订单";
  $("decision-events").replaceChildren();
}
function launch(){
  if(sim.running||sim.paused){tip("当前订单正在执行");return;}
  const preset={barrier:$("barrier").checked,moving:$("moving").checked,occupied:$("occupied").checked,zone:$("zone").checked};
  comparisons=[];reset();
  for(const [key,value] of Object.entries(preset))if(value){sim.act(key,true);$(key).checked=true;}
  sim.start();$("launch").disabled=true;$("pause").disabled=false;
}
function mapView(b){
  const c=$("cognitive"),g=c.getContext("2d");
  g.fillStyle="#0b2326";g.fillRect(0,0,c.width,c.height);
  const point=p=>[c.width/2+p[0]*1.15,c.height/2+p[2]*.94];
  for(const cell of b.map.voxels.values()){
    const [x,y]=point(cell.point);
    g.fillStyle=cell.odds>1?"#eeb678":cell.odds<-.8?"#64ad99":"#657b72";g.fillRect(x,y,3,3);
  }
  g.strokeStyle="#f7e9bf";g.beginPath();b.trajectory.forEach((p,i)=>{
    const [x,y]=point(p);if(i===0)g.moveTo(x,y);else g.lineTo(x,y);});g.stroke();
  if(comparisons.length===2)comparisons.forEach((branch,i)=>{
    g.strokeStyle=i?"#65eed3":"#f4a66e";g.lineWidth=1.6;g.beginPath();
    branch.metrics.trajectory.forEach((p,j)=>{const [x,y]=point(p);if(j)g.lineTo(x,y);else g.moveTo(x,y);});g.stroke();
    g.font="10px sans-serif";g.fillStyle=g.strokeStyle;g.fillText(branch.label,5+i*100,12);
  });
  const [x,y]=point(b.est);g.fillStyle="#fff6d7";g.beginPath();g.arc(x,y,3.5,0,2*Math.PI);g.fill();
}
function metrics(b){
  const controls=b.frameTimings.map(t=>t.command_ms).sort((a,b)=>a-b);
  const vision=b.frameTimings.map(t=>t.vision_ms).sort((a,b)=>a-b);
  const quantile=(values,fraction)=>values.length?values[Math.floor(values.length*fraction)]:null;
  return {unit:b.index+1,outcome:b.phase,delivered:b.delivered,elapsed_sim_s:sim.time,wait_s:b.wait,
    length_m:b.distance,contacts:b.contacts,min_aircraft_spacing_m:b.minGap,delivery_error_m:b.deliveredError,home_contact_error_m:b.homeError??null,
    localization_rmse_m:b.metrics.length?Math.sqrt(b.metrics.reduce((s,n)=>s+n*n,0)/b.metrics.length):null,
    camera_to_vision_result_p50_ms:quantile(vision,.5),camera_to_vision_result_p95_ms:quantile(vision,.95),
    camera_to_decision_p50_ms:quantile(controls,.5),camera_to_decision_p95_ms:quantile(controls,.95),
    measured_control_frames:controls.length,timing_samples:b.frameTimings.filter((_,i)=>i%30===0),
    accepted_sensor_frames:b.accepted,simulated_dropped_frames:b.unavailable,
    sensor_sim_hz:b.last?.sim_time>b.firstSense?(b.accepted-1)/(b.last.sim_time-b.firstSense):null,
    minimum_observed_forward_range_m:b.minRange??null,semantic_frames:b.semanticFrames||0,
    simulated_energy_used_pct:b.spent,receipts:b.receipts,trajectory:b.trajectory,
    visual_loop_closures:b.odometry.loops,evaluation_samples:b.samples};
}
function update(){
  const b=sim.units[sim.activeUnit], frame=b.last;
  sound.update(b,sim.running&&!sim.paused);
  if(sim.running){
    for(const key of ["barrier","moving","occupied"])$(key).checked=sim.environment[key];
    $("gps").checked=sim.options.gps;$("zone").checked=Boolean(sim.options.avoid.length);
  }
  if(frame && frame!==shownFrame){city.showFrame(b.pixels);shownFrame=frame;}
  $("clock").textContent=fmt(sim.time);$("phase").textContent=phaseName(b.phase);
  $("travel").textContent=b.distance.toFixed(0)+" m";$("energy").textContent=b.energy.toFixed(0)+"%";
  $("unit-name").textContent="AM–0"+(b.index+1);$("frame-num").textContent=frame?"F "+frame.id:"F —";
  $("percept").textContent=sim.serviceError?"感知中断，等待恢复":b.visionNote;
  const overlay=$("detections").getContext("2d");
  overlay.clearRect(0,0,320,180);
  for(const r of frame?.regions||[]){
    const warning=r.label==="construction",c=warning?"244,153,74":"61,198,195";
    overlay.fillStyle="rgba("+c+",.25)";overlay.strokeStyle="rgba("+c+",.86)";overlay.lineWidth=1;
    overlay.beginPath();r.polygon_px.forEach(([x,y],i)=>i?overlay.lineTo(x,y):overlay.moveTo(x,y));
    overlay.closePath();overlay.fill();overlay.stroke();
    const [u,v]=r.center_uv,[a,d]=r.predicted_uv_035s;overlay.beginPath();overlay.moveTo(u*320,v*180);overlay.lineTo(a*320,d*180);overlay.stroke();
    overlay.font="10px sans-serif";overlay.fillStyle="white";overlay.fillText((warning?"施工":"站牌")+" #"+r.track,u*320,Math.max(10,v*180-4));
  }
  for(const r of frame?.readings||[]){
    overlay.strokeStyle=r.state==="available"?"#50ffd5":"#ffba61";overlay.fillStyle=overlay.strokeStyle;
    overlay.lineWidth=1.7;overlay.beginPath();r.polygon_px.forEach(([x,y],i)=>i?overlay.lineTo(x,y):overlay.moveTo(x,y));overlay.closePath();overlay.stroke();
    overlay.font="11px Consolas, monospace";overlay.fillText(r.station+" · "+(100*r.confidence).toFixed(0)+"%",r.polygon_px[0][0],Math.max(12,r.polygon_px[0][1]-3));
  }
  $("range").textContent=b.rangeTrack?b.rangeTrack.range.toFixed(1)+" m":"未知";
  $("fix").textContent=b.fix;$("latency").textContent=b.lastVisionRttMs!=null?b.lastVisionRttMs.toFixed(0)+" ms":"—";
  $("rationale").textContent="已记录 "+b.map.voxels.size+" 个体素，跟踪 "+(frame?.tracked_features??0)+" 个特征。"+
    (b.clearance?.distance_m!=null?"前方局部距离场净空 "+b.clearance.distance_m.toFixed(1)+" m。":"")+
    (b.forecast?"F"+b.forecast.frame+" 滚动预测选速 "+b.forecast.options[0].speed.toFixed(1)+" m/s。":"")+
    (b.observation?"观察朝向 "+(b.observation.candidates[0].offset*180/Math.PI).toFixed(0)+"°，预期信息分 "+b.observation.candidates[0].score.toFixed(1)+"。":"")+
    (sim.options.learned && b.pace?"学习策略所选巡航速度 "+b.pace.chosen_m_s+" m/s。":"");
  $("fleet-state").textContent=sim.units.length===1?"单机运行":sim.units.map(u=>"AM–0"+(u.index+1)+" "+stations[u.station].name+" · "+phaseName(u.phase)).join("　");
  if($("knowledge").open)mapView(b);
  if(frame && sim.running && (trace.length===0 || sim.time-trace.at(-1).time>2)){
    trace.push({time:frame.sim_time,unit:b.index,frame:frame.id,readings:frame.readings,regions:frame.regions,handoff:frame.handoff,
               position_est_m:[...b.est],image:$("feed").toDataURL("image/jpeg",.60)});
    if(trace.length>220)trace.shift();
  }
  $("replay-time").max=String(Math.max(0,...trace.map(t=>t.time),...comparisons.map(c=>c.metrics.elapsed_sim_s)));
  if(sim.final&&!trial && !lecture?.active){$("launch").disabled=false;$("pause").disabled=true;}
  if(trial?.stage==="warm" && sim.paused && !sim.pending){beginFork();return;}
  if(trial?.stage==="branch" && (sim.final||sim.time>=trial.limit) && !sim.pending){
    sim.paused=true;
    comparisons.push({factor:trial.factor,label:factorLabels[trial.factor][comparisons.length],active_observation:sim.active,
      checkpoint:sim.options.checkpoint||"selected",gps:sim.options.gps,metrics:metrics(sim.units[0]),events:[...sim.events],keyframes:[...trace],
      initial_position_error_m:trial.restoreError,snapshot_tick:trial.snapshot.tick,
      shared_frame:trial.snapshot.units[0].last.id,seed_at_fork:trial.snapshot.units[0].seed,event_at:trial.eventAt});
    if(comparisons.length===1)restoreBranch(true);
    else{
      sim.running=sim.paused=false;trial=null;lockTrial(false);$("compare").disabled=false;$("launch").disabled=false;
      const a=comparisons[0].metrics,b=comparisons[1].metrics;
      $("compare-state").textContent=`${comparisons[0].label} · ${phaseName(a.outcome)}，等待 ${a.wait_s.toFixed(1)} s。${comparisons[1].label} · ${phaseName(b.outcome)}，等待 ${b.wait_s.toFixed(1)} s。`;
    }
  }
}
async function beginFork(){
  const current=trial;current.stage="snapshot";
  try{
    current.snapshot=await sim.snapshot();if(trial!==current)return;
    current.prefix=[...trace];await restoreBranch(false);
  }catch(e){if(trial===current)failTrial(e);}
}
function failTrial(e){
  trial=null;lockTrial(false);sim.paused=true;sim.running=false;$("compare").disabled=false;$("launch").disabled=false;
  $("compare-state").textContent="实验中止 · "+e.message;
}
async function restoreBranch(active){
  const current=trial;current.stage="restore";sim.paused=true;
  try{
    await sim.restore(current.snapshot);if(trial!==current)return;
    if(current.factor==="active_observation")sim.active=active;
    if(current.factor==="checkpoint")sim.options.checkpoint=active?"selected":"early";
    if(current.factor==="gps")sim.options.gps=active;
    if(current.factor==="policy")sim.options.learned=active;
    sim.speed=3;sim.pauseAt=Math.round(current.limit*30);trace=[...current.prefix];
    current.restoreError=Math.hypot(...sim.units[0].est.map((v,i)=>v-current.snapshot.units[0].est[i]));
    current.stage="branch";
  }catch(e){if(trial===current)failTrial(e);return;}
  $("speed").textContent="3×";$("pause").disabled=false;
  $("compare-state").textContent=`状态分叉 · ${factorLabels[current.factor][Number(active)]} · 公共观测截至 ${fmt(current.snapshot.time)} · ${current.limit} s 截止`;
}
function exportEvidence(){
  const gl=city.renderer.getContext(), ext=gl.getExtension("WEBGL_debug_renderer_info");
  const ft=[...sim.frameTimes].sort((a,b)=>a-b);
  const record={format:3,source:"Three.js WebGL2 live RGB-D",inference_backend:backendName,browser:navigator.userAgent,
    timing_boundary:"Wall time from start of live camera capture to parsed vision response and to the first subsequent completed control decision for that frame.",
    model_sha256:modelHash,segmentation_sha256:segmentHashes,policy_sha256:policyHash,
    gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),
    viewport:[innerWidth,innerHeight],resolution:[gl.drawingBufferWidth,gl.drawingBufferHeight],sensor:[320,180],physics_hz:30,
    render_pixel_ratio:city.renderer.getPixelRatio(),webgl_draw_calls:city.renderer.info.render.calls,webgl_triangles:city.renderer.info.render.triangles,
    js_heap_bytes:performance.memory?.usedJSHeapSize??null,
    render_frames:ft.length,mean_fps:ft.length?1000*ft.length/ft.reduce((a,b)=>a+b,0):null,
    frame_time_p95_ms:ft.length?ft[Math.min(ft.length-1,Math.floor(.95*ft.length))]:null,
    failed_frame_requests:sim.missingFrames,seed:1407,sensor_target_hz:8,control_sim_hz:30,
    energy_model:"percent/s = 0.035 + 0.006 * speed_m_s + (0.012 when carrying, 0 otherwise)",
    mode,options:sim.options,orders:sim.orders,communications:sim.linkLog,units:sim.units.map(metrics),events:sim.events,keyframes:trace,lecture:lecture?.report,
    experiment:comparisons.length?{method:"状态分叉",factor:comparisons[0].factor,fixed_event:{at:comparisons[0].event_at,type:"barrier",value:true},branches:comparisons}:null};
  const url=URL.createObjectURL(new Blob([JSON.stringify(record)],{type:"application/json"}));
  const a=document.createElement("a");a.href=url;a.download="AeroMind-"+Date.now()+".json";a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
}
function lockTrial(locked){
  for(const id of ["station","chapter","weather","worksite","zone-time","range-limit","depth-noise","drop-rate","link-range","departure",
    "second-route","link","barrier","moving","occupied","zone","gps","fleet","manual","low-battery","parse","factor","fork-time","policy","recall"])
    $(id).disabled=locked;
}
function setView(name){document.querySelector(`[data-view="${name}"]`).click();}
function startComparison(factor=$("factor").value){
  const fork=Number($("fork-time").value);
  comparisons=[];trial={stage:"warm",factor,limit:95,eventAt:fork+3,options:{...options(),station:17,chapter:4,fleet:false,gps:true,avoid:[],lowBattery:false,secondRoute:"mixed",worksite:"south"}};
  reset(trial.options);sim.speed=3;sim.pauseAt=fork*30;sim.timedEvents=[{at:trial.eventAt,type:"barrier",value:true}];
  sim.start();lockTrial(true);$("compare").disabled=true;$("launch").disabled=true;$("speed").textContent="3×";
  $("compare-state").textContent="正在采集共同输入历史，t="+fork+" s 保存物理、控制、地图、视觉跟踪与传感器状态";
}
function startLecture(){
  if(trial){tip("请在当前实验结束或重置后开始讲演");return;}
  comparisons=[];avoid=[];priority=1;
  lecture=new Lecture({
    enter(stage){
      const modeName=stage===4?"experiment":stage===3?"challenge":"course";
      document.querySelector(`[data-mode="${modeName}"]`).click();
      if([0,2,3,5].includes(stage)){
        $("chapter").value=({0:"1",2:"3",3:"4",5:"5"})[stage];$("station").value="17";
        $("gps").checked=true;$("fleet").checked=stage===5;$("low-battery").checked=false;
        $("zone").checked=false;$("weather").value="day";$("link").value="local";$("worksite").value="south";$("policy").value="rules";
        $("range-limit").value="90";$("depth-noise").value="0";$("drop-rate").value="0";$("departure").value="0";$("link-range").value="250";$("fork-time").value="6";
        $("second-route").value=stage===5?"shared":"mixed";reset();sim.start();sim.speed=stage===5?3:lecture.rate;
        $("speed").textContent=sim.speed+"×";$("launch").disabled=true;$("pause").disabled=false;
        sim.timedEvents=[stage===2?{at:6,type:"gps",value:false}:{at:9,type:"barrier",value:true}];
      }
      if(stage===4){$("factor").value="active_observation";startComparison();$("experiment").open=true;}
      if(stage===5)$("experiment").open=true;
      if(stage===6){
        $("experiment").open=true;
        const observed=trace.find(t=>t.readings.some(r=>r.state==="available"));
        $("replay-time").value=String(observed?.time??sim.time);$("replay-time").dispatchEvent(new Event("input"));
      }
      setView(["overview","follow","map","follow","overview","overview","cinema"][stage]);
    },
    ready:stage=>stage===4?!trial:stage===5||stage===6?sim.final||sim.time>=150:true,
    evidence(stage){
      return {sim_time:sim.time,orders:structuredClone(sim.orders),failed_sensor_requests:sim.missingFrames,
        results:sim.units.map(b=>({unit:b.index,phase:b.phase,receipts:[...b.receipts],contacts:b.contacts})),
        events:sim.events.map(e=>({...e})),observed_frames:sim.units.map(b=>b.accepted),
        branches:stage===4?comparisons.map(c=>({active:c.active_observation,phase:c.metrics.outcome,
          wait_s:c.metrics.wait_s,shared_frame:c.shared_frame})):undefined};
    },
    status(title,hint,time,index){
      $("lecture-status").textContent=index+"/7 · "+fmt(time)+"　"+title+"。"+hint;
      $("lecture-status").dataset.stage=String(index);
    },
    finish(report){
      $("lecture-status").textContent="讲演结束 · 七段运行证据可导出";$("lecture-status").dataset.stage="complete";
      $("lecture").disabled=false;$("launch").disabled=false;$("pause").disabled=true;
      $("classroom").open=true;tip("课堂讲演结束 · "+report.stages.length+" 段运行记录");
    }
  });
  $("lecture").disabled=true;lecture.start(Number($("lecture-rate").value));
}
function bind(){
  $("launch").onclick=launch;
  $("lecture").onclick=startLecture;
  $("reset").onclick=()=>{trial=null;comparisons=[];lockTrial(false);lecture?.stop();lecture=null;$("lecture").disabled=false;
    $("lecture-status").textContent="准备开始课堂讲演";$("compare").disabled=false;reset();};
  $("pause").onclick=()=>{const next=lecture?.active?!lecture.paused:!sim.paused;
    if(lecture?.active)lecture.paused=next;
    sim.paused=next;$("pause").textContent=next?"恢复":"暂停";tip(next?"仿真已暂停":"");};
  $("speed").onclick=()=>{sim.speed=sim.speed===1?2:sim.speed===2?3:1;$("speed").textContent=sim.speed+"×";};
  $("weather").onchange=()=>{sim.options.weather=$("weather").value;city.climate(sim.options.weather);sim.log("天气切换为"+$("weather").selectedOptions[0].text);};
  $("link").onchange=()=>sim.act("link",$("link").value);
  $("quality").onchange=()=>city.quality($("quality").value==="economy");
  for(const [id,key] of Object.entries({"range-limit":"rangeLimit","depth-noise":"depthNoise","drop-rate":"dropRate","link-range":"linkRange","departure":"departure"})){
    $(id).onchange=()=>{sim.options[key]=Number($(id).value);sim.log($(id).parentElement.firstChild.textContent+"切换为"+$(id).selectedOptions[0].text);};
  }
  $("sound").onchange=()=>sound.enable($("sound").checked).catch(e=>{tip(e.message);$("sound").checked=false;});
  $("worksite").onchange=()=>{
    const original=sim.options.worksite;sim.options.worksite=$("worksite").value;
    if(sim.environment.barrier && !sim.act(sim.environment.moving?"moving":"barrier",true)){
      sim.options.worksite=original;$("worksite").value=original||"south";
    }
  };
  $("zone-time").onchange=()=>{sim.options.zoneSeconds=Number($("zone-time").value);if(sim.city.restriction.visible)sim.act("zone",true);};
  $("recall").onclick=()=>sim.recall();
  $("policy").onchange=()=>{sim.options.learned=$("policy").value==="learned";sim.log(sim.options.learned?"启用校园学习策略":"恢复规则规划");};
  $("training").ontoggle=async()=>{
    if(!$("training").open||$("training-score").textContent)return;
    try{
      const report=await fetch("/api/learning").then(r=>{if(!r.ok)throw new Error();return r.json();});
      const g=$("learning-curve").getContext("2d");g.strokeStyle="#426360";g.fillStyle="#c7dbd1";g.font="10px sans-serif";
      for(const v of [0,.5,1]){const y=98-v*80;g.fillText(String(v),3,y+3);g.beginPath();g.moveTo(24,y);g.lineTo(291,y);g.stroke();}
      g.strokeStyle="#a9e3c7";g.lineWidth=2;g.beginPath();
      report.history.forEach((r,i)=>{const x=24+267*i/(report.history.length-1),y=98-r.val_foreground_miou*80;
        if(i)g.lineTo(x,y);else g.moveTo(x,y);});g.stroke();g.fillText("第 1 轮",24,115);g.fillText("第 "+report.epochs+" 轮",250,115);
      $("training-score").textContent="分割训练回放 · 验证集前景 mIoU。最佳第 "+report.best_epoch+" 轮，独立测试 "+
        report.held_out_test.images+" 帧，前景 mIoU "+report.held_out_test.foreground_miou.toFixed(3)+"。";
    }catch{$("training-score").textContent="训练记录读取失败";}
  };
  for(const key of ["barrier","moving","occupied","gps","zone"])$(key).onchange=()=>{
    if(!sim.act(key,$(key).checked))$(key).checked=!$(key).checked;
    if(key==="barrier" && !$(key).checked)$("moving").checked=false;
    if(key==="moving" && $(key).checked)$("barrier").checked=true;
  };
  for(const key of ["station","chapter","fleet"])$(key).onchange=()=>{
    if(sim.running){const o=sim.options;$(key).value=String(key==="station"?o.station:o.chapter);
      if(key==="fleet")$(key).checked=o.fleet;tip("重置后可更改订单、章节或机群");return;}
    reset();
  };
  $("manual").onchange=()=>{sim.manual=$("manual").checked;sim.keys.clear();$("drive-hint").hidden=!sim.manual;sim.log(sim.manual?"已手动接管":"恢复任务控制");};
  window.addEventListener("keydown",e=>{if(sim.manual&&!["INPUT","SELECT"].includes(e.target.tagName))sim.keys.add(e.key.toLowerCase());});
  window.addEventListener("keyup",e=>sim.keys.delete(e.key.toLowerCase()));window.addEventListener("blur",()=>sim.keys.clear());
  $("parse").onclick=()=>{if(sim.running){tip("请在选单阶段输入任务指令");return;}
    try{const o=orderFromText($("command").value);avoid=o.avoid;priority=o.priority;$("station").value=o.station;$("zone").checked=Boolean(avoid.length);reset();tip((priority===2?"加急订单 · ":"普通订单 · ")+stations[o.station].name);}
    catch(e){tip(e.message);}
  };
  $("compare").onclick=()=>{if(sim.running){tip("请先重置当前配送");return;}
    startComparison();
  };
  $("switch-unit").onclick=()=>{sim.activeUnit=1-sim.activeUnit;const b=sim.units[sim.activeUnit];
    sim.city.setRoute([b.est,...[b.next,...b.route].filter(Boolean).map(k=>airWaypoint(k,b.index))]);};
  $("export").onclick=exportEvidence;
  $("replay-time").oninput=()=>{
    const t=Number($("replay-time").value);
    const streams=comparisons.length===2 && lecture?.index!==6?comparisons.map(c=>({name:c.label,frames:c.keyframes})):
      [{name:"本次运行",frames:trace}];
    const pair=document.querySelector(".replay-pair");pair.replaceChildren();const captions=[];
    for(const s of streams){
      const f=s.frames.filter(f=>f.time<=t).at(-1);if(!f)continue;
      const img=document.createElement("img");img.src=f.image;img.alt=s.name+"机载关键帧";pair.append(img);
      captions.push(s.name+" F"+f.frame+" · "+f.handoff.reason);
    }
    $("replay").hidden=!pair.children.length;$("replay-caption").textContent="录制回放 "+fmt(t)+" · "+captions.join(" / ");
  };
  for(const button of document.querySelectorAll("[data-view]"))button.onclick=()=>{
    document.querySelector("[data-view].selected")?.classList.remove("selected");button.classList.add("selected");city.switchView(button.dataset.view);
    $("map-legend").hidden=button.dataset.view!=="map";
    document.querySelector(".map-title h1").textContent=button.dataset.view==="map"?"机载认知地图":"云港学区";
    document.querySelector(".map-title .eyebrow").textContent=button.dataset.view==="map"?"LOCAL MAP":"CAMPUS DISTRICT";
    if(button.dataset.view==="map")$("knowledge").open=true;
  };
  for(const button of document.querySelectorAll("[data-mode]"))button.onclick=()=>{
    mode=button.dataset.mode;document.querySelector("[data-mode].selected")?.classList.remove("selected");button.classList.add("selected");
    $("controls").open=mode==="challenge"||mode==="free";$("experiment").open=mode==="experiment";
    if(mode==="experiment")$("experiment").scrollIntoView({block:"nearest"});
  };
}
async function boot(){
  try{
    const health=await fetch("/api/health").then(r=>r.json());
    modelHash=health.weights_sha256;segmentHashes=health.segmentation_sha256;backendName=health.backend||"torch";
    const ruleFile=await fetch("/app/policy-weights.json").then(r=>r.arrayBuffer());
    policyHash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",ruleFile)),v=>v.toString(16).padStart(2,"0")).join("");
    const weights=JSON.parse(new TextDecoder().decode(ruleFile)).policy;
    city=new City($("world"),$("feed"));await city.load();
    sim=new Simulation(city,note,weights);$("connection").innerHTML="<i></i>本机推理在线 · CPU";
    if(health.device!=="CPU")$("connection").textContent=health.device;
    bind();reset();
    city.renderer.setAnimationLoop(now=>{sim.frame(now);if(now-lastUI>130){update();lecture?.tick(now);lastUI=now;}});
  }catch(e){tip("启动失败 · "+e.message);$("connection").textContent="启动未完成";console.error(e);}
}
boot();
