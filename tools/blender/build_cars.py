"""
EcoTire - modelos 3D dos carros feitos no Blender (por script).

Como rodar:
  blender --background --python tools/blender/build_cars.py
  (ou: pip install bpy && python tools/blender/build_cars.py)

Gera public/models/{hatch,sedan,suv,pickup}.glb e, com --blend, salva também os .blend
em tools/blender/ para abrir e editar no Blender.

Cada carro nasce de "estações" ao longo do comprimento (perfil lateral + largura),
ligadas numa malha e suavizadas com Subdivision Surface. Depois: caixas de roda
(boolean), rodas, faróis, lanternas, grade, retrovisores e maçanetas.
Materiais com nome fixo (Paint, Glass, Trim, Tire, Rim, LightFront, LightRear):
o app troca a cor do material "Paint" pela pintura do veículo.
"""
import math
import os
import sys

import bpy  # noqa: I001 (precisa vir antes do bmesh)
import bmesh

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'public', 'models')
SAVE_BLEND = '--blend' in sys.argv
RENDER = '--render' in sys.argv

# ---------------------------------------------------------------- materiais
def material(name, color, metallic=0.0, roughness=0.5, emission=None, coat=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Metallic'].default_value = metallic
    b.inputs['Roughness'].default_value = roughness
    if coat and 'Coat Weight' in b.inputs:
        b.inputs['Coat Weight'].default_value = coat
    if emission:
        b.inputs['Emission Color'].default_value = (*emission, 1)
        b.inputs['Emission Strength'].default_value = 2.0
    return m


def make_materials():
    return {
        'Paint': material('Paint', (0.80, 0.22, 0.03), metallic=0.35, roughness=0.32, coat=1.0),
        'Glass': material('Glass', (0.015, 0.02, 0.03), metallic=0.6, roughness=0.06),
        'Trim': material('Trim', (0.02, 0.02, 0.022), roughness=0.75),
        'Tire': material('Tire', (0.012, 0.012, 0.012), roughness=0.92),
        'Rim': material('Rim', (0.62, 0.64, 0.67), metallic=1.0, roughness=0.28),
        'LightFront': material('LightFront', (0.95, 0.95, 0.9), roughness=0.15, emission=(1.0, 0.96, 0.85)),
        'LightRear': material('LightRear', (0.5, 0.01, 0.01), roughness=0.2, emission=(1.0, 0.03, 0.02)),
    }


SLOTS = ['Paint', 'Glass', 'Trim']

# ---------------------------------------------------------------- carroceria
def ring(st):
    """Seção transversal (14 pontos) de uma estação."""
    x, w, zb, belt, roof, rw = st['x'], st['w'], st['zb'], st['belt'], st['roof'], st['rw']
    mid = zb + (belt - zb) * 0.55
    half = [
        (x, 0.0, zb),
        (x, w * 0.80, zb),
        (x, w * 0.99, zb + 0.10),
        (x, w * 1.00, mid),
        (x, w * 0.965, belt),
        (x, rw, roof - 0.035),
        (x, rw * 0.78, roof),
        (x, 0.0, roof + 0.012),
    ]
    return half + [(p[0], -p[1], p[2]) for p in reversed(half[1:7])]


def station(x, w, zb, belt, roof=None, rw=None, tag='body'):
    cabin = roof is not None
    return {
        'x': x, 'w': w, 'zb': zb, 'belt': belt,
        'roof': roof if cabin else belt + 0.035,
        'rw': rw if cabin else w * 0.80,
        'tag': tag,
    }


def build_body(name, stations, mats, glass_roof=True):
    bm = bmesh.new()
    rings = [[bm.verts.new(p) for p in ring(s)] for s in stations]
    n = 14
    for i in range(len(rings) - 1):
        tag = stations[i]['tag']
        for k in range(n):
            a, b = rings[i][k], rings[i][(k + 1) % n]
            c, d = rings[i + 1][(k + 1) % n], rings[i + 1][k]
            f = bm.faces.new((a, b, c, d))
            mat = 'Paint'
            if k in (0, 1, 12, 13):
                mat = 'Trim'  # assoalho e soleira
            elif k in (4, 9) and tag == 'cab':
                mat = 'Glass'  # vidros laterais
            elif k in (6, 7) and tag in ('screen', 'cab', 'pillar') and glass_roof:
                mat = 'Glass'  # para-brisa, teto de vidro e vidro traseiro
            elif k in (6, 7) and tag == 'screen':
                mat = 'Glass'
            f.material_index = SLOTS.index(mat)
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    # vincos: linha de cintura, soleira, coluna do teto e um friso leve na lateral
    crease = bm.edges.layers.float.new('crease_edge')
    sharp = {4: 0.80, 10: 0.80, 2: 0.75, 12: 0.75, 5: 0.55, 9: 0.55, 3: 0.30, 11: 0.30}
    for i in range(len(rings) - 1):
        for k, val in sharp.items():
            e = bm.edges.get((rings[i][k], rings[i + 1][k]))
            if e:
                e[crease] = val
    for i, st in enumerate(stations):  # bordas do para-brisa e do vidro traseiro
        if st['tag'] == 'screen' or (i > 0 and stations[i - 1]['tag'] == 'screen'):
            for k in (5, 6, 7, 8):
                e = bm.edges.get((rings[i][k], rings[i][k + 1]))
                if e:
                    e[crease] = 0.45
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    for s in SLOTS:
        me.materials.append(mats[s])
    for p in me.polygons:
        p.use_smooth = True
    sub = ob.modifiers.new('Subdivision', 'SUBSURF')
    sub.levels = 2
    sub.render_levels = 2
    return ob


def activate(ob):
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob


def apply_modifiers(ob):
    activate(ob)
    for m in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def cut(body, cutter):
    mod = body.modifiers.new('Cut', 'BOOLEAN')
    mod.operation = 'DIFFERENCE'
    mod.object = cutter
    mod.solver = 'EXACT'
    if hasattr(mod, 'material_mode'):
        mod.material_mode = 'TRANSFER'
    apply_modifiers(body)
    bpy.data.objects.remove(cutter, do_unlink=True)


def box(name, center, size, mat, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center)
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    ob.data.materials.append(mat)
    if bevel:
        bv = ob.modifiers.new('Bevel', 'BEVEL')
        bv.width = bevel
        bv.segments = 3
        apply_modifiers(ob)
    for p in ob.data.polygons:
        p.use_smooth = True
    return ob


def cylinder(name, center, radius, depth, mat, bevel=0.0, verts=48):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=depth, location=center, rotation=(math.pi / 2, 0, 0))
    ob = bpy.context.active_object
    ob.name = name
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    ob.data.materials.append(mat)
    if bevel:
        bv = ob.modifiers.new('Bevel', 'BEVEL')
        bv.width = bevel
        bv.segments = 4
        bv.limit_method = 'ANGLE'
        apply_modifiers(ob)
    for p in ob.data.polygons:
        p.use_smooth = True
    return ob


