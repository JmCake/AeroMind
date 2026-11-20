// Local classroom coordinates are metres, +Y up. These are declared public
// air lanes and nominal station regions, independent of the live obstacle layer.
export const stations = {
  46: {name:"物流中心", node:"depot", pad:[-50,9.18,62], hold:[-50,11.8,65.2]},
  17: {name:"图书馆", node:"library", pad:[7,16.02,2], hold:[7,18.6,5.3]},
  31: {name:"居民服务站", node:"residence", pad:[10,5.65,-52], hold:[10,8.3,-48.7]}
};

export const nodes = {
  depot:[-50,25,62], west:[-33,25,33], junction:[7,25,33],
  east:[33,25,33], north:[33,25,-31], bypass:[-33,25,-31],
  library:[7,25,5.3], residence:[10,25,-48.7], plaza:[-40,28,4],
  south:[-33,25,64], boulevard:[33,25,64]
};
export const edges = [
  ["depot","south"],["south","west"],["west","junction"],["junction","library"],
  ["junction","east"],["east","north"],["north","residence"],["west","plaza"],
  ["plaza","library"],["plaza","bypass"],["bypass","residence"],["south","boulevard"],
  ["boulevard","east"]
];
export const distance = (a,b) => Math.hypot(...a.map((v,i)=>v-b[i]));
export const edgeId = (a,b) => [a,b].sort().join("|");

// Published altitude layers separate approaching traffic from a waiting
// vehicle at a junction. The final station approach still has one berth.
export function airWaypoint(node,index) {
  const [x,y,z]=nodes[node];return [x,y+index*3.8,z];
}
export const sportsAirspace={min:[-28,18,30.5],max:[2,32,55]};
export function intersectsZone(a,b,zone=sportsAirspace){
  let enter=0,leave=1;
  for(let i=0;i<3;i++){
    const delta=b[i]-a[i];
    if(Math.abs(delta)<1e-8){
      if(a[i]<zone.min[i]||a[i]>zone.max[i])return false;
      continue;
    }
    const u=(zone.min[i]-a[i])/delta,v=(zone.max[i]-a[i])/delta;
    enter=Math.max(enter,Math.min(u,v));leave=Math.min(leave,Math.max(u,v));
    if(enter>leave)return false;
  }
  return true;
}
export function restrictedEdges(index=0){
  return edges.filter(([a,b])=>intersectsZone(airWaypoint(a,index),airWaypoint(b,index))).map(([a,b])=>edgeId(a,b));
}

export function measurementRandom(seed,frame){
  let state=(seed^Math.imul(frame+1,2654435761))>>>0;
  return ()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296;};
}

export function pathBetween(start, goal, closed=new Set()) {
  const cost = new Map([[start,0]]), previous = new Map(), open = new Set([start]);
  while (open.size) {
    const here = [...open].sort((a,b)=>cost.get(a)-cost.get(b) || a.localeCompare(b))[0];
    open.delete(here);
    if (here === goal) {
      const route = [goal];
      while (previous.has(route[0])) route.unshift(previous.get(route[0]));
      return route;
    }
    for (const [a,b] of edges) {
      const next = a === here ? b : b === here ? a : null;
      if (!next || closed.has(edgeId(a,b))) continue;
      const value = cost.get(here) + distance(nodes[here],nodes[next]);
      if (value >= (cost.get(next) ?? Infinity)) continue;
      cost.set(next,value); previous.set(next,here); open.add(next);
    }
  }
  return [];
}

export class Knowledge {
  constructor() { this.voxels=new Map(); this.blocked=new Map(); }
  key(p) { return p.map(v=>Math.floor(v/4)).join(","); }
  rays(origin, endpoints, time) {
    for (const delta of endpoints) {
      const length = Math.hypot(...delta);
      const steps = Math.min(24,Math.ceil(length/3));
      for (let i=1;i<=steps;i++) {
        const point = origin.map((v,k)=>v+delta[k]*i/steps);
        const key=this.key(point), old=this.voxels.get(key);
        const prior=old && time-old.time<15 ? old.odds : 0;
        this.voxels.set(key,{point, odds:Math.max(-4,Math.min(4,prior+(i===steps ? 1.5 : -.5))),time});
      }
    }
    for (const [key,item] of this.voxels) if (time-item.time>30) this.voxels.delete(key);
  }
  exclusions(time) {
    for (const [key,entry] of this.blocked) if (entry.until < time) this.blocked.delete(key);
    return new Set(this.blocked.keys());
  }
  clearance(point,time){
    const origin=point.map(v=>Math.floor(v/4));let best=Infinity,known=0;
    for(let x=-2;x<=2;x++)for(let y=-2;y<=2;y++)for(let z=-2;z<=2;z++){
      const cell=this.voxels.get([origin[0]+x,origin[1]+y,origin[2]+z].join(","));
      if(!cell||time-cell.time>12)continue;
      known++;
      if(cell.odds>1)best=Math.min(best,distance(point,cell.point));
    }
    return {distance_m:Number.isFinite(best)?best:null,observed_fraction:known/125};
  }
  mergeShared(cells,stamp,source,confidence){
    let fused=0,conflicts=0;
    for(const {point,odds} of cells){
      const key=this.key(point),old=this.voxels.get(key);
      if(old && old.time>=stamp)continue;
      if(old && stamp-old.time<2 && old.odds*odds<0){conflicts++;continue;}
      const prior=old && stamp-old.time<15?old.odds:0;
      this.voxels.set(key,{point:[...point],odds:Math.max(-4,Math.min(4,prior+odds*confidence*.65)),time:stamp,source});
      fused++;
    }
    return {fused,conflicts};
  }
  observeEdge(key, time, source, frame) {
    const previous=this.blocked.get(key);
    if(previous && previous.time>=time)return false;
    this.blocked.set(key,{until:time+45,time,source,frame});
    return true;
  }
}

