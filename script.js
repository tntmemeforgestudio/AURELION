import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

'use strict';

/*
 * AURELION 0.9 — HD-first studio viewer with an explicit smooth mode.
 * The rear architecture follows the documented component families and
 * component families of the ETA 2824-2 automatic calibre. This is a custom,
 * proportionally modelled visual study, not an official ETA CAD replica.
 */

const canvas = document.getElementById('watch-3d');
const viewer = document.getElementById('watch-viewer');
const statusLabel = document.getElementById('render-status');
const timezoneSelect = document.getElementById('timezone-select');
const digitalTime = document.getElementById('digital-time');
const dateLine = document.getElementById('date-line');
const zoneName = document.getElementById('zone-name');
const zoneOffset = document.getElementById('zone-offset');
const resetViewButton = document.getElementById('reset-view');
const zoomInButton = document.getElementById('zoom-in');
const zoomOutButton = document.getElementById('zoom-out');
const fullscreenButton = document.getElementById('fullscreen-view');
const smoothQualityButton = document.getElementById('quality-smooth');
const hdQualityButton = document.getElementById('quality-hd');
const exportButton = document.getElementById('export-glb');
const exportStatus = document.getElementById('export-status');

const zonedFormatterCache = new Map();
const offsetFormatterCache = new Map();

const TIME_ZONES = {
  'Asia/Ho_Chi_Minh': 'Việt Nam · Hồ Chí Minh',
  'Asia/Bangkok': 'Thái Lan · Bangkok',
  'Asia/Singapore': 'Singapore · Singapore',
  'Asia/Tokyo': 'Nhật Bản · Tokyo',
  'Asia/Seoul': 'Hàn Quốc · Seoul',
  'Asia/Dubai': 'UAE · Dubai',
  'Europe/London': 'Vương quốc Anh · London',
  'Europe/Paris': 'Pháp · Paris',
  'America/New_York': 'Hoa Kỳ · New York',
  'America/Los_Angeles': 'Hoa Kỳ · Los Angeles',
  'Australia/Sydney': 'Úc · Sydney'
};

const C = {
  gold: 0xcba45f,
  paleGold: 0xf0d99f,
  champagne: 0xd4b477,
  darkGold: 0x76562f,
  steel: 0x707a80,
  brightSteel: 0xbcc2c3,
  darkSteel: 0x30383d,
  dial: 0x101a29,
  blueSteel: 0x526c83,
  ruby: 0x8d343d,
  black: 0x121820
};

const hands = {};
const animatedParts = [];
let renderer;
let scene;
let camera;
let controls;
let pmremGenerator;
let resizeObserver;
let clockGroup;
let lastUiSecond = -1;
let rotor;
let balance;
let palletFork;
let elapsedTime = 0;
// New visitors start with the intended crisp presentation. The HD preset is
// balanced for integrated graphics; MƯỢT remains one click away.
const DEVICE_MEMORY_GB = Number(navigator.deviceMemory || 4);
const CPU_CORES = Number(navigator.hardwareConcurrency || 4);
const LOW_POWER_DEFAULT = DEVICE_MEMORY_GB <= 4 || CPU_CORES <= 4;
let highQuality = true;
let lastRenderedAt = 0;
const gearDrive = {
  second: null, thirdPinion: null, thirdWheel: null, intermediatePinion: null, intermediateWheel: null, escape: null,
  minuteInput: null, motionReduction: null, hourPinion: null, hourOutput: null
};

function stdMaterial(color, roughness = 0.3, metalness = 0.82, extra = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness,
    envMapIntensity: 1.15,
    ...extra
  });
}

function physicalMaterial(color, roughness = 0.16, metalness = 0.72, extra = {}) {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness,
    metalness,
    clearcoat: 0.65,
    clearcoatRoughness: 0.17,
    envMapIntensity: 1.25,
    ...extra
  });
}

function addMesh(parent, geometry, material, position = {}, rotation = {}) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(position.x || 0, position.y || 0, position.z || 0);
  mesh.rotation.set(rotation.x || 0, rotation.y || 0, rotation.z || 0);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function cylinderZ(radiusTop, radiusBottom, depth, segments = 128) {
  const qualitySegments = highQuality ? segments : Math.max(32, Math.round(segments * 0.72));
  const geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, depth, qualitySegments, 1, false);
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

function addCylinderZ(parent, radius, depth, material, x, y, z, segments = 96) {
  return addMesh(parent, cylinderZ(radius, radius, depth, segments), material, { x, y, z });
}

function annularExtrudeGeometry(outerRadius, innerRadius, depth, bevel = 0.025) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outerRadius, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, innerRadius, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0, bevelSegments: highQuality ? 3 : 2,
    bevelSize: bevel, bevelThickness: bevel * 0.65, curveSegments: highQuality ? 192 : 112
  });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function addRing(parent, radius, tube, material, z, radialSegments = 12, tubularSegments = 192) {
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(
      radius, tube,
      highQuality ? radialSegments : Math.max(6, Math.round(radialSegments * 0.72)),
      highQuality ? tubularSegments : Math.max(48, Math.round(tubularSegments * 0.7))
    ),
    material
  );
  ring.position.z = z;
  ring.castShadow = true;
  ring.receiveShadow = true;
  parent.add(ring);
  return ring;
}

function makeCanvasTexture(source, anisotropy = 8) {
  const texture = new THREE.CanvasTexture(source);
  texture.colorSpace = THREE.SRGBColorSpace;
  const requestedAnisotropy = highQuality ? anisotropy : Math.min(2, anisotropy);
  texture.anisotropy = Math.min(requestedAnisotropy, renderer?.capabilities.getMaxAnisotropy?.() || requestedAnisotropy);
  return texture;
}

function createDialTexture() {
  const size = highQuality ? 2048 : 1280;
  const source = document.createElement('canvas');
  source.width = size;
  source.height = size;
  const ctx = source.getContext('2d');
  const c = size / 2;

  const enamel = ctx.createRadialGradient(c * 0.72, c * 0.76, size * 0.035, c, c, size * 0.53);
  enamel.addColorStop(0, '#29394d');
  enamel.addColorStop(0.42, '#18283a');
  enamel.addColorStop(0.82, '#0d1827');
  enamel.addColorStop(1, '#080f19');
  ctx.fillStyle = enamel;
  ctx.fillRect(0, 0, size, size);

  // Restrained radial guilloché, like a fine engine-turned enamel dial.
  ctx.save();
  ctx.translate(c, c);
  const dialLineCount = highQuality ? 240 : 168;
  for (let i = 0; i < dialLineCount; i += 1) {
    const a = (i * Math.PI * 2) / dialLineCount;
    ctx.save();
    ctx.rotate(a);
    ctx.strokeStyle = i % 12 === 0 ? 'rgba(227,194,132,.10)' : 'rgba(190,205,220,.027)';
    ctx.lineWidth = i % 12 === 0 ? 2.2 : 1;
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.075);
    ctx.lineTo(0, -size * 0.445);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  // Delicate concentric machining traces are printed into the enamel,
  // while the bezel and chapter rings are separate three-dimensional parts.
  [0.455, 0.425, 0.318, 0.285].forEach((r, i) => {
    ctx.beginPath();
    ctx.arc(c, c, size * r, 0, Math.PI * 2);
    ctx.strokeStyle = i % 2 ? 'rgba(221,193,143,.10)' : 'rgba(243,215,164,.20)';
    ctx.lineWidth = i === 0 ? 3 : 1.5;
    ctx.stroke();
  });

  // Small maker's signature, kept subtle so the raised markers remain dominant.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(234,211,167,.82)';
  ctx.font = '600 46px Georgia, serif';
  ctx.letterSpacing = '12px';
  ctx.fillText('AURELION', c, size * 0.275);
  ctx.fillStyle = 'rgba(202,207,211,.62)';
  ctx.font = '500 21px Arial, sans-serif';
  ctx.letterSpacing = '7px';
  ctx.fillText('AUTOMATIC', c, size * 0.302);
  ctx.fillStyle = 'rgba(230,204,150,.8)';
  ctx.font = '500 20px Georgia, serif';
  ctx.letterSpacing = '5px';
  ctx.fillText('SWISS MOVEMENT STUDY', c, size * 0.725);

  return makeCanvasTexture(source, 12);
}

function createFineBrushedTexture(base = '#7b8589', line = 'rgba(248,240,220,.12)') {
  const size = highQuality ? 1536 : 960;
  const source = document.createElement('canvas');
  source.width = size;
  source.height = size;
  const ctx = source.getContext('2d');
  const grad = ctx.createRadialGradient(size * 0.42, size * 0.36, 8, size * 0.5, size * 0.5, size * 0.72);
  grad.addColorStop(0, base);
  grad.addColorStop(1, '#333b42');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  ctx.save();
  ctx.translate(size / 2, size / 2);
  const brushLineCount = highQuality ? 420 : 240;
  for (let i = 0; i < brushLineCount; i += 1) {
    const a = (i * Math.PI * 2) / brushLineCount;
    ctx.save();
    ctx.rotate(a);
    ctx.strokeStyle = i % 7 === 0 ? line : 'rgba(8,13,18,.075)';
    ctx.lineWidth = i % 7 === 0 ? 1.4 : 0.65;
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.08);
    ctx.lineTo(0, -size * 0.49);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
  return makeCanvasTexture(source, 12);
}

