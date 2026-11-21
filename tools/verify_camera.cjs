// Observe the spectator camera actually sent to WebGL during the public lesson.
// Neither camera transforms nor flight inputs are changed by this probe.
const {chromium} = require("playwright-core");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));
const quantile = (values, q) => values.length ? values.slice().sort((a, b) => a - b)[Math.floor((values.length - 1) * q)] : 0;

function motion(samples, stage) {
  const frames = samples.filter(s => s.stage === stage && !s.paused);
  assert.ok(frames.length > 5, "Missing live camera samples for " + stage);
  const angles = [], travel = [], pixelSteps = [];
  let moving = 0, repeated = 0;
  for (let i = 1; i < frames.length; i++) {
    const current = frames[i], previous = frames[i - 1];
    const dt = current.now - previous.now;
    if (dt <= 0 || dt > 150) continue;
    const dot = Math.abs(current.rotation.reduce((n, x, j) => n + x * previous.rotation[j], 0));
    angles.push(2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI);
    travel.push(distance(current.eye, previous.eye));
    pixelSteps.push(distance(current.screen, previous.screen));
    if (current.speed > 1.5) {
      moving++;
      if (distance(current.body, previous.body) < 1e-5) repeated++;
    }
  }
  return {samples: frames.length, moving_samples: moving, first_distance_m: distance(frames[0].eye, frames[0].body),
    peak_eye_step_m: Math.max(...travel), peak_turn_deg: Math.max(...angles),
    p95_turn_deg: quantile(angles, .95), p95_subject_step_px: quantile(pixelSteps, .95),
    repeated_body_fraction_while_moving: moving ? repeated / moving : null};
}

async function main() {
  const [url = "http://127.0.0.1:8863", dest = "output/playwright/camera", profile = "full"] = process.argv.slice(2);
  assert.ok(["quick", "full"].includes(profile));
  fs.mkdirSync(dest, {recursive: true});
  const browser = await chromium.launch({channel: "msedge", headless: true, args: ["--enable-gpu", "--use-angle=d3d11"]});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 720}});
    await page.goto(url);
    const at = stage => page.waitForSelector('#lesson[data-stage="' + stage + '"]', {timeout: 100000});
    await at("ready");
    await page.evaluate(async () => {
      const {Simulation} = await import("/app/simulation.js");
      window.cameraSamples = [];
      const frame = Simulation.prototype.frame;
      let lastShot, instrumented = false;
      Simulation.prototype.frame = function(now, ...args) {
        const city = this.city, renderer = city.renderer;
        if (!instrumented) {
          instrumented = true;
          const render = renderer.render.bind(renderer);
          renderer.render = (scene, camera) => {
            render(scene, camera);
            if (scene !== city.scene || camera !== city.camera || renderer.getRenderTarget()) return;
            const mesh = city.craft[this.activeUnit], body = mesh.position.clone(), screen = body.clone().project(camera);
            lastShot = {stage: document.querySelector("#lesson").dataset.stage, mode: city.mode,
              eye: camera.position.toArray(), rotation: camera.quaternion.toArray(), body: body.toArray(),
              screen: [screen.x * city.view.clientWidth / 2, screen.y * city.view.clientHeight / 2]};
          };
        }
        frame.call(this, now, ...args);
        if (lastShot) window.cameraSamples.push({...lastShot, now, paused: this.paused, speed: Math.hypot(...this.units[this.activeUnit].vel)});
      };
    });
    await page.getByRole("button", {name: "起飞送货"}).click();
    await at("route");
    await page.getByRole("button", {name: "设置前方施工"}).click();
    if (profile === "quick") await page.waitForTimeout(4500);
    else {
      await page.waitForTimeout(4500);
      await page.screenshot({path: path.join(dest, "follow.png")});
      await at("evidence");
      await page.getByRole("button", {name: "继续配送"}).click();
      await at("station");
      await page.getByRole("button", {name: "暂停飞行"}).click();
      await page.waitForTimeout(450);
      const paused = await page.evaluate(() => window.cameraSamples.filter(s => s.stage === "station" && s.paused).slice(-5));
      assert.ok(paused.length >= 2 && paused.every(s => distance(s.eye, paused[0].eye) < 1e-7 &&
        distance(s.body, paused[0].body) < 1e-7), "A teacher pause must also stop the spectator camera and model");
      await page.screenshot({path: path.join(dest, "station.png")});
      await page.getByRole("button", {name: "继续飞行"}).click();
      await at("complete");
    }
    const samples = await page.evaluate(() => window.cameraSamples);
    const health = await (await page.request.get(url + "/api/health")).json();
    const stages = Object.fromEntries((profile === "quick" ? ["takeoff", "search"] : ["takeoff", "search", "retreat", "station", "delivered"])
      .map(stage => [stage, motion(samples, stage)]));
    const report = {edition: health.classroom_edition, viewport: [1280, 720], profile, stages};
    fs.writeFileSync(path.join(dest, "camera.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(stages));
    for (const stage of ["search", ...(profile === "full" ? ["retreat", "station"] : [])]) {
      assert.ok(stages[stage].first_distance_m < 12, stage + ": follow shot must open alongside the aircraft");
    }
    assert.ok(stages.search.moving_samples > 20);
    assert.ok(stages.search.repeated_body_fraction_while_moving < .20, "Cruise must move smoothly between sensor and physics ticks");
    assert.ok(stages.search.peak_turn_deg < 2.5, "A flight-controller turn must not whip the spectator camera around");
  } finally { await browser.close(); }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