def wheel(name, x, y, r, width, mats):
    side = 1 if y > 0 else -1
    parts = [cylinder(name + '_tire', (x, y, r), r, width, mats['Tire'], bevel=0.045)]
    face = y + side * (width / 2 - 0.012)
    parts.append(cylinder(name + '_lip', (x, face, r), r * 0.76, 0.034, mats['Rim'], bevel=0.012))
    parts.append(cylinder(name + '_barrel', (x, face + side * 0.006, r), r * 0.68, 0.03, mats['Trim']))
    parts.append(cylinder(name + '_disc', (x, face - side * 0.004, r), r * 0.40, 0.04, mats['Rim'], verts=32))  # disco de freio
    parts.append(cylinder(name + '_hub', (x, face + side * 0.020, r), r * 0.17, 0.03, mats['Rim'], bevel=0.008, verts=24))
    for i in range(5):  # raios duplos
        a = i * 2 * math.pi / 5 + math.pi / 2
        for off in (-0.10, 0.10):
            aa = a + off
            d = r * 0.40
            sp = box(f'{name}_spoke{i}', (x + math.cos(aa) * d, face + side * 0.014, r + math.sin(aa) * d), (r * 0.60, 0.024, r * 0.055), mats['Rim'], bevel=0.006)
            sp.rotation_euler = (0, -a, 0)
            activate(sp)
            bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
            parts.append(sp)
    return parts


