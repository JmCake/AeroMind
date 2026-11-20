import {distance, edgeId, inspectPassage, integrate, Knowledge, nodes, observationYaw, pathBetween, stations} from "./navigation.js";

const step=1/30, sensorPeriod=1/8;
const titles={idle:"等待订单",climb:"装载起飞",cruise:"航路配送",look:"主动观察",retreat:"退回已知航点",
  holding:"进入站点",verify:"视觉确认",dock:"下降交接",returning:"返航起飞",home:"返回物流中心",
  done:"已返航",failed:"任务受阻"};
export const phaseName=x=>titles[x]||x;
const smoothAngle=(a,b,k)=>a+Math.atan2(Math.sin(b-a),Math.cos(b-a))*k;
const copy=p=>[...p];
const stamp=()=>crypto.randomUUID();
const stateKeys=["options","tick","time","active","units","events","inbox","timedEvents",
  "reservations","activeUnit","environment","manual","keys","speed","running","final","missingFrames"];

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
    fix:"初始已知停机位",map:new Knowledge(),frame:0,last:null,lastSense:-1,lastMapPose:copy(p),
    distance:0,wait:0,energy:100,deliveredError:null,trajectory:[],metrics:[],latencies:[],
    observation:null, rangeTrack:null,blockedSince:null,visionNote:"等待机载帧",minGap:null,contacts:0};
}
function noise(b) {
  b.seed=(Math.imul(b.seed,1664525)+1013904223)>>>0; return b.seed/4294967296-.5;
}

