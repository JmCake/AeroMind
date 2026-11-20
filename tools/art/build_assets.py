"""Build the original AeroMind city district and delivery quadrotor in metres."""

from collections import defaultdict
from functools import lru_cache
from pathlib import Path
import argparse
import math

import numpy as np
from PIL import Image
import trimesh

from aeromind.stations import SETTINGS, sign_texture


# sRGB base color, metalness, roughness, emissive strength (glTF linear RGB).
PALETTE = {
    "porcelain": ("e5dfcf", .12, .62, 0), "concrete": ("b3ab9c", .02, .78, 0),
    "trim": ("3b5059", .45, .47, 0), "glass": ("47798c", .53, .26, 0),
    "glasslight": ("77adad", .38, .32, 0), "darkglass": ("284957", .46, .3, 0),
    "road": ("424f5a", .02, .85, 0), "stripe": ("ece3cc", .02, .76, 0),
    "amber": ("ff9750", .14, .42, .2), "aqua": ("55e1d4", .2, .37, .4),
    "copper": ("bc7155", .28, .54, 0), "timber": ("9a704c", .02, .82, 0),
    "grass": ("759d82", 0, .90, 0), "leaf": ("467b71", 0, .87, 0),
    "leaflight": ("69a186", 0, .85, 0), "soil": ("65756d", 0, .95, 0),
    "solar": ("355674", .48, .34, 0), "graphite": ("26333d", .5, .42, 0),
    "paper": ("ce9664", 0, .9, 0), "water": ("598f99", .25, .28, 0),
}


def material(key):
    hex_color, metal, rough, emission = PALETTE[key]
    srgb = np.asarray(list(bytes.fromhex(hex_color)), dtype=float) / 255
    rgb = np.rint(255 * np.where(srgb <= .04045, srgb / 12.92, ((srgb + .055) / 1.055)**2.4)).astype(int).tolist()
    return trimesh.visual.material.PBRMaterial(
        name=key, baseColorFactor=[*rgb, 255], metallicFactor=metal,
        roughnessFactor=rough, emissiveFactor=np.asarray(rgb) / 255 * emission,
    )


@lru_cache(maxsize=None)
def primitive(kind):
    if kind == "box":
        return trimesh.creation.box()
    if kind == "sphere":
        return trimesh.creation.icosphere(subdivisions=1, radius=.5)
    return trimesh.creation.cylinder(radius=.5, height=1, sections=int(kind))


def gltf_axes(points):
    # Authoring Z up / right handed -> glTF Y up / right handed.
    return points[:, (0, 2, 1)] * [1, 1, -1]


class Model:
    def __init__(self):
        self.scene = trimesh.Scene()
        self.parts = defaultdict(list)
        self.zone = "District"
        self.pivots = {}

    def add(self, xyz, size, mat, kind="box", angle=0, rotation=None):
        shape = primitive(kind)
        if rotation is None:
            rotation = trimesh.transformations.rotation_matrix(angle, [0, 0, 1])[:3, :3]
        vertices = (shape.vertices * size) @ rotation.T + xyz
        self.parts[self.zone, mat].append((vertices, shape.faces))

    def box(self, x, y, base, width, depth, height, mat, angle=0):
        self.add((x, y, base + height / 2), (width, depth, height), mat, angle=angle)

    def column(self, x, y, base, width, height, mat, sides=12):
        self.add((x, y, base + height / 2), (width, width, height), mat, str(sides))

    def beam(self, a, b, radius, mat, sides=8):
        a, b = np.array(a), np.array(b)
        rotation = trimesh.geometry.align_vectors([0, 0, 1], b - a)[:3, :3]
        self.add((a + b) / 2, (2 * radius, 2 * radius, np.linalg.norm(b - a)),
                 mat, str(sides), rotation=rotation)

    def sign(self, station, x, y, z, width):
        # A separate material slot lets UE change the station display in play.
        texture = sign_texture(station, "available", np.random.default_rng(28), SETTINGS["train"][0])
        h = width * 200 / 352
        vertices = np.array([[-width/2, 0, 0], [width/2, 0, 0],
                             [width/2, 0, h], [-width/2, 0, h]]) + [x, y, z]
        uv = np.array([[0., 0.], [1., 0.], [1., 1.], [0., 1.]])
        surface = trimesh.visual.material.PBRMaterial(
            name=f"display_{station}", baseColorTexture=Image.fromarray(texture[:, :, ::-1]),
            metallicFactor=0, roughnessFactor=.8, doubleSided=True)
        mesh = trimesh.Trimesh(gltf_axes(vertices), [[0, 1, 2], [0, 2, 3]], process=False,
                               vertex_normals=np.tile([0., 0., 1.], (4, 1)),
                               visual=trimesh.visual.TextureVisuals(uv=uv, material=surface))
        name = f"StationDisplay_{station}"
        self.scene.add_geometry(mesh, node_name=name, geom_name=name)

    def export(self, path):
        for (zone, mat), segments in self.parts.items():
            all_vertices, all_faces = [], []
            offset = 0
            for vertices, faces in segments:
                all_vertices.append(vertices)
                all_faces.append(faces + offset)
                offset += len(vertices)
            vertices = np.concatenate(all_vertices)
            pivot = np.asarray(self.pivots.get(zone, (0., 0., 0.)))
            mesh = trimesh.Trimesh(gltf_axes(vertices - pivot), np.concatenate(all_faces), process=False)
            # Splitting hard edges keeps architectural planes flat in Unreal.
            mesh = trimesh.Trimesh(mesh.vertices[mesh.faces].reshape(-1, 3),
                                   np.arange(len(mesh.faces)*3).reshape(-1, 3),
                                   vertex_normals=np.repeat(mesh.face_normals, 3, axis=0), process=False)
            mesh.visual = trimesh.visual.TextureVisuals(material=material(mat))
            node = f"{zone}_{mat}"
            if zone not in self.scene.graph.nodes:
                self.scene.graph.update(frame_to=zone, matrix=trimesh.transformations.translation_matrix(
                    gltf_axes(pivot.reshape(1, 3))[0]))
            self.scene.add_geometry(mesh, node_name=node, geom_name=node, parent_node_name=zone)
        self.scene.export(path, include_normals=True)