def build_car(spec, mats):
    w, r = spec['w'], spec['wheel_r']
    body = build_body('Body', spec['stations'], mats, spec.get('glass_roof', True))
    apply_modifiers(body)

    # caçamba (picape)
    if 'bed' in spec:
        x0, x1, floor = spec['bed']
        c = box('bedcut', ((x0 + x1) / 2, 0, floor + 0.5), (x1 - x0, (w - 0.09) * 2, 1.0), mats['Trim'])
        cut(body, c)

    # caixas de roda
    tw = 0.235
    for x in spec['axles']:
        for side in (1, -1):
            c = cylinder('wellcut', (x, side * w, r), r + 0.075, 0.74, mats['Trim'], verts=40)
            cut(body, c)

    # recortes das portas, do capô e da tampa traseira
    belt = max(st['belt'] for st in spec['stations'])
    zb = min(st['zb'] for st in spec['stations'])
    lines = []
    for side in (1, -1):
        for dx in spec['doors']:
            lines.append(box('gap', (dx, side * (w + 0.03), (zb + 0.14 + belt) / 2), (0.011, 0.16, belt - zb - 0.16), mats['Trim']))
    hood_x = spec['hood_x']
    lines.append(box('gap', (hood_x, 0, belt + 0.2), (0.011, w * 1.5, 0.9), mats['Trim']))
    if 'trunk_x' in spec:
        lines.append(box('gap', (spec['trunk_x'], 0, belt + 0.2), (0.011, w * 1.5, 0.9), mats['Trim']))
    bpy.ops.object.select_all(action='DESELECT')
    for ln in lines:
        ln.select_set(True)
    bpy.context.view_layer.objects.active = lines[0]
    bpy.ops.object.join()
    cut(body, bpy.context.active_object)

    parts = [body]
    arch = mats['Trim'] if spec.get('cladding') else mats['Paint']
    for x in spec['axles']:
        for side in (1, -1):
            bpy.ops.mesh.primitive_torus_add(major_radius=r + 0.095, minor_radius=0.032 if spec.get('cladding') else 0.02, major_segments=48, minor_segments=10, location=(x, side * (w - 0.004), r), rotation=(math.pi / 2, 0, 0))
            t = bpy.context.active_object
            bpy.ops.object.transform_apply(location=True, rotation=True, scale=False)
            tb = bmesh.new()
            tb.from_mesh(t.data)
            bmesh.ops.bisect_plane(tb, geom=tb.verts[:] + tb.edges[:] + tb.faces[:], plane_co=(0, 0, zb + 0.13), plane_no=(0, 0, 1), clear_inner=True)
            tb.to_mesh(t.data)
            tb.free()
            t.data.materials.append(arch)
            for pl in t.data.polygons:
                pl.use_smooth = True
            parts.append(t)
    for i, x in enumerate(spec['axles']):
        for side in (1, -1):
            parts += wheel(f'Wheel{i}{"L" if side > 0 else "R"}', x, side * (w - tw / 2 - 0.005), r, tw, mats)

    xf, xr = spec['stations'][-1]['x'], spec['stations'][0]['x']
    fz, rz = spec['front_light_z'], spec['rear_light_z']
    for side in (1, -1):
        # faróis finos
        parts.append(box('HeadLight', (xf - 0.17, side * w * 0.62, fz), (0.32, w * 0.34, 0.05), mats['LightFront'], bevel=0.02))
        parts.append(box('Mirror', (spec['mirror_x'], side * (w + 0.06), spec['mirror_z']), (0.09, 0.15, 0.07), mats['Paint'], bevel=0.025))
        for hx in spec['handles']:  # maçanetas embutidas
            parts.append(box('Handle', (hx, side * (w * 0.992), spec['mirror_z'] - 0.10), (0.17, 0.014, 0.022), mats['Trim'], bevel=0.004))
    # barras de luz de ponta a ponta, sem grade
    parts.append(box('LightBarFront', (xf - 0.10, 0, fz), (0.20, w * 1.0, 0.018), mats['LightFront'], bevel=0.006))
    rd = spec.get('rear_bar_depth', 0.16)
    parts.append(box('LightBarRear', (xr + rd / 2 + 0.01, 0, rz), (rd, w * 1.74, 0.045), mats['LightRear'], bevel=0.015))
    parts.append(box('Intake', (xf - 0.13, 0, spec['intake_z']), (0.26, w * 1.0, 0.06), mats['Trim'], bevel=0.02))
    for side in (1, -1):
        parts.append(box('HeadTrim', (xf - 0.165, side * w * 0.62, fz - 0.04), (0.32, w * 0.36, 0.03), mats['Trim'], bevel=0.012))  # moldura do farol
        parts.append(box('FogIntake', (xf - 0.15, side * w * 0.66, spec['intake_z'] + 0.02), (0.26, w * 0.2, 0.10), mats['Trim'], bevel=0.03))
        parts.append(box('TailCorner', (xr + 0.10, side * w * 0.74, rz), (0.2, w * 0.28, 0.085), mats['LightRear'], bevel=0.025))
    parts.append(box('Diffuser', (xr + 0.12, 0, spec['intake_z'] + 0.02), (0.22, w * 1.2, 0.08), mats['Trim'], bevel=0.02))
    if 'rails' in spec:  # barras de teto no SUV
        roof = max(st['roof'] for st in spec['stations'])
        rx, rl = spec['rails']
        for side in (1, -1):
            parts.append(box('RoofRail', (rx, side * 0.64, roof - 0.045), (rl, 0.035, 0.03), mats['Trim'], bevel=0.012))
    if 'spoiler' in spec:  # aerofólio do hatch
        sx, sz = spec['spoiler']
        parts.append(box('Spoiler', (sx, 0, sz), (0.26, w * 1.22, 0.028), mats['Trim'], bevel=0.01))
    parts.append(box('PlateRear', (xr + 0.06, 0, rz - 0.20), (0.14, 0.46, 0.10), mats['Trim'], bevel=0.01))
    # tampa de recarga no para-lama traseiro esquerdo
    cx, cz = spec['axles'][0] + 0.02, spec['port_z']
    parts.append(cylinder('ChargeRing', (cx, w * 0.99, cz), 0.085, 0.02, mats['Trim'], verts=32))
    parts.append(cylinder('ChargeCap', (cx, w * 0.995, cz), 0.072, 0.022, mats['Paint'], bevel=0.004, verts=32))

    bpy.ops.object.select_all(action='DESELECT')
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    car = bpy.context.active_object
    car.name = spec['name']
    # glTF: a frente do carro aponta para +Z (no Blender, -Y)
    car.rotation_euler = (0, 0, -math.pi / 2)
    bpy.ops.object.transform_apply(rotation=True)
    return car


