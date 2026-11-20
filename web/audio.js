// Synthesized locally so offline operation does not need an audio asset pack.
export class FlightAudio {
  async enable(on){
    if(!this.ctx && on){
      this.ctx=new AudioContext();
      this.rotor=this.ctx.createOscillator();this.rotor.type="triangle";
      this.gain=this.ctx.createGain();this.gain.gain.value=0;
      const filter=this.ctx.createBiquadFilter();filter.type="lowpass";filter.frequency.value=410;
      this.rotor.connect(filter).connect(this.gain).connect(this.ctx.destination);this.rotor.start();
    }
    this.on=on;
    if(this.ctx){if(on)await this.ctx.resume();else await this.ctx.suspend();}
  }
  update(unit,live){
    if(!this.ctx||!this.on)return;
    const t=this.ctx.currentTime,v=Math.hypot(...unit.vel);
    this.rotor.frequency.setTargetAtTime(76+v*8,t,.15);
    this.gain.gain.setTargetAtTime(unit.airborne&&live?.028:0,t,.13);
  }
  cue(event){
    if(!this.on||event.kind!=="receipt")return;
    const t=this.ctx.currentTime,tone=this.ctx.createOscillator(),g=this.ctx.createGain();
    tone.frequency.setValueAtTime(587,t);tone.frequency.setValueAtTime(784,t+.095);
    g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(.055,t+.015);g.gain.exponentialRampToValueAtTime(.0001,t+.26);
    tone.connect(g).connect(this.ctx.destination);tone.start(t);tone.stop(t+.27);
    tone.onended=()=>{tone.disconnect();g.disconnect();};
  }
}
