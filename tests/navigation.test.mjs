import test from "node:test";
import assert from "node:assert/strict";
import {allocateOrders,pathBetween,edgeId,Knowledge,orderFromText,observationYaw,integrate,restrictedEdges,intersectsZone,measurementRandom} from "../web/navigation.js";
import {Simulation} from "../web/simulation.js";
import {learnedAction} from "../web/policy.js";

test("reported or published closure changes the three-dimensional route",()=>{
  const direct=pathBetween("depot","library");
  assert.deepEqual(direct,["depot","south","west","junction","library"]);
  const detour=pathBetween("depot","library",new Set([edgeId("west","junction")]));
  assert.ok(detour.includes("plaza"));assert.equal(detour.at(-1),"library");
  assert.deepEqual(pathBetween("depot","library",new Set(["depot|south"])),[]);
});
test("an observed endpoint is occupied and expired shared information is removed",()=>{
  const m=new Knowledge();m.rays([0,5,0],[[0,0,-16]],1);
  assert.ok(m.voxels.get(m.key([0,5,-16])).odds>0);
  assert.ok(m.voxels.get(m.key([0,5,-6])).odds<0);
  const k=edgeId("west","junction");m.observeEdge(k,3,"AM-01",14);
  assert.ok(m.exclusions(10).has(k));assert.ok(!m.exclusions(50).has(k));
  assert.equal(observationYaw(m,[0,5,0],0,2).length,3);
});
test("instruction grammar preserves destination and requested airspace restriction",()=>{
  assert.deepEqual(orderFromText("将包裹送到图书馆指定平台，避开体育场上空"),
    {station:17,priority:1,avoid:[edgeId("west","junction")]});
  assert.equal(orderFromText("请加急将包裹送到图书馆").priority,2);
  assert.equal(orderFromText("把教材送至居民服务站").station,31);
  assert.throws(()=>orderFromText("送到不存在的地方"));
});
test("reserve, payload and priority determine which order may leave the depot",()=>{
  const units=[{index:0,energy:5,capacity:1.5,phase:"idle"},{index:1,energy:80,capacity:1.2,phase:"idle"}];
  const orders=[{id:1,station:17,priority:1,mass:.4,state:"queued"},{id:2,station:31,priority:2,mass:.8,state:"queued"}];
  const assigned=allocateOrders(orders,units,new Set());
  assert.deepEqual(assigned.map(x=>[x.order.id,x.vehicle.index]),[[2,1]]);
  orders[1].mass=2;assert.equal(allocateOrders(orders,units,new Set())[0].order.id,1);
});
test("integrator respects acceleration and cannot teleport to an order",()=>{
  const body={pos:[0,0,0],vel:[0,0,0]};
  integrate(body,[100,20,30],[0,0,0],1/30,8);
  assert.ok(Math.hypot(...body.vel)<=5.5/30+1e-8);
  assert.ok(Math.hypot(...body.pos)<.01);
});
test("three-dimensional airspace leaves passages above its ceiling open",()=>{
  assert.deepEqual(restrictedEdges(),[edgeId("west","junction")]);
  assert.ok(intersectsZone([-30,26,33],[10,26,33]));
  assert.ok(!intersectsZone([-30,35,33],[10,35,33]));
});
test("fresh local free space supersedes conflicting delayed peer evidence",()=>{
  const m=new Knowledge(),p=[0,4,4];m.voxels.set(m.key(p),{point:p,odds:-3,time:5});
  assert.deepEqual(m.mergeShared([{point:p,odds:3}],5.6,0,.9),{fused:0,conflicts:1});
  const r=m.mergeShared([{point:[0,4,12],odds:3}],5.6,0,.9);
  assert.equal(r.fused,1);assert.equal(m.clearance([0,4,10],6).distance_m,2);
});
test("a learned preference cannot choose an ineligible or untrained action",()=>{
  const model={key:{q:[90,3,5],n:[40,5,1]}};
  assert.equal(learnedAction(model,"key",1,[1,2]),1);
  assert.equal(learnedAction(model,"missing",2,[0,1,2]),2);
});
test("camera perturbations reproduce from a saved frame and independent sensor seed",()=>{
  const a=measurementRandom(6101,50),b=measurementRandom(6101,50),c=measurementRandom(6298,50);
  assert.deepEqual([a(),a(),a()],[b(),b(),b()]);
  assert.notEqual(a(),c());
});
test("protective braking uses estimate and ranges without access to physics pose or velocity",()=>{
  const b={index:0,est:[-24,25,33],next:"junction",yaw:-Math.PI/2,odometry:{velocity:[6,0,0]},rangeTrack:{range:4,time:1,rate:0}};
  for(const key of ["pos","vel"])Object.defineProperty(b,key,{get(){throw new Error("read independent truth");}});
  assert.equal(Simulation.prototype.obstacle.call({time:1,options:{chapter:4}},b),true);
});
test("a camera frame gets one latency sample at its next actual control tick",()=>{
  const city={restriction:{},barrier(){},climate(){},panelState(){},setRoute(){},animateCraft(){},eventTick(){},collision(){return false;}};
  const sim=new Simulation(city,()=>{},{}),unit=sim.units[0];
  sim.start();
  unit.pendingControlFrame={id:17,capturedAt:performance.now()-80,visionMs:50};
  sim.advance();
  sim.advance();
  assert.equal(unit.frameTimings.length,1);
  const [sample]=unit.frameTimings;
  assert.deepEqual([sample.frame,sample.control_tick,sample.vision_ms],[17,1,50]);
  assert.ok(sample.command_ms>=79&&sample.command_ms>sample.vision_ms);
});
test("standard gamepad axis dead zone and shoulder inputs reach the manual controller",()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,"navigator");
  const simulated={mapping:"standard",axes:[.75,.1],buttons:[{},{},{},{},{value:0},{value:1}]};
  Object.defineProperty(globalThis,"navigator",{configurable:true,value:{getGamepads:()=>[null,simulated]}});
  try{
    const unit={index:0,station:17,phase:"cruise",est:[1,2,3]};
    const action=Simulation.prototype.control.call({manual:true,activeUnit:0,keys:new Set()},unit);
    assert.deepEqual(action,{goal:[4,6,3],max:4});
  }finally{
    if(previous)Object.defineProperty(globalThis,"navigator",previous);
    else delete globalThis.navigator;
  }
});
