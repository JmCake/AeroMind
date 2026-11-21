// Drive the public classroom screen and compare its decision still to the
// RGB-D request and response of that exact flight. Never inject a flight result.
const {chromium} = require("playwright-core");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {createHash} = require("node:crypto");

async function canvasPixels(canvas) {
  return Buffer.from(await canvas.evaluate(node => {
    const rgba = node.getContext("2d").getImageData(0, 0, node.width, node.height).data;
    const chunks = [];
    for (let i = 0; i < rgba.length; i += 8192) chunks.push(String.fromCharCode(...rgba.subarray(i, i + 8192)));
    return btoa(chunks.join(""));
  }), "base64");
}

async function cameraFrame(recent, id, stream) {
  for (const response of recent.slice().reverse()) {
    if (!response.ok()) continue;
    const result = await response.json();
    if (result.id !== id || (stream && result.stream !== stream)) continue;
    const packet = response.request().postDataBuffer();
    const end = 4 + packet.readUInt32LE(0), meta = JSON.parse(packet.subarray(4, end).toString());
    assert.equal(meta.id, id);
    assert.equal(meta.stream, result.stream);
    return {result, meta, packet, rgb: packet.subarray(end, end + meta.width * meta.height * 4)};
  }
  throw new Error("Missing original camera request for F" + id);
}

async function checkStation(page, recent, rawFolder) {
  const frameId = Number((await page.locator("#station-source").innerText()).match(/F(\d+)/)[1]);
  const exact = await cameraFrame(recent, frameId);
  const proof = exact.result.panel_proof;
  assert.equal(exact.result.handoff.state, "ready");
  assert.equal(proof.station, 17);
  assert.deepEqual(proof.frames.map(f => f.stamp_ns), exact.result.handoff.evidence_ns);
  assert.equal(proof.frames[1].id, frameId);
  assert.ok(proof.frames[0].id < frameId);
  assert.equal(await page.locator("#station-readings li").count(), 2);
  const camera = await canvasPixels(page.locator("#station-frame"));
  const quad = proof.frames[1].polygon_px;
  const xs = quad.map(p => p[0]), ys = quad.map(p => p[1]);
  let outlined = 0;
  for (let i = 0; i < camera.length; i += 4) {
    if (camera.subarray(i, i + 3).equals(exact.rgb.subarray(i, i + 3))) continue;
    const x = (i / 4) % exact.meta.width, y = Math.floor(i / 4 / exact.meta.width);
    assert.ok(x >= Math.min(...xs) - 4 && x <= Math.max(...xs) + 4 && y >= Math.min(...ys) - 4 && y <= Math.max(...ys) + 4);
    outlined++;
  }
  assert.ok(outlined > 0 && outlined < camera.length / 16, "Only the measured sign outline may change the camera picture");
  const inputs = [];
  for (const [i, frame] of proof.frames.entries()) {
    const {result, meta, packet} = await cameraFrame(recent, frame.id, exact.result.stream);
    const reading = result.readings.find(r => r.station === proof.station);
    assert.equal(Math.round(meta.sim_time * 1e9), frame.stamp_ns);
    assert.equal(reading.state, "available");
    assert.equal(frame.state, reading.state);
    assert.equal(frame.confidence, reading.confidence);
    assert.ok(frame.confidence >= proof.min_confidence);
    assert.deepEqual(reading.polygon_px, frame.polygon_px);
    const tile = Buffer.from(frame.gray_u8_b64, "base64");
    assert.equal(tile.length, proof.patch_size ** 2);
    const row = page.locator("#station-readings li").nth(i);
    const shown = await canvasPixels(row.locator("canvas"));
    assert.equal(shown.length, 4 * tile.length);
    for (let k = 0; k < tile.length; k++) {
      assert.equal(shown.readUInt32BE(k * 4), tile[k] * 0x1010100 + 255);
    }
    const caption = await row.textContent();
    assert.ok(caption.includes("F" + frame.id) && caption.includes("可交接"));
    const displayedScore = Number(caption.match(/([\d.]+)%/)[1]) / 100;
    assert.ok(Math.abs(displayedScore - frame.confidence) <= .00101);
    if (rawFolder) fs.writeFileSync(path.join(rawFolder, "station-" + frame.id + ".rgbd"), packet);
    inputs.push({id: frame.id, simulation_seconds: meta.sim_time, state: frame.state, score: frame.confidence, polygon_px: frame.polygon_px,
      gray_sha256: createHash("sha256").update(tile).digest("hex")});
  }
  return {station: proof.station, min_confidence: proof.min_confidence, patch_size: proof.patch_size, frames: inputs, outlined_pixels: outlined};
}

