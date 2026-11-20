// Discrete classroom decisions. Hard route, berth, load and energy constraints
// are checked by the simulator before a learned preference can take effect.
export const viewAngles=[-.5,0,.5];
export const pace=[3.4,5.2,7];
const threeBins=(x,a,b)=>x<a?0:x<b?1:2;

export function gazeState(candidates,sectors){
  const gain=viewAngles.map(offset=>candidates.find(c=>c.offset===offset)?.gain??0);
  const side=(sectors[0]??50)-(sectors[4]??50);
  return [threeBins(gain[0]-gain[2],-.35,.35),threeBins(gain[1]-(gain[0]+gain[2])/2,-.45,.45),
    threeBins(side,-2,2)].join("");
}
export function paceState(range,tracked,closing){
  return [threeBins(range??50,8,18),tracked>=20?1:0,closing< -2?1:0].join("");
}
export function dispatchState(eligible,order){
  const [a,b]=[...eligible].sort((x,y)=>x.index-y.index);
  return [threeBins(a.energy-b.energy,-7,7),threeBins(a.capacity-b.capacity,-.15,.15),order.priority>1?1:0].join("");
}
export function learnedAction(table,key,fallback,allowed){
  const row=table?.[key];
  if(!row)return fallback;
  const valid=allowed.filter(a=>row.n[a]>=5);
  if(!valid.length)return fallback;
  return valid.reduce((best,a)=>row.q[a]>row.q[best]?a:best,valid.includes(fallback)?fallback:valid[0]);
}
