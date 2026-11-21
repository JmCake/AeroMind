import * as T from "three";
import {GLTFLoader} from "three/addons/loaders/GLTFLoader.js";
import {OrbitControls} from "three/addons/controls/OrbitControls.js";
import {sportsAirspace, stations} from "./navigation.js";

const v = a => new T.Vector3(...a);
const W=320, H=180;

function paintedTexture(w,h,paint){
  const canvas=document.createElement("canvas");canvas.width=w;canvas.height=h;
  paint(canvas.getContext("2d"));
  const tex=new T.CanvasTexture(canvas);tex.colorSpace=T.SRGBColorSpace;return tex;
}
function cityHorizon(scene){
  const pavement=paintedTexture(256,256,g=>{
    g.fillStyle="#626f77";g.fillRect(0,0,256,256);
    for(let x=0;x<2;x++)for(let y=0;y<2;y++){
      const a=x*128+8,b=y*128+8;
      g.fillStyle="#a5a99a";g.fillRect(a,b,112,112);g.fillStyle="#92a690";g.fillRect(a+4,b+4,104,104);
      g.fillStyle="#b8bac0";g.fillRect(a+15,b+12,49,34);g.fillRect(a+53,b+64,40,27);
      g.fillStyle="#757f78";g.fillRect(a+19,b+17,14,7);g.fillRect(a+59,b+69,12,8);
      g.fillStyle="#758e79";for(let k=0;k<5;k++){g.beginPath();g.arc(a+12+k*20,b+100,4,0,2*Math.PI);g.fill();}
    }
    g.strokeStyle="#c9c9b2";g.setLineDash([5,6]);g.lineWidth=1;
    for(const n of [0,128]){g.beginPath();g.moveTo(n,0);g.lineTo(n,256);g.moveTo(0,n);g.lineTo(256,n);g.stroke();}
  });
  pavement.wrapS=pavement.wrapT=T.RepeatWrapping;pavement.repeat.set(10,10);
  const ground=new T.Mesh(new T.PlaneGeometry(1100,1100),new T.MeshStandardMaterial({map:pavement,roughness:.96}));
  ground.rotation.x=-Math.PI/2;ground.position.y=-1.6;ground.receiveShadow=true;scene.add(ground);
  const facade=paintedTexture(64,128,g=>{
    g.fillStyle="#c1cecf";g.fillRect(0,0,64,128);
    for(let y=4;y<128;y+=9)for(let x=2;x<64;x+=7){
      g.fillStyle=(x*3+y)%5?"#8299a9":"#a2ada7";g.fillRect(x,y,5,5);
      g.fillStyle="#c7c7b9";g.fillRect(x,y+5,5,1);
    }
  });
  const mat=new T.MeshStandardMaterial({map:facade,roughness:.74});
  const buildings=new T.InstancedMesh(new T.BoxGeometry(),mat,126);
  const crowns=new T.InstancedMesh(new T.CylinderGeometry(.5,.5,1,8),new T.MeshStandardMaterial({color:0x95abae,roughness:.7}),21);
  const transform=new T.Object3D(),color=new T.Color();
  for(let i=0;i<63;i++){
    const angle=i*2.39996,radius=172+i%5*13,h=10+(i*37%58),x=Math.cos(angle)*radius,z=Math.sin(angle)*radius;
    const w=11+i%9,d=10+i%12;
    transform.position.set(x,h/2-1.6,z);transform.rotation.y=(i%3)*.18;transform.scale.set(w,h,d);transform.updateMatrix();
    buildings.setMatrixAt(i*2,transform.matrix);color.setHex([0xb9d1d1,0xe1d0b4,0xaebcc9,0xc4cebf][i%4]);buildings.setColorAt(i*2,color);
    transform.position.y=h+1.6;transform.scale.set(w*.64,6.4,d*.68);transform.updateMatrix();buildings.setMatrixAt(i*2+1,transform.matrix);buildings.setColorAt(i*2+1,color);
    if(i%3===0){
      transform.position.y=h+6;transform.scale.set(w*.52,3.8,d*.54);transform.updateMatrix();crowns.setMatrixAt(i/3,transform.matrix);
    }
  }
  scene.add(buildings,crowns);
}