def tower(m, x, y, w, d, floors, accent, glass):
    base = .48
    floor = 3.1
    m.box(x, y, base, w+1.2, d+1.2, .65, "concrete")
    m.box(x, y, base+.65, w, d, floors*floor, glass)
    for i in range(floors+1):
        m.box(x, y, base+.65+i*floor, w+.65, d+.65, .26, accent)
    for side in (-1, 1):
        for i in np.arange(-w/2+1.6, w/2, 3.8):
            m.box(x+i, y+side*d/2, base+.65, .20, .22, floors*floor, "trim")
        for j in np.arange(-d/2+1.6, d/2, 3.8):
            m.box(x+side*w/2, y+j, base+.65, .22, .20, floors*floor, "trim")
    top = base+.91+floors*floor
    m.box(x, y, top, w*.46, d*.42, 1.45, "trim")
    for dx in (-1.7, 1.7):
        m.column(x+dx, y, top+1.45, 1.5, .26, "glasslight")
    m.box(x, y-d/2-.8, 3.9, min(w*.74, 11), 2.1, .24, accent)
    for dx in (-w*.23, w*.23):
        m.box(x+dx, y-d/2-1.15, .48, .25, .25, 3.45, "trim")
    if accent == "porcelain" and floors < 8:
        for level in range(1, floors, 2):
            for side in (-1, 1):
                bx, by = x+side*w*.28, y-d*.5-.65
                m.box(bx, by, .58+level*floor, w*.32, 1.55, .25, "porcelain")
                m.box(bx, by-.7, .85+level*floor, w*.32, .15, .6, "glasslight")
    return top


def trees(m, x, y, count, dx, dy, seed):
    rng = np.random.default_rng(seed)
    for i in range(count):
        px, py = x+i*dx, y+i*dy
        size = rng.uniform(3, 4.6)
        m.column(px, py, .44, 2.2, .25, "soil")
        m.column(px, py, .57, .34, 2.9, "timber", 8)
        m.add((px, py, 3.6), (size, size*.85, size*.86), "leaf", "sphere", angle=i)
        m.add((px+.3, py-.26, 4.75), (size*.8, size*.75, size*.72), "leaflight", "sphere", angle=-i)


def dock(m, x, y, z, station):
    m.column(x, y, z, 9.4, .24, "graphite", 28)
    m.column(x, y, z+.24, 8.7, .07, "aqua", 28)
    m.column(x, y, z+.31, 8.15, .07, "trim", 28)
    for a in range(0, 360, 45):
        r = math.radians(a)
        m.box(x+3.65*math.cos(r), y+3.65*math.sin(r), z+.38, .52, .14, .03, "stripe", r)
    for px in (-2.2, 2.2):
        m.box(x+px, y+4.9, z, .15, .18, 2.3, "trim")
    m.box(x, y+4.95, z+1.6, 5.15, .2, 2.9, "graphite")
    m.sign(station, x, y+4.83, z+1.66, 5.)


