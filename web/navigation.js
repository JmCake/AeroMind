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
  observeEdge(key, time, source, frame) {
    this.blocked.set(key,{until:time+45,time,source,frame});
  }
}

export function orderFromText(text) {
  const match = text.trim().match(/^(?:请)?(?:将|把)?(?:包裹|图书|教材)?(?:配送到|送至|送到|前往)(图书馆|居民服务站)(?:屋顶|指定平台|平台)?(?:[，, ]*(?:避开|绕开)(体育场上空|南侧通道))?[。！!]?$/);
  if (!match) throw new Error("请指定一个配送站和可识别的空域，例如“将包裹送到图书馆指定平台，避开体育场上空”。");
  return {station:match[1]==="图书馆" ? 17 : 31, avoid:match[2] ? [edgeId("west","junction")] : []};
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
