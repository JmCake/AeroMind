// Real browser acceptance run. The application is driven by classroom controls.
const {chromium}=require("playwright-core");
const fs=require("node:fs");
const path=require("node:path");
const assert=require("node:assert/strict");

async function readExport(page,destination){
  if(!await page.locator("#experiment").evaluate(el=>el.open))await page.locator("#experiment summary").click();
  const event=page.waitForEvent("download");
  await page.locator("#export").click();
  const download=await event;
  if(destination)await download.saveAs(destination);
  return JSON.parse(fs.readFileSync(await download.path(),"utf8"));
}

async function verifyControls(page,dest,software){
  await page.getByRole("button",{name:"自由配送",exact:true}).click();
  await page.locator("#command").fill("请加急将包裹送到居民服务站，避开体育场上空");
  await page.locator("#parse").click();
  assert.equal(await page.locator("#station").inputValue(),"31");
  assert.equal(await page.locator("#zone").isChecked(),true);
  await page.locator("#launch").click();
  await page.waitForFunction(()=>document.querySelector("#phase").textContent==="航路配送",null,{timeout:software?120000:35000});
  await page.locator("#manual").check();
  await page.locator("#pause").click();
  await page.waitForTimeout(550);
  const pausedAt=await page.locator("#clock").innerText(),pausedFrame=await page.locator("#frame-num").innerText();
  await page.waitForTimeout(1250);
  assert.equal(await page.locator("#clock").innerText(),pausedAt);
  assert.equal(await page.locator("#frame-num").innerText(),pausedFrame);
  const before=(await readExport(page)).units[0].evaluation_samples.at(-1);
  await page.locator("#pause").click();
  await page.locator("#world > canvas").click({position:{x:50,y:80}});
  await page.keyboard.down("e");
  try{
    await page.waitForFunction(target=>{
      const [minutes,seconds]=document.querySelector("#clock").textContent.split(":").map(Number);
      return 60*minutes+seconds>=target;
    },Math.ceil(before.time+3),{timeout:60000});
  }finally{await page.keyboard.up("e");}
  await page.waitForTimeout(600);
  const after=(await readExport(page)).units[0].evaluation_samples.at(-1);
  const rise=after.estimate[1]-before.estimate[1];
  assert.ok(rise>2,"Manual climb must change the estimated height");
  await page.locator("#manual").uncheck();
  for(const view of ["follow","fpv","map","cinema","overview"]){
    const button=page.locator('[data-view="'+view+'"]');await button.click();
    assert.ok(await button.evaluate(el=>el.classList.contains("selected")));
  }
  await page.locator("#speed").click();await page.locator("#speed").click();
  await page.waitForFunction(()=>!document.querySelector("#launch").disabled,null,{timeout:software?480000:180000});
  const data=await readExport(page,path.join(dest,"run.json")),unit=data.units[0];
  assert.equal(data.orders[0].priority,2);
  assert.ok(data.options.avoid.length&&unit.outcome==="done"&&unit.delivered&&unit.contacts===0&&unit.home_contact_error_m!=null&&unit.home_contact_error_m<.45);
  assert.ok(data.events.some(e=>e.reason==="已手动接管")&&data.events.some(e=>e.reason==="恢复任务控制"));
  await page.locator("#reset").click();
  await page.waitForFunction(()=>document.querySelector("#phase").textContent==="等待订单");
  const result={paused_at:pausedAt,paused_frame:pausedFrame,renderer:data.gpu,
    keyboard_climb_estimate_m:rise,before_frame:before.frame,after_frame:after.frame,station:31,priority:2,
    cameras:5,reset:true,home_error_m:unit.home_contact_error_m};
  fs.writeFileSync(path.join(dest,"controls.json"),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}

async function main(){
  const [url="http://127.0.0.1:8863",profile="delivery",dest="output/playwright/delivery",renderer="hardware"]=process.argv.slice(2);
  const software=renderer==="software";
  if(!["hardware","software"].includes(renderer))throw new Error("Select hardware or software rendering for the browser test");
  fs.mkdirSync(dest,{recursive:true});
  const renderArgs=software?["--use-angle=swiftshader","--enable-unsafe-swiftshader"]:["--enable-gpu","--use-angle=d3d11"];
  const browser=await chromium.launch({channel:"msedge",headless:true,args:renderArgs});
  const page=await browser.newPage({viewport:{width:1280,height:720},acceptDownloads:true});
  const errors=[];
  page.on("pageerror",e=>{errors.push(String(e));console.error(String(e));});
  page.on("console",m=>{if(m.type()==="error")console.error(m.text().slice(0,400));});
  try{
    const health=await page.request.get(url+"/api/health");
    if(!health.ok() || (await health.json()).application!=="JmCake/AeroMind/3D")throw new Error("当前地址未运行指定的三维课堂");
    await page.goto(url,{waitUntil:"networkidle",timeout:35000});
    console.log(await page.locator("header").innerText());
    await page.getByRole("button",{name:"开始配送"}).waitFor();
    await page.waitForFunction(()=>!document.querySelector("#launch").disabled,{},{timeout:30000});
    await page.screenshot({path:path.join(dest,"city.png")});
    if(profile==="inspect")return;
    if(profile==="controls"){
      await verifyControls(page,dest,software);assert.deepEqual(errors,[]);return;
    }
    const experiment=["ab","checkpoint-ab","gps-ab","policy-ab"].includes(profile);
    if(["fleet","fleet-share","blackout","battery","recall"].includes(profile))await page.locator("#chapter").selectOption("5");
    if(profile==="resident")await page.locator("#station").selectOption("31");
    if(["challenge","fleet-share","occupied","gps","blackout","battery","night","rain","moving","recall","learned","sensor-noise"].includes(profile)){
      await page.getByRole("button",{name:"现场挑战",exact:true}).click();
      if(["challenge","fleet-share","blackout"].includes(profile))await page.locator("#barrier").check();
      if(["fleet-share","blackout"].includes(profile))await page.locator("#second-route").selectOption("shared");
      if(profile==="blackout")await page.locator("#link").selectOption("off");
      if(profile==="battery")await page.locator("#low-battery").check();
      if(profile==="moving")await page.locator("#moving").check();
      if(profile==="sensor-noise"){await page.locator("#depth-noise").selectOption("0.05");await page.locator("#range-limit").selectOption("30");await page.locator("#drop-rate").selectOption("0.15");}
      if(profile==="night"||profile==="rain")await page.locator("#weather").selectOption(profile);
      if(profile==="learned"){await page.locator("#policy").selectOption("learned");await page.locator("#barrier").check();}
      if(profile==="occupied")await page.locator("#occupied").check();
      if(profile==="gps")await page.locator("#gps").uncheck();
    }
    if(experiment){
      await page.getByRole("button",{name:"对照实验",exact:true}).click();
      const factor={"checkpoint-ab":"checkpoint","gps-ab":"gps","policy-ab":"policy"}[profile];
      if(factor)await page.locator("#factor").selectOption(factor);
      await page.locator("#compare").click();
    }else{
      await page.locator("#launch").click();
      if(profile!=="realtime"){await page.locator("#speed").click();await page.locator("#speed").click();}
    }
    const limit=Date.now()+(experiment?320000:180000);
    let last="", phase="",gotFrame=false, clearAfter=0,recalled=false,followed=false;
    while(Date.now()<limit){
      await page.waitForTimeout(1600);
      phase=await page.locator("#phase").innerText();
      if(phase!==last){
        console.log(await page.locator("#clock").innerText(),phase,await page.locator("#events").innerText());
        last=phase;
      }
      if(profile==="realtime"&&!followed&&phase==="航路配送"){
        await page.locator('[data-view="follow"]').click();await page.waitForTimeout(420);
        await page.screenshot({path:path.join(dest,"flight.png")});await page.locator('[data-view="overview"]').click();followed=true;
      }
      if(phase==="视觉确认"&&!gotFrame){
        await page.screenshot({path:path.join(dest,"verification.png")});gotFrame=true;
        if(profile==="occupied")clearAfter=Date.now()+2500;
      }
      if(clearAfter && Date.now()>clearAfter){await page.locator("#occupied").uncheck();clearAfter=0;}
      if(profile==="recall"&&!recalled&&phase==="航路配送"){await page.locator("#recall").click();recalled=true;}
      if(experiment){
        if(!(await page.locator("#compare").isDisabled()))break;
      }else if(!(await page.locator("#launch").isDisabled()))break;
    }
    const data=await readExport(page,path.join(dest,"run.json"));
    await page.screenshot({path:path.join(dest,"result.png")});
    console.log(JSON.stringify({gpu:data.gpu,fps:data.mean_fps,units:data.units.map(({trajectory,evaluation_samples,visual_loop_closures,...r})=>r),frames:data.keyframes.length,
      experiment:data.experiment?.branches.map(b=>({active:b.active_observation,outcome:b.metrics.outcome,delivered:b.metrics.delivered})),errors}));
    let exercised=experiment?data.experiment?.branches.length===2:
      data.orders.every(o=>o.state==="delivered")&&data.units.every(u=>u.outcome==="done"&&!u.contacts);
    if(["challenge","fleet-share","ab"].includes(profile))
      exercised&&=data.events.some(e=>e.reason.includes("确认通道占用"));
    if(profile==="fleet-share")exercised&&=data.events.some(e=>e.reason.includes("共享观测改变")) && data.communications.some(m=>m.event==="fused");
    if(profile==="ab")exercised&&=data.experiment.branches[0].metrics.delivered===false &&
      data.experiment.branches[1].metrics.delivered===true && data.experiment.branches.every(b=>b.initial_position_error_m===0&&b.snapshot_tick===180);
    if(profile==="gps")exercised&&=data.units[0].evaluation_samples.every(s=>!s.source.includes("GPS")) && data.units[0].localization_rmse_m<=2;
    if(profile==="occupied")exercised&&=data.keyframes.some(f=>f.readings.some(r=>r.state==="occupied")) && data.events.some(e=>e.reason==="平台占用已解除");
    if(profile==="blackout")exercised&&=data.communications.some(m=>m.event==="dropped") && !data.communications.some(m=>m.event==="fused");
    if(profile==="recall")exercised&&=data.orders.some(o=>o.returned_by===0&&o.unit===1) && data.units[1].receipts.length===2;
    if(profile==="sensor-noise")exercised&&=data.units[0].simulated_dropped_frames>0;
    if(!experiment)exercised&&=data.units.filter(u=>u.receipts.length).every(u=>
      u.home_contact_error_m!=null&&u.home_contact_error_m<.45&&u.measured_control_frames>0&&u.timing_samples.length>0&&
      u.timing_samples.every(t=>t.command_ms>=t.vision_ms&&t.control_tick>0));
    const withinRealtimeBudget=profile!=="realtime"||(data.mean_fps>=30&&data.frame_time_p95_ms<=55&&
      data.units[0].camera_to_decision_p95_ms<=160&&data.units[0].sensor_sim_hz>=7);
    if(errors.length||data.failed_frame_requests||!exercised||!withinRealtimeBudget)process.exitCode=1;
  }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
