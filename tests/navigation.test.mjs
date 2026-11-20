import test from "node:test";
import assert from "node:assert/strict";
import {pathBetween,edgeId,Knowledge,orderFromText,observationYaw,integrate} from "../web/navigation.js";

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
    {station:17,avoid:[edgeId("west","junction")]});
  assert.equal(orderFromText("把教材送至居民服务站").station,31);
  assert.throws(()=>orderFromText("送到不存在的地方"));
});
test("integrator respects acceleration and cannot teleport to an order",()=>{
  const body={pos:[0,0,0],vel:[0,0,0]};
  integrate(body,[100,20,30],[0,0,0],1/30,8);
  assert.ok(Math.hypot(...body.vel)<=5.5/30+1e-8);
  assert.ok(Math.hypot(...body.pos)<.01);
});
