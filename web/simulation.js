import {airWaypoint,allocateOrders,distance, edgeId, forecastPace, inspectPassage, integrate, Knowledge, measurementRandom,observationYaw, pathBetween, restrictedEdges, stations} from "./navigation.js";
import {dispatchState,gazeState,learnedAction,pace,paceState,viewAngles} from "./policy.js";

const step=1/30, sensorPeriod=1/8;
const titles={idle:"等待订单",climb:"装载起飞",cruise:"航路配送",look:"主动观察",retreat:"退回已知航点",
  holding:"进入站点",verify:"视觉确认",dock:"下降交接",returning:"返航起飞",home:"返回物流中心",
  done:"已返航",failed:"任务受阻"};
export const phaseName=x=>titles[x]||x;
const smoothAngle=(a,b,k)=>a+Math.atan2(Math.sin(b-a),Math.cos(b-a))*k;
const copy=p=>[...p];
const bound=(x,m)=>Math.max(-m,Math.min(m,x));
const stamp=()=>crypto.randomUUID();
const stateKeys=["options","tick","time","active","units","events","inbox","timedEvents",
  "reservations","activeUnit","environment","manual","keys","speed","running","final","missingFrames","orders","linkLog","linkSeed"];

async function cloneCamera(source,target) {
  const r=await fetch("/api/fork",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({source,target}),signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw new Error("视觉历史无法恢复");
  return r.json();
}

function vehicle(index,station,seed) {
  const p=copy(stations[46].pad); p[0]-=index*2.3;
  return {index,station,seed,stream:stamp(),pos:p,est:copy(p),vel:[0,0,0],yaw:0,pitch:0,look:0,
    route:[],at:"depot",next:null,phase:"idle",returnTrip:false,airborne:false,cargo:false,delivered:false,
    fix:"初始已知停机位",map:new Knowledge(),frame:0,last:null,firstSense:null,
    lastSense:index===0?-1:2*step-sensorPeriod,lastMapPose:copy(p),
    distance:0,wait:0,energy:100,startingEnergy:100,deliveredError:null,trajectory:[],metrics:[],
    frameTimings:[],pendingControlFrame:null,lastVisionRttMs:null,
    odometry:{velocity:[0,0,0],reference:null,lastVision:0,anchors:new Map(),loops:[]},samples:[],accepted:0,unavailable:0,order:null,
    capacity:index===0?1.5:1.2,receipts:[],releaseAt:0,spent:0,
    observation:null, rangeTrack:null,blockedSince:null,visionNote:"等待机载帧",minGap:null,contacts:0};
}
function noise(b) {
  b.seed=(Math.imul(b.seed,1664525)+1013904223)>>>0; return b.seed/4294967296-.5;
}

// Simulated body-frame specific acceleration, with gravity compensated by the
// inertial attitude. The estimator receives acceleration, never physics velocity.
function accelerometer(before,after,yaw,t) {
  const [x,y,z]=after.map((n,i)=>(n-before[i])/step);
  const c=Math.cos(yaw),s=Math.sin(yaw);
  return [c*x-s*z+.0015+.014*Math.sin(17*t),y-.001+.013*Math.cos(13*t),
    s*x+c*z+.001+.015*Math.sin(11*t+.7)];
}
function propagate(b,reading) {
  const [x,y,z]=reading, c=Math.cos(b.yaw),s=Math.sin(b.yaw), a=[c*x+s*z,y,-s*x+c*z];
  const v=b.odometry.velocity;
  b.est=b.est.map((p,i)=>p+(v[i]+a[i]*step)*step);
  b.odometry.velocity=v.map((n,i)=>n+a[i]*step);
}
function measuredBerth(b,station,time,bay=0){
  if(b.last?.handoff.state!=="ready"||time-b.last.sim_time>=.65)return null;
  const panel=b.last.readings.find(r=>r.station===station)?.panel_relative_m;
  if(!panel)return null;
  const fixture=[-1.27-bay*2.3,-2.55,4.83];
  return b.est.map((n,i)=>n+panel[i]+fixture[i]+b.lastSensorOffset[i]);
}
// World-side receipt. Navigation gets an acknowledgement or must reobserve.
// Its position error is retained solely for the independent evaluation.
function dockContact(body,station,bay,occupied){
  const point=copy(stations[station].pad);point[0]-=bay*2.3;
  const error=distance(body.pos,point);
  return {accepted:!occupied && error<.45,error};
}

export class Simulation {
  constructor(city,notify,weights) {
    this.city=city;this.notify=notify;this.weights=weights;this.generation=0;this.pending=false;
    this.reset({station:17,chapter:4,fleet:false,weather:"day",avoid:[],gps:true});
  }
  reset(options) {
    this.generation++;this.options={...options};this.time=0;this.tick=0;this.running=false;this.paused=false;
    this.active=this.options.chapter>=4;this.events=[];this.inbox=[];this.pauseAt=null;this.serviceError=null;
    this.barred=false;this.timedEvents=[];this.reservations=new Map();this.activeUnit=0;this.keys=new Set();this.manual=false;
    this.units=[vehicle(0,options.station,1407)];
    const second=options.secondRoute==="shared"?options.station:options.station===17?31:17;
    if(options.fleet)this.units.push(vehicle(1,second,4892));
    if(options.lowBattery)this.units[0].energy=this.units[0].startingEnergy=5;
    this.orders=[{id:1,station:options.station,priority:options.priority||1,mass:.8,state:"queued"}];
    if(options.fleet)this.orders.push({id:2,station:second,priority:1,mass:.45,state:"queued"});
    this.linkLog=[];this.linkSeed=1741;
    this.clockDebt=0;this.speed=1;this.final=false;this.lastWall=performance.now();this.frameTimes=[];this.missingFrames=0;
    this.environment={barrier:false,moving:false,occupied:false};
    this.city.restriction.visible=options.avoid.length>0;
    this.city.barrier(false);this.city.climate(options.weather);
    for(const id of [17,31,46])this.city.panelState(id,"available");
    this.city.setRoute([]);this.city.animateCraft(this.units,0);
  }
  async snapshot() {
    if(!this.paused||this.pending||this.serviceError)throw new Error("快照需要已排空的仿真边界");
    const state=structuredClone(Object.fromEntries(stateKeys.map(k=>[k,this[k]])));
    for(const b of state.units){
      b.pendingControlFrame=null;
      const archive=stamp(), info=await cloneCamera(b.stream,archive);
      if(info.last_frame!==b.last?.id)throw new Error("视觉与仿真帧不同步");
      b.stream=archive;
    }
    return state;
  }
  async restore(snapshot) {
    const generation=++this.generation;
    const copyState=structuredClone(snapshot);
    for(const b of copyState.units){
      Object.setPrototypeOf(b.map,Knowledge.prototype);
      const stream=stamp(),info=await cloneCamera(b.stream,stream);
      if(info.last_frame!==b.last.id)throw new Error("恢复帧与快照不一致");
      b.stream=stream;b.last.stream=stream;
    }
    if(this.generation!==generation)throw new Error("当前任务已变化");
    Object.assign(this,copyState);
    this.clockDebt=0;this.lastWall=performance.now();this.paused=false;this.pauseAt=null;this.frameTimes=[];
    this.city.barrier(this.environment.barrier,this.environment.moving,this.options.worksite);this.city.eventTick(this.time);
    this.city.restriction.visible=this.options.avoid.length>0;
    this.city.climate(this.options.weather);
    this.city.panelState(this.options.station,this.environment.occupied?"occupied":"available");
    const b=this.units[this.activeUnit];
    this.city.setRoute([b.est,...[b.next,...b.route].filter(Boolean).map(k=>airWaypoint(k,b.index))]);
    this.city.animateCraft(this.units,this.time);
  }
  log(reason,b=this.units[this.activeUnit],kind="state") {
    const entry={time:this.time,unit:b.index,kind,reason,frame:b.last?.id??null};
    this.events.push(entry);this.notify(entry);
  }
  start() {
    if(this.running)return;
    this.running=true;this.dispatch();
  }
  dispatch() {
    const choose=(available,order)=>{
      if(!this.options.learned || available.length<2)return available[0].index;
      const key=dispatchState(available,order),ids=available.map(b=>b.index);
      return learnedAction(this.weights.dispatch,key,ids[0],ids);
    };
    for(const {order,vehicle:b,required} of allocateOrders(this.orders,this.units,new Set(this.options.avoid),choose)){
      order.state="assigned";order.unit=b.index;b.order=order.id;b.station=order.station;b.returnTrip=false;b.homeBerth=null;
      b.releaseAt=Math.max(this.time,b.index*(this.options.departure||(this.options.secondRoute==="shared"?13:4)));b.phase="idle";
      this.log((this.options.learned?"学习策略 · ":"")+"订单 "+order.id+" 分配至 AM–0"+(b.index+1)+"，预计含返仓预留需 "+required.toFixed(1)+"% 电量",b,"fleet");
    }
  }
  plan(b) {
    const closed=b.map.exclusions(this.time);
    for(const key of this.options.avoid)closed.add(key);
    const to=b.returnTrip?"depot":stations[b.station].node;
    b.route=pathBetween(b.at,to,closed).slice(1);
    b.next=b.route.shift()||null;
    if(!b.next && b.at!==to){b.phase="failed";b.visionNote="约束下无可用航路";this.log(b.visionNote,b);return;}
    b.phase=b.next?"cruise":b.returnTrip?"home":"holding";
    if(b.index===this.activeUnit)this.city.setRoute([copy(b.est),...[b.next,...b.route].filter(Boolean).map(k=>airWaypoint(k,b.index))]);
  }
  act(type,value,scripted=false) {
    if(type==="barrier"||type==="moving"){
      const zoneCenter=this.options.worksite==="north"?[-33,25,-14]:[-12,25,33];
      if(value && this.units.some(b=>distance(b.pos,zoneCenter)<11)){
        this.log("施工位置与机体保护区重叠，本次编辑未生效");return false;
      }
      this.environment.barrier=value;this.environment.moving=type==="moving"&&value;
      this.city.barrier(value,this.environment.moving,this.options.worksite);
    }else if(type==="occupied"){
      if(value && this.units.some(b=>distance(b.pos,stations[this.options.station].pad)<2)){
        this.log("站台正在交接，不能把障碍插入机体位置");return false;
      }
      this.environment.occupied=value;this.city.panelState(this.options.station,value?"occupied":"available");
    }else if(type==="gps"){this.options.gps=value;}
    else if(type==="link"){this.options.link=value;this.log("机间通信切换为"+({local:"校内链路",slow:"延迟链路",loss:"间歇链路",off:"断连"})[value],this.units[0],"fleet");return true;}
    else if(type==="zone"){this.options.avoid=value?restrictedEdges():[];
      this.city.restriction.visible=value;
      this.timedEvents=this.timedEvents.filter(e=>e.type!=="zone");
      if(value && this.options.zoneSeconds>0){
        this.timedEvents.push({at:this.time+this.options.zoneSeconds,type:"zone",value:false});
        this.timedEvents.sort((a,b)=>a.at-b.at);
      }
      for(const b of this.units)if(b.phase==="cruise"){
        if(value && this.options.avoid.includes(edgeId(b.at,b.next)))b.phase="retreat";
        else this.plan(b);
      }
    }
    this.log(({barrier:"通道施工",moving:"动态吊臂",occupied:"平台占用",gps:"GPS 更新",zone:"南侧通道限飞"})[type]+(value?"已开启":"已解除"),this.units[0],scripted?"script":"environment");
    return true;
  }
  recall(){
    const b=this.units[this.activeUnit],order=this.orders.find(o=>o.id===b.order);
    if(!order || b.returnTrip){this.log("当前无人机没有可召回的在途包裹",b,"fleet");return;}
    b.withdrawn=true;
    if(!b.airborne){
      order.state="queued";delete order.unit;b.order=null;b.phase="done";this.dispatch();
      this.log("未装载订单已释放",b,"fleet");return;
    }
    order.state="returning";b.returnTrip=true;b.look=0;b.observation=null;
    for(const [key,owner] of this.reservations)if(owner===b.index)this.reservations.delete(key);
    if(b.next)b.phase="retreat";
    else if(b.at==="depot")b.phase="home";
    else b.phase="returning";
    this.log("取消进站，包裹随本机返仓，抵达后办理交接",b,"fleet");
  }
  accept(b,result,rtt,sample) {
    b.last=result;b.pixels=sample.pixels;b.accepted++;b.lastVisionRttMs=rtt;
    if(sample.inFlightClock && this.running && !this.paused){
      b.pendingControlFrame={id:result.id,capturedAt:sample.capturedAt,visionMs:rtt};
    }
    b.firstSense??=result.sim_time;
    const odo=b.odometry,ref=odo.reference;
    if(this.options.gps && sample.gps) {
      if(ref?.gps && result.sim_time>ref.time){
        const dt=result.sim_time-ref.time;
        odo.velocity=odo.velocity.map((n,i)=>n+.06*bound((sample.gps[i]-ref.gps[i])/dt-n,1));
      }
      b.est=copy(sample.gps);b.fix="模拟 GPS";
    }else{
      const dt=ref?result.sim_time-ref.time:0;
      if(ref && dt>0 && result.translation_m && result.tracked_features>=6){
        const vo=result.translation_m.map((n,i)=>n-(sample.offset[i]-ref.offset[i]));
        const residual=vo.map((n,i)=>n-(b.est[i]-ref.position[i]));
        if(Math.hypot(...residual)<Math.max(.38,dt*1.8)){
          b.est=b.est.map((n,i)=>n+.12*residual[i]);
          odo.velocity=odo.velocity.map((n,i)=>n+.03*bound(residual[i]/dt,.6));
          odo.lastVision=result.sim_time;
        }
      }
      const age=result.sim_time-odo.lastVision;
      b.fix=age<.35?"RGB-D / 惯性融合":age<1.8?"惯性短时外推":"视觉跟踪不足";
    }
    const closure=result.loop_closure,anchor=closure?odo.anchors.get(closure.frame):null;
    if(anchor){
      const relative=anchor.map((n,i)=>n+closure.translation_m[i]-sample.offset[i]-b.est[i]);
      const difference=Math.hypot(...relative),applied=!this.options.gps && difference<2.5;
      odo.loops.push({frame:result.id,matched:closure.frame,inliers:closure.inliers,error_m:closure.residual_m,innovation_m:difference,applied});
      if(applied){
        b.est=b.est.map((n,i)=>n+relative[i]*Math.min(.45,.28/(difference||1)));
        odo.lastVision=result.sim_time;b.fix="RGB-D 关键帧重定位";
      }
      if(odo.loops.length>180)odo.loops.shift();
    }
    if(result.keyframe_added){
      odo.anchors.set(result.id,b.est.map((n,i)=>n+sample.offset[i]));
      if(odo.anchors.size>30)odo.anchors.delete([...odo.anchors.keys()][1]);
    }
    odo.reference={time:result.sim_time,position:copy(b.est),offset:sample.offset,gps:sample.gps};
    if(this.options.chapter>=3)b.map.rays(b.est.map((x,i)=>x+sample.offset[i]),result.rays_world_relative_m,result.sim_time);
    if(b.next && this.options.chapter>=3){
      const waypoint=airWaypoint(b.next,b.index),d=distance(b.est,waypoint);
      const probe=b.est.map((n,i)=>n+(waypoint[i]-n)*Math.min(1,4/(d||1)));
      b.clearance=b.map.clearance(probe,result.sim_time);
    }
    const range=result.sector_m[2], previous=b.rangeTrack;
    if(Number.isFinite(range))b.minRange=Math.min(b.minRange??Infinity,range);
    if(result.regions?.length)b.semanticFrames=(b.semanticFrames||0)+1;
    b.rangeTrack=Number.isFinite(range)?{range,time:result.sim_time,
      rate:previous?Math.max(-10,Math.min(10,(range-previous.range)/Math.max(.05,result.sim_time-previous.time))):0}:null;
    b.metrics.push(distance(sample.evaluationPose,b.est));
    if(b.metrics.length>5000)b.metrics.shift();
    if(b.accepted%4===1)b.samples.push({frame:result.id,time:result.sim_time,
      estimate:copy(b.est),truth:sample.evaluationPose,source:b.fix,features:result.tracked_features});
    if(b.samples.length>2400)b.samples.shift();
    b.visionNote=this.options.chapter===1?"本章执行固定航线，视觉识别未启用":result.handoff.reason;
    b.lastSensorOffset=sample.offset;
    if(b.lastMapPose && distance(b.est,b.lastMapPose)>.9){b.trajectory.push(copy(b.est));b.lastMapPose=copy(b.est);}
    if(b.trajectory.length>1800)b.trajectory.shift();
  }
  async sense() {
    const generation=this.generation;
    const batch=this.units.filter(b=>this.time-b.lastSense>=sensorPeriod-1e-8 && b.phase!=="done");
    if(!batch.length||this.pending)return;
    this.pending=true;
    try{
      await Promise.all(batch.map(async b=>{
        b.lastSense=this.time;const id=++b.frame,start=performance.now();
        const random=measurementRandom(6101+b.index*197,id);
        if(random()<(this.options.dropRate||0)){
          b.unavailable++;
          if(b.unavailable===1)this.log("机载相机首次模拟丢帧 F"+id,b,"sensor");
          return;
        }
        const ct=Math.cos(b.pitch),offset=[-.41*Math.sin(b.yaw+b.look)*ct,.23+.41*Math.sin(b.pitch),-.41*Math.cos(b.yaw+b.look)*ct];
        const sample={capturedAt:start,inFlightClock:this.running&&!this.paused,
                      gps:this.options.gps?b.pos.map(x=>x+noise(b)*.08):null,
                      offset,evaluationPose:copy(b.pos)};
        const capture=this.city.capture(b,id,this.time,b.stream,b.returnTrip?46:b.station,this.options.chapter,this.options.checkpoint||"selected",
          this.options.rangeLimit||90,this.options.depthNoise||0,random);
        sample.pixels=capture.pixels;
        const resp=await fetch("/api/frame",{method:"POST",body:capture.packet,signal:AbortSignal.timeout(5000)});
        if(!resp.ok)throw new Error("感知服务返回 "+resp.status);
        const result=await resp.json();
        if(this.generation===generation&&result.stream===b.stream&&result.id===id)this.accept(b,result,performance.now()-start,sample);
      }));
      if(this.generation===generation)this.serviceError=null;
    }catch(e){
      if(this.generation===generation){this.missingFrames++;
        if(!this.serviceError){this.serviceError=e.message;this.log("感知连接中断，飞行器等待新帧");}}
    }finally{this.pending=false;}
  }
  obstacle(b) {
    const track=b.rangeTrack;
    if(!track || this.time-track.time>.6 || !b.next)return false;
    const speed=Math.hypot(...b.odometry.velocity), future=this.options.chapter>=4?Math.min(0,track.rate)*.3:0;
    const waypoint=airWaypoint(b.next,b.index),yaw=Math.atan2(b.est[0]-waypoint[0],b.est[2]-waypoint[2]);
    if(Math.cos(b.yaw-yaw)<.9)return false;
    let clearance=track.range+future;
    if(this.options.chapter>=4)for(const r of b.last?.regions||[]){
      const [u,v]=r.predicted_uv_035s;
      if(r.label==="construction" && r.age>=3 && r.confidence>.8 && r.range_m!==null &&
        Math.abs(u-.5)<.16 && Math.abs(v-.5)<.22 && Math.abs(r.range_m-track.range)<3)
        clearance=Math.min(clearance,r.range_m+.35*Math.min(0,r.range_rate_m_s));
    }
    return clearance<Math.max(3.5,1.8+speed*speed/11) &&
      distance(b.est,waypoint)>track.range+.8;
  }
  share(b,key) {
    for(const peer of this.units)if(peer!==b){
      const link=this.options.link||"local",delay=link==="slow"?4:.6;
      this.linkSeed=(Math.imul(this.linkSeed,1664525)+1013904223)>>>0;
      const beyond=distance(b.est,peer.est)>(this.options.linkRange||250);
      const dropped=beyond||link==="off" || (link==="loss" && this.linkSeed/4294967296<.5);
      const message={from:b.index,to:peer.index,key,frame:b.last.id,observed:this.time,
        receive:this.time+delay,until:this.time+45,frameName:"classroom-world-m",
        observer_est_m:copy(b.est),position_sd_m:.35+(b.last.flow_residual_m||0),
        cells:[...b.map.voxels.values()].filter(c=>this.time-c.time<.7 && c.odds>1 && distance(c.point,b.est)<18)
          .slice(0,24).map(c=>({point:copy(c.point),odds:c.odds})),
        motion:(b.last.regions||[]).filter(r=>r.label==="construction").map(r=>({track:r.track,range_m:r.range_m,range_rate_m_s:r.range_rate_m_s})),
        confidence:b.observation.evidence.occupied/(b.observation.evidence.occupied+1)};
      this.linkLog.push({...message,event:dropped?"dropped":"sent",reason:beyond?"range":link});
      if(!dropped)this.inbox.push(message);
      this.log(dropped?"机间通信不可用，本次通道观测留在本机":"发送通道占用观测，模拟传输 "+delay+" 秒",b,"fleet");
    }
  }
  control(b) {
    const target=stations[b.station], here=b.est;
    let goal=copy(here), max=7, orient=true;
    if(b.phase==="idle"){
      if(this.running && b.order && this.time>=b.releaseAt){
        b.phase="climb";b.cargo=b.airborne=true;
        this.orders.find(o=>o.id===b.order).state="loaded";
        this.log("包裹已装载，起飞许可已取得",b,"fleet");
      }
      return {goal,max:0};
    }
    if(this.manual && b.index===this.activeUnit){
      const [x,y,z]=b.est,pad=Array.from(navigator.getGamepads?.()||[]).find(p=>p?.mapping==="standard");
      const axis=i=>Math.abs(pad?.axes[i]||0)>.15?pad.axes[i]:0;
      const dx=bound(Number(this.keys.has("d"))-Number(this.keys.has("a"))+axis(0),1);
      const dz=bound(Number(this.keys.has("s"))-Number(this.keys.has("w"))+axis(1),1);
      const dy=bound(Number(this.keys.has("e"))-Number(this.keys.has("q"))+(pad?.buttons[5]?.value||0)-(pad?.buttons[4]?.value||0),1);
      return {goal:[x+dx*4,y+dy*4,z+dz*4],max:4};
    }
    if(!this.options.gps && ["cruise","climb","retreat","returning"].includes(b.phase))
      b.pitch=smoothAngle(b.pitch,b.fix==="视觉跟踪不足"?-.53:-.17,.09);
    else b.pitch*=.88;
    const stale=this.time-(b.last?.sim_time??0)>1;
    if(stale||(!this.options.gps && b.fix==="视觉跟踪不足")||this.serviceError){b.wait+=step;return {goal,max:0};}
    switch(b.phase){
    case "climb": case "returning":
      goal=airWaypoint(b.phase==="climb"?"depot":target.node,b.index);
      if(distance(here,goal)<.65){b.at=b.phase==="climb"?"depot":target.node;this.plan(b);}
      break;
    case "cruise": {
      goal=airWaypoint(b.next,b.index);const key=edgeId(b.at,b.next);
      if(this.options.learned && b.last){
        const state=paceState(b.rangeTrack?.range,b.last.tracked_features,b.rangeTrack?.rate??0);
        const a=learnedAction(this.weights.pace,state,2,[0,1,2]);max=pace[a];b.pace={state,chosen_m_s:max};
      }
      if(b.clearance?.distance_m!=null && b.clearance.distance_m<2.2)max=Math.min(max,4.5);
      if(this.options.chapter>=4 && b.last){
        if(b.forecast?.frame!==b.last.id || b.forecast?.edge!==key || b.forecast?.nominal!==max){
          const aligned=Math.cos(b.yaw-Math.atan2(here[0]-goal[0],here[2]-goal[2]))>.9;
          const observed=aligned?b.rangeTrack?.range:null;
          const options=forecastPace(Math.hypot(...b.odometry.velocity),max,distance(here,goal),observed,b.rangeTrack?.rate||0);
          b.forecast={frame:b.last.id,edge:key,nominal:max,options};
        }
        max=b.forecast.options[0].speed;
      }
      const terminalKey="station:"+b.station;
      if(!b.returnTrip && b.next===target.node){
        const using=this.reservations.get(terminalKey);
        if(using!==undefined && using!==b.index){b.wait+=step;goal=here;break;}
        this.reservations.set(terminalKey,b.index);
      }
      const occupant=this.reservations.get(key);
      if(occupant!==undefined && occupant!==b.index){b.wait+=step;goal=here;break;}
      this.reservations.set(key,b.index);
      if(this.obstacle(b)){
        goal=here;b.wait+=step;
        if(b.blockedSince===null){b.blockedSince=this.time;this.log("前向深度观测触发制动",b,"vision");}
        if(this.active && this.time-b.blockedSince>.45){
          b.observation={from:b.last.id,time:this.time,range:b.rangeTrack.range,before:b.map.voxels.size,
            candidates:observationYaw(b.map,b.est,b.yaw,this.time)};
          if(this.options.learned){
            const candidates=b.observation.candidates,state=gazeState(candidates,b.last.sector_m);
            const rule=viewAngles.indexOf(candidates[0].offset),chosen=learnedAction(this.weights.gaze,state,rule,[0,1,2]);
            candidates.sort((a,b)=>Number(b.offset===viewAngles[chosen])-Number(a.offset===viewAngles[chosen]));
            b.observation.policy={state,rule,chosen};
          }
          b.phase="look";this.log("依据未知体素分布选择观察朝向",b,"vision");
        }
      }else{
        b.blockedSince=null;
        if(distance(here,goal)<.65){
          this.reservations.delete(key);
          if(b.at===target.node && b.returnTrip)this.reservations.delete(terminalKey);
          b.at=b.next;b.next=b.route.shift()||null;
          if(!b.next){b.phase=b.returnTrip?"home":"holding";this.log(b.returnTrip?"到达物流中心":"到达名义站区，读取站点面板",b);}
        }
      }
      break;
    }
    case "look":
      orient=false;b.look=smoothAngle(b.look,this.time-b.observation.time>2?0:b.observation.candidates[0].offset,.12);
      if(this.time-b.observation.time>.75 && b.last && b.last.id>b.observation.from+1){
        const seen=inspectPassage(here,airWaypoint(b.next,b.index),b.last.rays_world_relative_m,b.observation.range);
        b.observation.evidence={frame:b.last.id,...seen,newCells:b.map.voxels.size-b.observation.before};
        if(seen.occupied>=2){
          const key=edgeId(b.at,b.next);b.map.observeEdge(key,this.time,b.index,b.last.id);
          this.log("F"+b.last.id+" 的 "+seen.occupied+" 条测距射线确认通道占用，退回后改道",b,"vision");
          if(this.units.length>1)this.share(b,key);
          b.phase="retreat";b.look=0;b.blockedSince=null;
        }else if(seen.free>=3){
          b.phase="cruise";b.look=0;b.blockedSince=null;this.log("新距离观测确认前方已清空，恢复通行",b,"vision");
        }
      }
      b.wait+=step;break;
    case "retreat":
      goal=airWaypoint(b.at,b.index);
      if(distance(here,goal)<.65){this.reservations.delete(edgeId(b.at,b.next));this.plan(b);}
      break;
    case "holding":
      goal=target.hold;max=3.5;
      if(distance(here,goal)<.3){b.phase="verify";this.log("等待指定站点的两次独立视觉确认",b,"vision");}
      break;
    case "verify":
      orient=false;goal=target.hold;b.wait+=step;b.yaw=smoothAngle(b.yaw,0,.14);b.pitch*=.85;
      b.berth=measuredBerth(b,b.station,this.time);
      if(b.berth){this.log("机载图像及深度确认站台位置，开始进站",b,"vision");b.phase="dock";}
      break;
    case "dock":
      goal=b.berth;max=1.8;orient=false;
      if(b.last?.readings.some(r=>r.station===b.station && r.state==="occupied"&&r.confidence>=.8)){
        b.phase="holding";this.log("进站期间读到占用，撤回等待位",b,"vision");break;
      }
      if(distance(here,goal)<.24 && Math.hypot(...b.odometry.velocity)<.55){
        const receipt=dockContact(b,b.station,0,this.environment.occupied && b.station===this.options.station);
        if(receipt.accepted && b.cargo){
          b.delivered=true;b.cargo=false;b.deliveredError=receipt.error;b.returnTrip=true;b.phase="returning";
          const order=this.orders.find(o=>o.id===b.order);order.state="delivered";order.receipt=this.time;
          b.receipts.push({order:b.order,frame:b.last.id,time:this.time,error_m:receipt.error});
          this.log("站台接触回执已确认，包裹已交付",b,"receipt");
        }else{b.phase="holding";this.log("站台未发出交接回执，重新观察",b);}
      }
      break;
    case "home":
      orient=false;b.yaw=smoothAngle(b.yaw,0,.13);max=3;
      if(!b.homeBerth){
        goal=copy(stations[46].hold);goal[0]-=b.index*2.3;
        if(distance(here,goal)<.55){
          b.homeBerth=measuredBerth(b,46,this.time,b.index);
          if(b.homeBerth)this.log("机载视觉确认物流中心回收仓位",b,"vision");
          else if(this.options.chapter===1 && this.options.gps){
            b.homeBerth=copy(stations[46].pad);b.homeBerth[0]-=b.index*2.3;
            this.log("航线自动化按公布仓位和模拟 GPS 进站",b,"state");
          }
        }
        break;
      }
      goal=b.homeBerth;max=2;
      if(distance(here,goal)<.24&&Math.hypot(...b.odometry.velocity)<.6){
        const receipt=dockContact(b,46,b.index,false);
        if(!receipt.accepted){b.homeBerth=null;this.log("回收仓位无接触回执，重新观察",b,"receipt");break;}
        b.homeError=receipt.error;
        b.phase="done";b.airborne=false;b.vel=[0,0,0];b.odometry.velocity=[0,0,0];
        if(b.cargo && b.withdrawn){
          const order=this.orders.find(o=>o.id===b.order);
          order.state=this.units.some(u=>u!==b&&!u.withdrawn)?"queued":"returned";
          order.returned_by=b.index;order.depot_time=this.time;delete order.unit;b.cargo=false;
          this.log("仓位确认包裹已退回"+(order.state==="queued"?"，订单重新进入调度":"，订单结束"),b,"receipt");
        }
        b.order=null;b.at="depot";this.log("返仓完成",b,"receipt");this.dispatch();
      }
      break;
    default:return {goal,max:0};
    }
    if(orient && distance(here,goal)>.7 && Math.hypot(goal[0]-here[0],goal[2]-here[2])>.5){
      b.yaw=smoothAngle(b.yaw,Math.atan2(here[0]-goal[0],here[2]-goal[2]),.12);
    }
    return {goal,max};
  }
  advance() {
    this.tick++;this.time=this.tick*step;
    while(this.timedEvents.length && this.timedEvents[0].at<=this.time){
      const e=this.timedEvents.shift();this.act(e.type,e.value,true);
    }
    this.city.eventTick(this.time);
    this.inbox=this.inbox.filter(m=>{
      if(m.receive>this.time)return true;
      const b=this.units[m.to];
      if(m.until<this.time || this.options.link==="off" || !b.map.observeEdge(m.key,m.observed,m.from,m.frame)){
        this.linkLog.push({...m,event:"discarded",at:this.time});return false;
      }
      const fusion=b.map.mergeShared(m.cells,m.observed,m.from,m.confidence);
      this.linkLog.push({...m,...fusion,event:"fused",at:this.time});
      this.log("收到 "+(m.from+1)+" 号机的通道观测 F"+m.frame,b,"fleet");
      if(b.phase==="cruise" && [edgeId(b.at,b.next),...b.route.map((n,i)=>edgeId(i?b.route[i-1]:b.next,n))].includes(m.key))
        {b.phase="retreat";this.log("共享观测改变了后续航路",b,"fleet");}
      return false;
    });
    for(const b of this.units){
      const {goal,max}=this.control(b);
      const observation=b.pendingControlFrame;
      if(observation){
        if(b.airborne || b.phase==="done"){
          b.frameTimings.push({frame:observation.id,control_tick:this.tick,
            vision_ms:observation.visionMs,command_ms:performance.now()-observation.capturedAt});
          if(b.frameTimings.length>5000)b.frameTimings.shift();
        }
        b.pendingControlFrame=null;
      }
      if(!b.airborne || b.phase==="failed")continue;
      const before=copy(b.pos), wind=this.options.weather==="rain"?.15*Math.sin(this.time*.7):0;
      const priorVelocity=copy(b.vel);
      integrate(b,goal,b.est,step,max,wind);
      if(this.city.collision(before,b.pos)){b.pos=before;b.vel=[0,0,0];b.phase="failed";b.contacts++;
        for(const [k,n] of this.reservations)if(n===b.index)this.reservations.delete(k);
        this.log("三维碰撞评测触发，任务停止",b,"collision");}
      propagate(b,accelerometer(priorVelocity,b.vel,b.yaw,this.time));
      const consumed=(.035+.006*Math.hypot(...b.vel)+(b.cargo?.012:0))*step;
      b.distance+=distance(before,b.pos);b.energy=Math.max(0,b.energy-consumed);b.spent+=consumed;
    }
    if(this.orders.some(o=>o.state==="queued") && this.tick%30===0){
      for(const b of this.units)if(!b.order&&!b.airborne)b.energy=Math.min(100,b.energy+.32);
      this.dispatch();
    }
    if(this.orders.every(o=>o.state==="delivered") || this.units.some(b=>b.phase==="failed")){
      for(const b of this.units)if(!b.order && b.phase==="idle")b.phase="done";
    }
    if(this.units.length===2){
      const [a,b]=this.units,gap=distance(a.pos,b.pos);
      a.minGap=b.minGap=Math.min(a.minGap??Infinity,gap);
      if(gap<.65 && (a.airborne||b.airborne) && a.phase!=="failed" && b.phase!=="failed"){
        for(const who of this.units){who.phase="failed";who.contacts++;who.vel=[0,0,0];}
        this.log("双机间距触发机体碰撞评测",a,"collision");
      }
    }
    this.final=this.units.every(b=>["done","failed"].includes(b.phase));
    if(this.final)this.running=false;
  }
  frame(now) {
    const interval=now-this.lastWall, dt=Math.min(.09,interval/1000);this.lastWall=now;
    if(this.paused)for(const b of this.units)b.pendingControlFrame=null;
    if(this.running&&!this.paused&&interval>0){this.frameTimes.push(interval);this.city.budget(interval);if(this.frameTimes.length>10000)this.frameTimes.shift();}
    if(this.running&&!this.paused){
      this.clockDebt=Math.min(.22,this.clockDebt+dt*this.speed);
      while(this.clockDebt>=step && !this.pending){
        // Commit all observations at their acquisition tick. Wall-clock RPC
        // jitter cannot change which simulation tick first sees a measurement.
        if(this.units.some(b=>b.phase!=="done"&&this.time-b.lastSense>=sensorPeriod-1e-8))break;
        this.advance();this.clockDebt-=step;
        if(this.pauseAt!==null&&this.tick>=this.pauseAt){this.paused=true;break;}
        if(this.final)break;
      }
    }
    this.city.animateCraft(this.units,this.time);
    if(!this.paused&&!this.final)this.sense();
    this.city.draw(this.units[this.activeUnit],this.time);
  }
}
