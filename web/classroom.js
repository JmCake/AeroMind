import {Vector3} from "three";
import {City} from "./world.js";
import {airWaypoint, edgeId} from "./navigation.js";
import {Simulation} from "./simulation.js";
import {drawStationEvidence} from "./station-view.js";

const el = id => document.getElementById(id);
const copy = {
  ready: ["图书馆配送", "无人机如何从图像决定下一步？", "路上看它怎样发现挡板，到站看它怎样读懂站牌。", "起飞送货"],
  takeoff: ["起飞", "它准备走哪条路？", "包裹已装载。升到巡航高度后，画面会停在它选好的航线上。"],
  route: ["看航线", "如果前面施工，它会立刻知道吗？", "青线是刚算出的路线。请一位同学在通道里设置施工，再观察无人机的反应。", "设置前方施工"],
  search: ["看现场", "它什么时候才会发现施工？", "施工已经开始。留意飞机飞到哪里才刹车。"],
  evidence: ["机载图像与深度", "这张图里的挡板离相机多远？", "", "继续配送"],
  retreat: ["看行动", "它接下来会往哪边飞？", "无人机正在退回上一个航点，到那里会重新计算路线。"],
  detour: ["看行动", "它选了一条怎样的新路线？", "青线是绕开受阻通道后重新算出的路线。"],
  station: ["站牌图像分类", "怎样从站牌判断能否交接？", "左侧的黑白方码标识图书馆。相机画面中框出的状态图案被校正成灰度小图，交给卷积网络分类。"],
  delivered: ["图书馆已签收", "如果第二帧显示占用，还能进站吗？", "模型逐帧判断可交接、占用或看不清。如果中途读到占用，进站确认就要重新开始。"],
  complete: ["包裹已签收 · 无人机已返仓", "哪幅图让它绕行，哪两帧让它进站？", "", "再讲一次"],
};

const runningStages = new Set(["takeoff", "search", "retreat", "detour", "station", "delivered"]);
const routeStages = new Set(["route", "detour"]);
const overlay = el("route-overlay");
const routeContext = overlay.getContext("2d");
const projected = new Vector3();
let city, sim, stage, evidence, originalRoute, interruptedExplanation;
let showingRoute = false;
let hasStationEvidence = false;

function show(stageName, detail) {
  stage = stageName;
  interruptedExplanation = null;
  const [topic, question, explanation, action] = copy[stage];
  el("lesson").dataset.stage = stage;
  el("topic").textContent = topic;
  el("question").textContent = !hasStationEvidence && stage === "delivered" ? "包裹送到哪里了？" :
    !hasStationEvidence && stage === "complete" ? "哪一帧观测改变了航线？" : question;
  el("explanation").textContent = detail ?? explanation;
  el("next").textContent = action ?? "暂停飞行";
  el("next").disabled = false;
  const reading = stage === "evidence" || stage === "complete";
  const withStation = hasStationEvidence && ["station", "delivered", "complete"].includes(stage);
  el("lesson").classList.toggle("with-station", withStation);
  el("station-proof").hidden = !withStation;
  el("observation").hidden = !reading;
  el("world").style.visibility = reading ? "hidden" : "";
  showingRoute = routeStages.has(stage);
  overlay.hidden = !showingRoute;
  el("scene-caption").hidden = reading;
  document.querySelector(".route-swatch").hidden = !showingRoute;
  el("old-edge-key").hidden = stage !== "detour" || !evidence?.oldSegment;
  const flightLabel = stage === "delivered" ? "图书馆 → 物流中心" : stage === "station" ? "图书馆 · 正在进站" : "物流中心 → 图书馆";
  el("scene-text").textContent = showingRoute ? (stage === "route" ? "原计划航线" : "重新规划的航线") : flightLabel;
}

function routeView() {
  city.switchView("overview");
  city.camera.position.set(-65, 98, 120);
  city.controls.target.set(-18, 14, 29);
  city.controls.update();
}

function closeView(unit) {
  city.switchView("follow", 1.8);
  city.camera.position.fromArray(unit.pos).add(new Vector3(-1.71, 1.40, 2.16));
}