# ---------------------------------------------------------------- os quatro tipos
S = station


def sedan():  # sedã baixo e comprido, três volumes com traseira fastback
    w = 0.93
    return {
        'name': 'sedan', 'w': w, 'wheel_r': 0.34, 'axles': (-1.46, 1.50),
        'front_light_z': 0.64, 'rear_light_z': 0.92, 'intake_z': 0.38, 'port_z': 0.86,
        'mirror_x': 0.96, 'mirror_z': 0.99, 'handles': (-0.50, 0.42),
        'doors': (1.08, -0.065, -1.00), 'hood_x': 1.46, 'trunk_x': -1.58,
        'stations': [
            S(-2.42, w * 0.84, 0.40, 0.88),
            S(-2.34, w * 0.95, 0.30, 0.98),
            S(-2.10, w, 0.24, 1.02),
            S(-1.50, w, 0.22, 1.03, tag='screen'),
            S(-0.80, w, 0.22, 1.00, 1.40, 0.60, tag='cab'),
            S(-0.10, w, 0.22, 0.98, 1.43, 0.63, tag='pillar'),
            S(-0.03, w, 0.22, 0.98, 1.43, 0.63, tag='cab'),
            S(0.60, w, 0.22, 0.96, 1.40, 0.62, tag='screen'),
            S(1.40, w, 0.22, 0.90),
            S(2.05, w, 0.24, 0.78),
            S(2.33, w * 0.95, 0.30, 0.68),
            S(2.42, w * 0.84, 0.40, 0.58),
        ],
    }