def library(m):
    m.zone = "Library"
    m.box(0, 0, .48, 46, 35, 1.0, "concrete")
    for i in range(4):
        m.box(0, -18.7+i*.48, .46, 27, .85, (i+1)*.24, "porcelain")
    m.box(0, 1, 1.48, 39, 25, 7.1, "darkglass")
    for x in np.arange(-19, 20, 3):
        m.box(x, -12, 1.48, .32, 2.2, 7.2, "copper")
    m.box(0, 0, 8.45, 47, 34, .7, "porcelain")
    m.box(1, 2, 9.15, 36, 24, 5.6, "glass")
    for i in range(4):
        m.box(1, 2, 9.8+i*1.45, 39.2, 26.5, .27, "porcelain")
    m.box(1, 2, 14.75, 40, 27.5, .72, "porcelain")
    for i in range(6):
        m.box(-13+i*2.4, 7, 15.48, 1.9, 5, .26, "solar")
    dock(m, 7, -2, 15.48, 17)
    for x in (-17,-9,9,17):
        m.box(x, -22, .46, 5.25, 2.7, .74, "porcelain")
        m.box(x, -22, 1.20, 4.9, 2.3, .24, "leaflight")
    for x in range(-12,13,3):
        m.beam((x,-15,8.7), (x+2.3,-12,10.9), .13, "copper")


def depot(m):
    m.zone = "Logistics"
    m.box(-66, -62, .48, 47, 23, 7.5, "porcelain")
    m.box(-66, -62, 7.98, 49, 25, .65, "trim")
    for x in (-83, -74, -65, -56, -47):
        m.box(x, -73.58, .52, 5.7, .33, 4.7, "graphite")
        for i in range(7):
            m.box(x, -73.8, 1+i*.55, 5.45, .14, .08, "glasslight")
        m.box(x, -74, 5.52, 6, .28, .28, "amber")
    m.box(-66, -75, 6.88, 49, 5.4, .34, "copper")
    for i in range(8):
        m.box(-86+i*3.1, -58, 8.64, 2.5, 7, .24, "solar")
    dock(m, -50, -62, 8.64, 46)
    for i in range(3):
        m.box(-84+i*8, -84, .48, 5.2, 2.6, 2.4, ("copper", "trim", "glasslight")[i])


def street_life(m):
    m.zone = "PublicRealm"
    for x,y in [(-38,-16),(20,-39),(37,40),(-79,34),(30,-74)]:
        for dx in (-2.8, 2.8):
            m.column(x+dx, y, .46, .2, 2.8, "trim")
        m.box(x,y,3.25,7.6,2.6,.3,"porcelain")
        m.box(x,y,3.55,6.9,2.2,.06,"solar")
        m.box(x,y+.76,.6,5.9,.15,1.7,"glasslight")
        m.box(x,y,.84,4.5,.65,.22,"timber")
    for i,(x,y,angle) in enumerate([(-31,-72,0),(-35,-49,0),(35,11,0),
                                      (31,79,0),(14,-35,1.57),(-72,31,1.57)]):
        m.box(x,y,.13,2.1,4.6,1.0, ("porcelain","copper","glasslight")[i%3],angle)
        m.box(x,y,1.13,1.9,2.7,.9,"darkglass",angle)
        m.box(x,y,2.03,1.8,2.4,.12,"porcelain",angle)
    for x,y,count,dx,dy in [(-89,31,5,8,0),(39,-24,5,0,10),(-25,24,5,11,0),
                             (-26,48,4,0,12),(-89,-90,5,10,0),(42,-89,5,10,0)]:
        trees(m,x,y,count,dx,dy,count+abs(x))
    # A shaded pedestrian concourse links the transit stop and library plaza.
    for x in range(-26,27,6):
        m.column(x, -24.6, .48, .28, 3.4, "copper")
        m.box(x, -25.4, 3.9, 4.9, 3.6, .2, "porcelain", angle=.04)
    for x in (41,80):
        for y in (-3,17):
            m.box(x,y,.46,3.5,3.5,.65,"porcelain")
            m.column(x,y,1.11,2.9,.55,"leaflight")