// Trace the planner's displayed 3D polyline in projector-sized pixels. The
// overlay is on the spectator screen and never enters either sensor target.
function drawRoute() {
  if (!showingRoute) return;
  const width = overlay.clientWidth, height = overlay.clientHeight;
  if (overlay.width !== width) overlay.width = width;
  if (overlay.height !== height) overlay.height = height;
  routeContext.clearRect(0, 0, width, height);
  if (stage === "detour" && evidence.oldSegment) {
    routeContext.beginPath();
    evidence.oldSegment.forEach((point, i) => {
      projected.fromArray(point).project(city.camera);
      const x = (1 + projected.x) * width / 2, y = (1 - projected.y) * height / 2;
      if (i === 0) routeContext.moveTo(x, y);
      else routeContext.lineTo(x, y);
    });
    routeContext.setLineDash([9, 7]);
    routeContext.lineWidth = 5;
    routeContext.strokeStyle = "#593a20";
    routeContext.stroke();
    routeContext.lineWidth = 3;
    routeContext.strokeStyle = "#ffc07a";
    routeContext.stroke();
    routeContext.setLineDash([]);
  }
  const points = city.route.geometry.getAttribute("position");
  if (!points?.count) return;
  routeContext.beginPath();
  let penDown = false;
  for (let index = 0; index < points.count; index++) {
    projected.fromBufferAttribute(points, index).project(city.camera);
    if (projected.z < -1 || projected.z > 1) { penDown = false; continue; }
    const x = (projected.x + 1) * width / 2, y = (1 - projected.y) * height / 2;
    if (penDown) routeContext.lineTo(x, y);
    else routeContext.moveTo(x, y);
    penDown = true;
  }
  routeContext.lineJoin = "round";
  routeContext.lineCap = "round";
  routeContext.lineWidth = 6;
  routeContext.strokeStyle = "#15594f";
  routeContext.stroke();
  routeContext.lineWidth = 3;
  routeContext.strokeStyle = "#67ffdf";
  routeContext.stroke();
}

function hold() {
  sim.pauseAt = sim.tick;
  sim.paused = true;
}

function resume() {
  sim.clockDebt = 0;
  sim.lastWall = performance.now();
  sim.pauseAt = null;
  sim.paused = false;
}

function keepSiteStill(unit, measuredRay) {
  // The spectator sees the situation at the decision tick. Only the separate
  // onboard RGB-D image supplies the measurement used by the controller.
  const forward = new Vector3(measuredRay[0], 0, measuredRay[2]).normalize();
  const side = new Vector3(-forward.z, 0, forward.x);
  city.switchView("overview");
  city.controls.target.fromArray(unit.pos).addScaledVector(forward, 1.7);
  city.camera.position.copy(city.controls.target).addScaledVector(side, 8.5).addScaledVector(forward, -6.5);
  city.camera.position.y += 3;
  city.controls.update();
  const routeVisible = city.route.visible;
  city.route.visible = false;
  city.draw(unit, sim.time);
  city.route.visible = routeVisible;
  const source = city.renderer.domElement, still = el("site-still");
  const scale = Math.max(still.width / source.width, still.height / source.height);
  const width = still.width / scale, height = still.height / scale;
  still.getContext("2d").drawImage(source, (source.width - width) / 2, (source.height - height) / 2,
    width, height, 0, 0, still.width, still.height);
}

function showObservation(event) {
  if (event.stationAdmission && ["detour", "station"].includes(stage)) {
    const unit = sim.units[event.unit];
    hasStationEvidence = drawStationEvidence(el("station-proof"), unit.last, unit.pixels, event.stationAdmission);
    city.switchView("follow", 2.5);
    show("station", hasStationEvidence ? undefined : "已获准进站，这次未收到完整的两帧模型记录。");
    return;
  }
  if (stage !== "search" || !event.passage) return;
  const unit = sim.units[event.unit];
  hold();
  const pixels = unit.last.ray_pixels_px, feed = el("feed");
  const fromCenter = i => Math.hypot(pixels[i][0] - (feed.width - 1) / 2, pixels[i][1] - (feed.height - 1) / 2);
  const index = event.passage.rayIndices.reduce((best, i) => fromCenter(i) < fromCenter(best) ? i : best);
  const [x, y] = pixels[index], ray = unit.last.rays_world_relative_m[index];
  const edge = event.passage.edge;
  const nextIndex = originalRoute.findIndex((next, i) => i > 0 && edgeId(originalRoute[i - 1], next) === edge);
  const oldSegment = nextIndex > 0 ? originalRoute.slice(nextIndex - 1, nextIndex + 1).map(node => airWaypoint(node, unit.index)) : null;
  evidence = {frame: event.frame, edge, oldSegment, range: Math.hypot(...ray).toFixed(1)};
  keepSiteStill(unit, ray);
  city.showFrame(unit.pixels);
  const ctx = city.imageContext;
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = "#123734";
  ctx.stroke();
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = "#8affdb";
  ctx.stroke();
  el("frame-label").textContent = "机载画面 · F" + event.frame;
  show("evidence", "彩色图像里能看见挡板，对应位置的深度测量给出 " + evidence.range + " 米。还能沿原路向前飞吗？");
}