function createRoundedShape(width, height, radius) {
  const w = width / 2;
  const h = height / 2;
  const r = Math.min(radius, w, h);
  const shape = new THREE.Shape();
  shape.moveTo(-w + r, -h);
  shape.lineTo(w - r, -h);
  shape.quadraticCurveTo(w, -h, w, -h + r);
  shape.lineTo(w, h - r);
  shape.quadraticCurveTo(w, h, w - r, h);
  shape.lineTo(-w + r, h);
  shape.quadraticCurveTo(-w, h, -w, h - r);
  shape.lineTo(-w, -h + r);
  shape.quadraticCurveTo(-w, -h, -w + r, -h);
  return shape;
}

function createBridgeShape(type = 'train') {
  const s = new THREE.Shape();
  if (type === 'barrel') {
    s.moveTo(-1.05, -0.52);
    s.bezierCurveTo(-1.2, 0.25, -0.72, 0.93, 0.15, 0.94);
    s.bezierCurveTo(0.85, 0.94, 1.08, 0.48, 0.98, 0.16);
    s.lineTo(0.52, 0.08);
    s.bezierCurveTo(0.45, 0.54, -0.03, 0.62, -0.4, 0.34);
    s.bezierCurveTo(-0.63, 0.12, -0.64, -0.17, -0.43, -0.52);
    s.closePath();
  } else if (type === 'train') {
    s.moveTo(-0.78, 0.48);
    s.bezierCurveTo(-0.34, 0.91, 0.27, 0.82, 0.55, 0.42);
    s.bezierCurveTo(0.84, 0.04, 0.79, -0.44, 1.22, -0.6);
    s.lineTo(1.58, -0.34);
    s.bezierCurveTo(1.13, -0.04, 1.22, 0.56, 0.84, 0.91);
    s.bezierCurveTo(0.3, 1.35, -0.45, 1.23, -0.95, 0.72);
    s.closePath();
  } else if (type === 'balance') {
    s.moveTo(-0.88, 0.27);
    s.bezierCurveTo(-0.72, 0.76, -0.2, 0.98, 0.3, 0.77);
    s.bezierCurveTo(0.7, 0.58, 0.86, 0.21, 0.71, -0.1);
    s.lineTo(0.38, -0.02);
    s.bezierCurveTo(0.45, 0.31, 0.17, 0.59, -0.16, 0.59);
    s.bezierCurveTo(-0.48, 0.59, -0.65, 0.36, -0.59, 0.03);
    s.closePath();
  } else if (type === 'pallet') {
    s.moveTo(-0.38, 0.18);
    s.bezierCurveTo(-0.27, 0.39, 0.04, 0.43, 0.19, 0.22);
    s.lineTo(0.41, -0.12);
    s.lineTo(0.23, -0.23);
    s.lineTo(0.02, 0.03);
    s.bezierCurveTo(-0.08, 0.12, -0.21, 0.06, -0.2, -0.08);
    s.lineTo(-0.18, -0.26);
    s.lineTo(-0.39, -0.26);
    s.closePath();
  }
  return s;
}

function addBridge(parent, type, x, y, z, material, screwPoints) {
  const shape = createBridgeShape(type);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.095,
    bevelEnabled: true,
    bevelSegments: 3,
    bevelSize: 0.028,
    bevelThickness: 0.018,
    curveSegments: 12
  });
  geometry.computeVertexNormals();
  const bridge = addMesh(parent, geometry, material, { x, y, z });
  bridge.name = `${type} bridge`;
  bridge.castShadow = true;
  bridge.receiveShadow = true;

  (screwPoints || []).forEach(([sx, sy]) => addScrew(parent, x + sx, y + sy, z + 0.11, 0.075));
  return bridge;
}

function addScrew(parent, x, y, z, radius = 0.075) {
  const steel = physicalMaterial(0xbcc5c7, 0.22, 0.96);
  const dark = stdMaterial(0x283038, 0.48, 0.52);
  const head = addCylinderZ(parent, radius, 0.075, steel, x, y, z, 32);
  head.name = 'Blued steel movement screw';
  const slot = addMesh(parent, new THREE.BoxGeometry(radius * 1.2, radius * 0.16, 0.012), dark, { x, y, z: z + 0.041 });
  slot.rotation.z = Math.PI / 5;
  return head;
}

function addJewel(parent, x, y, z, radius = 0.085) {
  const seatMaterial = stdMaterial(0x777f82, 0.25, 0.93);
  const rubyMaterial = new THREE.MeshPhysicalMaterial({
    color: C.ruby,
    roughness: 0.12,
    metalness: 0.18,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    envMapIntensity: 1.5
  });
  addCylinderZ(parent, radius * 1.52, 0.055, seatMaterial, x, y, z, 32);
  const jewel = addCylinderZ(parent, radius, 0.045, rubyMaterial, x, y, z + 0.033, 32);
  jewel.name = 'Synthetic ruby bearing';
  return jewel;
}

function addGear(parent, { x, y, radius, teeth, z, depth = 0.06, hole = 0.12, material, name = 'Watch wheel' }) {
  const rootR = radius * 0.90;
  const baseR = radius * 0.93;
  const outerR = radius;
  const pitch = (Math.PI * 2) / teeth;
  const basePressure = 20 * Math.PI / 180;
  const inv = angle => Math.tan(angle) - angle;
  const halfTooth = r => {
    if (r <= baseR) return Math.PI / (2 * teeth) + inv(basePressure);
    const alpha = Math.acos(Math.min(0.9999, baseR / r));
    return Math.max(0.006, Math.PI / (2 * teeth) + inv(basePressure) - inv(alpha));
  };

  const points = [];
  for (let tooth = 0; tooth < teeth; tooth += 1) {
    const center = tooth * pitch;
    const leftRoot = center - pitch * 0.48;
    points.push([rootR * Math.cos(leftRoot), rootR * Math.sin(leftRoot)]);
    points.push([rootR * Math.cos(center - pitch * 0.31), rootR * Math.sin(center - pitch * 0.31)]);
    const flankSteps = 8;
    for (let i = 0; i <= flankSteps; i += 1) {
      const t = i / flankSteps;
      const r = baseR + (outerR - baseR) * t;
      const a = center - halfTooth(r);
      points.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    for (let i = flankSteps; i >= 0; i -= 1) {
      const t = i / flankSteps;
      const r = baseR + (outerR - baseR) * t;
      const a = center + halfTooth(r);
      points.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    points.push([rootR * Math.cos(center + pitch * 0.31), rootR * Math.sin(center + pitch * 0.31)]);
    points.push([rootR * Math.cos(center + pitch * 0.48), rootR * Math.sin(center + pitch * 0.48)]);
  }

  const shape = new THREE.Shape();
  points.forEach(([px, py], index) => {
    if (index === 0) shape.moveTo(px, py);
    else shape.lineTo(px, py);
  });
  shape.closePath();
  const bore = new THREE.Path();
  bore.absarc(0, 0, hole, 0, Math.PI * 2, true);
  shape.holes.push(bore);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelSegments: 3,
    bevelSize: 0.008,
    bevelThickness: 0.006,
    curveSegments: 8
  });
  geometry.computeVertexNormals();
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.name = name;
  const wheel = new THREE.Mesh(geometry, material);
  wheel.castShadow = true;
  wheel.receiveShadow = true;
  group.add(wheel);

  const hubMat = physicalMaterial(0x9ea5a6, 0.18, 0.96);
  const hub = addCylinderZ(group, Math.max(hole * 1.25, radius * 0.18), depth * 1.7, hubMat, 0, 0, depth * 0.35, 48);
  hub.name = `${name} arbor hub`;
  parent.add(group);
  return group;
}

function addBarrel(parent) {
  const group = new THREE.Group();
  group.position.set(-1.52, 1.18, -0.625);
  group.name = 'Mainspring barrel assembly';
  const steel = stdMaterial(0x9ca4a5, 0.29, 0.88);
  const brass = physicalMaterial(0xb48b4f, 0.25, 0.92);
  addCylinderZ(group, 0.83, 0.12, steel, 0, 0, 0, 96);
  addRing(group, 0.75, 0.035, brass, 0.075, 10, 96);
  addCylinderZ(group, 0.29, 0.11, brass, 0, 0, 0.08, 48);
  addRing(group, 0.23, 0.025, steel, 0.145, 10, 64);
  // A restrained cutaway segment hints at the coiled mainspring inside the barrel.
  const springPoints = [];
  for (let i = 0; i <= 260; i += 1) {
    const t = i / 260;
    const r = 0.12 + t * 0.50;
    const a = t * Math.PI * 5.4;
    springPoints.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0.12));
  }
  const springCurve = new THREE.CatmullRomCurve3(springPoints);
  const spring = new THREE.Mesh(
    new THREE.TubeGeometry(springCurve, 260, 0.014, 6, false),
    physicalMaterial(0x777f83, 0.3, 0.9)
  );
  group.add(spring);
  addScrew(group, 0, 0, 0.17, 0.085);
  parent.add(group);
  return group;
}

