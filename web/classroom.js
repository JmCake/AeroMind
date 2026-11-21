import {City} from "./world.js";
import {edgeId} from "./navigation.js";
import {Simulation} from "./simulation.js";
import {drawStationEvidence} from "./station-view.js";

const el = id => document.getElementById(id);
const stages = {
  ready:     [0, "送一件包裹到图书馆", "点一次「开始配送」，沿途看它避障、读站牌。"],
  takeoff:   [0, "带上包裹，起飞", "无人机正在爬升。看一看机载相机离开屋顶时拍到了什么。"],
  search:    [1, "前方施工，它能发现吗？", "航线上出现了挡板。留意机载图像里最先出现的线索。"],
  evidence:  [1, "看见挡板，原路还能走吗？", "画面停留片刻，随后继续飞行。"],
  retreat:   [1, "发现挡板，退回路口", "无人机把这段通道记为受阻，退回路口重新选路。"],
  detour:    [1, "绕开挡板，飞往图书馆", "新航线绕过了刚才测到障碍的通道。"],
  station:   [2, "读懂站牌，才能进站", "在机载图里找一找，哪个图案表示可以交接？"],
  delivered: [2, "图书馆已签收", "包裹送到了。无人机正在沿返程航线飞回物流中心。"],
  complete:  [2, "配送完成，已返仓", ""],
  error:     [0, "这次配送已停止", ""],
};

const regionStyles = {
  construction: {name: "施工构件", color: "#ffae51", fill: "rgba(255,158,55,.22)"},
  station_display: {name: "站牌", color: "#74ffcf", fill: "rgba(81,240,183,.20)"},
};
const marks = el("mask-overlay").getContext("2d");
const readingDurationMs = 6500;
let city, sim, stage, lastObservation, obstacle, stationProof;
let userPaused = false, readingLeft = 0, lastPaint = 0, interrupted = false;
let stageExplanation = "";

function setButton() {
  const action = stage === "ready" ? "开始配送" : stage === "complete" ? "再送一次" :
    stage === "error" ? "重新载入" : userPaused ? "继续演示" : "暂停演示";
  const button = el("next");
  button.querySelector("span").textContent = action;
  button.dataset.action = action === "暂停演示" ? "pause" : "play";
  button.disabled = false;
}

function show(name, detail) {
  stage = name;
  const [step, title, explanation] = stages[name];
  stageExplanation = detail ?? explanation;
  el("lesson").dataset.stage = name;
  el("question").textContent = title;
  el("explanation").textContent = stageExplanation;
  document.querySelectorAll(".progress li").forEach((item, index) => {
    if (index === step && name !== "error") item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
    item.classList.toggle("passed", index < step && name !== "error");
  });
  const stationImage = Boolean(stationProof && ["station", "delivered", "complete"].includes(name));
  el("station-frame").hidden = el("station-source").hidden = !stationImage;
  el("feed").hidden = el("mask-overlay").hidden = el("frame-label").hidden = stationImage;
  el("segmentation-labels").hidden = stationImage;
  el("vision-mode").textContent = stationImage ? "进站定格" : name === "evidence" ? "避障定格" :
    name === "ready" ? "起飞前" : name === "error" ? "已停止" : "实时识别";
  el("scene-text").textContent = name === "delivered" ? "图书馆 → 物流中心" : name === "complete" ? "已返回物流中心" : "物流中心 → 图书馆";
  el("recap").hidden = name !== "complete";
  setButton();
}