export function orderFromText(text) {
  const request=text.trim(),urgent=/^(?:请)?(?:优先|加急)/.test(request);
  const match = request.replace(/^(?:请)?(?:优先|加急)/,"").match(/^(?:请)?(?:将|把)?(?:包裹|图书|教材)?(?:配送到|送至|送到|前往)(图书馆|居民服务站)(?:屋顶|指定平台|平台)?(?:[，, ]*(?:避开|绕开)(体育场上空|南侧通道))?[。！!]?$/);
  if (!match) throw new Error("请指定一个配送站和可识别的空域，例如“将包裹送到图书馆指定平台，避开体育场上空”。");
  return {station:match[1]==="图书馆" ? 17 : 31, priority:urgent?2:1,avoid:match[2] ? [edgeId("west","junction")] : []};
}

export function allocateOrders(orders,vehicles,closed,choose=null) {
  const waiting=orders.filter(o=>o.state==="queued").sort((a,b)=>b.priority-a.priority || a.id-b.id);
  const idle=vehicles.filter(b=>!b.airborne && !b.order && !b.withdrawn && ["idle","done"].includes(b.phase));
  const result=[];
  for(const order of waiting){
    const route=pathBetween("depot",stations[order.station].node,closed);
    if(route.length<2)continue;
    const length=route.slice(1).reduce((s,n,i)=>s+distance(nodes[route[i]],nodes[n]),0);
    // Conservative return-trip energy estimate and a 3% landing reserve.
    const required=3+(2*length+52)*(.035+.006*5+.012)/(5*.84);
    const available=idle.filter(b=>b.energy>=required && b.capacity>=order.mass)
      .sort((a,b)=>b.energy-a.energy || a.index-b.index);
    if(!available.length)continue;
    const preferred=choose?.(available,order);
    const chosen=available.find(b=>b.index===preferred)||available[0];idle.splice(idle.indexOf(chosen),1);
    result.push({order,vehicle:chosen,required});
  }
  return result;
}

export function observationYaw(map, pose, yaw, time) {
  const offsets=[-.5,.5,0];
  const candidates=offsets.map(offset=>{
    let gain=0;
    for (let r=4;r<=24;r+=4) {
      const key=map.key([pose[0]-Math.sin(yaw+offset)*r,pose[1],pose[2]-Math.cos(yaw+offset)*r]);
      const seen=map.voxels.get(key);
      gain+=!seen || time-seen.time>15 ? 1 : 1/(1+Math.abs(seen.odds));
    }
    return {offset,gain,score:gain-.28*Math.abs(offset)};
  });
  return candidates.sort((a,b)=>b.score-a.score);
}

export function inspectPassage(origin, waypoint, rays, observedRange) {
  const offset=waypoint.map((n,i)=>n-origin[i]), length=Math.hypot(...offset);
  if(length<.1)return {occupied:0,free:0};
  const axis=offset.map(n=>n/length), probe=Math.max(2,Math.min(12,observedRange));
  let occupied=0,free=0;
  for(const ray of rays){
    const along=ray.reduce((s,n,i)=>s+n*axis[i],0);
    if(along<.4)continue;
    const side=Math.hypot(...ray.map((n,i)=>n-axis[i]*along));
    if(side<1.9 && along<Math.min(length,probe+3))occupied++;
    if(along>probe+2 && side*probe/along<1.9)free++;
  }
  return {occupied,free};
}

export function integrate(body, goal, estimate, dt, maxSpeed, wind=0) {
  const offset=goal.map((v,i)=>v-estimate[i]), range=Math.hypot(...offset);
  const speed=Math.min(maxSpeed,range*1.55,Math.sqrt(2*4*range));
  const wanted=range>0 ? offset.map(v=>v/range*speed) : [0,0,0];
  const acceleration=wanted.map((v,i)=>v-body.vel[i]);
  const factor=Math.min(1,5.5*dt/(Math.hypot(...acceleration)||1));
  body.vel=body.vel.map((v,i)=>v+acceleration[i]*factor);
  body.pos=body.pos.map((v,i)=>v+(body.vel[i]+(i===0 ? wind : 0))*dt);
}

// Receding-horizon pace selection for the fictional lane simulator. Each
// candidate rolls the same bounded one-dimensional speed dynamics forward.
export function forecastPace(speed,nominal,remaining,range,closing){
  const clearance=range==null?Infinity:range;
  const candidates=[.45,.72,1].map(factor=>{
    const target=nominal*factor;let v=speed,travel=0,cost=0;
    for(let k=1;k<=5;k++){
      const dv=Math.max(-1.1,Math.min(1.1,target-v));v+=dv;travel+=v*.2;
      const gap=clearance+Math.min(0,closing)*.2*k-travel;
      cost+=.012*dv*dv+Math.max(0,1.2+v*.30-gap)**2*.9;
      cost+=.03*Math.max(0,travel-remaining)**2;
    }
    cost-=Math.min(travel,remaining)*.32;
    return {speed:target,cost};
  });
  return candidates.sort((a,b)=>a.cost-b.cost || b.speed-a.speed);
}