function fail(message) {
  if (sim) hold();
  stage = "error";
  el("lesson").dataset.stage = stage;
  el("topic").textContent = "配送已停止";
  el("question").textContent = "这次飞行未能继续";
  el("explanation").textContent = message;
  el("next").textContent = "重新开始";
  el("next").disabled = false;
}

function update() {
  const b = sim.units[0];
  if (b.phase === "failed") return fail(b.visionNote);
  if (sim.serviceError && sim.running) {
    if (interruptedExplanation === null) {
      interruptedExplanation = el("explanation").textContent;
      el("explanation").textContent = "机载画面暂时中断。无人机正在制动，收到新画面后继续。";
    }
    return;
  }
  if (interruptedExplanation !== null) {
    el("explanation").textContent = interruptedExplanation;
    interruptedExplanation = null;
  }
  if (stage === "takeoff" && b.phase === "cruise" && b.next) {
    hold();
    originalRoute = [b.at, b.next, ...b.route];
    routeView();
    show("route");
  } else if (stage === "retreat" && b.phase === "cruise" && b.next) {
    const route = [b.at, b.next, ...b.route];
    const usesOldEdge = route.slice(1).some((next, i) => edgeId(route[i], next) === evidence.edge);
    if (!usesOldEdge) {
      routeView();
      show("detour", route.includes("plaza") ? "它改从广场一侧飞往图书馆。沿青线看，原来被挡的通道已经绕开了。" : undefined);
    }
  } else if (stage === "station" && b.phase === "holding") {
    hasStationEvidence = false;
    routeView();
    show("detour", "本次进站已撤回，无人机正在等待新的站牌观测。");
  } else if ((stage === "station" || stage === "detour") && b.receipts.length) {
    city.switchView("cinema");
    show("delivered", hasStationEvidence ? undefined : "图书馆已完成交接。此次进站的模型输入未完整记录。");
  } else if (stage === "delivered" && sim.final && b.phase === "done") {
    el("frame-label").textContent = "改道时的机载画面 · F" + evidence.frame + " · " + evidence.range + " 米";
    show("complete", hasStationEvidence
      ? "用 F" + evidence.frame + " 的测距点解释绕行，再用两次站牌分类结果解释为什么可以交接。"
      : "可以回看 F" + evidence.frame + " 的改道依据。此次进站的模型输入未完整记录。");
  }
}

function start() {
  evidence = null;
  hasStationEvidence = false;
  sim.reset({station: 17, chapter: 4, fleet: false, weather: "day", avoid: [], gps: true, panelEvidence: true});
  closeView(sim.units[0]);
  sim.start();
  show("takeoff");
}

el("next").addEventListener("click", () => {
  if (stage === "ready" || stage === "complete") return start();
  if (stage === "error") return location.reload();
  if (stage === "route") {
    if (!sim.act("barrier", true)) return fail("施工点与机体保护区重叠，这次无法设置施工。");
    city.switchView("follow");
    show("search");
    resume();
  } else if (stage === "evidence") {
    city.switchView("follow");
    show("retreat");
    resume();
  } else if (runningStages.has(stage)) {
    if (sim.paused) resume();
    else hold();
    el("next").textContent = sim.paused ? "继续飞行" : "暂停飞行";
  }
});

async function boot() {
  try {
    const response = await fetch("/api/health", {signal: AbortSignal.timeout(8000)});
    if (!response.ok || (await response.json()).application !== "JmCake/AeroMind/3D") {
      throw new Error("无法连接本机视觉服务。");
    }
    city = new City(el("world"), el("feed"));
    await city.load();
    sim = new Simulation(city, showObservation);
    city.tags.get("31").classList.add("outside-lesson");
    closeView(sim.units[0]);
    show("ready");
    city.renderer.setAnimationLoop(now => {
      if (stage === "evidence" || stage === "error" || stage === "complete") return;
      // A pending sensor request holds the physics tick. Repainting the same
      // city on a software renderer competes with that request for CPU time.
      sim.frame(now, !sim.pending || sim.paused);
      update();
      drawRoute();
    });
  } catch (error) {
    fail("请检查本机视觉服务与浏览器的 WebGL2 支持。" + error.message);
  }
}

boot();
