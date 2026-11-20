import * as T from "three";
import {GLTFLoader} from "three/addons/loaders/GLTFLoader.js";
import {OrbitControls} from "three/addons/controls/OrbitControls.js";
import {nodes, stations} from "./navigation.js";

const v = a => new T.Vector3(...a);
const W=320, H=180;

export class City {
  constructor(view, image) {
    this.renderer=new T.WebGLRenderer({antialias:true,alpha:false,powerPreference:"high-performance"});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.4));
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
    const floor=new T.Mesh(new T.PlaneGeometry(1100,1100),new T.MeshStandardMaterial({color:0x80978f,roughness:.96}));
    floor.rotation.x=-Math.PI/2; floor.position.y=-1.6; floor.receiveShadow=true; this.scene.add(floor);
    const distant=new T.InstancedMesh(new T.BoxGeometry(),new T.MeshStandardMaterial({color:0x97a9ae,roughness:.85}),64);
    const transform=new T.Object3D();
    for(let i=0;i<64;i++) {
      const t=i*2.39996, radius=175+(i%5)*12, height=8+(i*37%62);
      transform.position.set(Math.cos(t)*radius,height/2-1.6,Math.sin(t)*radius);
      transform.scale.set(11+i%9,height,10+i%12); transform.updateMatrix(); distant.setMatrixAt(i,transform.matrix);
    }
    this.scene.add(distant);
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
    this.craft=[]; this.rotors=[]; this.panelMeshes={}; this.panelTextures={};
    this.layer=new T.Group(); this.layer.layers.set(1); this.scene.add(this.layer);
    const lineMaterial=new T.LineBasicMaterial({color:0x13d0c1,transparent:true,opacity:.9,depthTest:false});
    this.route=new T.Line(new T.BufferGeometry(),lineMaterial); this.route.layers.set(1); this.layer.add(this.route);
    this.route.frustumCulled=false;
    this.meshRay=new T.Raycaster();
    this.tags=new Map(); this.colliders=[]; this.challenge=null;this.occupants={};
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
  async load() {
    const loader=new GLTFLoader();
    const [city,quad]=await Promise.all([loader.loadAsync("/assets/CampusDistrict.glb"),loader.loadAsync("/assets/CourierQuad.glb")]);
    this.city=city.scene; this.scene.add(this.city);
    this.city.traverse(o=>{
      if(!o.isMesh)return;
      o.castShadow=o.receiveShadow=true; this.colliders.push(o);
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
      const root=quad.scene.clone(true), pivots=[];
      root.traverse(o=>{ if(/^Rotor_[1-4]$/.test(o.name))pivots.push(o); });
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
  barrier(enabled, moving=false) {
    if(!this.challenge) {
      const g=new T.Group(), orange=new T.MeshStandardMaterial({color:0xe98245,roughness:.62});
      const dark=new T.MeshStandardMaterial({color:0x485b62,roughness:.52});
      const part=(x,y,z,w,h,d,mat)=>{
        const p=new T.Mesh(new T.BoxGeometry(w,h,d),mat); p.position.set(x,y,z); p.castShadow=true; p.receiveShadow=true; g.add(p);
      };
      part(0,-12,5.2,.7,26,.7,dark); part(0,0,0,.82,4,11,orange);
      for(let z=-4;z<5;z+=2)part(0,.3,z,.87,1.05,.75,dark);
      this.scene.add(g); this.challenge=g;
    }
    this.challenge.visible=enabled; this.moving=moving; this.challenge.position.set(-12,25,33);
    this.renderer.shadowMap.needsUpdate=true;
  }
  eventTick(time) {
    if(this.challenge?.visible && this.moving)this.challenge.position.z=33+6*Math.sin(time*.42);
    this.challenge?.updateMatrixWorld(true);
  }
  climate(kind) {
    const night=kind==="night", fog=kind==="fog", rain=kind==="rain";
    this.sky.setHex(night?0x25364f:fog?0xabbdbd:rain?0x91a4af:0xb2cdd1);
    this.scene.fog.color.copy(this.sky); this.scene.fog.density=fog?.018:rain?.009:.0027;
    this.sun.intensity=night?.68:rain?1.3:2.6; this.hemi.intensity=night?.8:1.5;
    this.sun.color.setHex(night?0x97b6ff:rain?0xccd8e1:0xffdfad);
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
    });
    this.scene.updateMatrixWorld(true);
  }
  aim(b) {
    this.sensor.position.fromArray(b.pos); this.sensor.position.y+=.23;
    this.sensor.rotation.order="YXZ"; this.sensor.rotation.set(b.pitch,b.yaw+b.look,0,"YXZ");
    this.sensor.translateZ(-.41); this.sensor.updateMatrixWorld(true);
  }
  capture(b,id,time,stream,station,level,show=true) {
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
    const meta={width:W,height:H,fov:this.sensor.fov,stream,id,sim_time:time,station,level,
                camera_basis:[e[0],e[4],e[8],e[1],e[5],e[9],e[2],e[6],e[10]]};
    const header=new TextEncoder().encode(JSON.stringify(meta));
    const out=new Uint8Array(4+header.length+W*H*6);
    new DataView(out.buffer).setUint32(0,header.length,true); out.set(header,4);
    const color=out.subarray(4+header.length,4+header.length+W*H*4);
    const depth=out.subarray(4+header.length+W*H*4);
    for(let y=0;y<H;y++){
      const from=(H-y-1)*W*4; color.set(this.raw.subarray(from,from+W*4),y*W*4);
      for(let x=0;x<W;x++){ const p=from+x*4,k=(y*W+x)*2;depth[k]=this.zraw[p];depth[k+1]=this.zraw[p+1]; }
    }
    if(show){this.imageData.data.set(color);this.imageContext.putImageData(this.imageData,0,0);}
    return out;
  }
  collision(from,to) {
    const d=v(to).sub(v(from)), length=d.length();
    if(length<1e-5)return false;
    this.meshRay.set(v(from),d.multiplyScalar(1/length)); this.meshRay.far=length+.12;
    if(this.challenge?.visible && this.meshRay.intersectObject(this.challenge,true).length)return true;
    for(const obj of Object.values(this.occupants))if(obj.visible&&this.meshRay.intersectObject(obj).length)return true;
    return this.meshRay.intersectObjects(this.colliders,false).length>0 || to[1]<.14;
  }
  draw(b,time) {
    const body=v(b.pos);
    this.controls.enabled=this.mode==="overview"||this.mode==="map";
    if(this.mode==="follow"){
      const off=v([-.95,.78,1.2]).applyAxisAngle(v([0,1,0]),b.yaw);
      this.camera.position.lerp(body.clone().addScaledVector(off,3.4),.14);
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
  switchView(name) {
    this.mode=name;
    if(name==="overview")this.resetView();
    if(name==="map"){this.camera.position.set(0,159,1);this.controls.target.set(0,0,0);this.controls.update();}
  }
}