export class Simulation {
  constructor(city,notify) {
    this.city=city;this.notify=notify;this.generation=0;this.pending=false;
    this.reset({station:17,chapter:4,fleet:false,weather:"day",avoid:[],gps:true});
  }
  reset(options) {
    this.generation++;this.options={...options};this.time=0;this.tick=0;this.running=false;this.paused=false;
    this.active=this.options.chapter>=4;this.events=[];this.inbox=[];this.pauseAt=null;this.serviceError=null;
    this.barred=false;this.timedEvents=[];this.reservations=new Map();this.activeUnit=0;this.keys=new Set();this.manual=false;
    this.units=[vehicle(0,options.station,1407)];
    if(options.fleet)this.units.push(vehicle(1,options.station===17?31:17,4892));
    this.clockDebt=0;this.speed=1;this.final=false;this.lastWall=performance.now();this.frameTimes=[];this.missingFrames=0;
    this.environment={barrier:false,moving:false,occupied:false};
    this.city.barrier(false);this.city.climate(options.weather);
    for(const id of [17,31,46])this.city.panelState(id,"available");
    this.city.setRoute([]);this.city.animateCraft(this.units,0);
  }
  async snapshot() {
    if(!this.paused||this.pending||this.serviceError)throw new Error("快照需要已排空的仿真边界");
    const state=structuredClone(Object.fromEntries(stateKeys.map(k=>[k,this[k]])));
    for(const b of state.units){
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
    this.city.barrier(this.environment.barrier,this.environment.moving);this.city.eventTick(this.time);
    this.city.climate(this.options.weather);
    this.city.panelState(this.options.station,this.environment.occupied?"occupied":"available");
    const b=this.units[this.activeUnit];
    this.city.setRoute([b.est,...[b.next,...b.route].filter(Boolean).map(k=>nodes[k])]);
    this.city.animateCraft(this.units,this.time);
  }
  log(reason,b=this.units[this.activeUnit],kind="state") {
    const entry={time:this.time,unit:b.index,kind,reason,frame:b.last?.id??null};
    this.events.push(entry);this.notify(entry);
  }
  start() {
    if(this.running)return;
    this.running=true;this.units[0].phase="climb";this.units[0].cargo=true;this.units[0].airborne=true;
    this.log("包裹已装载，起飞许可已取得");
    if(this.units.length>1)this.log("第二笔订单分配给二号机，等待起飞位",this.units[1],"fleet");
  }
  plan(b) {
    const closed=b.map.exclusions(this.time);
    for(const key of this.options.avoid)closed.add(key);
    const to=b.returnTrip?"depot":stations[b.station].node;
    b.route=pathBetween(b.at,to,closed).slice(1);
    b.next=b.route.shift()||null;
    if(!b.next && b.at!==to){b.phase="failed";b.visionNote="约束下无可用航路";this.log(b.visionNote,b);return;}
    b.phase=b.next?"cruise":b.returnTrip?"home":"holding";
    if(b.index===this.activeUnit)this.city.setRoute([copy(b.est),...[b.next,...b.route].filter(Boolean).map(k=>nodes[k])]);
  }
  act(type,value,scripted=false) {
    if(type==="barrier"||type==="moving"){
      if(value && this.units.some(b=>distance(b.pos,[-12,25,33])<9)){
        this.log("施工位置与机体保护区重叠，本次编辑未生效");return false;
      }
      this.environment.barrier=value;this.environment.moving=type==="moving"&&value;
      this.city.barrier(value,this.environment.moving);
    }else if(type==="occupied"){
      this.environment.occupied=value;this.city.panelState(this.options.station,value?"occupied":"available");
    }else if(type==="gps"){this.options.gps=value;}
    else if(type==="zone"){this.options.avoid=value?[edgeId("west","junction")]:[];
      for(const b of this.units)if(b.phase==="cruise"){
        if(value && edgeId(b.at,b.next)===this.options.avoid[0])b.phase="retreat";
        else this.plan(b);
      }
    }
    this.log(({barrier:"通道施工",moving:"动态吊臂",occupied:"平台占用",gps:"GPS 更新",zone:"南侧通道限飞"})[type]+(value?"已开启":"已解除"),this.units[0],scripted?"script":"environment");
    return true;
  }
  accept(b,result,rtt,sample) {
    b.last=result; b.latencies.push(rtt);
    if(b.latencies.length>5000)b.latencies.shift();
    if(this.options.gps && sample.gps) {
      b.est=sample.gps; b.fix="模拟 GPS";
    } else if(result.translation_m) {
      b.est=b.est.map((x,i)=>x+result.translation_m[i]);b.fix="RGB-D 视觉 / 惯性朝向";
    } else b.fix="视觉跟踪不足";
    if(this.options.chapter>=3)b.map.rays(b.est.map((x,i)=>x+sample.offset[i]),result.rays_world_relative_m,result.sim_time);
    const range=result.sector_m[2], previous=b.rangeTrack;
    b.rangeTrack=Number.isFinite(range)?{range,time:result.sim_time,
      rate:previous?Math.max(-10,Math.min(10,(range-previous.range)/Math.max(.05,result.sim_time-previous.time))):0}:null;
    b.metrics.push(distance(sample.evaluationPose,b.est));
    if(b.metrics.length>5000)b.metrics.shift();
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
        const offset=[-.41*Math.sin(b.yaw+b.look),.23,-.41*Math.cos(b.yaw+b.look)];
        const sample={gps:this.options.gps?b.pos.map(x=>x+noise(b)*.08):null,
                      offset,evaluationPose:copy(b.pos)};
        const bytes=this.city.capture(b,id,this.time,b.stream,b.station,this.options.chapter,b.index===this.activeUnit);
        const resp=await fetch("/api/frame",{method:"POST",body:bytes,signal:AbortSignal.timeout(5000)});
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
    const speed=Math.hypot(...b.vel), future=this.options.chapter>=4?Math.min(0,track.rate)*.3:0;
    const yaw=Math.atan2(b.est[0]-nodes[b.next][0],b.est[2]-nodes[b.next][2]);
    if(Math.cos(b.yaw-yaw)<.9)return false;
    return track.range+future<Math.max(3.5,1.8+speed*speed/11) &&
      distance(b.est,nodes[b.next])>track.range+.8;
  }
  share(b,key) {
    for(const peer of this.units)if(peer!==b){
      this.inbox.push({from:b.index,to:peer.index,key,frame:b.last.id,observed:this.time,
                       receive:this.time+.6,until:this.time+45,frameName:"classroom-world-m"});
      this.log("发送通道占用观测，模拟传输 0.6 秒",b,"fleet");
    }
  }
  control(b) {
    const target=stations[b.station], here=b.est;
    let goal=copy(here), max=7, orient=true;
    if(b.phase==="idle"){
      if(this.running && b.index===1 && this.time>=4){
        b.phase="climb";b.cargo=b.airborne=true;this.log("起飞位释放，二号机领取包裹",b,"fleet");
      }
      return {goal,max:0};
    }
    if(this.manual && b.index===this.activeUnit){
      const [x,y,z]=b.est; const dx=Number(this.keys.has("d"))-Number(this.keys.has("a"));
      const dz=Number(this.keys.has("s"))-Number(this.keys.has("w"));
      const dy=Number(this.keys.has("e"))-Number(this.keys.has("q"));
      return {goal:[x+dx*4,y+dy*4,z+dz*4],max:4};
    }
    if((!this.options.gps && b.fix==="视觉跟踪不足")||this.serviceError){b.wait+=step;return {goal,max:0};}
    switch(b.phase){
    case "climb": case "returning":
      goal=nodes[b.phase==="climb"?"depot":target.node];
      if(distance(here,goal)<.65){b.at=b.phase==="climb"?"depot":target.node;this.plan(b);}
      break;
    case "cruise": {
      goal=nodes[b.next];const key=edgeId(b.at,b.next);
      const occupant=this.reservations.get(key);
      if(occupant!==undefined && occupant!==b.index){b.wait+=step;goal=here;break;}
      this.reservations.set(key,b.index);
      if(this.obstacle(b)){
        goal=here;b.wait+=step;
        if(b.blockedSince===null){b.blockedSince=this.time;this.log("前向深度观测触发制动",b,"vision");}
        if(this.active && this.time-b.blockedSince>.45){
          b.observation={from:b.last.id,time:this.time,range:b.rangeTrack.range,before:b.map.voxels.size,
            candidates:observationYaw(b.map,b.est,b.yaw,this.time)};
          b.phase="look";this.log("依据未知体素分布选择观察朝向",b,"vision");
        }
      }else{
        b.blockedSince=null;
        if(distance(here,goal)<.65){
          this.reservations.delete(key);b.at=b.next;b.next=b.route.shift()||null;
          if(!b.next){b.phase=b.returnTrip?"home":"holding";this.log(b.returnTrip?"到达物流中心":"到达名义站区，读取站点面板",b);}
        }
      }
      break;
    }
    case "look":
      orient=false;b.look=smoothAngle(b.look,this.time-b.observation.time>2?0:b.observation.candidates[0].offset,.12);
      if(this.time-b.observation.time>.75 && b.last && b.last.id>b.observation.from+1){
        const seen=inspectPassage(here,nodes[b.next],b.last.rays_world_relative_m,b.observation.range);
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
      goal=nodes[b.at];
      if(distance(here,goal)<.65){this.reservations.delete(edgeId(b.at,b.next));this.plan(b);}
      break;
    case "holding":
      goal=target.hold;max=3.5;
      if(distance(here,goal)<.3){b.phase="verify";this.log("等待指定站点的两次独立视觉确认",b,"vision");}
      break;
    case "verify":
      orient=false;goal=target.hold;b.wait+=step;b.yaw=smoothAngle(b.yaw,0,.14);b.pitch*=.85;
      if(b.last?.handoff.state==="ready" && this.time-b.last.sim_time<.65){
        const panel=b.last.readings.find(r=>r.station===b.station)?.panel_relative_m;
        if(panel){
          // Only the fictional station fixture defines this offset from its
          // status tile to the mechanical cradle. The evaluator owns pad truth.
          const offset=[-1.27,-2.55,4.83].map((x,i)=>x+b.lastSensorOffset[i]);
          b.berth=here.map((n,i)=>n+panel[i]+offset[i]);
          this.log("机载图像及深度确认站台位置，开始进站",b,"vision");b.phase="dock";
        }
      }
      break;
    case "dock":
      goal=b.berth;max=1.8;orient=false;
      if(b.last?.readings.some(r=>r.station===b.station && r.state==="occupied"&&r.confidence>=.8)){
        b.phase="holding";this.log("进站期间读到占用，撤回等待位",b,"vision");break;
      }
      if(distance(here,goal)<.24 && Math.hypot(...b.vel)<.55){
        // Independent world-side dock contact/parcel receipt. Visible status
        // is separate from the collision volume and its physical occupancy.
        const err=distance(b.pos,target.pad);
        if(err<.45 && b.cargo && !(this.environment.occupied && b.station===this.options.station)){
          b.delivered=true;b.cargo=false;b.deliveredError=err;b.returnTrip=true;b.phase="returning";
          this.log("站台接触回执已确认，包裹已交付",b,"receipt");
        }else{b.phase="holding";this.log("站台未发出交接回执，重新观察",b);}
      }
      break;
    case "home":
      goal=copy(stations[46].pad);goal[0]-=b.index*2.3;max=3;
      if(distance(here,goal)<.25&&Math.hypot(...b.vel)<.6){b.phase="done";b.airborne=false;b.vel=[0,0,0];this.log("返仓完成",b,"receipt");}
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
      const b=this.units[m.to];if(m.until<this.time)return false;
      b.map.observeEdge(m.key,m.observed,m.from,m.frame);
      this.log("收到 "+(m.from+1)+" 号机的通道观测 F"+m.frame,b,"fleet");
      if(b.phase==="cruise" && [edgeId(b.at,b.next),...b.route.map((n,i)=>edgeId(i?b.route[i-1]:b.next,n))].includes(m.key))
        {b.phase="retreat";this.log("共享观测改变了后续航路",b,"fleet");}
      return false;
    });
    for(const b of this.units){
      const {goal,max}=this.control(b);
      if(!b.airborne || b.phase==="failed")continue;
      const before=copy(b.pos), wind=this.options.weather==="rain"?.15*Math.sin(this.time*.7):0;
      integrate(b,goal,b.est,step,max,wind);
      if(this.city.collision(before,b.pos)){b.pos=before;b.vel=[0,0,0];b.phase="failed";b.contacts++;
        for(const [k,n] of this.reservations)if(n===b.index)this.reservations.delete(k);
        this.log("三维碰撞评测触发，任务停止",b,"collision");}
      b.distance+=distance(before,b.pos);b.energy=Math.max(0,b.energy-(.035+.006*Math.hypot(...b.vel)+(b.cargo?.012:0))*step);
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
    if(this.running&&!this.paused&&interval>0){this.frameTimes.push(interval);if(this.frameTimes.length>10000)this.frameTimes.shift();}
    if(this.running&&!this.paused){
      this.clockDebt=Math.min(.22,this.clockDebt+dt*this.speed);
      while(this.clockDebt>=step){
        // While sensor data is in flight, the simulation clock can advance one
        // acquisition period. Slow machines retain valid timestamps and hold.
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