function addBalanceAssembly(parent) {
  const center = new THREE.Group();
  center.position.set(1.85, -0.05, -0.72);
  center.name = 'Balance wheel and hairspring';
  const rim = physicalMaterial(0xc2a36c, 0.2, 0.94);
  const blued = physicalMaterial(0x48657c, 0.24, 0.86);
  const silver = physicalMaterial(0xaeb5b7, 0.22, 0.94);

  addRing(center, 0.57, 0.052, rim, 0, 12, 96);
  addRing(center, 0.48, 0.018, silver, -0.015, 8, 80);
  // Three-arm balance wheel: a restrained, conventional annular balance layout.
  for (let i = 0; i < 3; i += 1) {
    const a = i * (Math.PI * 2 / 3);
    const spoke = addMesh(center, new THREE.BoxGeometry(0.052, 0.91, 0.045), blued, {
      x: Math.sin(a) * 0.035,
      y: Math.cos(a) * 0.035,
      z: -0.015
    });
    spoke.rotation.z = -a;
  }
  for (let i = 0; i < 3; i += 1) {
    const a = i * (Math.PI * 2 / 3) + Math.PI / 6;
    addCylinderZ(center, 0.052, 0.06, rim, Math.sin(a) * 0.50, Math.cos(a) * 0.50, 0.025, 20);
  }
  addCylinderZ(center, 0.13, 0.12, silver, 0, 0, 0.035, 40);
  addJewel(center, 0, 0, -0.12, 0.072);

  // Incabloc-style shock setting around the balance pivot: cup, cap jewel and lyre spring.
  addRing(center, 0.19, 0.025, silver, -0.12, 10, 64);
  const lyrePoints = [
    new THREE.Vector3(-0.13, 0.19, -0.095),
    new THREE.Vector3(-0.21, 0.10, -0.095),
    new THREE.Vector3(-0.18, -0.06, -0.095),
    new THREE.Vector3(0, -0.17, -0.095),
    new THREE.Vector3(0.18, -0.06, -0.095),
    new THREE.Vector3(0.21, 0.10, -0.095),
    new THREE.Vector3(0.13, 0.19, -0.095)
  ];
  const lyreCurve = new THREE.CatmullRomCurve3(lyrePoints);
  const lyre = new THREE.Mesh(
    new THREE.TubeGeometry(lyreCurve, 90, 0.012, 6, false),
    physicalMaterial(0xd5b779, 0.18, 0.95)
  );
  lyre.name = 'Balance shock protection spring';
  center.add(lyre);

  // Spiral hairspring: a real coiled form held beneath the balance cock.
  const spiralPoints = [];
  for (let i = 0; i <= 360; i += 1) {
    const t = i / 360;
    const r = 0.035 + t * 0.30;
    const a = t * Math.PI * 2 * 5.3;
    spiralPoints.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, -0.055));
  }
  const springCurve = new THREE.CatmullRomCurve3(spiralPoints);
  const hairspring = new THREE.Mesh(
    new THREE.TubeGeometry(springCurve, 360, 0.009, 6, false),
    blued
  );
  hairspring.name = 'Balance hairspring';
  center.add(hairspring);

  balance = center;
  animatedParts.push({
    update: time => { center.rotation.z = Math.sin(time * Math.PI * 8) * 0.18; }
  });
  parent.add(center);
  return center;
}

function addPalletFork(parent) {
  const group = new THREE.Group();
  group.position.set(1.30, 0.456, -0.72);
  group.name = 'Swiss lever escapement pallet fork';
  const steel = physicalMaterial(0x9ca9ac, 0.2, 0.92);
  const ruby = physicalMaterial(0xa54851, 0.14, 0.25);
  const arm = addMesh(group, new THREE.BoxGeometry(0.58, 0.075, 0.055), steel, { x: 0.02, y: 0, z: 0 });
  arm.rotation.z = -0.48;
  const forkA = addMesh(group, new THREE.BoxGeometry(0.22, 0.065, 0.05), steel, { x: 0.27, y: 0.22, z: 0.005 });
  forkA.rotation.z = 0.66;
  const forkB = addMesh(group, new THREE.BoxGeometry(0.22, 0.065, 0.05), steel, { x: 0.33, y: -0.19, z: 0.005 });
  forkB.rotation.z = -0.82;
  addMesh(group, new THREE.BoxGeometry(0.105, 0.045, 0.035), ruby, { x: 0.39, y: 0.32, z: 0.04 }).name = 'Entry pallet stone';
  addMesh(group, new THREE.BoxGeometry(0.105, 0.045, 0.035), ruby, { x: 0.45, y: -0.29, z: 0.04 }).name = 'Exit pallet stone';
  addCylinderZ(group, 0.08, 0.05, ruby, -0.16, 0, 0.06, 24);
  palletFork = group;
  animatedParts.push({ update: time => { group.rotation.z = Math.sin(time * Math.PI * 8 + 0.7) * 0.09; } });
  parent.add(group);
  return group;
}

function createAnnularSector(outerRadius, innerRadius, startAngle, endAngle) {
  const shape = new THREE.Shape();
  shape.moveTo(Math.cos(startAngle) * outerRadius, Math.sin(startAngle) * outerRadius);
  shape.absarc(0, 0, outerRadius, startAngle, endAngle, false);
  shape.lineTo(Math.cos(endAngle) * innerRadius, Math.sin(endAngle) * innerRadius);
  shape.absarc(0, 0, innerRadius, endAngle, startAngle, true);
  shape.closePath();
  return shape;
}

function addRotor(parent) {
  const group = new THREE.Group();
  group.position.set(-0.08, 0.08, -0.79);
  group.name = 'Bidirectional automatic oscillating rotor';
  const tungsten = physicalMaterial(0x92999c, 0.28, 0.96, { map: createFineBrushedTexture('#a3a8aa', 'rgba(250,245,230,.20)') });
  const polished = physicalMaterial(0xd4c08f, 0.18, 0.96);
  const dark = stdMaterial(0x333d43, 0.28, 0.9);

  // A single crescent-shaped oscillating mass with a central ball-bearing hub.
  // Its solid outer weight and open inner area follow a conventional automatic rotor.
  const massShape = createAnnularSector(3.18, 2.33, Math.PI * 0.57, Math.PI * 1.57);
  const massGeometry = new THREE.ExtrudeGeometry(massShape, {
    depth: 0.13,
    bevelEnabled: true,
    bevelSegments: 3,
    bevelSize: 0.032,
    bevelThickness: 0.022,
    curveSegments: 36
  });
  massGeometry.computeVertexNormals();
  const mass = addMesh(group, massGeometry, tungsten, { z: 0 });
  mass.name = 'Rotor tungsten oscillating weight';

  // A machined spoke links the hub to the crescent mass; it is part of the rotor, not a loose gear.
  const armShape = new THREE.Shape();
  armShape.moveTo(-0.25, -0.45);
  armShape.quadraticCurveTo(-0.95, -1.08, -2.37, -2.12);
  armShape.lineTo(-2.12, -2.43);
  armShape.quadraticCurveTo(-0.58, -1.42, 0.32, -0.28);
  armShape.closePath();
  const armGeom = new THREE.ExtrudeGeometry(armShape, {
    depth: 0.11,
    bevelEnabled: true,
    bevelSegments: 2,
    bevelSize: 0.025,
    bevelThickness: 0.018
  });
  const arm = addMesh(group, armGeom, tungsten, { z: -0.015 });
  arm.name = 'Rotor support arm';

  // Inner edge, outer edge, and central ball-bearing cover.
  addRing(group, 3.15, 0.026, polished, 0.145, 10, 128);
  addRing(group, 2.34, 0.022, dark, 0.145, 10, 128);
  addRing(group, 0.43, 0.055, polished, 0.16, 14, 96);
  addCylinderZ(group, 0.31, 0.14, dark, 0, 0, 0.15, 64);
  addRing(group, 0.24, 0.035, polished, 0.235, 12, 72);
  addCylinderZ(group, 0.13, 0.08, stdMaterial(0x8b9295, 0.18, 0.98), 0, 0, 0.245, 48);
  addJewel(group, 0, 0, 0.30, 0.06);

  // Fine rotor balance grooves, machined into the weighted rim.
  for (let i = 0; i < 14; i += 1) {
    const a = Math.PI * 0.57 + (i / 13) * Math.PI;
    const r = 2.73;
    const line = addMesh(group, new THREE.BoxGeometry(0.012, 0.22, 0.008), dark, {
      x: Math.cos(a) * r,
      y: Math.sin(a) * r,
      z: 0.145
    });
    line.rotation.z = a;
  }

  rotor = group;
  animatedParts.push({ update: time => { group.rotation.z = Math.sin(time * 0.38) * 0.16; } });
  parent.add(group);
  return group;
}