async function checkFrame(page, recent) {
  const label = await page.locator("#frame-label").innerText();
  const id = Number(label.match(/F(\d+)/)[1]);
  const shownRange = (await page.locator("#vision-result").innerText()).match(/(\d+\.\d) 米/)[1];
  for (const response of recent.slice().reverse()) {
    if (!response.ok()) continue;
    const data = await response.json();
    if (data.id !== id) continue;
    const packet = response.request().postDataBuffer();
    const headerEnd = 4 + packet.readUInt32LE(0);
    const meta = JSON.parse(packet.subarray(4, headerEnd).toString());
    assert.equal(meta.id, id);
    assert.equal(data.stream, meta.stream);
    assert.equal(data.ray_pixels_px.length, data.rays_world_relative_m.length);
    const rgb = packet.subarray(headerEnd, headerEnd + meta.width * meta.height * 4);
    const displayed = await canvasPixels(page.locator("#feed"));
    assert.equal(displayed.length, rgb.length);
    const marked = [];
    for (const [x, y] of data.ray_pixels_px) {
      let changes = 0;
      for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
        const off = ((y + dy) * meta.width + x + dx) * 4;
        if (!rgb.subarray(off, off + 3).equals(displayed.subarray(off, off + 3))) changes++;
      }
      if (changes > 12) marked.push([x, y]);
    }
    assert.equal(marked.length, 1, "The teaching marker must coincide with one actual ray");
    const [x, y] = marked[0];
    const z = packet.readUInt16LE(headerEnd + rgb.length + 2 * (meta.width * y + x)) / 100;
    const focal = meta.height / (2 * Math.tan(meta.fov * Math.PI / 360));
    const measuredRange = z * Math.hypot(1, (x - (meta.width - 1) / 2) / focal, (y - (meta.height - 1) / 2) / focal);
    assert.ok(Math.abs(Number(shownRange) - measuredRange) < 0.06, "Project the original depth sample into metres");
    let changed = 0;
    for (let i = 0; i < displayed.length; i += 4) {
      if (!rgb.subarray(i, i + 3).equals(displayed.subarray(i, i + 3))) changed++;
    }
    assert.ok(changed > 0 && changed <= 200, "The remaining pixels must be the original RGB frame");
    const overlay = page.locator("#mask-overlay");
    assert.equal(Number(await overlay.getAttribute("data-frame")), id);
    const mask = await overlay.evaluate((canvas, regions) => {
      const reference = document.createElement("canvas");
      reference.width = canvas.width;
      reference.height = canvas.height;
      const ctx = reference.getContext("2d");
      for (const {polygon_px} of regions) {
        const path = new Path2D();
        polygon_px.forEach(([x, y], i) => i ? path.lineTo(x, y) : path.moveTo(x, y));
        path.closePath();
        ctx.fillStyle = "white";
        ctx.fill(path);
        ctx.strokeStyle = "gray"; // Allow antialiasing around the outline.
        ctx.lineWidth = 5;
        ctx.stroke(path);
      }
      const expected = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const actual = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0, mismatches = 0;
      for (let p = 0; p < actual.length; p += 4) {
        if (actual[p + 3]) ink++;
        if ((!expected[p + 3] && actual[p + 3]) || (expected[p] === 255 && expected[p + 3] === 255 && !actual[p + 3])) mismatches++;
      }
      return {ink, mismatches};
    }, data.regions);
    assert.equal(mask.mismatches, 0, "The displayed mask must cover the predicted polygon interiors and leave the outside clear");
    assert.equal(mask.ink > 0, data.regions.length > 0);
    for (const [label, selector] of [["construction", "#construction-label"], ["station_display", "#sign-label"]]) {
      assert.equal(await page.locator(selector).isVisible(), data.regions.some(r => r.label === label));
    }
    return {frame: id, simulation_seconds: meta.sim_time, measured_pixel: marked[0], range_m: Number(shownRange), marked_image_pixels: changed,
      model_regions: data.regions.map(r => r.label), overlay_pixels: mask.ink};
  }
  throw new Error("Missing model response for the displayed frame " + id);
}

