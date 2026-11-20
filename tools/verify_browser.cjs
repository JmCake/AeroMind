// Real browser acceptance run. The application is driven by classroom controls.
const {chromium}=require("playwright-core");
const fs=require("node:fs");
const path=require("node:path");

async function main(){
  const [url="http://127.0.0.1:8765",profile="delivery",dest="output/playwright/delivery"]=process.argv.slice(2);
  fs.mkdirSync(dest,{recursive:true});
  const browser=await chromium.launch({channel:"msedge",headless:true,args:["--enable-gpu","--use-angle=d3d11"]});
  const page=await browser.newPage({viewport:{width:1280,height:720},acceptDownloads:true});
  const errors=[];
  page.on("pageerror",e=>{errors.push(String(e));console.error(String(e));});
  page.on("console",m=>{if(m.type()==="error")console.error(m.text().slice(0,400));});
  try{
    await page.goto(url,{waitUntil:"networkidle",timeout:35000});
    console.log(await page.locator("header").innerText());
    await page.getByRole("button",{name:"开始配送"}).waitFor();
    await page.waitForFunction(()=>!document.querySelector("#launch").disabled,{},{timeout:30000});
    await page.screenshot({path:path.join(dest,"city.png")});
    if(profile==="inspect")return;
    if(profile==="fleet"||profile==="fleet-share")await page.locator("#chapter").selectOption("5");
    if(profile==="resident")await page.locator("#station").selectOption("31");
    if(profile==="challenge"||profile==="fleet-share"||profile==="occupied"||profile==="gps"){
      await page.getByRole("button",{name:"现场挑战",exact:true}).click();
      if(profile==="challenge"||profile==="fleet-share")await page.locator("#barrier").check();
      if(profile==="occupied")await page.locator("#occupied").check();
      if(profile==="gps")await page.locator("#gps").uncheck();
    }
    if(profile==="ab"){
      await page.getByRole("button",{name:"对照实验",exact:true}).click();
      await page.locator("#compare").click();
    }else{
      await page.locator("#launch").click();await page.locator("#speed").click();await page.locator("#speed").click();
    }
    const limit=Date.now()+(profile==="ab"?320000:150000);
    let last="", phase="",gotFrame=false, clearAfter=0;
    while(Date.now()<limit){
      await page.waitForTimeout(1600);
      phase=await page.locator("#phase").innerText();
      if(phase!==last){
        console.log(await page.locator("#clock").innerText(),phase,await page.locator("#events").innerText());
        last=phase;
      }
      if(phase==="视觉确认"&&!gotFrame){
        await page.screenshot({path:path.join(dest,"verification.png")});gotFrame=true;
        if(profile==="occupied")clearAfter=Date.now()+2500;
      }
      if(clearAfter && Date.now()>clearAfter){await page.locator("#occupied").uncheck();clearAfter=0;}
      if(profile==="ab"){
        if(!(await page.locator("#compare").isDisabled()))break;
      }else if(!(await page.locator("#launch").isDisabled()))break;
    }
    if(await page.locator("#experiment").getAttribute("open")===null)await page.locator("#experiment summary").click();
    const download=page.waitForEvent("download");await page.locator("#export").click();
    await (await download).saveAs(path.join(dest,"run.json"));
    await page.screenshot({path:path.join(dest,"result.png")});
    const data=JSON.parse(fs.readFileSync(path.join(dest,"run.json"),"utf8"));
    console.log(JSON.stringify({gpu:data.gpu,fps:data.mean_fps,units:data.units.map(({trajectory,...r})=>r),frames:data.keyframes.length,
      experiment:data.experiment?.branches.map(b=>({active:b.active_observation,outcome:b.metrics.outcome,delivered:b.metrics.delivered})),errors}));
    const exercised=profile==="ab" ? data.experiment?.branches.length===2 : data.units.every(u=>u.outcome==="done"&&u.delivered);
    if(errors.length||!exercised)process.exitCode=1;
  }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