export class City {
  constructor(view, image) {
    this.renderer=new T.WebGLRenderer({antialias:true,alpha:false,powerPreference:"high-performance"});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.25));
    this.frameWindow=[];this.autoQuality=true;
    this.renderer.outputColorSpace=T.SRGBColorSpace;
    this.renderer.toneMapping=T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure=1.02;
    this.renderer.shadowMap.enabled=true;
    this.renderer.shadowMap.type=T.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate=false;
    view.prepend(this.renderer.domElement);
    this.view=view; this.image=image; image.width=W; image.height=H;
    this.imageContext=image.getContext("2d"); this.imageData=this.imageContext.createImageData(W,H);
    this.scene=new T.Scene();
    this.sky=new T.Color(0xb2cdd1); this.scene.background=this.sky;
    this.scene.fog=new T.FogExp2(0xaec8c9,.0035);
    this.hemi=new T.HemisphereLight(0xe1f3ff,0x998574,2.0);
    this.sun=new T.DirectionalLight(0xffdfad,3);
    this.sun.position.set(-82,132,62); this.sun.castShadow=true;
    Object.assign(this.sun.shadow.camera,{left:-139,right:139,top:139,bottom:-139,near:1,far:365});
    this.sun.shadow.mapSize.set(1024,1024); this.sun.shadow.normalBias=.14;
    this.scene.add(this.hemi,this.sun);
    cityHorizon(this.scene);
    this.camera=new T.PerspectiveCamera(42,1,.2,850); this.camera.layers.enable(1);
    this.controls=new OrbitControls(this.camera,this.renderer.domElement);
    this.controls.enableDamping=true; this.controls.maxPolarAngle=1.48;
    this.controls.minDistance=10; this.controls.maxDistance=300; this.mode="overview";
    this.resetView();
    this.sensor=new T.PerspectiveCamera(57,W/H,.14,110);
    this.rgb=new T.WebGLRenderTarget(W,H,{colorSpace:T.SRGBColorSpace});
    this.rgb.texture.colorSpace=T.SRGBColorSpace;
    this.range=new T.WebGLRenderTarget(W,H,{minFilter:T.NearestFilter,magFilter:T.NearestFilter});
    this.depth=new T.ShaderMaterial({
      vertexShader:`varying float z; void main(){vec4 p=vec4(position,1.);
       #ifdef USE_INSTANCING
       p=instanceMatrix*p;
       #endif
       vec4 eye=modelViewMatrix*p; z=-eye.z; gl_Position=projectionMatrix*eye;}`,
      fragmentShader:`varying float z; void main(){float cm=floor(z*100.+.5);
       gl_FragColor=vec4(mod(cm,256.)/255.,floor(cm/256.)/255.,0.,1.);}`,
      side:T.DoubleSide, toneMapped:false
    });
    this.raw=new Uint8Array(W*H*4); this.zraw=new Uint8Array(W*H*4);
    this.craft=[]; this.rotors=[]; this.parcels=[]; this.panelMeshes={}; this.panelTextures={};
    this.litGlass=new Set();
    this.layer=new T.Group(); this.layer.layers.set(1); this.scene.add(this.layer);
    const lineMaterial=new T.LineBasicMaterial({color:0x13d0c1,transparent:true,opacity:.9,depthTest:false});
    this.route=new T.Line(new T.BufferGeometry(),lineMaterial); this.route.layers.set(1); this.layer.add(this.route);
    this.route.frustumCulled=false;
    this.knowledgeScene=new T.Scene();
    this.knowledgeScene.background=new T.Color(0x10272b);
    const grid=new T.GridHelper(264,66,0x3d6a6c,0x264448);
    this.knowledgeScene.add(grid);
    this.mapPositions=new T.BufferAttribute(new Float32Array(2400*3),3).setUsage(T.DynamicDrawUsage);
    this.mapColors=new T.BufferAttribute(new Float32Array(2400*3),3).setUsage(T.DynamicDrawUsage);
    const mapGeometry=new T.BufferGeometry();mapGeometry.setAttribute("position",this.mapPositions);mapGeometry.setAttribute("color",this.mapColors);
    mapGeometry.setDrawRange(0,0);
    this.mapPoints=new T.Points(mapGeometry,new T.PointsMaterial({size:1.2,vertexColors:true,toneMapped:false}));
    this.mapPoints.frustumCulled=false;this.knowledgeScene.add(this.mapPoints);
    const traceGeometry=new T.BufferGeometry();
    this.tracePositions=new T.BufferAttribute(new Float32Array(1801*3),3).setUsage(T.DynamicDrawUsage);
    traceGeometry.setAttribute("position",this.tracePositions);traceGeometry.setDrawRange(0,0);
    this.estimatedTrace=new T.Line(traceGeometry,new T.LineBasicMaterial({color:0xffecaf,depthTest:false,toneMapped:false}));
    this.estimatedTrace.frustumCulled=false;this.estimatedTrace.renderOrder=2;this.knowledgeScene.add(this.estimatedTrace);
    this.estimateArrow=new T.ArrowHelper(v([0,0,-1]),v([0,0,0]),5,0xffed9d,2.8,2.2);
    this.knowledgeScene.add(this.estimateArrow);
    this.meshRay=new T.Raycaster();
    this.tags=new Map(); this.colliders=[]; this.challenge=null;this.occupants={};
    const bounds=sportsAirspace;
    this.restriction=new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(...bounds.max.map((n,i)=>n-bounds.min[i]))),
      new T.LineBasicMaterial({color:0xefaa63,transparent:true,opacity:.8}));
    this.restriction.position.fromArray(bounds.max.map((n,i)=>(n+bounds.min[i])/2));this.restriction.layers.set(1);this.restriction.visible=false;this.layer.add(this.restriction);
    new ResizeObserver(()=>this.resize()).observe(view);
    this.resize();
  }
  resetView() {
    this.camera.position.set(-91,91,139); this.controls.target.set(-1,7,4); this.controls.update();
  }
  resize() {
    const {width,height}=this.view.getBoundingClientRect();
    if(!width||!height)return;
    this.renderer.setSize(width,height,false); this.camera.aspect=width/height; this.camera.updateProjectionMatrix();
  }
  quality(economy){
    this.autoQuality=!economy;this.frameWindow=[];
    this.renderer.setPixelRatio(economy?.72:Math.min(devicePixelRatio,1.25));this.resize();
  }
  budget(interval){
    if(!this.autoQuality || interval<=0 || interval>500)return;
    this.frameWindow.push(interval);
    if(this.frameWindow.length<120)return;
    const times=this.frameWindow.sort((a,b)=>a-b),q90=times[Math.floor(.9*times.length)],q95=times[Math.floor(.95*times.length)];
    this.frameWindow=[];
    const scale=this.renderer.getPixelRatio();
    const next=q90>36||q95>52?Math.max(.68,scale-.12):q90<16&&q95<30?Math.min(Math.min(1.25,devicePixelRatio),scale+.05):scale;
    if(Math.abs(scale-next)>.01){this.renderer.setPixelRatio(next);this.resize();}
  }
  async load() {
    const loader=new GLTFLoader();
    const [city,quad]=await Promise.all([loader.loadAsync("/assets/CampusDistrict.glb"),loader.loadAsync("/assets/CourierQuad.glb")]);
    this.city=city.scene; this.scene.add(this.city);
    this.city.traverse(o=>{
      o.updateMatrix();o.matrixAutoUpdate=false;
      if(!o.isMesh)return;
      o.castShadow=o.receiveShadow=true; this.colliders.push(o);
      if(["glass","glasslight","darkglass"].includes(o.material.name))this.litGlass.add(o.material);
      if(o.name.startsWith("StationDisplay_")) this.panelMeshes[Number(o.name.split("_")[1])]=o;
    });
    const textures=new T.TextureLoader();
    await Promise.all([17,31,46].flatMap(id=>["available","occupied","unreadable"].map(async state=>{
      const tex=await textures.loadAsync(`/assets/StationDisplays/station_${id}_${state}.png`);
      tex.colorSpace=T.SRGBColorSpace; tex.flipY=false; tex.anisotropy=Math.min(4,this.renderer.capabilities.getMaxAnisotropy());
      this.panelTextures[id+state]=tex;
    })));
    for(const id of [17,31,46]){
      const crate=new T.Mesh(new T.BoxGeometry(1.6,1.25,1.4),new T.MeshStandardMaterial({color:0xbd8046,roughness:.9}));
      crate.position.fromArray(stations[id].pad);crate.position.y+=.5;crate.castShadow=true;
      this.scene.add(crate);this.occupants[id]=crate;this.panelState(id,"available");
    }
    for(let i=0;i<2;i++) {
      const root=quad.scene.clone(true), pivots=[], parcels=[];
      root.traverse(o=>{ if(/^Rotor_[1-4]$/.test(o.name))pivots.push(o);
        if(o.isMesh && o.name.startsWith("Parcel_"))parcels.push(o); });
      this.parcels.push(parcels);
      this.rotors.push(pivots); this.craft.push(root); this.scene.add(root);
    }
    for(const [id,s] of Object.entries(stations)) {
      const tag=document.createElement("span"); tag.className="world-tag"; tag.textContent=s.name;
      this.view.append(tag); this.tags.set(id,tag);
    }
    this.renderer.shadowMap.needsUpdate=true; this.scene.updateMatrixWorld(true);
  }
  panelState(id,state) {
    const mesh=this.panelMeshes[id]; if(!mesh)throw new Error("三维资产缺少站点面板 "+id);
    // The sign is an illuminated real surface visible to the simulated camera.
    if(!mesh.material.isMeshBasicMaterial)mesh.material=new T.MeshBasicMaterial({side:T.DoubleSide,toneMapped:false});
    mesh.material.map=this.panelTextures[id+state]; mesh.material.needsUpdate=true;
    if(this.occupants[id])this.occupants[id].visible=state==="occupied";
    this.renderer.shadowMap.needsUpdate=true;
  }
  barrier(enabled, moving=false,site="south") {
    if(!this.challenge) {
      const g=new T.Group(), orange=new T.MeshStandardMaterial({color:0xe98245,roughness:.62});
      const dark=new T.MeshStandardMaterial({color:0x485b62,roughness:.52});
      this.boom=new T.Group();this.boom.position.z=5.2;g.add(this.boom);
      const part=(x,y,z,w,h,d,mat)=>{
        const p=new T.Mesh(new T.BoxGeometry(w,h,d),mat),parent=y< -5?g:this.boom;
        p.position.set(x,y,z-(parent===this.boom?5.2:0));p.castShadow=true;p.receiveShadow=true;parent.add(p);
      };
      part(0,-12,5.2,.7,26,.7,dark); part(0,0,0,.82,4,11,orange);
      for(let z=-4;z<5;z+=2)part(0,.3,z,.87,1.05,.75,dark);
      this.scene.add(g); this.challenge=g;
    }
    this.challenge.visible=enabled; this.moving=moving;this.site=site;
    this.boom.rotation.y=0;
    this.challenge.position.set(...(site==="north"?[-33,25,-14]:[-12,25,33]));
    this.challenge.rotation.y=site==="north"?Math.PI/2:0;
    this.renderer.shadowMap.needsUpdate=true;
  }
  eventTick(time) {
    if(this.challenge?.visible && this.moving){
      this.boom.rotation.y=1.18*Math.sin(time*.48);
    }
    this.challenge?.updateMatrixWorld(true);
  }
  climate(kind) {
    const night=kind==="night", fog=kind==="fog", rain=kind==="rain";
    this.sky.setHex(night?0x25364f:fog?0xabbdbd:rain?0x91a4af:0xb2cdd1);
    this.scene.fog.color.copy(this.sky); this.scene.fog.density=fog?.018:rain?.009:.0027;
    this.sun.intensity=night?.68:rain?1.3:2.6; this.hemi.intensity=night?.8:1.5;
    this.sun.color.setHex(night?0x97b6ff:rain?0xccd8e1:0xffdfad);
    for(const glass of this.litGlass){glass.emissive.setHex(night?0x4a9ba4:0x000000);glass.emissiveIntensity=night?.28:0;}
  }
  setRoute(points) {
    this.route.geometry.dispose();
    this.route.geometry=new T.BufferGeometry().setFromPoints(points.map(v));
    this.route.visible=points.length>1;
  }
  animateCraft(bodies,time) {
    this.craft.forEach((o,i)=>{
      const b=bodies[i]; o.visible=Boolean(b); if(!b)return;
      o.position.fromArray(b.pos); o.rotation.order="YXZ"; o.rotation.y=b.yaw+Math.PI;
      o.rotation.z=T.MathUtils.clamp(-b.vel[0]*.018,-.22,.22);
      o.rotation.x=T.MathUtils.clamp(b.vel[2]*.016,-.2,.2);
      this.rotors[i].forEach((rotor,j)=>rotor.rotation.y=(j%2?1:-1)*time*(b.airborne?55:4));
      this.parcels[i].forEach(part=>{part.visible=b.cargo;});
    });
    this.scene.updateMatrixWorld();
  }
  aim(b) {
    this.sensor.position.fromArray(b.pos); this.sensor.position.y+=.23;
    this.sensor.rotation.order="YXZ"; this.sensor.rotation.set(b.pitch,b.yaw+b.look,0,"YXZ");
    this.sensor.translateZ(-.41); this.sensor.updateMatrixWorld(true);
  }
  capture(b,id,time,stream,station,level,checkpoint,rangeLimit=90,depthNoise=0,random=Math.random) {
    this.aim(b);
    const renderer=this.renderer, scene=this.scene;
    const own=this.craft[b.index], visible=own.visible; own.visible=false;
    const background=scene.background;
    try {
      renderer.setRenderTarget(this.rgb); renderer.render(scene,this.sensor);
      renderer.readRenderTargetPixels(this.rgb,0,0,W,H,this.raw);
      scene.background=null; scene.overrideMaterial=this.depth; renderer.setClearColor(0,1);
      renderer.setRenderTarget(this.range); renderer.clear(); renderer.render(scene,this.sensor);
      renderer.readRenderTargetPixels(this.range,0,0,W,H,this.zraw);
    } finally {
      scene.background=background; scene.overrideMaterial=null; own.visible=visible;
      renderer.setRenderTarget(null);
    }
    const e=this.sensor.matrixWorld.elements;
    const meta={width:W,height:H,fov:this.sensor.fov,stream,id,sim_time:time,station,level,checkpoint,
                camera_basis:[e[0],e[4],e[8],e[1],e[5],e[9],e[2],e[6],e[10]]};
    const header=new TextEncoder().encode(JSON.stringify(meta));
    const out=new Uint8Array(4+header.length+W*H*6);
    new DataView(out.buffer).setUint32(0,header.length,true); out.set(header,4);
    const color=out.subarray(4+header.length,4+header.length+W*H*4);
    const depth=out.subarray(4+header.length+W*H*4);
    for(let y=0;y<H;y++){
      const from=(H-y-1)*W*4; color.set(this.raw.subarray(from,from+W*4),y*W*4);
      for(let x=0;x<W;x++){
        const p=from+x*4,k=(y*W+x)*2;
        let cm=this.zraw[p]+256*this.zraw[p+1];
        if(cm>rangeLimit*100)cm=0;
        else if(cm>0 && depthNoise)cm=Math.max(1,Math.round(cm+(2*random()-1)*depthNoise*100));
        depth[k]=cm&255;depth[k+1]=cm>>>8;
      }
    }
    return {packet:out,pixels:color.slice()};
  }
  showFrame(pixels) {
    if(!pixels){this.imageContext.clearRect(0,0,W,H);return;}
    this.imageData.data.set(pixels);this.imageContext.putImageData(this.imageData,0,0);
  }
  collision(from,to) {
    const d=v(to).sub(v(from)), length=d.length();
    if(length<1e-5)return false;
    this.meshRay.set(v(from),d.multiplyScalar(1/length)); this.meshRay.far=length+.12;
    if(this.challenge?.visible && this.meshRay.intersectObject(this.challenge,true).length)return true;
    for(const obj of Object.values(this.occupants))if(obj.visible&&this.meshRay.intersectObject(obj).length)return true;
    return this.meshRay.intersectObjects(this.colliders,false).length>0 || to[1]<.14;
  }
  drawKnowledge(b){
    if(this.mapFrame!==b.last){
      this.mapFrame=b.last;
      const stride=Math.max(1,Math.ceil(b.map.voxels.size/2400));let k=0,i=0;
      for(const cell of b.map.voxels.values()){
        if(i++%stride)continue;
        this.mapPositions.setXYZ(k,...cell.point);
        const c=cell.odds>1?[1,.33,.045]:cell.odds<-.8?[.025,.8,.54]:[.19,.27,.27];
        this.mapColors.setXYZ(k++,...c);
      }
      this.mapPositions.needsUpdate=this.mapColors.needsUpdate=true;this.mapPoints.geometry.setDrawRange(0,k);
      b.trajectory.forEach((point,index)=>this.tracePositions.setXYZ(index,...point));
      this.tracePositions.setXYZ(b.trajectory.length,...b.est);
      this.tracePositions.needsUpdate=true;this.estimatedTrace.geometry.setDrawRange(0,b.trajectory.length+1);
    }
    this.estimateArrow.position.fromArray(b.est);
    this.estimateArrow.setDirection(v([-Math.sin(b.yaw),0,-Math.cos(b.yaw)]));
    if(this.mapNeedsFocus){
      this.controls.target.set(b.est[0]*.5,13,b.est[2]*.5);
      this.camera.position.copy(this.controls.target).add(v([33,98,46]));
      this.mapNeedsFocus=false;
    }
    this.controls.enabled=true;this.controls.update();
    this.renderer.render(this.knowledgeScene,this.camera);
  }
  draw(b,time) {
    if(this.mode==="map"){this.drawKnowledge(b);return;}
    const body=v(b.pos);
    this.controls.enabled=this.mode==="overview";
    if(this.mode==="follow"){
      const off=v([-.95,.78,1.2]).applyAxisAngle(v([0,1,0]),b.yaw);
      this.camera.position.lerp(body.clone().addScaledVector(off,this.followDistance),.14);
      this.camera.lookAt(body.clone().add(v([0,.1,0])));
    }else if(this.mode==="fpv"){
      this.aim(b); this.camera.position.copy(this.sensor.position); this.camera.quaternion.copy(this.sensor.quaternion);
    }else if(this.mode==="cinema"){
      this.camera.position.set(body.x+Math.sin(time*.10+.7)*15,body.y+6.2,body.z+Math.cos(time*.10+.7)*15);
      this.camera.lookAt(body);
    }else this.controls.update();
    const own=this.craft[b.index], visible=own.visible;
    if(this.mode==="fpv")own.visible=false;
    this.renderer.render(this.scene,this.camera); own.visible=visible;
    for(const [id,tag] of this.tags){
      const p=v(stations[id].hold); p.y+=3.2; p.project(this.camera);
      tag.hidden=this.mode!=="overview" || p.z>1 || p.z<0 || Math.abs(p.x)>.92 || Math.abs(p.y)>.90;
      tag.style.left=(p.x*.5+.5)*100+"%"; tag.style.top=(-p.y*.5+.5)*100+"%";
    }
  }
  switchView(name,followDistance=3.4) {
    this.mode=name;this.followDistance=followDistance;
    if(name==="overview")this.resetView();
    if(name==="map"){
      this.mapNeedsFocus=true;this.mapFrame=undefined;
      for(const tag of this.tags.values())tag.hidden=true;
    }
  }
}
