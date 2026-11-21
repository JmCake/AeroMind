const states = {available: "可交接", occupied: "占用", unreadable: "看不清"};

// The outlined quad and both tiles come from the same visual pipeline that
// granted berth entry. These canvases are presentation surfaces only.
export function drawStationEvidence(panel, observation, rgb, station) {
  const proof = observation?.panel_proof;
  if (proof?.station !== station || observation.handoff?.state !== "ready" || proof.frames?.length !== 2) return false;
  const frames = proof.frames, current = frames[1];
  if (current.id !== observation.id || !frames.every((f, i) => f.stamp_ns === observation.handoff.evidence_ns[i])) return false;

  const camera = panel.querySelector("#station-frame"), ctx = camera.getContext("2d");
  const scene = ctx.createImageData(camera.width, camera.height);
  scene.data.set(rgb);
  ctx.putImageData(scene, 0, 0);
  ctx.beginPath();
  current.polygon_px.forEach(([x, y], i) => i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
  ctx.closePath();
  ctx.strokeStyle = "#113f39";
  ctx.lineWidth = 2.8;
  ctx.stroke();
  ctx.strokeStyle = "#89ffdb";
  ctx.lineWidth = 1.4;
  ctx.stroke();
  panel.querySelector("#station-source").textContent = "机载原图 · F" + current.id;

  const list = panel.querySelector("#station-readings");
  list.replaceChildren();
  for (const frame of frames) {
    const row = document.createElement("li"), tile = document.createElement("canvas");
    tile.width = tile.height = proof.patch_size;
    tile.setAttribute("role", "img");
    tile.setAttribute("aria-label", "F" + frame.id + " 实际输入网络的站牌灰度图");
    const pixels = atob(frame.gray_u8_b64), tileContext = tile.getContext("2d");
    const image = tileContext.createImageData(tile.width, tile.height);
    for (let i = 0; i < pixels.length; i++) {
      const offset = i * 4, gray = pixels.charCodeAt(i);
      image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = gray;
      image.data[offset + 3] = 255;
    }
    tileContext.putImageData(image, 0, 0);
    const labels = document.createElement("div"), caption = document.createElement("span"), result = document.createElement("strong");
    caption.textContent = "F" + frame.id;
    const score = frame.confidence > .999 && frame.confidence < 1 ? ">99.9%" : (frame.confidence * 100).toFixed(1) + "%";
    result.textContent = states[frame.state] + " " + score;
    labels.append(caption, result);
    row.append(tile, labels);
    list.append(row);
  }
  panel.querySelector("#input-title").textContent = "卷积网络输入 · " + proof.patch_size + " × " + proof.patch_size + " 灰度图";
  panel.querySelector("#station-rule").textContent = "两帧都判为可交接，且模型得分均达到 " + (proof.min_confidence * 100).toFixed(0) + "%。";
  return true;
}