// The model's polygons are already expressed in the source camera's pixel
// coordinates. The overlay has the same backing resolution as that camera.
function showCamera(unit) {
  const frame = unit.last;
  if (!frame || frame === lastObservation) return;
  lastObservation = frame;
  city.showFrame(unit.pixels);
  marks.clearRect(0, 0, marks.canvas.width, marks.canvas.height);
  const detected = new Set();
  for (const region of frame.regions) {
    const style = regionStyles[region.label];
    if (!style || region.polygon_px.length < 3) continue;
    detected.add(region.label);
    marks.beginPath();
    region.polygon_px.forEach(([x, y], i) => i ? marks.lineTo(x, y) : marks.moveTo(x, y));
    marks.closePath();
    marks.fillStyle = style.fill;
    marks.fill();
    marks.lineWidth = 1.6;
    marks.strokeStyle = style.color;
    marks.stroke();
  }
  marks.canvas.dataset.frame = String(frame.id);
  el("construction-label").hidden = !detected.has("construction");
  el("sign-label").hidden = !detected.has("station_display");
  el("frame-label").textContent = "机载原图 · F" + frame.id;
  const names = Array.from(detected, label => regionStyles[label].name);
  el("vision-result").textContent = names.length ? "模型标出了" + names.join("和") : "还没认出挡板或站牌";
  el("vision-note").textContent = names.length ? [
    detected.has("construction") ? "橙色轮廓是预测的施工构件" : "",
    detected.has("station_display") ? "绿色轮廓是预测的站牌" : "",
  ].filter(Boolean).join("，") + "。" : "相机拍到的原图会随飞行更新。";
}

function setFlightPaused(paused) {
  sim.paused = paused;
  sim.pauseAt = paused ? sim.tick : null;
  sim.clockDebt = 0;
  sim.lastWall = performance.now();
}

function showObservation(event) {
  const unit = sim.units[event.unit];
  if (event.stationAdmission && stage === "detour") {
    stationProof = drawStationEvidence(el("lesson"), unit.last, unit.pixels, event.stationAdmission) ? unit.last.panel_proof : null;
    if (stationProof) {
      el("vision-result").textContent = "连续两帧 · 可交接";
      el("vision-note").textContent = "绿框内的图案被校正成 " + stationProof.patch_size + " × " + stationProof.patch_size + " 灰度图，交给卷积网络。";
    }
    show("station", stationProof ? undefined : "飞机已获准进站，本次未收到完整的两帧识别记录。");
  }
  if (!event.passage || stage !== "search") return;
  setFlightPaused(true);
  showCamera(unit);
  const pixels = unit.last.ray_pixels_px, feed = el("feed");
  const centerDistance = i => Math.hypot(pixels[i][0] - (feed.width - 1) / 2, pixels[i][1] - (feed.height - 1) / 2);
  const index = event.passage.rayIndices.reduce((a, b) => centerDistance(a) <= centerDistance(b) ? a : b);
  const [x, y] = pixels[index], range = Math.hypot(...unit.last.rays_world_relative_m[index]).toFixed(1);
  obstacle = {edge: event.passage.edge, range, frame: event.frame};
  const ctx = city.imageContext;
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.strokeStyle = "#153732";
  ctx.lineWidth = 3.8;
  ctx.stroke();
  ctx.strokeStyle = "#fffbe9";
  ctx.lineWidth = 2;
  ctx.stroke();
  const replay = el("obstacle-replay").getContext("2d");
  replay.drawImage(feed, 0, 0);
  replay.drawImage(marks.canvas, 0, 0);
  el("obstacle-caption").textContent = "F" + event.frame + " · 白圈处测得 " + range + " 米，原通道受阻。";
  el("vision-result").textContent = "挡板距相机 " + range + " 米";
  el("vision-note").textContent = "白圈标出深度相机的实际测距点。";
  readingLeft = readingDurationMs;
  show("evidence");
}

function fail(message) {
  if (sim) setFlightPaused(true);
  show("error", message);
}

