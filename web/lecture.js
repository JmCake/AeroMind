// Times follow the classroom script. Each transition retains actual simulation
// evidence; a slow comparison can extend its slot without skipping a branch.
const chapters=[
  [0,"云港开场","查看订单起点、目的地和装载状态。"],
  [30,"航线自动化","检查前向测距触发制动的帧，观察自动化航线在哪里停下。"],
  [80,"空间理解","关闭 GPS 后，比较视觉、惯性估计和认知地图。"],
  [140,"主动观察","改变通道条件，观察新机载帧怎样改变原定路径。"],
  [240,"状态分叉","对照相同快照下的两个分支，比较等待时间和交付回执。"],
  [320,"机群协作","追踪通道消息从发现、接收、融合到改道的过程。"],
  [390,"投递与回放","回看实际站台图像，核对订单回执与返航结果。"]
];

export class Lecture {
  constructor(actions){this.actions=actions;this.active=false;this.report=null;}
  start(rate){
    this.active=true;this.paused=false;this.index=0;this.elapsed=0;this.rate=rate;this.last=performance.now();
    this.report={rate,completed:false,stages:[]};this.actions.enter(0);this.draw();
  }
  stop(){this.active=false;}
  draw(){
    const [,title,hint]=chapters[this.index];
    this.actions.status(title,hint,this.elapsed,this.index+1);
  }
  tick(now){
    if(!this.active)return;
    if(!this.paused)this.elapsed+=(now-this.last)*this.rate/1000;
    this.last=now;
    const boundary=chapters[this.index+1]?.[0]??450;
    if(this.elapsed>=boundary){
      const complete=this.actions.ready(this.index);
      if(!complete){this.elapsed=boundary;this.draw();return;}
      this.report.stages.push({stage:this.index+1,title:chapters[this.index][1],...this.actions.evidence(this.index)});
      if(++this.index===chapters.length){
        this.active=false;this.report.completed=true;this.actions.finish(this.report);return;
      }
      this.actions.enter(this.index);
    }
    this.draw();
  }
}
