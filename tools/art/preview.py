"""Render the exported glTF meshes offscreen for asset review on the actual GPU."""

import argparse
from pathlib import Path

import moderngl
import numpy as np
from PIL import Image
import trimesh


def unit(vector):
    return vector / np.linalg.norm(vector)


def view(eye, target, radius, aspect):
    forward = unit(np.asarray(target) - eye)
    right = unit(np.cross(forward, [0., 1., 0.]))
    up = np.cross(right, forward)
    # Orthographic view with a symmetric depth volume around the target.
    matrix = np.eye(4)
    matrix[:3, :3] = [right / (radius * aspect), up / radius, forward / (radius * 4)]
    matrix[:3, 3] = -matrix[:3, :3] @ target
    return matrix


VERTEX = """
#version 330
uniform mat4 view_matrix;
uniform mat4 light_matrix;
in vec3 pos;
in vec3 normal;
in vec2 uv;
out vec3 norm;
out vec3 shadow_pos;
out vec2 coord;
void main() {
    gl_Position = view_matrix * vec4(pos, 1.0);
    shadow_pos = (light_matrix * vec4(pos, 1.0)).xyz * 0.5 + 0.5;
    norm = normal;
    coord = uv;
}
"""

FRAGMENT = """
#version 330
in vec3 norm;
in vec3 shadow_pos;
in vec2 coord;
uniform vec3 tint;
uniform vec3 sun;
uniform sampler2D surface;
uniform sampler2D shadow_map;
out vec4 color;
void main() {
    vec3 n = normalize(norm);
    float facing = max(dot(n, sun), 0.0);
    float visibility = 0.0;
    vec2 texel = 1.0 / vec2(textureSize(shadow_map, 0));
    float bias = max(0.00004, 0.00022 * (1.0 - facing));
    for (int x = -1; x <= 1; x++) {
        for (int y = -1; y <= 1; y++) {
            float depth = texture(shadow_map, shadow_pos.xy + vec2(x, y) * texel).r;
            visibility += step(shadow_pos.z - bias, depth) / 9.0;
        }
    }
    vec3 ambient = vec3(0.38, 0.45, 0.51) + 0.13 * max(n.y, 0.0);
    vec3 direct = vec3(0.77, 0.70, 0.56) * facing * visibility;
    vec3 albedo = tint * pow(texture(surface, coord).rgb, vec3(2.2));
    color = vec4(pow(albedo * (ambient + direct), vec3(1.0/2.2)), 1);
}
"""


def render(path, output, width=1280, height=768, closeup=False):
    scene = trimesh.load_scene(path, process=False)
    lower, upper = scene.bounds
    center = (lower + upper) * .5
    span = float(max(upper - lower))
    eye = center + np.array([-.73, .66, 1.12]) * span
    radius = span * (.20 if closeup else .60 if span < 5 else .45)
    if closeup:
        center = np.array([0., 9., 0.])
    camera = view(eye, center, radius, width/height)
    sun = unit(np.array([-.58, 1.0, .54]))
    light = view(center + span*sun, center, span*.75, 1)
    ctx = moderngl.create_standalone_context(require=330)
    print(f"{ctx.info['GL_RENDERER']}, {len(scene.geometry)} meshes, "
          f"{sum(len(g.faces) for g in scene.geometry.values())} triangles")
    program = ctx.program(vertex_shader=VERTEX, fragment_shader=FRAGMENT)
    shadow_pass = ctx.program(vertex_shader="""
        #version 330
        uniform mat4 light_matrix;
        in vec3 pos;
        void main() { gl_Position = light_matrix * vec4(pos, 1.0); }
    """, fragment_shader="#version 330\nvoid main() {}")
    for prog in (program, shadow_pass):
        prog["light_matrix"].write(light.T.astype("f4").tobytes())
    program["view_matrix"].write(camera.T.astype("f4").tobytes())
    program["sun"].value = tuple(sun)
    program["surface"].value = 0
    program["shadow_map"].value = 1
    white = ctx.texture((1,1), 3, bytes([255]*3))
    draws = []
    for name in sorted(scene.graph.nodes_geometry):
        transform, key = scene.graph[name]
        geo = scene.geometry[key]
        positions = trimesh.transform_points(geo.vertices, transform)
        normals = geo.vertex_normals @ np.linalg.inv(transform[:3, :3])
        uv = getattr(geo.visual, "uv", None)
        if uv is None:
            uv = np.zeros((len(positions), 2))
        vbo = ctx.buffer(np.column_stack([positions, normals, uv]).astype("f4").tobytes())
        indices = ctx.buffer(geo.faces.astype("i4").tobytes())
        vao = ctx.vertex_array(program, [(vbo, "3f 3f 2f", "pos", "normal", "uv")], indices)
        depth_vao = ctx.vertex_array(shadow_pass, [(vbo, "3f 20x", "pos")], indices)
        mat = geo.visual.material
        base = mat.baseColorFactor
        color = tuple(base[:3]/255) if base is not None else (1., 1., 1.)
        texture = white
        if mat.baseColorTexture:
            raw = mat.baseColorTexture.convert("RGB").transpose(Image.Transpose.FLIP_TOP_BOTTOM)
            texture = ctx.texture(raw.size, 3, raw.tobytes())
        draws.append((vao, depth_vao, texture, color))
    depth = ctx.depth_texture((2048,2048))
    depth.compare_func = ""
    depth.repeat_x = depth.repeat_y = False
    shadow = ctx.framebuffer(depth_attachment=depth)
    shadow.use()
    shadow.clear(depth=1)
    ctx.enable(moderngl.DEPTH_TEST)
    for _, depth_vao, _, _ in draws:
        depth_vao.render()
    size = (width*2, height*2)
    target = ctx.simple_framebuffer(size)
    target.use()
    target.clear(.72, .79, .80, 1.0, depth=1)
    depth.use(location=1)
    for vao, _, texture, color in draws:
        program["tint"].value = color
        texture.use(location=0)
        vao.render()
    out = Image.frombytes("RGB", size, target.read(components=3))
    out = out.transpose(Image.Transpose.FLIP_TOP_BOTTOM).resize((width,height), Image.Resampling.LANCZOS)
    output.parent.mkdir(parents=True, exist_ok=True)
    out.save(output)
    ctx.release()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--library", action="store_true")
    args = parser.parse_args()
    render(args.source, args.output, closeup=args.library)