function addAutomaticMovement(parent) {
  const assembly = new THREE.Group();
  assembly.name = 'AURELION automatic movement — ETA 2824-2 architecture study';
  parent.add(assembly);

  const plateMat = physicalMaterial(0x707a80, 0.34, 0.88, {
    map: createFineBrushedTexture('#879195', 'rgba(245,239,221,.10)'),
    anisotropy: 0.55
  });
  const bridgeMat = physicalMaterial(0xb4b9b8, 0.25, 0.94, {
    map: createFineBrushedTexture('#aeb5b7', 'rgba(255,255,255,.15)'),
    anisotropy: 0.7
  });
  const darkBridge = physicalMaterial(0x47535b, 0.29, 0.9);
  const brass = physicalMaterial(0xc2a06a, 0.23, 0.92);
  const gearSteel = physicalMaterial(0xc2c9c9, 0.2, 0.96);
  const bluedSteel = physicalMaterial(0x496a83, 0.23, 0.9);

  // Mainplate: recessed bearing seats plus real openings in the plate silhouette.
  const plateShape = new THREE.Shape();
  plateShape.absarc(0, 0, 3.78, 0, Math.PI * 2, false);
  const bearingSeats = [
    [0.00, 0.00, 0.18], [0.594, 0.00, 0.09], [0.594, 0.474, 0.09],
    [0.950, 0.474, 0.075], [1.85, -0.05, 0.61], [1.30, 0.456, 0.12],
    [-1.52, 1.18, 0.30], [-0.08, 0.08, 0.40],
    [1.45, 1.62, 0.12], [2.28, 1.38, 0.10], [0.82, 2.08, 0.09],
    [2.90, 0.26, 0.08], [2.15, -1.55, 0.085], [2.625, -1.55, 0.11], [3.005, -1.55, 0.085]
  ];
  bearingSeats.forEach(([x, y, radius]) => {
    const bore = new THREE.Path();
    bore.absarc(x, y, radius, 0, Math.PI * 2, true);
    plateShape.holes.push(bore);
  });
  // A few restrained skeletonisation windows expose depth below the mainplate.
  [[-1.05, -1.70, 0.43], [0.28, -1.72, 0.34], [2.88, 0.92, 0.28]].forEach(([x, y, radius]) => {
    const window = new THREE.Path();
    window.absarc(x, y, radius, 0, Math.PI * 2, true);
    plateShape.holes.push(window);
  });
  const plateGeometry = new THREE.ExtrudeGeometry(plateShape, {
    depth: 0.16, bevelEnabled: true, bevelSegments: 2,
    bevelSize: 0.014, bevelThickness: 0.01, curveSegments: 96
  });
  plateGeometry.computeVertexNormals();
  const plate = addMesh(assembly, plateGeometry, plateMat, { z: -0.63 });
  plate.name = 'Machined mainplate with bearing seats and skeleton openings';
  addRing(assembly, 3.88, 0.075, darkBridge, -0.49, 14, 160);
  addRing(assembly, 3.68, 0.025, brass, -0.635, 10, 144);

  const automaticFramework = new THREE.Mesh(new THREE.RingGeometry(2.58, 3.30, 160), bridgeMat);
  automaticFramework.position.z = -0.745;
  automaticFramework.material.side = THREE.DoubleSide;
  automaticFramework.name = 'Automatic device framework';
  automaticFramework.castShadow = true;
  automaticFramework.receiveShadow = true;
  assembly.add(automaticFramework);

  const recesses = [
    [0, 0, 0.37], [0.594, 0, 0.22], [0.594, 0.474, 0.22], [0.950, 0.474, 0.17],
    [1.85, -0.05, 0.62], [1.30, 0.456, 0.28], [-1.52, 1.18, 0.85],
    [1.45, 1.62, 0.34], [2.28, 1.38, 0.25], [0.82, 2.08, 0.19],
    [2.15, -1.55, 0.15], [2.625, -1.55, 0.22], [3.005, -1.55, 0.17]
  ];
  recesses.forEach(([x, y, r]) => {
    addCylinderZ(assembly, r, 0.025, stdMaterial(0x242d34, 0.5, 0.72), x, y, -0.635, 48);
    const seat = addRing(assembly, r * 0.88, 0.014, stdMaterial(0x68757a, 0.28, 0.9), -0.61, 8, 64);
    seat.position.set(x, y, -0.61);
  });

  // Barrel and ratchet assembly, placed under the barrel bridge.
  const barrel = addBarrel(assembly);
  barrel.position.set(-1.52, 1.18, -0.63);
  const ratchet = addGear(assembly, {
    x: -1.52, y: 1.18, radius: 0.63, teeth: 48, z: -0.70, depth: 0.05,
    hole: 0.12, material: brass, name: 'Ratchet wheel — barrel arbor'
  });
  addRing(ratchet, 0.40, 0.025, gearSteel, 0.065, 8, 72);
  addScrew(assembly, -1.52, 1.18, -0.59, 0.07);

  // Kinematic display train. Gear centre spacing is set from the modeled pitch radii.
  // These display tooth counts are chosen to preserve a linked 24:1 ratio; they are
  // not represented as the unpublished internal tooth counts of the ETA 2824-2.
  // 80:20 = 4x; 60:20 = 3x; 40:20 = 2x; total 24x to the 20T escape wheel.
  gearDrive.second = addGear(assembly, {
    x: 0.00, y: 0.00, radius: 0.48, teeth: 80, z: -0.74, depth: 0.045,
    hole: 0.075, material: gearSteel, name: 'Second wheel — central seconds, display ratio 80T'
  });
  gearDrive.thirdPinion = addGear(assembly, {
    x: 0.594, y: 0.00, radius: 0.12, teeth: 20, z: -0.745, depth: 0.04,
    hole: 0.045, material: brass, name: 'Third wheel pinion — 20T display ratio'
  });
  gearDrive.thirdWheel = addGear(assembly, {
    x: 0.594, y: 0.00, radius: 0.36, teeth: 60, z: -0.70, depth: 0.04,
    hole: 0.075, material: brass, name: 'Third wheel — compound 60T display ratio'
  });
  gearDrive.intermediatePinion = addGear(assembly, {
    x: 0.594, y: 0.474, radius: 0.12, teeth: 20, z: -0.745, depth: 0.04,
    hole: 0.045, material: gearSteel, name: 'Intermediate wheel pinion — 20T display ratio'
  });
  gearDrive.intermediateWheel = addGear(assembly, {
    x: 0.594, y: 0.474, radius: 0.24, teeth: 40, z: -0.70, depth: 0.04,
    hole: 0.06, material: brass, name: 'Intermediate wheel — compound 40T display ratio'
  });
  gearDrive.escape = addGear(assembly, {
    x: 0.950, y: 0.474, radius: 0.12, teeth: 20, z: -0.745, depth: 0.04,
    hole: 0.045, material: gearSteel, name: 'Escape wheel — 20 teeth, 24 revolutions per minute display rate'
  });

  // Motion works: a separate, visible 12:1 reduction links the minute output
  // to the hour output. The geometry is a proportioned study, not an ETA CAD copy.
  // Two external meshes give the minute and hour outputs the same direction:
  // 12T -> 48T (4:1), then 12T -> 36T (3:1), total 12:1.
  gearDrive.minuteInput = addGear(assembly, {
    x: 2.15, y: -1.55, radius: 0.096, teeth: 12, z: -0.715, depth: 0.045,
    hole: 0.035, material: gearSteel, name: 'Motion works — minute input pinion 12T'
  });
  gearDrive.motionReduction = addGear(assembly, {
    x: 2.625, y: -1.55, radius: 0.384, teeth: 48, z: -0.715, depth: 0.045,
    hole: 0.075, material: brass, name: 'Motion works — first reduction wheel 48T'
  });
  gearDrive.hourPinion = addGear(assembly, {
    x: 2.625, y: -1.55, radius: 0.096, teeth: 12, z: -0.675, depth: 0.04,
    hole: 0.035, material: gearSteel, name: 'Motion works — compound hour pinion 12T'
  });
  gearDrive.hourOutput = addGear(assembly, {
    x: 3.005, y: -1.55, radius: 0.288, teeth: 36, z: -0.675, depth: 0.04,
    hole: 0.065, material: brass, name: 'Motion works — hour wheel 36T'
  });
  addJewel(assembly, 2.15, -1.55, -0.68, 0.05);
  addJewel(assembly, 2.625, -1.55, -0.60, 0.055);
  addJewel(assembly, 3.005, -1.55, -0.61, 0.05);

  // Small arbor sleeves visually join the coaxial compound wheels.
  const arborSteel = physicalMaterial(0x8c969a, 0.18, 0.97);
  addCylinderZ(assembly, 0.055, 0.18, arborSteel, 0.594, 0.00, -0.65, 28);
  addCylinderZ(assembly, 0.052, 0.18, arborSteel, 0.594, 0.474, -0.65, 28);
  [
    [0, 0, -0.70], [0.594, 0, -0.70], [0.594, 0.474, -0.70],
    [0.950, 0.474, -0.70], [-1.52, 1.18, -0.68],
    [1.45, 1.62, -0.68], [2.28, 1.38, -0.68], [0.82, 2.08, -0.68]
  ].forEach(([x, y, z]) => addJewel(assembly, x, y, z, 0.055));

  // Automatic winding works remain beneath the rotor; the reversing system
  // is separate from the timekeeping gear ratio because wrist motion drives it.
  addGear(assembly, { x: 1.45, y: 1.62, radius: 0.34, teeth: 34, z: -0.68, depth: 0.04, hole: 0.07, material: brass, name: 'Automatic reduction wheel — illustrative geometry' });
  addGear(assembly, { x: 2.28, y: 1.38, radius: 0.25, teeth: 28, z: -0.68, depth: 0.04, hole: 0.06, material: gearSteel, name: 'Automatic reversing wheel — illustrative geometry' });
  addGear(assembly, { x: 0.82, y: 2.08, radius: 0.19, teeth: 22, z: -0.68, depth: 0.04, hole: 0.05, material: gearSteel, name: 'Auxiliary reversing wheel — illustrative geometry' });

  // Crown, stem and setting works on the 3 o'clock axis.
  const stem = addMesh(assembly, cylinderZ(0.07, 0.07, 1.35, 24), gearSteel, { x: 4.25, y: 0.02, z: -0.67 }, { y: Math.PI / 2 });
  stem.name = 'Winding stem';
  addGear(assembly, { x: 2.90, y: 0.26, radius: 0.18, teeth: 22, z: -0.70, depth: 0.04, hole: 0.05, material: brass, name: 'Crown wheel — setting works study' });
  addGear(assembly, { x: 3.08, y: -0.38, radius: 0.15, teeth: 18, z: -0.70, depth: 0.04, hole: 0.045, material: gearSteel, name: 'Winding pinion — setting works study' });
  addCylinderZ(assembly, 0.11, 0.04, brass, 3.28, -0.10, -0.67, 32).name = 'Sliding pinion collar';

  // Bridges, click and escapement are kept low-profile so the moving train remains visible.
  addBridge(assembly, 'barrel', -1.50, 1.18, -0.645, bridgeMat, [[-0.72, -0.28], [0.76, 0.18], [0.05, 0.74]]);
  addBridge(assembly, 'train', 0.62, 0.18, -0.635, bridgeMat, [[-0.56, 0.50], [0.73, 0.52], [1.18, -0.36]]);
  addBridge(assembly, 'pallet', 1.35, 0.48, -0.645, darkBridge, [[-0.23, 0.22], [0.28, -0.19]]);

  const clickShape = new THREE.Shape();
  clickShape.moveTo(-0.12, 0.02);
  clickShape.quadraticCurveTo(0.12, 0.22, 0.37, 0.08);
  clickShape.lineTo(0.44, 0.17);
  clickShape.quadraticCurveTo(0.15, 0.42, -0.18, 0.16);
  clickShape.closePath();
  const click = addMesh(assembly, new THREE.ExtrudeGeometry(clickShape, {
    depth: 0.035, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.006
  }), bluedSteel, { x: -0.48, y: 1.72, z: -0.71 });
  click.name = 'Ratchet click';
  addScrew(assembly, -0.48, 1.72, -0.66, 0.045);

  addBalanceAssembly(assembly);
  addPalletFork(assembly);
  addBridge(assembly, 'balance', 1.85, -0.05, -0.615, bridgeMat, [[-0.67, 0.26], [0.57, 0.18]]);
  addRotor(assembly);

  return assembly;
}

