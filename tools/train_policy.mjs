// Train finite-state action values in small partially observed classroom tasks.
// The three held-out suites use independent random seeds and harder layouts.
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {gazeState,paceState,dispatchState,learnedAction,pace,viewAngles} from "../web/policy.js";
import {Knowledge,observationYaw} from "../web/navigation.js";

const destination=process.argv[2];
if(!destination)throw new Error("node tools/train_policy.mjs runs/policy-01");
fs.mkdirSync(destination);
const episodes=6000,weights={gaze:{},pace:{},dispatch:{}},history=[];
function rng(seed){
  return ()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
}
function row(table,s,count){
  return table[s]??=( {q:Array(count).fill(0),n:Array(count).fill(0)} );
}
function run(env,table,random,mode){
  let total=0;
  for(let t=0;t<env.limit;t++){
    const {key,legal,baseline}=env.read();
    const record=mode==="train"?row(table,key,env.actions):table[key];
    let action=baseline;
    if(mode!=="baseline")action=learnedAction(table,key,baseline,legal);
    if(mode==="train" && (random()<.22 || !record.n[action]))action=legal[Math.floor(random()*legal.length)];
    const {reward,done}=env.apply(action);total+=reward;
    if(mode==="train"){
      const next=done||t+1===env.limit?null:env.read();
      const future=next?Math.max(...next.legal.map(a=>table[next.key]?.q[a]??0)):0;
      const n=++record.n[action],alpha=Math.max(.025,1/Math.sqrt(n));
      record.q[action]+=alpha*(reward+.88*future-record.q[action]);
    }
    if(done)break;
  }
  return total;
}
function gazeEpisode(random,hard){
  const size=17,map=new Knowledge(),origin=[34,6,54],blocks=new Set();
  const xx=hard?8:7,zz=hard?5:6;
  for(let i=0;i<9;i++){
    const x=2+Math.floor(random()*12),z=2+Math.floor(random()*9);
    blocks.add(x+","+z);if(random()<.55)blocks.add((x+1)+","+z);
  }
  blocks.add(xx+","+zz);
  let clock=0,sector=[];
  function observe(yaw,fov){
    const rays=[],ranges=[];
    for(let i=0;i<13;i++){
      const angle=yaw+(i/12-.5)*fov;
      let length=2;
      for(;length<=44;length+=2){
        const x=Math.floor((origin[0]-Math.sin(angle)*length)/4),z=Math.floor((origin[2]-Math.cos(angle)*length)/4);
        if(x<0||z<0||x>=size||blocks.has(x+","+z))break;
      }
      rays.push([-Math.sin(angle)*length,0,-Math.cos(angle)*length]);ranges.push(length);
    }
    map.rays(origin,rays,++clock);sector=[ranges[0],ranges[3],ranges[6],ranges[9],ranges[12]];
  }
  observe((random()-.5)*.9,.48);
  return {actions:3,limit:3,
    read(){const c=observationYaw(map,origin,0,clock);return {key:gazeState(c,sector),legal:[0,1,2],baseline:viewAngles.indexOf(c[0].offset)};},
    apply(a){const before=map.voxels.size;observe(viewAngles[a],hard?.67:.76);
      return {reward:Math.min(30,map.voxels.size-before)/7-.16*Math.abs(viewAngles[a]),done:false};}};
}
function paceEpisode(random,hard){
  let remaining=35+random()*30,clearance=6+random()*25,good=random()>.3,closing=random()>.45;
  const timeline=Array.from({length:25},()=>[random(),random(),random()]);
  let t=0,velocity=0;
  return {actions:3,limit:24,
    read:()=>({key:paceState(clearance,good?32:8,closing?-3:1),legal:[0,1,2],baseline:2}),
    apply(a){
      const gust=timeline[t++];velocity+=Math.max(-2,Math.min(2,pace[a]-velocity));
      const usable=clearance-(closing?1.8:0),brake=velocity*velocity/(good?10:6)+1.3;
      let progress=velocity*.8,penalty=0;
      if(usable<brake){penalty=hard?8:7;progress=0;velocity=0;}
      remaining-=progress;clearance-=progress*(closing?.63:.27);
      if(clearance<3||gust[0]<.21)clearance=5+gust[1]*(hard?23:28);
      good=gust[2]>(hard?.36:.28);closing=gust[1]>.5;
      return {reward:progress*.35-1-penalty+(remaining<=0?5:0),done:remaining<=0};
    }};
}
function fleetEpisode(random,hard){
  const units=[0,1].map(index=>({index,capacity:random()>.5?1.5:1.05,energy:15+random()*65}));
  const orders=Array.from({length:8},()=>({mass:random()>(hard?.50:.64)?1.35:.65,
    priority:random()>.66?2:1,cost:4.5+random()*(hard?6.5:5.5)}));
  let cursor=0;
  return {actions:2,limit:8,
    read(){const o=orders[cursor],available=units.filter(u=>u.capacity>=o.mass&&u.energy>=o.cost+3);
      const legal=available.map(u=>u.index);
      return {key:dispatchState(units,o),legal:legal.length?legal:[0,1],
        baseline:(available.length?[...available].sort((a,b)=>b.energy-a.energy)[0]:units[0]).index};},
    apply(a){const o=orders[cursor++],u=units[a],accepted=u.capacity>=o.mass&&u.energy>=o.cost+3;
      if(accepted)u.energy-=o.cost;units[1-a].energy=Math.min(100,units[1-a].energy+1.2);
      return {reward:accepted?3+o.priority:-5*o.priority,done:cursor===orders.length};}};
}
const tasks={gaze:gazeEpisode,pace:paceEpisode,dispatch:fleetEpisode};
function evaluate(group,seed,n,hard){
  return Object.fromEntries(Object.entries(tasks).map(([name,build])=>{
    const values={baseline:0,learned:0};
    for(let k=0;k<n;k++)for(const mode of Object.keys(values)){
      const random=rng(seed+k*2081);values[mode]+=run(build(random,hard),group[name],random,mode)/n;
    }
    return [name,values];
  }));
}
let checkpoint=null,best=-Infinity;
for(let i=0;i<episodes;i++){
  for(const [name,build] of Object.entries(tasks)){
    const random=rng(15299+i*104729);run(build(random,false),weights[name],random,"train");
  }
  if((i+1)%1000===0){
    const val=evaluate(weights,87113,100,true);
    const score=Object.values(val).reduce((s,r)=>s+(r.learned-r.baseline)/Math.max(1,Math.abs(r.baseline)),0);
    history.push({episode:i+1,val,score});
    if(score>best){best=score;checkpoint={episode:i+1,policy:structuredClone(weights)};}
  }
}
for(const table of Object.values(checkpoint.policy))for(const r of Object.values(table))r.q=r.q.map(n=>Number(n.toFixed(5)));
const write=(name,obj)=>fs.writeFileSync(path.join(destination,name),JSON.stringify(obj,null,2)+"\n");
write("policy.json",checkpoint);
const digest=createHash("sha256").update(fs.readFileSync(path.join(destination,"policy.json"))).digest("hex");
const result={method:"tabular episodic Q-learning",scope:"partially observed campus grid, speed and order-allocation teaching tasks",
  episodes_per_task:episodes,validation_episodes_per_task:100,test_episodes_per_task:600,discount:.88,exploration:.22,
  train_seed:15299,val_seed:87113,test_seed:192793,gaze_reward:"new observed map cells minus turning cost",
  pace_reward:"progress minus time and emergency stops",dispatch_reward:"accepted orders, weighted missed priority",
  chosen_episode:checkpoint.episode,weights_sha256:digest,history,held_out_return:evaluate(checkpoint.policy,192793,600,true)};
write("result.json",result);console.log(JSON.stringify(result.held_out_return));
