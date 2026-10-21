/* 좌표·기하·경로탐색 유틸 (외부 의존성 없음) */
(function () {
  'use strict';
  const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
  const R = 6371008.8;

  // 사이트 기준 국지 평면 투영 (위도 -25.25° 기준 등장방형, 10 km 범위 오차 < 0.1%)
  const LAT0 = -25.25;
  const KY = 111132.954 - 559.822 * Math.cos(2 * toRad(LAT0)) + 1.175 * Math.cos(4 * toRad(LAT0));
  const KX = 111412.84 * Math.cos(toRad(LAT0)) - 93.5 * Math.cos(3 * toRad(LAT0));
  const proj = (lat, lon) => [(lon + 67) * KX, (lat + 25.2) * KY];
  const unproj = (x, y) => [y / KY - 25.2, x / KX - 67];

  function haversine(a, b) {
    const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function bearing(a, b) {
    const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
    const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) - Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }
  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const compass8 = deg => COMPASS[Math.round(deg / 45) % 8];

  // 점-선분 투영 (평면 좌표)
  function projSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx, qy = ay + t * dy;
    return { t, x: qx, y: qy, d: Math.hypot(px - qx, py - qy) };
  }

  function pointInRing(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i], [yj, xj] = ring[j];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  // 폴리곤 경계 위 최근접점 [lat,lon] 과 거리(m)
  function nearestOnRing(lat, lon, ring) {
    const [px, py] = proj(lat, lon);
    let best = null;
    for (let i = 0; i < ring.length; i++) {
      const a = proj(...ring[i]), b = proj(...ring[(i + 1) % ring.length]);
      const r = projSeg(px, py, a[0], a[1], b[0], b[1]);
      if (!best || r.d < best.d) best = r;
    }
    return { point: unproj(best.x, best.y), d: best.d };
  }
  function centroid(ring) {
    let x = 0, y = 0;
    ring.forEach(p => { y += p[0]; x += p[1]; });
    return [y / ring.length, x / ring.length];
  }

  // ---- 데이터 파서 ----
  function parsePonds(raw) {
    return raw.split(';').filter(Boolean).map(r => {
      const [code, site, str, pond, area, ring] = r.split('|');
      const pts = ring.trim().split(' ').map(s => { const [x, y] = s.split(',').map(Number); return [y / 1e6 - 25.2, x / 1e6 - 67]; });
      return mkPond(code, site, str, pond, +area, pts);
    });
  }
  function mkPond(code, site, str, pond, area, ring) {
    const group = code.split('-')[0];
    return { id: 'pond:' + code, type: 'pond', name: code, code, site, group, string: str, pond, area_m2: area, ring, center: centroid(ring) };
  }
  function parseRoads(raw) {
    return raw.split(';').filter(Boolean).map((r, i) => {
      const [kind, name, s] = r.split('|');
      let x = 0, y = 0;
      const coords = s.trim().split(' ').map(p => { const [dx, dy] = p.split(',').map(Number); x += dx; y += dy; return [y / 1e5 - 25.2, x / 1e5 - 67]; });
      return { id: 'osm:' + i, kind, name, coords };
    });
  }

  const OFFW_BRIDGE = 2.5;
  // ---- 도로 그래프 ----
  function buildGraph(lines) {
    const nodes = [], adj = [], grid = new Map(), CELL = 4;
    const k = (a, b) => a + ',' + b;
    function addNode(x, y) {
      const ix = Math.floor(x / CELL), iy = Math.floor(y / CELL);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const arr = grid.get(k(ix + dx, iy + dy));
        if (arr) for (const id of arr) if (Math.hypot(nodes[id][0] - x, nodes[id][1] - y) <= 2.5) return id;
      }
      const id = nodes.length; nodes.push([x, y]); adj.push([]);
      const key = k(ix, iy); if (!grid.has(key)) grid.set(key, []); grid.get(key).push(id);
      return id;
    }
    function link(a, b) {
      if (a === b) return;
      const w = Math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1]);
      adj[a].push([b, w]); adj[b].push([a, w]);
    }
    const segs = [];
    lines.forEach((ln, li) => {
      let prev = null;
      for (const [lat, lon] of ln.coords) {
        const [x, y] = proj(lat, lon); const id = addNode(x, y);
        if (prev !== null && prev !== id) { link(prev, id); segs.push([prev, id, li]); }
        prev = id;
      }
    });
    // 선분 공간 인덱스 (100 m 셀)
    const SG = 100, sgrid = new Map();
    segs.forEach((s, si) => {
      const a = nodes[s[0]], b = nodes[s[1]];
      for (let gx = Math.floor(Math.min(a[0], b[0]) / SG); gx <= Math.floor(Math.max(a[0], b[0]) / SG); gx++)
        for (let gy = Math.floor(Math.min(a[1], b[1]) / SG); gy <= Math.floor(Math.max(a[1], b[1]) / SG); gy++) {
          const key = k(gx, gy); if (!sgrid.has(key)) sgrid.set(key, []); sgrid.get(key).push(si);
        }
    });
    // 1) 교차점 연결 (공유 노드 없이 X자로 교차하는 경우)
    const seen = new Set();
    for (const arr of sgrid.values()) {
      for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
        const s1 = segs[arr[i]], s2 = segs[arr[j]];
        if (s1[0] === s2[0] || s1[0] === s2[1] || s1[1] === s2[0] || s1[1] === s2[1]) continue;
        const pk = arr[i] < arr[j] ? arr[i] + '_' + arr[j] : arr[j] + '_' + arr[i];
        if (seen.has(pk)) continue; seen.add(pk);
        const p = nodes[s1[0]], p2 = nodes[s1[1]], q = nodes[s2[0]], q2 = nodes[s2[1]];
        const rx = p2[0] - p[0], ry = p2[1] - p[1], sx = q2[0] - q[0], sy = q2[1] - q[1];
        const den = rx * sy - ry * sx; if (Math.abs(den) < 1e-9) continue;
        const t = ((q[0] - p[0]) * sy - (q[1] - p[1]) * sx) / den, u = ((q[0] - p[0]) * ry - (q[1] - p[1]) * rx) / den;
        if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue;
        const id = addNode(p[0] + t * rx, p[1] + t * ry);
        link(id, s1[0]); link(id, s1[1]); link(id, s2[0]); link(id, s2[1]);
      }
    }
    // 2) 끊긴 끝점 → 25 m 이내 다른 도로에 접속 (T자 분기, GPS 궤적 끝단 보정)
    const SNAP = 25;
    for (let id = 0; id < nodes.length; id++) {
      if (adj[id].length !== 1) continue;
      const [x, y] = nodes[id];
      let best = null;
      for (let gx = Math.floor((x - SNAP) / SG); gx <= Math.floor((x + SNAP) / SG); gx++)
        for (let gy = Math.floor((y - SNAP) / SG); gy <= Math.floor((y + SNAP) / SG); gy++) {
          const arr = sgrid.get(k(gx, gy)); if (!arr) continue;
          for (const si of arr) {
            const s = segs[si]; if (s[0] === id || s[1] === id || s[0] === adj[id][0][0] || s[1] === adj[id][0][0]) continue;
            const a = nodes[s[0]], b = nodes[s[1]];
            const r = projSeg(x, y, a[0], a[1], b[0], b[1]);
            if (r.d <= SNAP && (!best || r.d < best.r.d)) best = { r, s };
          }
        }
      if (best) {
        const nid = addNode(best.r.x, best.r.y);
        link(id, nid); link(nid, best.s[0]); link(nid, best.s[1]);
      }
    }
    // 3) 끊긴 도로 조각 연결: 다른 연결요소의 가장 가까운 노드와 BRIDGE m 이내면 비도로 가중치로 연결
    const BRIDGE = 400;
    for (let iter = 0; iter < 6; iter++) {
      const comp = new Int32Array(nodes.length).fill(-1); let nc = 0; const size = [];
      for (let i = 0; i < nodes.length; i++) {
        if (comp[i] >= 0) continue; const st = [i]; comp[i] = nc; let sz = 0;
        while (st.length) { const v = st.pop(); sz++; for (const [w] of adj[v]) if (comp[w] < 0) { comp[w] = nc; st.push(w); } }
        size.push(sz); nc++;
      }
      if (nc <= 1) break;
      const main = size.indexOf(Math.max(...size));
      let changed = false;
      for (let c = 0; c < nc; c++) {
        if (c === main) continue;
        let best = null;
        for (let i = 0; i < nodes.length; i++) {
          if (comp[i] !== c) continue;
          for (let j = 0; j < nodes.length; j++) {
            if (comp[j] === c) continue;
            const d = Math.hypot(nodes[i][0] - nodes[j][0], nodes[i][1] - nodes[j][1]);
            if (d <= BRIDGE && (!best || d < best.d)) best = { i, j, d };
          }
        }
        if (best) { const w = best.d * OFFW_BRIDGE; adj[best.i].push([best.j, w]); adj[best.j].push([best.i, w]); segs.push([best.i, best.j, -1]); changed = true; }
      }
      if (!changed) break;
    }
    return { nodes, adj, segs };
  }

  function nearestSeg(g, x, y) {
    let best = null;
    for (const s of g.segs) {
      const a = g.nodes[s[0]], b = g.nodes[s[1]];
      const r = projSeg(x, y, a[0], a[1], b[0], b[1]);
      if (!best || r.d < best.d) best = { ...r, a: s[0], b: s[1] };
    }
    return best;
  }

  // 이진 힙 Dijkstra
  function dijkstra(g, seeds, targets) {
    const n = g.nodes.length, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
    const heap = [];
    const push = (d, v) => { heap.push([d, v]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    seeds.forEach(([v, d]) => { if (d < dist[v]) { dist[v] = d; push(d, v); } });
    const tset = new Map(targets.map(([v, d]) => [v, d]));
    let best = Infinity, bestNode = -1;
    while (heap.length) {
      const [d, v] = pop(); if (d > dist[v]) continue; if (d >= best) break;
      if (tset.has(v) && d + tset.get(v) < best) { best = d + tset.get(v); bestNode = v; }
      for (const [w, c] of g.adj[v]) { const nd = d + c; if (nd < dist[w]) { dist[w] = nd; prev[w] = v; push(nd, w); } }
    }
    if (bestNode < 0) return null;
    const path = []; for (let v = bestNode; v >= 0; v = prev[v]) path.push(v);
    return { cost: best, path: path.reverse() };
  }

  /* 경로 계산
   * from: [lat,lon], dest: {point:[lat,lon]} 또는 {ring:[...]} (Pond)
   * maxOff: 도로 접근 허용 최대 이탈 거리(m)
   */
  /* 알고리즘
   * 1) 현재 위치에서 가장 가까운 도로 지점으로 진입 (비도로 구간 1)
   * 2) 진입점에서 도달 가능한 모든 도로를 Dijkstra로 탐색
   * 3) 각 도로 선분마다 "도로거리 + 목적지까지 비도로거리 × OFFW" 비용을 계산해 최소 지점에서 하차 (비도로 구간 2)
   *    → 목적지 바로 옆 도로가 본선과 끊겨 있어도, 도달 가능한 도로 중 최적 하차점을 고름
   * 4) 직선 이동(비도로 × OFFW)이 더 유리하면 도로 경로를 쓰지 않음
   */
  // Pond 내부(염수)는 비도로 구간이 가로지를 수 없음 → 장애물
  function makeObstacles(ponds) {
    const edges = [];
    ponds.forEach(p => { const P = p.ring.map(q => proj(...q)); for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; edges.push([a[0], a[1], b[0], b[1], p.ring]); } });
    return { edges, rings: ponds.map(p => p.ring) };
  }
  function crosses(ob, x1, y1, x2, y2, skip) {
    if (!ob) return false;
    const rx = x2 - x1, ry = y2 - y1;
    for (const e of ob.edges) {
      if (skip.has(e[4])) continue;
      const sx = e[2] - e[0], sy = e[3] - e[1], den = rx * sy - ry * sx; if (Math.abs(den) < 1e-9) continue;
      const t = ((e[0] - x1) * sy - (e[1] - y1) * sx) / den, u = ((e[0] - x1) * ry - (e[1] - y1) * rx) / den;
      if (t > 0.002 && t < 0.998 && u > 0.002 && u < 0.998) return true;
    }
    return false;
  }
  const OFFW = 2.5; // 비도로 1 m 를 도로 2.5 m 로 간주 (험로·Pond 횡단 불가 고려)
  function route(g, from, dest, maxOff, ob) {
    if (!g || !g.segs.length) return null;
    const N = g.nodes;
    const [fx, fy] = proj(...from);
    const skip = new Set();
    if (dest.ring) skip.add(dest.ring);
    if (ob) ob.rings.forEach(r => { if (pointInRing(from[0], from[1], r)) skip.add(r); }); // 현재 위치가 속한 Pond 는 제외

    // 목적지까지 비도로 거리 함수: 점 목표 / 폰드(경계) 목표
    const ringP = dest.ring ? dest.ring.map(p => proj(...p)) : null;
    const [tx, ty] = dest.point ? proj(...dest.point) : [0, 0];
    function exitOn(ax, ay, bx, by) { // 선분 위 하차점과 비도로 거리
      if (!ringP) { const r = projSeg(tx, ty, ax, ay, bx, by); return { x: r.x, y: r.y, off: r.d, end: [tx, ty] }; }
      let best = null;
      for (let i = 0; i < ringP.length; i++) {
        const c = ringP[i], d = ringP[(i + 1) % ringP.length];
        const r1 = projSeg(c[0], c[1], ax, ay, bx, by), r2 = projSeg(d[0], d[1], ax, ay, bx, by);
        const r3 = projSeg(ax, ay, c[0], c[1], d[0], d[1]), r4 = projSeg(bx, by, c[0], c[1], d[0], d[1]);
        const cands = [
          { x: r1.x, y: r1.y, off: r1.d, end: c }, { x: r2.x, y: r2.y, off: r2.d, end: d },
          { x: ax, y: ay, off: r3.d, end: [r3.x, r3.y] }, { x: bx, y: by, off: r4.d, end: [r4.x, r4.y] },
        ];
        for (const k of cands) if (!best || k.off < best.off) best = k;
      }
      return best;
    }
    let directOff;
    if (ringP) directOff = pointInRing(from[0], from[1], dest.ring) ? 0 : nearestOnRing(from[0], from[1], dest.ring).d;
    else directOff = Math.hypot(tx - fx, ty - fy);

    // 진입 후보: maxOff 이내 모든 도로 선분 (가장 가까운 도로가 고립된 조각이어도 본선으로 진입 가능)
    const n = N.length, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
    const entryOf = new Array(n);
    const heap = [];
    const push = (d, v) => { heap.push([d, v]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    let best = null;
    const consider = (cost, via, entry, ex) => { if (ex.off > maxOff) return; if (best && cost >= best.cost) return; if (ex.off > 1 && crosses(ob, ex.x, ex.y, ex.end[0], ex.end[1], skip)) return; best = { cost, via, entry, ex }; };
    for (const sg of g.segs) {
      const A = N[sg[0]], B = N[sg[1]];
      const r = projSeg(fx, fy, A[0], A[1], B[0], B[1]);
      if (r.d > maxOff) continue;
      if (r.d > 1 && crosses(ob, fx, fy, r.x, r.y, skip)) continue;
      const entry = { x: r.x, y: r.y, d: r.d }, base = OFFW * r.d;
      for (const v of [sg[0], sg[1]]) {
        const c = base + Math.hypot(N[v][0] - r.x, N[v][1] - r.y);
        if (c < dist[v]) { dist[v] = c; prev[v] = -1; entryOf[v] = entry; push(c, v); }
      }
      // 같은 선분 위에서 바로 하차
      const ex = exitOn(A[0], A[1], B[0], B[1]);
      consider(base + Math.hypot(ex.x - r.x, ex.y - r.y) + OFFW * ex.off, -1, entry, ex);
    }
    if (!heap.length) return { ok: false, reason: 'far', offStart: nearestSeg(g, fx, fy).d };
    while (heap.length) {
      const [d, v] = pop(); if (d > dist[v]) continue;
      for (const [w, c] of g.adj[v]) { const nd = d + c; if (nd < dist[w]) { dist[w] = nd; prev[w] = v; entryOf[w] = entryOf[v]; push(nd, w); } }
    }
    for (const sg of g.segs) {
      const da = dist[sg[0]], db = dist[sg[1]]; if (!isFinite(da) && !isFinite(db)) continue;
      const A = N[sg[0]], B = N[sg[1]], ex = exitOn(A[0], A[1], B[0], B[1]);
      const ca = da + Math.hypot(A[0] - ex.x, A[1] - ex.y), cb = db + Math.hypot(B[0] - ex.x, B[1] - ex.y);
      const via = ca <= cb ? sg[0] : sg[1];
      consider(Math.min(ca, cb) + OFFW * ex.off, via, entryOf[via], ex);
    }
    if (!best) return { ok: false, reason: 'far', offStart: nearestSeg(g, fx, fy).d };
    // 비도로 직진이 허용 범위 안이고 더 유리하면 직진 안내
    let directOk = directOff <= maxOff;
    if (directOk && directOff > 1) {
      const dp = ringP ? proj(...nearestOnRing(from[0], from[1], dest.ring).point) : [tx, ty];
      directOk = !crosses(ob, fx, fy, dp[0], dp[1], skip);
    }
    if (directOk && best.cost >= OFFW * directOff) return { ok: false, reason: 'direct' };
    const path = []; for (let v = best.via; v >= 0; v = prev[v]) path.push(N[v]);
    path.reverse();
    const roadPts = [[best.entry.x, best.entry.y], ...path, [best.ex.x, best.ex.y]];
    let roadLen = 0; for (let i = 1; i < roadPts.length; i++) roadLen += Math.hypot(roadPts[i][0] - roadPts[i - 1][0], roadPts[i][1] - roadPts[i - 1][1]);
    const road = roadPts.map(p => unproj(p[0], p[1]));
    let endPt = unproj(best.ex.end[0], best.ex.end[1]);
    if (ringP && pointInRing(road[road.length - 1][0], road[road.length - 1][1], dest.ring)) endPt = road[road.length - 1];
    const offStart = best.entry.d, offEnd = best.ex.off;
    return { ok: true, road, offStart, offEnd, roadLen, total: offStart + roadLen + offEnd, startConn: [from, road[0]], endConn: [road[road.length - 1], endPt], endPt };
  }

  // 폴리라인 위 현재 위치 이후 남은 거리
  function remainingAlong(line, pos) {
    const [px, py] = proj(...pos); const P = line.map(p => proj(...p));
    let best = null;
    for (let i = 0; i < P.length - 1; i++) { const r = projSeg(px, py, P[i][0], P[i][1], P[i + 1][0], P[i + 1][1]); if (!best || r.d < best.d) best = { ...r, i }; }
    if (!best) return { rem: 0, off: Infinity };
    let rem = Math.hypot(P[best.i + 1][0] - best.x, P[best.i + 1][1] - best.y);
    for (let i = best.i + 1; i < P.length - 1; i++) rem += Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]);
    return { rem, off: best.d, idx: best.i, at: unproj(best.x, best.y) };
  }
  // 경로상 현재 위치에서 ahead(m) 앞의 점 → 진행 방향 안내용
  function pointAhead(line, pos, ahead) {
    const r = remainingAlong(line, pos); if (!isFinite(r.off)) return null;
    const P = line.map(p => proj(...p)); let [cx, cy] = proj(...r.at), left = ahead;
    for (let i = r.idx + 1; i < P.length; i++) {
      const seg = Math.hypot(P[i][0] - cx, P[i][1] - cy);
      if (seg >= left) { const t = left / seg; return unproj(cx + t * (P[i][0] - cx), cy + t * (P[i][1] - cy)); }
      left -= seg; [cx, cy] = P[i];
    }
    return line[line.length - 1];
  }

  // 단순화 (GPS 궤적 저장용)
  function simplify(coords, eps) {
    if (coords.length < 3) return coords.slice();
    const P = coords.map(c => proj(...c)), keep = new Array(coords.length).fill(false);
    keep[0] = keep[coords.length - 1] = true; const st = [[0, coords.length - 1]];
    while (st.length) {
      const [a, b] = st.pop(); let md = 0, mi = -1;
      for (let i = a + 1; i < b; i++) { const r = projSeg(P[i][0], P[i][1], P[a][0], P[a][1], P[b][0], P[b][1]); if (r.d > md) { md = r.d; mi = i; } }
      if (md > eps) { keep[mi] = true; st.push([a, mi], [mi, b]); }
    }
    return coords.filter((_, i) => keep[i]);
  }
  function lineLength(coords) { let s = 0; for (let i = 1; i < coords.length; i++) s += haversine(coords[i - 1], coords[i]); return s; }

  // 슬리피맵 타일 목록
  function tilesForBBox(s, w, n, e, z0, z1) {
    const out = [];
    for (let z = z0; z <= z1; z++) {
      const N = 2 ** z;
      const tx = lon => Math.floor((lon + 180) / 360 * N);
      const ty = lat => { const r = toRad(lat); return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N); };
      for (let x = tx(w); x <= tx(e); x++) for (let y = ty(n); y <= ty(s); y++) out.push([z, y, x]);
    }
    return out;
  }

  window.LPNGeo = { proj, unproj, haversine, bearing, compass8, pointInRing, nearestOnRing, centroid, parsePonds, mkPond, parseRoads, buildGraph, route, makeObstacles, remainingAlong, pointAhead, simplify, lineLength, tilesForBBox };
})();