function createDialBar(parent, x1, y1, x2, y2, width, z, material) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  const shape = createRoundedShape(length, width, width * 0.42);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.055,
    bevelEnabled: true,
    bevelSegments: 3,
    bevelSize: 0.012,
    bevelThickness: 0.01,
    curveSegments: 8
  });
  geometry.computeVertexNormals();
  const mesh = addMesh(parent, geometry, material, { x: (x1 + x2) / 2, y: (y1 + y2) / 2, z });
  mesh.rotation.z = Math.atan2(dy, dx);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildRomanGlyph(parent, glyph, x, y, z, scale = 1) {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.scale.setScalar(scale);
  group.name = `Applied Roman numeral ${glyph}`;
  const gold = physicalMaterial(0xe1c17d, 0.19, 0.95);
  const edge = stdMaterial(0x664b2a, 0.32, 0.78);

  const glyphWidth = char => char === 'I' ? 0.085 : char === 'V' ? 0.205 : 0.225;
  const total = [...glyph].reduce((sum, char) => sum + glyphWidth(char), 0) + (glyph.length - 1) * 0.045;
  let cursor = -total / 2;

  const stroke = (x1, y1, x2, y2, w = 0.036) => {
    // A dark undercut underneath the gold inlay gives each numeral a real cast shadow.
    createDialBar(group, x1 + 0.014, y1 - 0.014, x2 + 0.014, y2 - 0.014, w * 1.22, -0.012, edge);
    createDialBar(group, x1, y1, x2, y2, w, 0, gold);
  };

  for (const char of glyph) {
    const width = glyphWidth(char);
    const mid = cursor + width / 2;
    if (char === 'I') {
      stroke(mid, -0.145, mid, 0.145, 0.04);
      stroke(mid - 0.055, 0.145, mid + 0.055, 0.145, 0.03);
      stroke(mid - 0.055, -0.145, mid + 0.055, -0.145, 0.03);
    } else if (char === 'V') {
      stroke(mid - 0.09, 0.15, mid, -0.15, 0.04);
      stroke(mid, -0.15, mid + 0.09, 0.15, 0.04);
    } else if (char === 'X') {
      stroke(mid - 0.10, 0.15, mid + 0.10, -0.15, 0.04);
      stroke(mid - 0.10, -0.15, mid + 0.10, 0.15, 0.04);
    }
    cursor += width + 0.045;
  }
  parent.add(group);
  return group;
}

function createAppliedHourNumerals(parent) {
  const roman = ['XII', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
  roman.forEach((glyph, index) => {
    const angle = (index * Math.PI) / 6;
    const x = Math.sin(angle) * 3.63;
    const y = Math.cos(angle) * 3.63;
    const scale = index % 3 === 0 ? 1.12 : 1.0;
    buildRomanGlyph(parent, glyph, x, y, 0.875, scale);
  });
}

function createMinuteTrack(parent) {
  const minorMaterial = physicalMaterial(0x99a2a5, 0.3, 0.85);
  const majorMaterial = physicalMaterial(0xe0c17d, 0.2, 0.96);
  const minorGeometry = new THREE.BoxGeometry(0.025, 0.09, 0.035);
  const majorGeometry = new THREE.BoxGeometry(0.045, 0.16, 0.045);
  const minor = new THREE.InstancedMesh(minorGeometry, minorMaterial, 48);
  const major = new THREE.InstancedMesh(majorGeometry, majorMaterial, 12);
  const dummy = new THREE.Object3D();
  let minorCount = 0;
  let majorCount = 0;

  for (let i = 0; i < 60; i += 1) {
    const a = (i * Math.PI) / 30;
    const isMajor = i % 5 === 0;
    const r = isMajor ? 4.30 : 4.34;
    dummy.position.set(Math.sin(a) * r, Math.cos(a) * r, 0.86);
    dummy.rotation.set(0, 0, -a);
    dummy.updateMatrix();
    if (isMajor) major.setMatrixAt(majorCount++, dummy.matrix);
    else minor.setMatrixAt(minorCount++, dummy.matrix);
  }
  minor.count = minorCount;
  major.count = majorCount;
  minor.castShadow = true;
  major.castShadow = true;
  minor.receiveShadow = true;
  major.receiveShadow = true;
  minor.name = 'Applied minute indices';
  major.name = 'Applied five-minute indices';
  parent.add(minor, major);
}

function addDialAssembly(parent) {
  const dialBase = addMesh(parent, cylinderZ(4.57, 4.57, 0.16, 192), stdMaterial(0x92703d, 0.28, 0.92), { z: 0.68 });
  dialBase.name = 'Dial brass foundation';
  const dialSurface = new THREE.MeshPhysicalMaterial({
    map: createDialTexture(),
    color: 0xffffff,
    roughness: 0.23,
    metalness: 0.28,
    clearcoat: 0.9,
    clearcoatRoughness: 0.12,
    envMapIntensity: 1.15
  });
  const dial = addMesh(parent, new THREE.CircleGeometry(4.535, 192), dialSurface, { z: 0.775 });
  dial.name = 'Midnight blue guilloche enamel dial';
  dial.castShadow = false;
  dial.receiveShadow = true;

  // Stepped, machined chapter ring with dark recessed channels between surfaces.
  addRing(parent, 4.515, 0.035, physicalMaterial(0xe0c17d, 0.17, 0.97), 0.815, 12, 192);
  addRing(parent, 4.455, 0.018, stdMaterial(0x38434d, 0.34, 0.82), 0.825, 8, 192);
  addRing(parent, 4.205, 0.026, physicalMaterial(0xc6a36a, 0.2, 0.92), 0.842, 10, 192);
  addRing(parent, 3.31, 0.018, stdMaterial(0x9a8059, 0.29, 0.82), 0.842, 8, 160);
  addRing(parent, 0.66, 0.028, physicalMaterial(0xd7b97b, 0.19, 0.94), 0.858, 10, 96);
  addRing(parent, 0.49, 0.012, stdMaterial(0x53606b, 0.32, 0.84), 0.863, 8, 96);

  createMinuteTrack(parent);
  createAppliedHourNumerals(parent);

  // Small applied hour jewels are used as restrained accents at the four quarters.
  const jewel = physicalMaterial(0x9a464b, 0.13, 0.2, { clearcoat: 1 });
  for (let i = 0; i < 4; i += 1) {
    const a = i * Math.PI / 2;
    const x = Math.sin(a) * 3.10;
    const y = Math.cos(a) * 3.10;
    addCylinderZ(parent, 0.055, 0.045, physicalMaterial(0xd7b979, 0.18, 0.95), x, y, 0.86, 24);
    addCylinderZ(parent, 0.032, 0.025, jewel, x, y, 0.895, 24);
  }

  // The dial edge is visibly seated into a dark gasket and a warm-metal retaining lip.
  addRing(parent, 4.575, 0.045, stdMaterial(0x262e35, 0.32, 0.76), 0.70, 12, 192);
  addRing(parent, 4.60, 0.025, physicalMaterial(0xd3b16f, 0.17, 0.97), 0.78, 12, 192);
}

function createHand(length, width, style, material) {
  const shape = new THREE.Shape();
  if (style === 'hour') {
    shape.moveTo(0, -0.30);
    shape.quadraticCurveTo(-width * 0.95, -0.12, -width * 0.60, length * 0.63);
    shape.quadraticCurveTo(-width * 0.45, length * 0.88, 0, length);
    shape.quadraticCurveTo(width * 0.45, length * 0.88, width * 0.60, length * 0.63);
    shape.quadraticCurveTo(width * 0.95, -0.12, 0, -0.30);
  } else if (style === 'minute') {
    shape.moveTo(0, -0.36);
    shape.quadraticCurveTo(-width, -0.15, -width * 0.55, length * 0.82);
    shape.quadraticCurveTo(0, length, width * 0.55, length * 0.82);
    shape.quadraticCurveTo(width, -0.15, 0, -0.36);
  } else {
    shape.moveTo(-width * 0.58, -0.68);
    shape.lineTo(-width * 0.46, length - 0.28);
    shape.quadraticCurveTo(0, length, width * 0.46, length - 0.28);
    shape.lineTo(width * 0.58, -0.68);
    shape.closePath();
  }

  const depth = style === 'second' ? 0.035 : 0.075;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelSegments: 4,
    bevelSize: style === 'second' ? 0.009 : 0.022,
    bevelThickness: style === 'second' ? 0.008 : 0.018,
    curveSegments: 12
  });
  geometry.computeVertexNormals();
  const pivot = new THREE.Group();
  pivot.name = `${style} hand pivot`;
  pivot.position.z = style === 'hour' ? 0.99 : style === 'minute' ? 1.075 : 1.15;
  const body = addMesh(pivot, geometry, material, { z: -depth / 2 });
  body.name = `3D ${style} hand`;

  if (style !== 'second') {
    const channel = addMesh(pivot, new THREE.BoxGeometry(width * 0.17, length * 0.53, 0.014),
      physicalMaterial(style === 'hour' ? 0xf7e8bd : 0xdbe2e6, 0.18, 0.78),
      { x: 0, y: length * 0.48, z: depth * 0.55 });
    channel.name = `${style} hand inset`; 
  } else {
    addRing(pivot, 0.095, 0.018, physicalMaterial(0xc6935c, 0.2, 0.9), 0.025, 8, 40).position.y = -0.53;
    addCylinderZ(pivot, 0.042, 0.035, physicalMaterial(0xc6935c, 0.18, 0.94), 0, -0.53, 0.032, 24);
  }
  return pivot;
}