def hatch():  # compacto urbano: curto, alto e de traseira reta
    w = 0.87
    return {
        'name': 'hatch', 'w': w, 'wheel_r': 0.32, 'axles': (-1.30, 1.28),
        'front_light_z': 0.78, 'rear_light_z': 1.02, 'intake_z': 0.42, 'port_z': 0.94,
        'mirror_x': 0.86, 'mirror_z': 1.08, 'handles': (-0.50, 0.36),
        'doors': (0.95, -0.065, -0.95), 'hood_x': 1.20, 'glass_roof': False, 'spoiler': (-1.68, 1.535),
        'stations': [
            S(-1.96, w * 0.86, 0.42, 0.98),
            S(-1.92, w * 0.96, 0.30, 1.08),
            S(-1.86, w, 0.24, 1.10, tag='screen'),
            S(-1.66, w, 0.22, 1.08, 1.54, 0.62, tag='cab'),
            S(-0.10, w, 0.22, 1.04, 1.58, 0.64, tag='pillar'),
            S(-0.03, w, 0.22, 1.04, 1.58, 0.64, tag='cab'),
            S(0.52, w, 0.22, 1.02, 1.54, 0.62, tag='screen'),
            S(1.12, w, 0.22, 0.98),
            S(1.62, w, 0.24, 0.90),
            S(1.90, w * 0.95, 0.30, 0.80),
            S(1.98, w * 0.84, 0.42, 0.70),
        ],
    }


def suv():  # SUV alto e quadrado, com molduras pretas e barras de teto
    w = 0.98
    return {
        'name': 'suv', 'w': w, 'wheel_r': 0.40, 'axles': (-1.40, 1.46),
        'front_light_z': 1.02, 'rear_light_z': 1.22, 'intake_z': 0.60, 'port_z': 1.10,
        'mirror_x': 0.92, 'mirror_z': 1.30, 'handles': (-0.52, 0.42),
        'doors': (1.02, -0.065, -1.00), 'hood_x': 1.24, 'cladding': True, 'rails': (-0.75, 1.6),
        'stations': [
            S(-2.34, w * 0.90, 0.56, 1.14),
            S(-2.30, w * 0.98, 0.44, 1.26),
            S(-2.24, w, 0.36, 1.30, tag='screen'),
            S(-2.02, w, 0.34, 1.28, 1.76, 0.72, tag='cab'),
            S(-0.10, w, 0.34, 1.25, 1.80, 0.74, tag='pillar'),
            S(-0.03, w, 0.34, 1.25, 1.80, 0.74, tag='cab'),
            S(0.56, w, 0.34, 1.23, 1.77, 0.72, tag='screen'),
            S(1.16, w, 0.34, 1.20),
            S(2.00, w, 0.36, 1.16),
            S(2.28, w * 0.98, 0.44, 1.08),
            S(2.36, w * 0.90, 0.56, 0.96),
        ],
    }


