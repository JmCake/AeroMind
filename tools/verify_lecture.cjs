// Rehearse all seven live stages repeatedly in the same Edge tab. Retain a
// complete downloadable record per run, including unsuccessful outcomes.
const {chromium}=require("playwright-core");
const fs=require("node:fs");
const path=require("node:path");

async function main(){
  const [url="http://127.0.0.1:8863",folder="output/playwright/lecture",count="10",rate="3"]=process.argv.slice(2);
  fs.mkdirSync(folder,{recursive:true});
  const browser=await chromium.launch({channel:"msedge",headless:true,args:["--enable-gpu","--use-angle=d3d11"]});
  const page=await browser.newPage({viewport:{width:1280,height:720},acceptDownloads:true});
  const errors=[],rows=[];
  page.on("pageerror",e=>errors.push(e.message));
  try{
    const health=await page.request.get(url+"/api/health");
    if(!health.ok()||(await health.json()).application!=="JmCake/AeroMind/3D")throw new Error("使用三维课堂地址");
    await page.goto(url,{waitUntil:"networkidle"});
    await page.waitForFunction(()=>!document.querySelector("#launch").disabled);
    for(let run=1;run<=Number(count);run++){
      const started=Date.now(),before=errors.length;
      if(run>1)await page.locator("#reset").click();
      await page.locator("#classroom").evaluate(el=>el.open=true);
      await page.locator("#lecture-rate").selectOption(rate);
      await page.locator("#lecture").click();
      for(let stage=1;stage<=7;stage++){
        await page.waitForFunction(expected=>document.querySelector("#lecture-status").dataset.stage===String(expected),stage,{timeout:230000});
        console.log(`rehearsal ${run}/${count} stage ${stage}/7, ${Math.round((Date.now()-started)/1000)} wall s`);
        if(run===1&&stage===3){
          await page.waitForTimeout(3800);
          await page.screenshot({path:path.join(folder,"cognitive-map.png")});
        }
      }
      await page.waitForFunction(()=>document.querySelector("#lecture-status").dataset.stage==="complete",
        null,{timeout:Math.ceil(450000/Number(rate))+240000});
      if(!await page.locator("#experiment").evaluate(el=>el.open))await page.locator("#experiment summary").click();
      const download=page.waitForEvent("download");await page.locator("#export").click();
      const file=path.join(folder,`lecture-${run}.json`);await (await download).saveAs(file);
      const data=JSON.parse(fs.readFileSync(file)),stages=data.lecture.stages;
      const shared=stages[5].events.some(e=>e.reason.includes("共享观测改变"));
      const branches=stages[4].branches,brake=stages[1].events.some(e=>e.reason.includes("制动"));
      const visual=stages[3].events.some(e=>e.reason.includes("确认通道占用"));
      const row={run,wall_s:(Date.now()-started)/1000,rate:Number(rate),browser_errors:errors.slice(before),
        stages:stages.length,brake,visual,shared,branch_outcomes:branches.map(b=>b.phase),
        gps_cut:stages[2].events.some(e=>e.reason==="GPS 更新已解除"),
        fleet:data.units.map(u=>({outcome:u.outcome,delivered:u.delivered,contacts:u.contacts,min_spacing_m:u.min_aircraft_spacing_m,
          dock_error_m:u.delivery_error_m,frame_to_decision_p95_ms:u.camera_to_decision_p95_ms})),
        backend:data.inference_backend,viewport:data.viewport,render_resolution:data.resolution,failed_sensor_requests:data.failed_frame_requests,
        fps:data.mean_fps,frame_p95_ms:data.frame_time_p95_ms,heap_bytes:data.js_heap_bytes};
      rows.push(row);console.log(JSON.stringify(row));
      fs.writeFileSync(path.join(folder,"summary.json"),JSON.stringify(rows,null,2));
      if(run===1)await page.screenshot({path:path.join(folder,"lecture.png")});
      if(row.browser_errors.length||row.stages!==7||!brake||!visual||!shared||!row.gps_cut||
        branches.length!==2||branches[0].phase==="done"||branches[1].phase!=="done"||
        row.fleet.some(u=>!u.delivered||u.outcome!=="done"||u.contacts))process.exitCode=1;
    }
  }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
