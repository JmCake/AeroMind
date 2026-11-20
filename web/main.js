import {City} from "./world.js";
import {Simulation,phaseName} from "./simulation.js";
import {nodes,orderFromText,stations} from "./navigation.js";

const $=id=>document.getElementById(id);
const fmt=t=>[Math.floor(t/60),Math.floor(t%60)].map(n=>String(n).padStart(2,"0")).join(":");
let city,sim,mode="course",avoid=[],trial=null,comparisons=[],trace=[],lastUI=0;
const tip=text=>{$("stage-tip").textContent=text;};
function options(){return {station:Number($("station").value),chapter:Number($("chapter").value),
  fleet:$("fleet").checked||$("chapter").value==="5",weather:$("weather").value,gps:$("gps").checked,avoid:[...avoid]};}
function note(e){$("events").textContent=fmt(e.time)+"　AM–0"+(e.unit+1)+"　"+e.reason;}
function reset(o=options()){
  sim.reset(o);trace=[];tip("");$("replay").hidden=true;$("launch").disabled=false;$("pause").disabled=true;
  $("pause").textContent="暂停";$("speed").textContent="1×";$("manual").checked=false;
  $("barrier").checked=$("moving").checked=$("occupied").checked=false;
  $("switch-unit").disabled=sim.units.length<2;$("events").textContent="等待选择订单";
}
function launch(){
  if(sim.running||sim.paused){tip("当前订单正在执行");return;}
  const preset={barrier:$("barrier").checked,moving:$("moving").checked,occupied:$("occupied").checked,zone:$("zone").checked};
  reset();
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
  const [x,y]=point(b.est);g.fillStyle="#fff6d7";g.beginPath();g.arc(x,y,3.5,0,2*Math.PI);g.fill();
}
function metrics(b){
  const ordered=[...b.latencies].sort((a,b)=>a-b);
  return {unit:b.index+1,outcome:b.phase,delivered:b.delivered,elapsed_sim_s:sim.time,wait_s:b.wait,
    length_m:b.distance,contacts:b.contacts,min_aircraft_spacing_m:b.minGap,delivery_error_m:b.deliveredError,
    localization_rmse_m:b.metrics.length?Math.sqrt(b.metrics.reduce((s,n)=>s+n*n,0)/b.metrics.length):null,
    camera_to_decision_p50_ms:ordered.length?ordered[Math.floor(ordered.length*.5)]:null,
    camera_to_decision_p95_ms:ordered.length?ordered[Math.min(ordered.length-1,Math.floor(ordered.length*.95))]:null,
    simulated_energy_used_pct:100-b.energy,trajectory:b.trajectory};
}
function update(){
  const b=sim.units[sim.activeUnit], frame=b.last;
  $("clock").textContent=fmt(sim.time);$("phase").textContent=phaseName(b.phase);
  $("travel").textContent=b.distance.toFixed(0)+" m";$("energy").textContent=b.energy.toFixed(0)+"%";
  $("unit-name").textContent="AM–0"+(b.index+1);$("frame-num").textContent=frame?"F "+frame.id:"F —";
  $("percept").textContent=sim.serviceError?"感知中断，等待恢复":b.visionNote;
  const overlay=$("detections").getContext("2d");
  overlay.clearRect(0,0,320,180);
  for(const r of frame?.readings||[]){
    overlay.strokeStyle=r.state==="available"?"#50ffd5":"#ffba61";overlay.fillStyle=overlay.strokeStyle;
    overlay.lineWidth=1.7;overlay.beginPath();r.polygon_px.forEach(([x,y],i)=>i?overlay.lineTo(x,y):overlay.moveTo(x,y));overlay.closePath();overlay.stroke();
    overlay.font="11px Consolas, monospace";overlay.fillText(r.station+" · "+(100*r.confidence).toFixed(0)+"%",r.polygon_px[0][0],Math.max(12,r.polygon_px[0][1]-3));
  }
  $("range").textContent=b.rangeTrack?b.rangeTrack.range.toFixed(1)+" m":"未知";
  $("fix").textContent=b.fix;$("latency").textContent=b.latencies.length?b.latencies.at(-1).toFixed(0)+" ms":"—";
  $("rationale").textContent="已记录 "+b.map.voxels.size+" 个体素，跟踪 "+(frame?.tracked_features??0)+" 个特征。"+
    (b.observation?"观察朝向 "+(b.observation.candidates[0].offset*180/Math.PI).toFixed(0)+"°，预期信息分 "+b.observation.candidates[0].score.toFixed(1)+"。":"");
  $("fleet-state").textContent=sim.units.length===1?"单机运行":sim.units.map(u=>"AM–0"+(u.index+1)+" "+stations[u.station].name+" · "+phaseName(u.phase)).join("　");
  if($("knowledge").open)mapView(b);
  if(frame && sim.running && (trace.length===0 || sim.time-trace.at(-1).time>2)){
    trace.push({time:sim.time,unit:b.index,frame:frame.id,readings:frame.readings,handoff:frame.handoff,
               position_est_m:[...b.est],image:$("feed").toDataURL("image/jpeg",.60)});
    if(trace.length>220)trace.shift();
  }
  $("replay-time").max=String(Math.max(0,...trace.map(t=>t.time),...comparisons.map(c=>c.metrics.elapsed_sim_s)));
  if(sim.final&&!trial){$("launch").disabled=false;$("pause").disabled=true;}
  if(trial?.stage==="warm" && sim.paused && !sim.pending){beginFork();return;}
  if(trial?.stage==="branch" && (sim.final||sim.time>=trial.limit) && !sim.pending){
    sim.paused=true;
    comparisons.push({active_observation:sim.active,metrics:metrics(sim.units[0]),events:[...sim.events],keyframes:[...trace],
      initial_position_error_m:trial.restoreError, snapshot_tick:trial.snapshot.tick});
    if(comparisons.length===1)restoreBranch(true);
    else{
      sim.running=sim.paused=false;trial=null;$("compare").disabled=false;$("launch").disabled=false;
      const a=comparisons[0].metrics,b=comparisons[1].metrics;
      $("compare-state").textContent=`关闭：${phaseName(a.outcome)}，等待 ${a.wait_s.toFixed(1)} s。开启：${phaseName(b.outcome)}，等待 ${b.wait_s.toFixed(1)} s。可导出关键帧。`;
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
  trial=null;sim.paused=true;sim.running=false;$("compare").disabled=false;$("launch").disabled=false;
  $("compare-state").textContent="实验中止 · "+e.message;
}
async function restoreBranch(active){
  const current=trial;current.stage="restore";sim.paused=true;
  try{
    await sim.restore(current.snapshot);if(trial!==current)return;
    sim.active=active;sim.speed=3;sim.pauseAt=Math.round(current.limit*30);trace=[...current.prefix];
    current.restoreError=Math.hypot(...sim.units[0].est.map((v,i)=>v-current.snapshot.units[0].est[i]));
    current.stage="branch";
  }catch(e){if(trial===current)failTrial(e);return;}
  $("speed").textContent="3×";$("pause").disabled=false;
  $("compare-state").textContent=`状态分叉 · 主动观察${active?"开启":"关闭"} · 公共观测截至 ${fmt(current.snapshot.time)} · ${current.limit} s 截止`;
}
function exportEvidence(){
  const gl=city.renderer.getContext(), ext=gl.getExtension("WEBGL_debug_renderer_info");
  const ft=[...sim.frameTimes].sort((a,b)=>a-b);
  const record={format:1,source:"Three.js WebGL2 live RGB-D + local PyTorch/OpenCV",browser:navigator.userAgent,
    gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),
    resolution:[gl.drawingBufferWidth,gl.drawingBufferHeight],sensor:[320,180],physics_hz:30,
    render_frames:ft.length,mean_fps:ft.length?1000*ft.length/ft.reduce((a,b)=>a+b,0):null,
    frame_time_p95_ms:ft.length?ft[Math.min(ft.length-1,Math.floor(.95*ft.length))]:null,
    failed_frame_requests:sim.missingFrames,seed:1407,sensor_target_hz:8,
    mode,options:sim.options,units:sim.units.map(metrics),events:sim.events,keyframes:trace,
    experiment:comparisons.length?{method:"状态分叉",factor:"active_observation",fixed_event:{at:9,type:"barrier",value:true},branches:comparisons}:null};
  const url=URL.createObjectURL(new Blob([JSON.stringify(record)],{type:"application/json"}));
  const a=document.createElement("a");a.href=url;a.download="AeroMind-"+Date.now()+".json";a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
}
function bind(){
  $("launch").onclick=launch;
  $("reset").onclick=()=>{trial=null;comparisons=[];$("compare").disabled=false;reset();};
  $("pause").onclick=()=>{sim.paused=!sim.paused;$("pause").textContent=sim.paused?"恢复":"暂停";tip(sim.paused?"仿真已暂停":"");};
  $("speed").onclick=()=>{sim.speed=sim.speed===1?2:sim.speed===2?3:1;$("speed").textContent=sim.speed+"×";};
  $("weather").onchange=()=>{sim.options.weather=$("weather").value;city.climate(sim.options.weather);sim.log("天气切换为"+$("weather").selectedOptions[0].text);};
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
    try{const o=orderFromText($("command").value);avoid=o.avoid;$("station").value=o.station;$("zone").checked=Boolean(avoid.length);reset();tip("已识别目标："+stations[o.station].name);}
    catch(e){tip(e.message);}
  };
  $("compare").onclick=()=>{if(sim.running){tip("请先重置当前配送");return;}
    comparisons=[];trial={stage:"warm",limit:95,options:{...options(),station:17,chapter:4,fleet:false,gps:true,avoid:[]}};
    reset(trial.options);sim.speed=3;sim.pauseAt=180;sim.timedEvents=[{at:9,type:"barrier",value:true}];
    sim.start();$("compare").disabled=true;$("launch").disabled=true;$("speed").textContent="3×";
    $("compare-state").textContent="正在采集共同输入历史，t=6 s 保存物理、控制、地图、视觉跟踪与传感器状态";
  };
  $("switch-unit").onclick=()=>{sim.activeUnit=1-sim.activeUnit;const b=sim.units[sim.activeUnit];
    sim.city.setRoute([b.est,...[b.next,...b.route].filter(Boolean).map(k=>nodes[k])]);};
  $("export").onclick=exportEvidence;
  $("replay-time").oninput=()=>{
    const t=Number($("replay-time").value);
    const streams=comparisons.length===2?comparisons.map(c=>({name:c.active_observation?"开启":"关闭",frames:c.keyframes})):
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
    city=new City($("world"),$("feed"));await city.load();
    sim=new Simulation(city,note);$("connection").innerHTML="<i></i>本机推理在线 · CPU";
    if(health.device!=="CPU")$("connection").textContent=health.device;
    bind();reset();
    city.renderer.setAnimationLoop(now=>{sim.frame(now);if(now-lastUI>130){update();lastUI=now;}});
  }catch(e){tip("启动失败 · "+e.message);$("connection").textContent="启动未完成";console.error(e);}
}
boot();