def waterfront(m):
    m.zone = "Waterfront"
    m.box(117,0,-1.5,15,219,.8,"water")
    m.box(108,0,-1.4,2.8,219,2.0,"concrete")
    for y in range(-105,106,5):
        m.column(109.1,y,.56,.14,1.05,"trim")
    m.box(109.1,0,1.52,.12,215,.12,"timber")
    for y in (-66,0,66):
        m.box(114.5,y,.43,15,8,.52,"timber")
        for yy in (y-3.9,y+3.9):
            m.beam((109,yy,1.8),(122,yy,1.8),.1,"trim")
    for y in range(-90,95,22):
        m.box(105.5,y,.2,1.3,4.6,.6,"porcelain")
        m.box(105.5,y,.8,1.1,4.4,.16,"timber")


def crane(m):
    x, y = 56, 70
    m.zone = "Construction"
    for floor in range(4):
        m.box(70, 67, .48+floor*4.5, 27, 27, .62, "concrete")
        for dx in (-12, 0, 12):
            for dy in (-12, 12):
                m.box(70+dx, 67+dy, 1.1+floor*4.5, .8, .8, 3.88, "copper")
    x -= 8
    m.box(x, y, .45, 5, 5, 1.35, "concrete")
    for dx in (-.78,.78):
        for dy in (-.78,.78):
            m.column(x+dx,y+dy,1.8,.21,26,"amber",6)
    for i in range(9):
        z=1.8+2.9*i
        for dy in (-.78,.78):
            m.beam((x-.78,y+dy,z),(x+.78,y+dy,z+2.9),.09,"amber")
    m.zone = "CraneJib"
    m.pivots[m.zone] = (x,y,28.)
    m.box(x+7.5,y,27.8,29,1.5,.46,"amber")
    m.box(x-4.6,y,28.25,3.4,2.7,2.1,"concrete")
    m.box(x+.25,y,28.25,2,2.5,1.9,"glass")
    m.beam((x,y,32),(x+21,y,28.2),.085,"trim")
    m.beam((x,y,32),(x-6,y,28.2),.085,"trim")
    m.beam((x,y,28),(x,y,32),.15,"amber")
    m.beam((x+17,y,27.8),(x+17,y,21),.065,"trim")
    m.box(x+17,y,20,2,1.4,1,"copper")


def city(path):
    m = Model()
    m.zone = "Streets"
    m.box(0,0,-.68,219,219,.68,"road")
    for a in (-99,-33,33,99):
        for b in range(-92,94,7):
            if any(abs(b-j)<4 for j in (-99,-33,33,99)):
                continue
            m.box(a,b,.015,.14,2.2,.02,"stripe")
            m.box(b,a,.015,2.2,.14,.02,"stripe")
        for b in (-84,-58,-18,12,50,82):
            m.column(a-3.9,b,.12,.17,5.2,"trim",8)
            m.box(a-3.25,b,5.25,1.65,.43,.22,"porcelain")
    for x in (-66,0,66):
        for y in (-66,0,66):
            m.box(x,y,0,57.8,57.8,.45,"concrete")
            for i in range(-3,4):
                for dx,dy in [(32,i*.86),(i*.86,32)]:
                    m.box(x+dx,y+dy,.03,1.5 if dx==32 else .39,.39 if dx==32 else 1.5,.03,"stripe")
    library(m)
    depot(m)
    m.zone="Campus"
    for y in (-12,12):
        tower(m,-66,y,37,12,3,"copper","glasslight")
    m.box(-55,0,6,8,13,.45,"porcelain")
    m.box(-55,0,6.45,7,13,2.5,"glass")
    m.box(-55,0,8.95,8,13,.4,"porcelain")
    trees(m,-86,-7,5,0,3.5,21)
    m.zone="Park"
    m.box(0,-66,.45,53,53,.15,"grass")
    m.box(0,-66,.6,5,53,.08,"porcelain")
    m.box(0,-65,.6,53,3,.09,"concrete")
    m.box(11,-78,.61,15,9,.1,"water")
    # A public sports court marks the campus airspace constraint in the lesson.
    m.box(-11,-49,.63,18,10.6,.13,"copper")
    m.box(-11,-49,.76,15.5,8.7,.06,"leaf")
    for dy in (-4.05,4.05):
        m.box(-11,-49+dy,.82,14.8,.09,.025,"stripe")
    for dx in (-7.4,0,7.4):
        m.box(-11+dx,-49,.82,.10,8.13,.025,"stripe")
    for side in (-1,1):
        for dy in (-1.8,1.8):
            m.box(-11+side*6.35,-49+dy,.82,2.15,.1,.025,"stripe")
        m.box(-11+side*5.3,-49,.82,.10,3.7,.025,"stripe")
    for level in range(3):
        m.box(-11,-55-level*.67,.64+level*.3,12,.7,.3,"porcelain" if level%2==0 else "timber")
    for x in (-21,-12,14,23):
        trees(m,x,-86,6,0,8,100+x)
    for x in (-5.2,5.2):
        for y in (-84,-73,-58,-49):
            m.box(x,y,.65,2.4,.8,.6,"timber")
    m.zone="Commercial"
    tower(m,57,-8,19,23,12,"porcelain","darkglass")
    tower(m,77,10,16,19,9,"trim","glasslight")
    tower(m,57,-70,24,27,9,"trim","glass")
    tower(m,76,-53,14,16,6,"copper","darkglass")
    for level in range(4):
        extent = 15-level*2.4
        m.column(57,-8,38.6+level*2.4,extent,2.4,"glasslight",8)
        m.column(57,-8,40.85+level*2.4,extent+.4,.2,"porcelain",8)
    m.column(57,-8,48.2,.3,4.2,"trim")
    m.column(57,-8,52.4,.36,.25,"amber")
    m.box(76,-56,20,12,15,.6,"porcelain")
    m.zone="Residential"
    for x,y,f in [(-79,54,4),(-56,55,6),(-77,77,5),(-54,78,4),(-12,60,6),(13,76,5)]:
        tower(m,x,y,15,15,f,"porcelain","glass")
    m.box(10,52,.46,18,15,4.2,"copper")
    m.box(10,52,4.66,20,17,.45,"porcelain")
    dock(m,10,52,5.11,31)
    crane(m)
    waterfront(m)
    street_life(m)
    m.export(path)