def pickup():  # picape elétrica cabine dupla
    w = 0.98
    return {
        'name': 'pickup', 'w': w, 'wheel_r': 0.40, 'axles': (-1.66, 1.68),
        'front_light_z': 1.00, 'rear_light_z': 1.02, 'intake_z': 0.56, 'port_z': 1.06,
        'mirror_x': 1.16, 'mirror_z': 1.30, 'handles': (-0.22, 0.62), 'doors': (1.26, 0.235, -0.66), 'hood_x': 1.64, 'cladding': True,
        'bed': (-2.54, -0.84, 0.82), 'glass_roof': False, 'rear_bar_depth': 0.09,
        'stations': [
            S(-2.68, w * 0.92, 0.52, 1.18),
            S(-2.62, w * 0.985, 0.42, 1.23),
            S(-2.40, w, 0.36, 1.24),
            S(-0.80, w, 0.34, 1.24),
            S(-0.74, w, 0.34, 1.24, tag='screen'),
            S(-0.50, w, 0.34, 1.24, 1.80, 0.70, tag='cab'),
            S(0.20, w, 0.34, 1.23, 1.83, 0.72, tag='pillar'),
            S(0.27, w, 0.34, 1.23, 1.83, 0.72, tag='cab'),
            S(0.86, w, 0.34, 1.22, 1.80, 0.71, tag='screen'),
            S(1.56, w, 0.34, 1.18),
            S(2.26, w, 0.36, 1.12),
            S(2.58, w * 0.975, 0.42, 1.04),
            S(2.68, w * 0.90, 0.52, 0.92),
        ],
    }


# ---------------------------------------------------------------- saída
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def render_preview(car, path):
    scn = bpy.context.scene
    scn.render.engine = 'CYCLES'
    scn.cycles.samples = 24
    scn.cycles.use_denoising = False
    scn.render.resolution_x, scn.render.resolution_y = 800, 450
    world = bpy.data.worlds.new('w')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs[0].default_value = (0.75, 0.78, 0.82, 1)
    scn.world = world
    bpy.ops.mesh.primitive_plane_add(size=40)
    bpy.context.active_object.data.materials.append(material('floor', (0.12, 0.12, 0.13), roughness=0.6))
    bpy.ops.object.light_add(type='SUN', rotation=(math.radians(50), 0, math.radians(35)))
    bpy.context.active_object.data.energy = 3.5
    bpy.ops.object.camera_add(location=(5.2, -5.6, 2.6))
    cam = bpy.context.active_object
    cam.data.lens = 50
    target = bpy.data.objects.new('t', None)
    target.location = (0, 0, 0.7)
    bpy.context.collection.objects.link(target)
    tr = cam.constraints.new('TRACK_TO')
    tr.target = target
    scn.camera = cam
    scn.render.filepath = path
    bpy.ops.render.render(write_still=True)
    cam.location = (0, -9.5, 1.0)
    scn.render.filepath = path.replace('.png', '_side.png')
    bpy.ops.render.render(write_still=True)
    cam.location = (-5.4, 5.4, 2.4)
    scn.render.filepath = path.replace('.png', '_rear.png')
    bpy.ops.render.render(write_still=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    for make in (hatch, sedan, suv, pickup):
        reset()
        spec = make()
        car = build_car(spec, make_materials())
        activate(car)
        bpy.ops.object.shade_auto_smooth(angle=math.radians(38))
        bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, spec['name'] + '.glb'), export_format='GLB', use_selection=True, export_apply=True, export_yup=True)
        print(spec['name'], 'bbox', [tuple(round(c, 2) for c in v) for v in (car.bound_box[0], car.bound_box[6])], 'tris', sum(len(p.vertices) - 2 for p in car.data.polygons))
        if SAVE_BLEND:
            bpy.ops.wm.save_as_mainfile(filepath=os.path.join(os.path.dirname(__file__), spec['name'] + '.blend'))
        if RENDER:
            render_preview(car, f'/tmp/blender/{spec["name"]}.png')


main()