function update(now) {
  const elapsed = lastPaint ? Math.min(250, Math.max(0, now - lastPaint)) : 0;
  lastPaint = now;
  const unit = sim.units[0];
  if (unit.phase === "failed") return fail(sim.events.at(-1)?.reason || unit.visionNote);
  if (sim.running && sim.serviceError) {
    if (!interrupted) {
      interrupted = true;
      el("explanation").textContent = "机载画面暂时中断。无人机正在制动，收到新画面后继续。";
    }
    return;
  }
  if (interrupted) {
    interrupted = false;
    el("explanation").textContent = stageExplanation;
  }
  if (stage === "evidence") {
    if (!userPaused && !document.hidden) readingLeft -= elapsed;
    if (readingLeft <= 0) {
      show("retreat");
      setFlightPaused(false);
    }
    return;
  }
  if (!stationProof) showCamera(unit);
  if (stage === "takeoff" && unit.phase === "cruise" && unit.next) {
    // Introduce an external change once the real planner has selected a route.
    // The controller must discover the change from subsequent RGB-D frames.
    if (!sim.act("barrier", true)) return fail("施工点离飞机太近，本次未能设置挡板。");
    show("search");
  } else if (stage === "retreat" && unit.phase === "cruise" && unit.next) {
    const path = [unit.at, unit.next, ...unit.route];
    if (path.slice(1).every((next, i) => edgeId(path[i], next) !== obstacle.edge)) show("detour");
  } else if (stage === "station" && unit.phase === "holding") {
    stationProof = null;
    lastObservation = null;
    show("detour", "站台情况改变，无人机正在等待新的站牌观测。");
  } else if ((stage === "station" || stage === "detour") && unit.receipts.length) {
    show("delivered");
  } else if (stage === "delivered" && sim.final && unit.phase === "done") {
    show("complete", "白圈处的挡板只有 " + obstacle.range + " 米远，无人机改道。" +
      (stationProof ? "站牌连续两帧显示可交接，它才进站送件。" : "此次进站的模型输入未完整记录。"));
  }
}

function start() {
  obstacle = stationProof = lastObservation = null;
  userPaused = interrupted = false;
  readingLeft = 0;
  el("review").open = false;
  el("station-readings").replaceChildren();
  el("station-rule").textContent = "此次进站的模型输入未完整记录。";
  el("obstacle-caption").textContent = "";
  city.showFrame(null);
  marks.clearRect(0, 0, marks.canvas.width, marks.canvas.height);
  delete marks.canvas.dataset.frame;
  el("construction-label").hidden = el("sign-label").hidden = true;
  el("frame-label").textContent = "等待第一帧";
  el("vision-result").textContent = "相机正在取图";
  el("vision-note").textContent = "收到图像后开始识别。";
  sim.reset({station: 17, chapter: 4, fleet: false, weather: "day", avoid: [], gps: true, panelEvidence: true});
  sim.start();
  show("takeoff");
}

el("next").addEventListener("click", () => {
  if (stage === "ready" || stage === "complete") return start();
  if (stage === "error") return location.reload();
  userPaused = !userPaused;
  setFlightPaused(userPaused || stage === "evidence");
  if (!interrupted) el("explanation").textContent = userPaused ? "画面已暂停，点「继续演示」接着看。" : stageExplanation;
  if (stage !== "evidence" && !stationProof) el("vision-mode").textContent = userPaused ? "已暂停" : "实时识别";
  setButton();
});

async function boot() {
  try {
    const response = await fetch("/api/health", {signal: AbortSignal.timeout(8000)});
    if (!response.ok || (await response.json()).application !== "JmCake/AeroMind/3D") throw new Error("无法连接本机视觉服务。");
    city = new City(el("world"), el("feed"));
    await city.load();
    sim = new Simulation(city, showObservation);
    city.switchView("follow", 2.2);
    city.draw(sim.units[0], 0);
    await sim.sense();
    if (!sim.units[0].last) throw new Error(sim.serviceError || "没有收到起飞前的机载图像。");
    showCamera(sim.units[0]);
    show("ready");
    city.renderer.setAnimationLoop(now => {
      if (stage === "error" || stage === "complete") return;
      sim.frame(now);
      update(now);
    });
  } catch (error) {
    fail("请确认本机视觉服务已启动，并使用支持 WebGL2 的浏览器。" + error.message);
  }
}

boot();