function addFrontHands(parent) {
  hands.hour = createHand(2.30, 0.18, 'hour', physicalMaterial(0xe1c17d, 0.18, 0.94));
  hands.minute = createHand(3.30, 0.125, 'minute', physicalMaterial(0xc5d0d5, 0.17, 0.92));
  hands.second = createHand(3.95, 0.038, 'second', physicalMaterial(0xb56c4b, 0.2, 0.86));
  parent.add(hands.hour, hands.minute, hands.second);

  addCylinderZ(parent, 0.27, 0.16, stdMaterial(0x3b3024, 0.22, 0.92), 0, 0, 1.04, 64);
  addCylinderZ(parent, 0.205, 0.12, physicalMaterial(0xd8b777, 0.15, 0.97), 0, 0, 1.15, 64);
  addRing(parent, 0.145, 0.022, stdMaterial(0x72562f, 0.22, 0.9), 1.225, 10, 64);
  addCylinderZ(parent, 0.078, 0.05, physicalMaterial(0x9b5155, 0.12, 0.28, { clearcoat: 1 }), 0, 0, 1.25, 32);
}

function addWatchLugs(parent) {
  const lugGold = physicalMaterial(0xb98f52, 0.23, 0.95);
  const lugHighlight = physicalMaterial(0xe5c987, 0.16, 0.97);
  const lugShape = new THREE.Shape();
  lugShape.moveTo(-0.30, -0.78);
  lugShape.quadraticCurveTo(-0.34, -0.40, -0.27, 0.18);
  lugShape.quadraticCurveTo(-0.23, 0.63, -0.12, 0.77);
  lugShape.lineTo(0.12, 0.77);
  lugShape.quadraticCurveTo(0.23, 0.63, 0.27, 0.18);
  lugShape.quadraticCurveTo(0.34, -0.40, 0.30, -0.78);
  lugShape.closePath();
  const lugGeometry = new THREE.ExtrudeGeometry(lugShape, {
    depth: 1.16,
    bevelEnabled: true,
    bevelSegments: 4,
    bevelSize: 0.055,
    bevelThickness: 0.045,
    curveSegments: 12
  });
  lugGeometry.computeVertexNormals();

  for (const side of [-1, 1]) {
    for (const xSide of [-1, 1]) {
      const lug = addMesh(parent, lugGeometry, lugGold, {
        x: xSide * 0.98,
        y: side * 5.20,
        z: -0.58
      });
      lug.name = side > 0 ? 'Upper integrated watch lug' : 'Lower integrated watch lug';
      addRing(parent, 0.105, 0.018, lugHighlight, side * 6.00, 8, 40).position.set(xSide * 0.98, side * 5.98, 0.02);
    }
    // The spring bar runs between the two lugs and is aligned with the strap axis.
    const springBar = addMesh(parent, cylinderZ(0.075, 0.075, 1.52, 32), stdMaterial(0x9da5a7, 0.2, 0.95), {
      x: 0,
      y: side * 5.98,
      z: 0.015
    }, { y: Math.PI / 2 });
    springBar.name = 'Strap spring bar';
    for (const xSide of [-1, 1]) {
      addCylinderZ(parent, 0.09, 0.08, lugHighlight, xSide * 0.72, side * 5.98, 0.015, 24);
    }
  }
}

function addCaseAndBezel(parent) {
  const caseGold = physicalMaterial(0xb88e50, 0.24, 0.94, {
    map: createFineBrushedTexture('#b18b50', 'rgba(255,241,205,.18)'), anisotropy: 0.7
  });
  const darkSteel = stdMaterial(0x2d343a, 0.28, 0.88);
  const brightGold = physicalMaterial(0xe6c987, 0.15, 0.97);
  const satinSteel = physicalMaterial(0x858d91, 0.34, 0.93, {
    map: createFineBrushedTexture('#90999b'), anisotropy: 0.65
  });

  // Hollow middle case: the rear aperture is a real opening, not a painted disc.
  const body = addMesh(parent, annularExtrudeGeometry(5.03, 3.98, 1.46, 0.035), caseGold, { z: 0 });
  body.name = 'Hollow machined watch middle — exhibition case aperture';
  addMesh(parent, annularExtrudeGeometry(5.00, 4.02, 0.12, 0.018), darkSteel, { z: 0.55 });
  addMesh(parent, annularExtrudeGeometry(4.98, 4.02, 0.10, 0.014), caseGold, { z: 0.66 });
  addMesh(parent, annularExtrudeGeometry(4.84, 4.02, 0.08, 0.012), satinSteel, { z: 0.75 });

  // Front bezel shoulders and a machined seat for the sapphire edge.
  addRing(parent, 4.95, 0.09, brightGold, 0.79, 16, 192);
  addRing(parent, 4.80, 0.047, darkSteel, 0.835, 12, 192);
  addRing(parent, 4.66, 0.042, brightGold, 0.86, 12, 192);
  addRing(parent, 4.57, 0.022, satinSteel, 0.875, 10, 192);

  // Raised, tapered-looking bezel wall reaches the crystal seat. This closes
  // the old visual gap so the sapphire is captured by the actual case rim.
  const bezelWall = addMesh(parent, annularExtrudeGeometry(4.88, 4.78, 0.40, 0.022), brightGold, { z: 1.11 });
  bezelWall.name = 'Raised sapphire retaining bezel — continuous metal seat';
  addRing(parent, 4.84, 0.026, satinSteel, 1.335, 10, 192);

  // Fine side fluting is cut into the case wall, not floating decoration.
  for (let i = 0; i < 72; i += 1) {
    const a = (i * Math.PI * 2) / 72;
    const x = Math.cos(a) * 5.015;
    const y = Math.sin(a) * 5.015;
    const groove = addMesh(parent, new THREE.BoxGeometry(0.026, 0.13, 0.20), brightGold, { x, y, z: 0.02 });
    groove.rotation.z = a + Math.PI / 2;
  }

  // Crown and tube are aligned through the 3 o'clock case wall.
  const stem = addMesh(parent, cylinderZ(0.10, 0.10, 0.60, 32), satinSteel, { x: 5.12, y: 0, z: 0.0 }, { y: Math.PI / 2 });
  stem.name = 'Crown stem through case tube';
  const crown = addMesh(parent, cylinderZ(0.34, 0.34, 0.55, 64), caseGold, { x: 5.38, y: 0, z: 0.0 }, { y: Math.PI / 2 });
  crown.name = 'Knurled winding crown';
  addMesh(parent, cylinderZ(0.27, 0.27, 0.09, 64), brightGold, { x: 5.69, y: 0, z: 0.0 }, { y: Math.PI / 2 });
  for (let i = 0; i < 28; i += 1) {
    const a = (i * Math.PI * 2) / 28;
    const rib = addMesh(parent, new THREE.BoxGeometry(0.42, 0.036, 0.042), darkSteel, {
      x: 5.37, y: Math.cos(a) * 0.327, z: Math.sin(a) * 0.327
    });
    rib.rotation.x = a;
  }
  const crownLip = addRing(parent, 0.25, 0.022, caseGold, 0.0, 10, 64);
  crownLip.position.set(5.73, 0, 0);
  crownLip.rotation.y = Math.PI / 2;

  addWatchLugs(parent);
  addRing(parent, 4.93, 0.065, satinSteel, -0.73, 14, 192);
  addRing(parent, 4.76, 0.045, caseGold, -0.75, 12, 192);
}
function createSapphireMaterial() {
  // Neutral sapphire: let the studio environment create reflections while the
  // transmission stays high enough to read the dial and movement through it.
  return new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.012,
    transmission: 0.995,
    thickness: 0.12,
    ior: 1.76,
    clearcoat: 0.28,
    clearcoatRoughness: 0.045,
    reflectivity: 0.24,
    specularIntensity: 0.72,
    attenuationColor: new THREE.Color(0xf5f9fd),
    attenuationDistance: 120,
    transparent: false,
    opacity: 1,
    side: THREE.FrontSide,
    envMapIntensity: 0.78
  });
}