def quadrotor(path):
    m = Model()
    m.zone="Airframe"
    m.add((0,0,.10),(.42,.32,.19),"graphite","sphere")
    m.add((0,.02,.17),(.43,.33,.15),"porcelain","sphere")
    m.add((0,-.079,.206),(.20,.14,.055),"darkglass","sphere")
    for x in (-.077,.077):
        m.box(x,.064,.222,.014,.082,.008,"copper",angle=.1 if x>0 else -.1)
    for i in range(5):
        m.box(-.039+i*.019,.067,.238,.008,.058,.008,"graphite")
    m.zone="Parcel"
    m.box(0,0,-.097,.22,.20,.12,"paper")
    m.box(0,0,-.1,.035,.203,.125,"amber")
    m.box(.057,-.102,-.06,.059,.004,.042,"porcelain")
    for x in (.037,.044,.049,.058,.067,.072):
        m.box(x,-.105,-.053,.003,.003,.026,"graphite")
    m.zone="Airframe"
    for x in (-.17,.17):
        m.beam((x*.65,0,.08),(x,0,-.12),.012,"graphite")
        m.beam((x,-.15,-.12),(x,.15,-.12),.014,"trim")
    m.add((0,-.154,.09),(.095,.09,.085),"graphite","sphere")
    m.add((0,-.194,.09),(.051,.021,.051),"glasslight","sphere")
    for x in (-.087,.087):
        m.add((x,-.13,.132),(.052,.018,.019),"aqua","sphere")
    for i,(x,y) in enumerate([(-.26,-.24),(.26,-.24),(-.26,.24),(.26,.24)]):
        m.zone = "Airframe"
        m.beam((x*.40,y*.30,.13),(x,y,.145),.031,"trim")
        m.column(x,y,.13,.068,.084,"graphite")
        m.column(x,y,.167,.074,.012,"aqua" if y<0 else "amber")
        m.zone=f"Rotor_{i+1}"
        m.pivots[m.zone]=(x,y,.222)
        m.column(x,y,.211,.046,.024,"trim")
        for j in range(3):
            angle = 2*math.pi*j/3+i*.4
            m.add((x+.074*math.cos(angle),y+.074*math.sin(angle),.22),
                  (.15,.031,.009),"graphite","sphere",angle=angle)
    m.export(path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    folder = parser.parse_args().output
    folder.mkdir(parents=True, exist_ok=True)
    city(folder/"CampusDistrict.glb")
    quadrotor(folder/"CourierQuad.glb")