async function main() {
  const [url = "http://127.0.0.1:8863", dest = "output/playwright/classroom", repeats = "1", profile = "hardware"] = process.argv.slice(2);
  const software = profile === "software-checkpoint";
  const faultTest = profile === "reconnect" || software;
  assert.ok(software || faultTest || profile === "hardware");
  fs.mkdirSync(dest, {recursive: true});
  const browser = await chromium.launch({channel: "msedge", headless: true, args: software
    ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : ["--enable-gpu", "--use-angle=d3d11"]});
  const page = await browser.newPage({viewport: software ? {width: 820, height: 500} : {width: 1280, height: 720},
    deviceScaleFactor: software ? 0.65 : 1});
  const errors = [], recent = [], runs = [];
  let requests = 0, submitted = 0, interruptedRequests = 0;
  const observed = new Map();
  let lastStage = "", lastFrame = null, lastProgress = Date.now();
  await page.exposeFunction("recordLessonStage", entry => {
    if (entry.stage === "loading" || entry.stage === "takeoff") observed.clear();
    observed.set(entry.stage, entry);
    lastStage = entry.stage;
    lastProgress = Date.now();
    if (software) console.log("Lesson", entry.stage, "at", lastFrame);
  });
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const lesson = document.querySelector("#lesson");
      if (!lesson) return;
      const record = () => window.recordLessonStage({stage: lesson.dataset.stage,
        explanation: document.querySelector("#explanation").textContent, route: document.querySelector("#scene-text").textContent});
      new MutationObserver(record).observe(lesson, {attributes: true, attributeFilter: ["data-stage"]});
      record();
    });
  });
  page.on("pageerror", error => errors.push(error.message));
  page.on("crash", () => errors.push("Classroom page crashed"));
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/frame") submitted++;
  });
  page.on("response", response => {
    if (new URL(response.url()).pathname !== "/api/frame") return;
    requests++;
    if (faultTest && response.headers()["x-classroom-test"] === "dropped-frame") interruptedRequests++;
    else if (!response.ok()) errors.push("frame HTTP " + response.status());
    if (response.ok()) {
      lastProgress = Date.now();
      if (software && requests % 32 === 0) response.json().then(({id, sim_time}) => {
        lastFrame = {id, sim_time};
        console.log("Accepted camera frame", id, "at", sim_time, "simulated seconds during", lastStage);
      }).catch(() => {}); // A navigation may release this optional timing sample.
    }
    recent.push(response);
    if (recent.length > 16) recent.shift();
  });
  const at = async stage => {
    const start = Date.now();
    // Read real DOM transitions once. Polling layout on a virtual GPU competes
    // with actual RGB-D capture. A slow return still has to produce new frames.
    const limit = software && stage === "complete" ? 480000 : software ? 240000 : 105000;
    while (!observed.has(stage)) {
      if (observed.has("error")) throw new Error(observed.get("error").explanation);
      if (errors.length || Date.now() - Math.max(lastProgress, start) > 90000 || Date.now() - start > limit)
        throw new Error("Waiting for " + stage + ": " + JSON.stringify({lastStage, lastFrame, requests, errors}));
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return observed.get(stage);
  };
  const click = name => page.getByRole("button", {name, exact: true}).click();
  const lessonFits = () => page.evaluate(() => {
    return ["#next", ".image-plane"].every(selector => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return box.width > 80 && box.top >= 0 && box.bottom <= innerHeight + 1;
    }) && document.documentElement.scrollWidth <= innerWidth;
  });
  async function held() {
    await page.waitForTimeout(400);
    const before = submitted;
    await page.waitForTimeout(1300);
    assert.equal(submitted, before, "The lesson must wait for the teacher before capturing another camera frame");
  }
  try {
    await page.goto(url);
    await at("ready");
    const health = await (await page.request.get(url + "/api/health")).json();
    const gpu = await page.locator("#world > canvas").evaluate(canvas => {
      const gl = canvas.getContext("webgl2");
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    });
    const saveReport = labRoundTrip => {
      const report = {edition: health.classroom_edition, backend: health.backend, renderer: gpu, profile, runs,
        deliberately_interrupted_requests: interruptedRequests, page_errors: errors, lab_round_trip: labRoundTrip};
      fs.writeFileSync(path.join(dest, "classroom.json"), JSON.stringify(report, null, 2));
      return report;
    };
    const actions = page.locator("button:visible, a:visible, summary:visible, select:visible, input:visible");
    assert.equal(await actions.count(), 1);
    assert.equal(await actions.first().innerText(), "开始配送");
    assert.ok(await lessonFits());
    assert.ok(Number(await page.locator("#mask-overlay").getAttribute("data-frame")) >= 1, "A real image must be present before takeoff");
    await page.locator("#next").evaluate(button => {
      window.classroomClicks = 0;
      button.addEventListener("click", () => window.classroomClicks++);
    });
    await page.screenshot({path: path.join(dest, "opening.png")});
    if (!software) {
      await page.setViewportSize({width: 390, height: 740});
      assert.ok(await lessonFits(), "Both the first action and the vision image must be above the fold");
      await page.screenshot({path: path.join(dest, "opening-narrow.png")});
      await page.setViewportSize({width: 1280, height: 720});
    }
    for (let i = 0; i < Number(repeats); i++) {
      const start = Date.now(), baseline = requests;
      const before = await page.evaluate(() => window.classroomClicks);
      observed.clear();
      lastFrame = null;
      if (i === 0) {
        await page.keyboard.press("Tab");
        assert.equal(await page.evaluate(() => document.activeElement.id), "next");
        await page.keyboard.press("Enter");
      } else await click("再送一次");
      await at("search");
      assert.equal(await actions.count(), 1);
      if (faultTest) {
        await click("暂停演示");
        await held();
        await page.locator("#explanation").evaluate(node => {
          delete window.interruptedLessonStage;
          const observer = new MutationObserver(() => {
            if (!node.textContent.includes("机载画面暂时中断")) return;
            window.interruptedLessonStage = document.querySelector("#lesson").dataset.stage;
            observer.disconnect();
          });
          observer.observe(node, {childList: true, subtree: true});
        });
        await page.route("**/api/frame", route => route.fulfill({status: 503,
          headers: {"x-classroom-test": "dropped-frame"}, body: "Camera temporarily unavailable"}), {times: 1});
        await click("继续演示");
        await page.waitForFunction(() => window.interruptedLessonStage === "search", null, {timeout: software ? 60000 : 12000});
      }
      await at("evidence");
      if (faultTest) await click("暂停演示");
      assert.ok(await page.locator("#feed").isVisible());
      assert.equal(await page.locator("#vision-mode").innerText(), "避障定格");
      const confirmation = await checkFrame(page, recent);
      if (i === 0) await page.screenshot({path: path.join(dest, "decision-frame.png")});
      if (faultTest) {
        await page.waitForTimeout(7000);
        assert.equal(await page.locator("#lesson").getAttribute("data-stage"), "evidence", "A teacher pause must hold past the automatic reading time");
        await click("继续演示");
      }
      console.log("Measured decision", JSON.stringify(confirmation));
      await at("detour");
      await at("station");
      assert.ok(await page.locator("#station-frame").isVisible());
      assert.ok(!(await page.locator("#feed").isVisible()));
      const stationEvidence = await checkStation(page, recent.slice(), i === 0 ? dest : null);
      if (i === 0) await page.screenshot({path: path.join(dest, "station-classifier.png")});
      const delivered = await at("delivered");
      assert.equal(delivered.route, "图书馆 → 物流中心");
      await at("complete");
      assert.ok((await page.locator("#explanation").innerText()).includes(confirmation.range_m + " 米"));
      assert.ok((await page.locator("#station-rule").textContent()).includes("80%"));
      assert.ok(await lessonFits());
      const clicks = (await page.evaluate(() => window.classroomClicks)) - before;
      assert.equal(clicks, faultTest ? 5 : 1, "The ordinary trip must finish from just the start action");
      assert.equal(await page.locator("#review").getAttribute("open"), null);
      if (i === 0) {
        await page.screenshot({path: path.join(dest, "vision-recap.png")});
        await page.locator("#review summary").click();
        assert.ok(await page.locator("#obstacle-replay").isVisible() && await page.locator("#station-readings").isVisible());
        assert.ok((await page.locator("#obstacle-caption").innerText()).includes("F" + confirmation.frame));
        await page.screenshot({path: path.join(dest, "review.png"), fullPage: true});
      }
      runs.push({confirmation, station_classification: stationEvidence, responses: requests - baseline, seconds: (Date.now() - start) / 1000,
        primary_actions_to_return: clicks, delivery_and_return: true});
      saveReport(false);
    }
    await page.getByRole("link", {name: "课后实验"}).click();
    await page.waitForFunction(() => document.querySelector("#launch")?.disabled === false);
    observed.clear();
    await page.getByRole("link", {name: "返回课堂"}).click();
    await at("ready");
    assert.deepEqual(errors, []);
    if (faultTest) assert.equal(interruptedRequests, Number(repeats));
    const report = saveReport(true);
    console.log("Verified", report.runs.length, "classroom run(s) and the return from the lab.", path.join(dest, "classroom.json"));
  } catch (error) {
    const diagnostic = {error: String(error), lastStage, lastFrame, requests, submitted, errors, stages: [...observed.values()]};
    console.error(diagnostic);
    fs.writeFileSync(path.join(dest, "incomplete.json"), JSON.stringify(diagnostic, null, 2));
    await page.screenshot({path: path.join(dest, "incomplete.png"), timeout: 5000}).catch(() => {});
    throw error;
  } finally { await browser.close(); }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
