// Training-only renderer. Semantic labels are rasterized with occlusion using
// the same camera as RGB. Neither this tool nor its labels enter the live app.
const {chromium}=require("playwright-core");
const fs=require("node:fs");
const path=require("node:path");

async function main(){
  const [url="http://127.0.0.1:8863",folder="runs/city-images"]=process.argv.slice(2);
  fs.mkdirSync(folder,{recursive:false});
  const browser=await chromium.launch({channel:"msedge",headless:true,args:["--enable-gpu","--use-angle=d3d11"]});
  try{
    const page=await browser.newPage();await page.goto(url+"/api/health");
    await page.evaluate(async()=>{
      const map=document.createElement("script");map.type="importmap";
      map.textContent=JSON.stringify({imports:{three:"/three/three.module.js","three/addons/":"/addons/"}});document.head.append(map);
      const T=await import("three"),{City}=await import("/app/world.js");
      const container=document.createElement("div");container.style.cssText="width:640px;height:360px";document.body.append(container);
      const city=new City(container,document.createElement("canvas"));await city.load();city.barrier(true);
      city.craft.forEach(o=>o.visible=false);
      const width=160,height=90,rgb=new T.WebGLRenderTarget(width,height,{colorSpace:T.SRGBColorSpace}),
        label=new T.WebGLRenderTarget(width,height),camera=new T.PerspectiveCamera(57,width/height,.14,150);
      rgb.texture.colorSpace=T.SRGBColorSpace;
      const materials=[0,1,2].map(id=>new T.ShaderMaterial({side:T.DoubleSide,toneMapped:false,
        vertexShader:`void main(){vec4 p=vec4(position,1.);
          #ifdef USE_INSTANCING
          p=instanceMatrix*p;
          #endif
          gl_Position=projectionMatrix*modelViewMatrix*p;}`,
        fragmentShader:`void main(){gl_FragColor=vec4(${id.toFixed(1)}/255.,0.,0.,1.);}`}));
      const masks=[],temporary=new Set(city.challenge.children),signs=new Set(Object.values(city.panelMeshes));
      city.scene.traverse(o=>{if(o.isMesh)masks.push([o,materials[temporary.has(o)?2:signs.has(o)?1:0]]);});
      globalThis.renderSample=(conf,k)=>{
        let seed=conf.seed+k*7919;
        const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
        city.climate(conf.weather);city.challenge.position.fromArray(conf.worksite);
        city.challenge.scale.set(1,.7+.6*rnd(),.75+.65*rnd());
        city.challenge.rotation.y=(rnd()-.5)*.6;
        for(const id of [17,31,46])city.panelState(id,["available","occupied","unreadable"][(k+id)%3]);
        city.scene.updateMatrixWorld(true);
        const kind=k%8,station=kind<4,street=kind===7;
        const center=station?new T.Box3().setFromObject(city.panelMeshes[conf.station]).getCenter(new T.Vector3()):
          city.challenge.position.clone();
        const range=street?35+22*rnd():station?4+15*rnd():3+20*rnd();
        const angle=(station?0:-Math.PI/2)+(rnd()-.5)*(station?1.5:1.45);
        camera.position.copy(center).add(new T.Vector3(Math.sin(angle)*range,(rnd()-.35)*range*.66,Math.cos(angle)*range));
        center.x+=(rnd()-.5)*range*.65;center.y+=(rnd()-.5)*range*.36;center.z+=(rnd()-.5)*range*.4;
        camera.lookAt(center);camera.rotateZ((rnd()-.5)*.18);camera.updateMatrixWorld(true);
        const r=city.renderer,s=city.scene,old=s.background,colors=new Uint8Array(width*height*4),ids=new Uint8Array(colors.length);
        r.setRenderTarget(rgb);r.render(s,camera);r.readRenderTargetPixels(rgb,0,0,width,height,colors);
        const oldMaterials=masks.map(([o])=>o.material);masks.forEach(([o,m])=>o.material=m);
        s.background=new T.Color(0);r.setRenderTarget(label);r.render(s,camera);r.readRenderTargetPixels(label,0,0,width,height,ids);
        s.background=old;masks.forEach(([o],i)=>o.material=oldMaterials[i]);r.setRenderTarget(null);
        const packed=new Uint8Array(width*height*4);
        for(let y=0;y<height;y++)for(let x=0;x<width;x++){
          const i=((height-1-y)*width+x)*4,d=(y*width+x)*4;
          packed[d]=colors[i];packed[d+1]=colors[i+1];packed[d+2]=colors[i+2];packed[d+3]=ids[i];
        }
        return btoa(String.fromCharCode(...packed));
      };
    });
    const groups={
      train:[[17,"day",[-12,25,33]],[46,"rain",[-33,22,9]],[17,"fog",[24,25,-31]],[46,"night",[-48,22,60]]],
      val:[[17,"night",[32,23,41]],[46,"day",[-30,28,1]]],
      test:[[31,"day",[18,24,64]],[31,"night",[31,22,-43]]]
    },manifest={width:160,height:90,channels:["r","g","b","class"],labels:["background","station_display","construction"],groups:[]};
    let seed=239;
    for(const [split,list] of Object.entries(groups)){
      const file=fs.openSync(path.join(folder,split+".raw"),"wx");
      try{
        for(const [station,weather,worksite] of list){
          const count=split==="train"?72:36,conf={station,weather,worksite,seed:seed+=977};
          for(let k=0;k<count;k++){
            const b64=await page.evaluate(([c,i])=>globalThis.renderSample(c,i),[conf,k]);fs.writeSync(file,Buffer.from(b64,"base64"));
          }
          manifest.groups.push({split,...conf,count});console.log(split,station,weather,count);
        }
      }finally{fs.closeSync(file);}
    }
    fs.writeFileSync(path.join(folder,"manifest.json"),JSON.stringify(manifest,null,2));
  }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