function createDomeCrystalGeometry(radius, thickness = 0.12) {
  // Solid lens profile: a flat inner bearing face, a thick polished edge,
  // and a shallow convex outer dome. LatheGeometry makes the edge continuous.
  const points = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(radius - 0.18, 0),
    new THREE.Vector2(radius - 0.075, 0.002),
    new THREE.Vector2(radius - 0.032, 0.009),
    new THREE.Vector2(radius - 0.008, 0.026),
    new THREE.Vector2(radius, thickness * 0.42),
    new THREE.Vector2(radius - 0.035, thickness * 0.78),
    new THREE.Vector2(radius - 0.12, thickness),
    new THREE.Vector2(0, thickness)
  ];
  const geometry = new THREE.LatheGeometry(points, 256);
  geometry.rotateX(Math.PI / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function addFrontCrystal(parent) {
  const gasket = stdMaterial(0x20262b, 0.42, 0.18);
  const retainer = physicalMaterial(0xd7bd83, 0.17, 0.96);
  const edgeSteel = physicalMaterial(0x9ca5a8, 0.23, 0.94);

  // The gasket supports the crystal at its perimeter. The lens edge is wider
  // than the bezel aperture, so its shoulder is captured beneath the metal lip.
  addRing(parent, 4.675, 0.052, gasket, 1.245, 14, 224);
  const crystal = addMesh(parent, createDomeCrystalGeometry(4.70, 0.12), createSapphireMaterial(), { z: 1.245 });
  crystal.name = 'Front sapphire crystal — thick domed lens seated on compression gasket';
  crystal.renderOrder = 5;

  const captureLip = addMesh(parent, annularExtrudeGeometry(4.82, 4.625, 0.058, 0.012), retainer, { z: 1.34 });
  captureLip.name = 'Front crystal retaining lip — overlaps and captures sapphire edge';
  addRing(parent, 4.84, 0.018, edgeSteel, 1.365, 10, 224);
}

function addRearCaseback(parent) {
  const steel = physicalMaterial(0x899195, 0.29, 0.94, {
    map: createFineBrushedTexture('#8b969a', 'rgba(255,255,255,.17)'), anisotropy: 0.8
  });
  const dark = stdMaterial(0x202a32, 0.38, 0.42);
  const gold = physicalMaterial(0xc7a66a, 0.21, 0.94);

  // A true exhibition opening is cut into the caseback ring. Its inner lip
  // overlaps the sapphire edge instead of leaving the lens loose in the hole.
  const retainingRing = addMesh(parent, annularExtrudeGeometry(4.93, 3.62, 0.105, 0.02), steel, { z: -0.80 });
  retainingRing.name = 'Screw-down exhibition caseback — machined aperture and sapphire capture shoulder';
  addRing(parent, 4.84, 0.052, gold, -0.858, 12, 192);
  addRing(parent, 3.66, 0.045, dark, -0.842, 12, 192);
  addRing(parent, 3.60, 0.024, gold, -0.866, 10, 192);

  // Recessed screws secure the external caseback ring, not the glass itself.
  for (let i = 0; i < 10; i += 1) {
    const a = (i * Math.PI * 2) / 10;
    const x = Math.cos(a) * 4.37;
    const y = Math.sin(a) * 4.37;
    addScrew(parent, x, y, -0.8925, 0.085);
  }

  // A dark elastomer gasket bears the lens edge from inside; the sapphire
  // domed face points outward and its perimeter is trapped under the steel lip.
  addRing(parent, 3.72, 0.052, dark, -0.785, 14, 224);
  const rearCrystal = addMesh(parent, createDomeCrystalGeometry(3.73, 0.12), createSapphireMaterial(), { z: -0.79 });
  rearCrystal.rotation.x = Math.PI;
  rearCrystal.name = 'Rear sapphire exhibition crystal — seated, gasketed, and captured under caseback lip';
  rearCrystal.renderOrder = 5;
  addRing(parent, 3.70, 0.022, gold, -0.855, 10, 224);
}

function createEnvironment() {
  scene = new THREE.Scene();
  scene.background = null;

  camera = new THREE.PerspectiveCamera(35, 1, 0.1, 120);
  camera.position.set(6.2, 4.1, 22.8);
  camera.lookAt(0, 0, 0);

  document.body.classList.toggle('low-power-mode', !highQuality);
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: highQuality ? 'high-performance' : 'low-power',
    stencil: false,
    depth: true,
    preserveDrawingBuffer: false
  });
  renderer.setPixelRatio(getRenderPixelRatio());
  renderer.setSize(canvas.clientWidth || 1080, canvas.clientHeight || 740, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.transmissionResolutionScale = highQuality ? 0.75 : 0.45;
  // Shadows are the most expensive part of this scene; omit them in the default
  // lightweight profile and retain the baked lighting/reflections for shape cues.
  renderer.shadowMap.enabled = highQuality;
  renderer.shadowMap.type = highQuality ? THREE.PCFSoftShadowMap : THREE.BasicShadowMap;

  pmremGenerator = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const env = pmremGenerator.fromScene(room, 0.04);
  scene.environment = env.texture;
  room.dispose();
  pmremGenerator.dispose();
  pmremGenerator = null;

  scene.add(new THREE.HemisphereLight(0xf0f3f5, 0x50565b, 1.65));
  scene.add(new THREE.AmbientLight(0xffffff, 0.38));

  const frontKey = new THREE.DirectionalLight(0xffe6bd, 3.7);
  frontKey.position.set(-7, 9, 13);
  frontKey.castShadow = highQuality;
  const shadowResolution = highQuality ? (getRenderPixelRatio() >= 1.5 ? 1536 : 1024) : 512;
  frontKey.shadow.mapSize.set(shadowResolution, shadowResolution);
  frontKey.shadow.camera.left = -8;
  frontKey.shadow.camera.right = 8;
  frontKey.shadow.camera.top = 8;
  frontKey.shadow.camera.bottom = -8;
  frontKey.shadow.bias = -0.0002;
  frontKey.shadow.normalBias = 0.02;
  scene.add(frontKey);

  const frontFill = new THREE.DirectionalLight(0xc6ddf0, 1.8);
  frontFill.position.set(9, -4, 10);
  scene.add(frontFill);

  const rearKey = new THREE.DirectionalLight(0xf4e3c7, 4.2);
  rearKey.position.set(7, 8, -12);
  rearKey.castShadow = highQuality;
  rearKey.shadow.mapSize.set(shadowResolution, shadowResolution);
  rearKey.shadow.camera.left = -8;
  rearKey.shadow.camera.right = 8;
  rearKey.shadow.camera.top = 8;
  rearKey.shadow.camera.bottom = -8;
  rearKey.shadow.bias = -0.0002;
  rearKey.shadow.normalBias = 0.02;
  scene.add(rearKey);

  const rearFill = new THREE.DirectionalLight(0xc9e0f2, 2.6);
  rearFill.position.set(-9, -4, -11);
  scene.add(rearFill);

  const rimLight = new THREE.PointLight(0xffd58c, 20, 26, 2);
  rimLight.position.set(-8, 1, 4);
  scene.add(rimLight);
  const coolRim = new THREE.PointLight(0xa5c6df, 18, 24, 2);
  coolRim.position.set(8, 2, -5);
  scene.add(coolRim);

  if (highQuality) {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.ShadowMaterial({ color: 0x02060b, opacity: 0.26 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -5.3;
    ground.receiveShadow = true;
    scene.add(ground);
  }

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.055;
  controls.enablePan = false;
  controls.rotateSpeed = 0.72;
  controls.zoomSpeed = 0.82;
  controls.minDistance = 9.2;
  controls.maxDistance = 56;
  controls.minPolarAngle = 0.001;
  controls.maxPolarAngle = Math.PI - 0.001;
  controls.zoomToCursor = true;
  controls.target.set(0, 0, 0);
  controls.update();

  clockGroup = new THREE.Group();
  clockGroup.name = 'AURELION — Creative TNT — ETA 2824-2 architecture study';
  scene.add(clockGroup);
  addCaseAndBezel(clockGroup);
  addDialAssembly(clockGroup);
  addFrontHands(clockGroup);
  addFrontCrystal(clockGroup);
  addAutomaticMovement(clockGroup);
  addRearCaseback(clockGroup);

  resetViewButton?.addEventListener('click', resetView);
  zoomInButton?.addEventListener('click', () => changeZoom(0.84));
  zoomOutButton?.addEventListener('click', () => changeZoom(1.19));
  fullscreenButton?.addEventListener('click', toggleFullscreen);
  smoothQualityButton?.addEventListener('click', () => setRenderQuality(false));
  hdQualityButton?.addEventListener('click', () => setRenderQuality(true));
  viewer?.addEventListener('dblclick', toggleFullscreen);
  exportButton?.addEventListener('click', exportModelAsGLB);
  document.addEventListener('fullscreenchange', () => {
    resizeRenderer();
    const active = Boolean(document.fullscreenElement);
    if (fullscreenButton) {
      fullscreenButton.textContent = active ? '⤢' : '⛶';
      fullscreenButton.setAttribute('aria-label', active ? 'Thoát toàn màn hình' : 'Mở toàn màn hình');
      fullscreenButton.title = active ? 'Thoát toàn màn hình' : 'Mở toàn màn hình';
    }
  });
  window.addEventListener('keydown', handleViewerKeys);
  syncQualityButton();
  resizeObserver = new ResizeObserver(resizeRenderer);
  resizeObserver.observe(canvas.parentElement);
  window.addEventListener('resize', resizeRenderer, { passive: true });
}

function getRenderPixelRatio() {
  const deviceRatio = window.devicePixelRatio || 1;
  // HD renders at the screen's native pixel density (up to a modest cap); it
  // does not supersample excessively. MƯỢT deliberately lowers pixel density.
  const maxRatio = highQuality ? (LOW_POWER_DEFAULT ? 1.25 : 1.65) : 0.9;
  return Math.max(0.75, Math.min(deviceRatio, maxRatio));
}

function syncQualityButton() {
  if (smoothQualityButton) {
    smoothQualityButton.classList.toggle('is-active', !highQuality);
    smoothQualityButton.setAttribute('aria-pressed', String(!highQuality));
    smoothQualityButton.title = !highQuality ? 'Đang bật chế độ MƯỢT' : 'Chuyển sang chế độ MƯỢT để giảm tải đồ họa';
  }
  if (hdQualityButton) {
    hdQualityButton.classList.toggle('is-active', highQuality);
    hdQualityButton.setAttribute('aria-pressed', String(highQuality));
    hdQualityButton.title = highQuality ? 'Đang bật HD – độ nét ưu tiên' : 'Chuyển sang HD để tăng độ chi tiết';
  }
  document.body.classList.toggle('low-power-mode', !highQuality);
}

function changeZoom(factor) {
  if (!camera || !controls) return;
  const offset = camera.position.clone().sub(controls.target);
  const nextDistance = THREE.MathUtils.clamp(
    offset.length() * factor,
    controls.minDistance,
    controls.maxDistance
  );
  offset.setLength(nextDistance);
  camera.position.copy(controls.target).add(offset);
  camera.updateProjectionMatrix();
  controls.update();
}

async function toggleFullscreen() {
  if (!viewer) return;
  try {
    if (viewer.classList.contains('cinema-mode')) {
      viewer.classList.remove('cinema-mode');
      resizeRenderer();
      return;
    }
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (viewer.requestFullscreen) {
      await viewer.requestFullscreen();
    } else {
      viewer.classList.add('cinema-mode');
      resizeRenderer();
    }
  } catch (error) {
    console.warn('Fullscreen request was not permitted:', error);
  }
}

function setRenderQuality(enableHD) {
  if (highQuality === enableHD) return;
  highQuality = enableHD;
  if (renderer) {
    renderer.setPixelRatio(getRenderPixelRatio());
    renderer.transmissionResolutionScale = highQuality ? 0.75 : 0.45;
    renderer.shadowMap.enabled = highQuality;
    const shadowLights = scene.children.filter(child => child.isDirectionalLight);
    shadowLights.forEach(light => { light.castShadow = highQuality; });
    renderer.shadowMap.needsUpdate = true;
    resizeRenderer();
  }
  syncQualityButton();
}

function handleViewerKeys(event) {
  const tag = event.target?.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea' || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === '+' || event.key === '=') changeZoom(0.9);
  else if (event.key === '-' || event.key === '_') changeZoom(1.1);
  else if (event.key === '0') resetView();
  else if (event.key === 'f' || event.key === 'F') toggleFullscreen();
}

function exportModelAsGLB() {
  if (!clockGroup || !exportButton) return;
  exportButton.disabled = true;
  if (exportStatus) exportStatus.textContent = 'ĐANG XUẤT MÔ HÌNH 3D…';
  const exporter = new GLTFExporter();
  exporter.parse(
    clockGroup,
    binary => {
      const blob = new Blob([binary], { type: 'model/gltf-binary' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'AURELION_0.8_LUXURY_CLOCK.glb';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      exportButton.disabled = false;
      if (exportStatus) exportStatus.textContent = 'ĐÃ XUẤT GLB · MỞ BẰNG BLENDER HOẶC GAME ENGINE';
    },
    error => {
      console.error('GLB export failed:', error);
      exportButton.disabled = false;
      if (exportStatus) exportStatus.textContent = 'XUẤT GLB THẤT BẠI · KIỂM TRA CONSOLE';
    },
    { binary: true, onlyVisible: true, trs: false }
  );
}

function resetView() {
  if (!camera || !controls) return;
  camera.position.set(6.2, 4.1, 22.8);
  controls.target.set(0, 0, 0);
  controls.update();
}

function resizeRenderer() {
  if (!renderer || !camera) return;
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  renderer.setPixelRatio(getRenderPixelRatio());
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function zonedParts(date, timeZone) {
  let formatter = zonedFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('vi-VN', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    zonedFormatterCache.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    weekday: parts.weekday, hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second)
  };
}

function offsetLabel(date, timeZone) {
  let formatter = offsetFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, timeZoneName: 'longOffset', hour: '2-digit'
    });
    offsetFormatterCache.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(date);
  return parts.find(p => p.type === 'timeZoneName')?.value || 'GMT';
}

function updateClock(now) {
  const timeZone = timezoneSelect.value;
  const p = zonedParts(now, timeZone);
  const second = p.second + now.getMilliseconds() / 1000;
  const minute = p.minute + second / 60;
  const hour = (p.hour % 12) + minute / 60;

  hands.second.rotation.z = -(second * Math.PI / 30);
  hands.minute.rotation.z = -(minute * Math.PI / 30);
  hands.hour.rotation.z = -(hour * Math.PI / 6);

  // Mechanically linked display ratios: 80:20 × 60:20 × 40:20 = 24:1.
  // The escape wheel therefore turns 24 times per minute while the seconds wheel
  // makes one revolution per minute. A 20-tooth wheel at 24 rpm advances 8 teeth/s,
  // matching the 4 Hz balance frequency (two impulses per oscillation).
  const secondsAngle = hands.second.rotation.z;
  if (gearDrive.second) gearDrive.second.rotation.z = secondsAngle;
  if (gearDrive.thirdPinion) gearDrive.thirdPinion.rotation.z = -4 * secondsAngle;
  if (gearDrive.thirdWheel) gearDrive.thirdWheel.rotation.z = -4 * secondsAngle;
  if (gearDrive.intermediatePinion) gearDrive.intermediatePinion.rotation.z = 12 * secondsAngle;
  if (gearDrive.intermediateWheel) gearDrive.intermediateWheel.rotation.z = 12 * secondsAngle;
  if (gearDrive.escape) gearDrive.escape.rotation.z = -24 * secondsAngle;

  // Motion works: 12T:48T then 12T:36T = 12:1 overall.
  // The hour wheel is phase-locked to the actual hour hand so both remain aligned.
  const minuteAngle = hands.minute.rotation.z;
  if (gearDrive.minuteInput) gearDrive.minuteInput.rotation.z = minuteAngle;
  if (gearDrive.motionReduction) gearDrive.motionReduction.rotation.z = -(12 / 48) * minuteAngle;
  if (gearDrive.hourPinion) gearDrive.hourPinion.rotation.z = -(12 / 48) * minuteAngle;
  if (gearDrive.hourOutput) gearDrive.hourOutput.rotation.z = hands.hour.rotation.z;

  if (p.second !== lastUiSecond) {
    const pad = n => String(n).padStart(2, '0');
    digitalTime.textContent = `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
    dateLine.textContent = `${p.weekday}, ${pad(p.day)}/${pad(p.month)}/${p.year}`;
    zoneName.textContent = TIME_ZONES[timeZone] || timeZone;
    zoneOffset.textContent = offsetLabel(now, timeZone);
    lastUiSecond = p.second;
  }
}

const motionClock = new THREE.Clock();
function animate(timestamp = 0) {
  requestAnimationFrame(animate);
  // HD stays crisp but is capped at about 40 FPS on constrained integrated
  // graphics to limit heat. MƯỢT targets 30 FPS and lowers render resolution.
  const frameInterval = highQuality ? (LOW_POWER_DEFAULT ? 1000 / 40 : 0) : 1000 / 30;
  if (frameInterval > 0 && timestamp - lastRenderedAt < frameInterval) return;
  lastRenderedAt = timestamp;
  const delta = Math.min(motionClock.getDelta(), 0.04);
  elapsedTime += delta;
  updateClock(new Date());
  animatedParts.forEach(part => part.update(elapsedTime));
  controls.update();
  renderer.render(scene, camera);
}

function start() {
  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());
  if (!('WebGLRenderingContext' in window)) {
    statusLabel.innerHTML = '<span></span> TRÌNH DUYỆT KHÔNG HỖ TRỢ WEBGL';
    statusLabel.classList.add('is-error');
    return;
  }
  try {
    createEnvironment();
    statusLabel.innerHTML = '<span></span> REAL-TIME 3D · LUXURY WATCH STUDY';
    statusLabel.classList.add('is-ready');
    animate();
  } catch (error) {
    console.error('AURELION 3D startup error:', error);
    statusLabel.innerHTML = '<span></span> KHÔNG THỂ KHỞI TẠO 3D';
    statusLabel.classList.add('is-error');
  }
}

timezoneSelect.addEventListener('change', () => {
  lastUiSecond = -1;
  updateClock(new Date());
});

start();
