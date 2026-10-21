/* Pond Navigator — React(htm) + Leaflet, 빌드 도구 없이 동작 */
(function () {
  'use strict';
  const { useState, useEffect, useRef, useMemo } = React;
  const html = htm.bind(React.createElement);
  const G = window.LPNGeo;
  const APP_VERSION = '1.0.0';

  // ---------- 저장소 ----------
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('lpn.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { if (v === undefined || v === null) localStorage.removeItem('lpn.' + k); else localStorage.setItem('lpn.' + k, JSON.stringify(v)); } catch (e) { /* 용량 초과 등 */ } },
  };
  function usePersist(k, d) {
    const [v, setV] = useState(() => LS.get(k, d));
    useEffect(() => { LS.set(k, v); }, [k, v]);
    return [v, setV];
  }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ---------- 상수 ----------
  const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const TILE_CACHE = 'lpn-tiles-v1';
  const OSM_BBOX = [-25.32, -67.06, -25.17, -66.90]; // s,w,n,e
  const SITE_COLORS = { CP1: '#38bdf8', CP2: '#2dd4bf', DP: '#fbbf24' };
  const ROAD_STYLE = {
    u: { color: '#fde047', weight: 3.5, opacity: 0.9 },
    t: { color: '#fde047', weight: 2.5, opacity: 0.85, dashArray: '7 5' },
    s: { color: '#fdba74', weight: 2.5, opacity: 0.85 },
    user: { color: '#22d3ee', weight: 4, opacity: 0.95 },
  };
  const DEFAULTS = {
    lang: 'ko', arriveRadius: 30, defSpeed: 20, keepAwake: true, pondTarget: 'edge', maxOff: 1500,
    showRoads: true, showLabels: true, compass: false, sim: false, zMin: 12, zMax: 17, dikes: true,
  };
  const BASE_PONDS = G.parsePonds(window.LPN_PONDS_RAW);
  const SNAP_ROADS = G.parseRoads(window.LPN_ROADS_RAW);

  const fmtDist = m => m == null || !isFinite(m) ? '—' : m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' km';
  const fmtTime = (sec, t) => { if (!isFinite(sec)) return '—'; const m = Math.round(sec / 60); return m < 60 ? Math.max(1, m) + ' ' + t('min') : Math.floor(m / 60) + t('hr') + ' ' + (m % 60) + t('min'); };
  const bboxOf = ponds => { let s = 90, w = 180, n = -90, e = -180; ponds.forEach(p => p.ring.forEach(([la, lo]) => { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); })); return [s, w, n, e]; };

  function App() {
    // ---------- 상태 ----------
    const [settings, setSettings] = usePersist('settings', DEFAULTS);
    const S = { ...DEFAULTS, ...settings };
    const setS = patch => setSettings(prev => ({ ...DEFAULTS, ...prev, ...patch }));
    const dict = window.LPN_I18N[S.lang] || window.LPN_I18N.ko;
    const t = k => dict[k] || window.LPN_I18N.ko[k] || k;

    const [pondOverride, setPondOverride] = usePersist('pondsOverride', null);
    const ponds = useMemo(() => pondOverride ? pondOverride.map(p => G.mkPond(p.code, p.site, p.string, p.pond, p.area_m2, p.ring)) : BASE_PONDS, [pondOverride]);
    const [customs, setCustoms] = usePersist('customs', []);
    const [hidden, setHidden] = usePersist('hidden', []);
    const [userRoads, setUserRoads] = usePersist('userRoads', []);
    const [osm, setOsm] = usePersist('osm', null);
    const osmLines = osm ? osm.lines : SNAP_ROADS;
    const [destId, setDestId] = usePersist('dest', '');
    const [routeOn, setRouteOn] = usePersist('routeOn', true);
    const [rec, setRec] = usePersist('rec', null);        // 기록 중 궤적 (앱 재시작 시 복구)
    const [draw, setDraw] = useState(null);
    const [pos, setPos] = useState(null);
    const [gps, setGps] = useState('wait');
    const [compassHdg, setCompassHdg] = useState(null);
    const [follow, setFollow] = useState(true);
    const [sheet, setSheet] = useState(null);
    const [tab, setTab] = useState('dest');
    const [modal, setModal] = useState(null);
    const [toast, setToast] = useState(null);
    const [busy, setBusy] = useState(null);
    const [dl, setDl] = useState(null);
    const [tileCount, setTileCount] = useState(null);
    const [filter, setFilter] = useState('');
    const [routeRes, setRouteRes] = useState(null);
    const dlAbort = useRef(false);
    const say = (msg, ms = 2600) => { setToast(msg); clearTimeout(say._t); say._t = setTimeout(() => setToast(null), ms); };

    const siteBBox = useMemo(() => { const [s, w, n, e] = bboxOf(ponds); return [s - 0.015, w - 0.015, n + 0.015, e + 0.015]; }, [ponds]);
    const dests = useMemo(() => [
      ...ponds,
      ...customs.map(c => ({ ...c, type: 'custom', center: [c.lat, c.lon] })),
    ], [ponds, customs]);
    const dest = dests.find(d => d.id === destId) || null;
    const here = pos ? [pos.lat, pos.lon] : null;

    // ---------- GPS ----------
    useEffect(() => {
      if (S.sim) { setGps('sim'); return; }
      if (!window.isSecureContext) { setGps('insecure'); return; }
      if (!navigator.geolocation) { setGps('unavailable'); return; }
      setGps('wait');
      const id = navigator.geolocation.watchPosition(p => {
        const c = p.coords;
        setPos({ lat: c.latitude, lon: c.longitude, acc: c.accuracy, alt: c.altitude, speed: c.speed, heading: c.heading, ts: p.timestamp });
        setGps('ok');
      }, err => {
        if (err.code === 1) setGps('denied'); else if (err.code === 2) setGps('unavailable');
      }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
      return () => navigator.geolocation.clearWatch(id);
    }, [S.sim]);

    // ---------- 나침반 ----------
    useEffect(() => {
      if (!S.compass) { setCompassHdg(null); return; }
      let last = 0, lastVal = null;
      const h = e => {
        let hd = null;
        if (typeof e.webkitCompassHeading === 'number') hd = e.webkitCompassHeading;
        else if (e.absolute && e.alpha != null) hd = (360 - e.alpha) % 360;
        if (hd == null) return;
        const so = (screen.orientation && screen.orientation.angle) || 0;
        hd = (hd + so + 360) % 360;
        const now = Date.now();
        if (now - last < 200 || (lastVal != null && Math.abs(((hd - lastVal + 540) % 360) - 180) < 2)) return;
        last = now; lastVal = hd; setCompassHdg(hd);
      };
      const evt = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
      window.addEventListener(evt, h);
      return () => window.removeEventListener(evt, h);
    }, [S.compass]);
    async function toggleCompass(on) {
      if (on && typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        try { const r = await DeviceOrientationEvent.requestPermission(); if (r !== 'granted') return; } catch (e) { return; }
      }
      setS({ compass: on });
    }

    // ---------- 화면 꺼짐 방지 ----------
    useEffect(() => {
      if (!S.keepAwake || !('wakeLock' in navigator)) return;
      let lock = null;
      const req = async () => { try { if (document.visibilityState === 'visible') lock = await navigator.wakeLock.request('screen'); } catch (e) { } };
      req();
      const v = () => { if (document.visibilityState === 'visible') req(); };
      document.addEventListener('visibilitychange', v);
      return () => { document.removeEventListener('visibilitychange', v); try { lock && lock.release(); } catch (e) { } };
    }, [S.keepAwake]);

    // ---------- GPS 주행 기록 ----------
    useEffect(() => {
      if (!rec || !pos || pos.acc > 30) return;
      const p = [pos.lat, pos.lon], last = rec[rec.length - 1];
      if (!last || G.haversine(last, p) >= 8) setRec(r => r ? [...r, p] : r);
    }, [pos]);
    function stopRec() {
      if (rec && rec.length >= 2) {
        const coords = G.simplify(rec, 3);
        setUserRoads(rs => [...rs, { id: 'u:' + uid(), name: 'GPS ' + new Date().toLocaleString(), coords, source: 'gps', created: Date.now() }]);
        say(t('save') + ' · ' + fmtDist(G.lineLength(coords)));
      }
      setRec(null);
    }
    function finishDraw() {
      if (draw && draw.length >= 2) {
        setUserRoads(rs => [...rs, { id: 'u:' + uid(), name: 'Road ' + new Date().toLocaleString(), coords: draw, source: 'draw', created: Date.now() }]);
        say(t('save') + ' · ' + fmtDist(G.lineLength(draw)));
      }
      setDraw(null);
    }

    // ---------- 도로 그래프 & 경로 ----------
    const dikeLines = useMemo(() => S.dikes ? ponds.map(p => ({ id: 'dike:' + p.code, kind: 'dike', coords: [...p.ring, p.ring[0]] })) : [], [ponds, S.dikes]);
    const graph = useMemo(() => G.buildGraph([...osmLines, ...userRoads, ...dikeLines]), [osmLines, userRoads, dikeLines]);
    const obstacles = useMemo(() => G.makeObstacles(ponds), [ponds]);
    const lastRoute = useRef({});
    useEffect(() => {
      if (!routeOn || !dest || !here) { setRouteRes(null); lastRoute.current = {}; return; }
      const L0 = lastRoute.current, key = [dest.id, S.maxOff, S.pondTarget].join('|');
      if (L0.key === key && L0.graph === graph && L0.pos && G.haversine(L0.pos, here) < 15) return;
      const target = dest.type === 'pond' && S.pondTarget === 'edge' ? { ring: dest.ring } : { point: dest.center };
      const r = G.route(graph, here, target, S.maxOff, obstacles);
      lastRoute.current = { key, graph, pos: here };
      setRouteRes(r);
    }, [pos, dest, graph, routeOn, S.maxOff, S.pondTarget]);

    // 목표 지점 (Pond: 가장 가까운 제방 또는 중심)
    const target = useMemo(() => {
      if (!dest) return null;
      if (routeRes && routeRes.ok) return routeRes.endPt;
      if (dest.type !== 'pond' || S.pondTarget === 'center' || !here) return dest.center;
      if (G.pointInRing(here[0], here[1], dest.ring)) return here;
      return G.nearestOnRing(here[0], here[1], dest.ring).point;
    }, [dest, pos, routeRes, S.pondTarget]);

    // ---------- 파생 값 ----------
    const straight = here && target ? G.haversine(here, target) : null;
    const insidePond = here && dest && dest.type === 'pond' && G.pointInRing(here[0], here[1], dest.ring);
    const arrived = straight != null && (straight <= S.arriveRadius || insidePond);
    const gpsHeading = pos && pos.speed != null && pos.speed >= 1.5 && pos.heading != null && !isNaN(pos.heading) ? pos.heading : null;
    const heading = gpsHeading != null ? gpsHeading : compassHdg;
    const guidePt = useMemo(() => {
      if (!here || !target) return null;
      if (routeRes && routeRes.ok) {
        if (routeRes.offStart > 30) return routeRes.road[0];
        return G.pointAhead([...routeRes.road, routeRes.endPt], here, 60) || target;
      }
      return target;
    }, [pos, target, routeRes]);
    const brg = here && guidePt ? G.bearing(here, guidePt) : null;
    const brgTarget = here && target ? G.bearing(here, target) : null;
    const arrowRot = brg == null ? 0 : heading != null ? brg - heading : brg;
    const remain = routeRes && routeRes.ok ? routeRes.total : straight;
    const spd = pos && pos.speed != null && pos.speed > 2 ? pos.speed : S.defSpeed / 3.6;
    const eta = remain != null ? remain / spd : null;
    const near = useMemo(() => {
      if (!here) return null;
      let best = null;
      for (const p of ponds) {
        if (G.pointInRing(here[0], here[1], p.ring)) return { p, d: 0, inside: true };
        const r = G.nearestOnRing(here[0], here[1], p.ring);
        if (!best || r.d < best.d) best = { p, d: r.d };
      }
      return best && best.d < 400 ? best : null;
    }, [pos, ponds]);

    // 도착 진동 알림
    const wasArrived = useRef(false);
    useEffect(() => {
      if (arrived && !wasArrived.current) { try { navigator.vibrate && navigator.vibrate([300, 150, 300]); } catch (e) { } }
      wasArrived.current = !!arrived;
    }, [arrived]);

    // ---------- 지도 ----------
    const mapDiv = useRef(null), mapRef = useRef(null), lay = useRef(null), me = useRef(null), H = useRef({});
    useEffect(() => {
      const map = L.map(mapDiv.current, { zoomControl: false, maxZoom: 19, worldCopyJump: false });
      mapRef.current = map;
      map.fitBounds(L.latLngBounds(ponds.flatMap(p => p.ring)), { padding: [20, 20] });
      L.tileLayer(TILE_URL, {
        maxNativeZoom: 17, maxZoom: 19, crossOrigin: 'anonymous',
        attribution: 'Imagery © Esri, Maxar, Earthstar Geographics · Roads © OpenStreetMap contributors',
      }).addTo(map);
      L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
      lay.current = {};
      ['ponds', 'roads', 'customs', 'route', 'work', 'dest', 'me'].forEach(k => { lay.current[k] = L.layerGroup().addTo(map); });
      map.on('click', e => H.current.onClick(e));
      map.on('contextmenu', e => H.current.onLong(e));
      map.on('dragstart', () => H.current.onDrag());
      const zc = () => map.getContainer().classList.toggle('z-labels', map.getZoom() >= 15);
      map.on('zoomend', zc); zc();
      return () => map.remove();
    }, []);

    H.current = {
      onClick(e) {
        const p = [e.latlng.lat, e.latlng.lng];
        if (draw) { setDraw(d => [...d, p]); return; }
        if (S.sim) {
          setPos(prev => ({ lat: p[0], lon: p[1], acc: 5, alt: 4000, speed: prev ? 5 : 0, heading: prev ? G.bearing([prev.lat, prev.lon], p) : null, ts: Date.now(), sim: true }));
        }
      },
      onLong(e) { if (!draw) setModal({ lat: e.latlng.lat.toFixed(6), lon: e.latlng.lng.toFixed(6), name: '', note: '' }); },
      onDrag() { setFollow(false); },
      onPondClick(p, e) {
        if (draw || S.sim) return H.current.onClick(e);
        const div = document.createElement('div'); div.className = 'pop';
        div.innerHTML = '<b></b><div class="pop-sub"></div>';
        div.querySelector('b').textContent = p.code;
        div.querySelector('.pop-sub').textContent = `${t('site')} ${p.site} · ${t('area')} ${(p.area_m2 / 10000).toFixed(1)} ha` + (here ? ` · ${fmtDist(G.nearestOnRing(here[0], here[1], p.ring).d)}` : '');
        const b = document.createElement('button'); b.textContent = t('setDest');
        b.onclick = () => { setDestId(p.id); mapRef.current.closePopup(); };
        div.appendChild(b);
        L.popup({ closeButton: false }).setLatLng(e.latlng).setContent(div).openOn(mapRef.current);
      },
      onCustomClick(c, e) {
        if (draw || S.sim) return H.current.onClick(e);
        const div = document.createElement('div'); div.className = 'pop';
        div.innerHTML = '<b></b><div class="pop-sub"></div>';
        div.querySelector('b').textContent = '★ ' + c.name;
        div.querySelector('.pop-sub').textContent = (c.note ? c.note + ' · ' : '') + c.lat.toFixed(5) + ', ' + c.lon.toFixed(5);
        const b = document.createElement('button'); b.textContent = t('setDest');
        b.onclick = () => { setDestId(c.id); mapRef.current.closePopup(); };
        div.appendChild(b);
        L.popup({ closeButton: false }).setLatLng(e.latlng).setContent(div).openOn(mapRef.current);
      },
    };

    // Pond 폴리곤
    useEffect(() => {
      const g = lay.current.ponds; g.clearLayers();
      ponds.forEach(p => {
        const col = SITE_COLORS[p.site] || '#a3e635', isD = p.id === destId, hid = hidden.includes(p.id);
        const poly = L.polygon(p.ring, {
          color: isD ? '#f472b6' : col, weight: isD ? 3.5 : 1.5, opacity: hid ? 0.35 : 0.95,
          fillColor: isD ? '#f472b6' : col, fillOpacity: hid ? 0.04 : isD ? 0.3 : 0.16, bubblingMouseEvents: false,
        });
        poly.bindTooltip(p.code.replace('CP2_', ''), { permanent: true, direction: 'center', className: 'pond-label' + (isD ? ' is-dest' : '') });
        poly.on('click', e => H.current.onPondClick(p, e));
        g.addLayer(poly);
      });
    }, [ponds, hidden, destId]);
    useEffect(() => { mapRef.current.getContainer().classList.toggle('labels-on', S.showLabels); }, [S.showLabels]);

    // 사용자 지점
    useEffect(() => {
      const g = lay.current.customs; g.clearLayers();
      customs.forEach(c => {
        const m = L.marker([c.lat, c.lon], {
          icon: L.divIcon({ className: 'cpin' + (c.id === destId ? ' is-dest' : ''), html: '<span>★</span><em></em>', iconSize: [28, 28], iconAnchor: [14, 14] }),
          bubblingMouseEvents: false,
        });
        m.on('add', () => { const el = m.getElement(); if (el) el.querySelector('em').textContent = c.name; });
        m.on('click', e => H.current.onCustomClick(c, e));
        g.addLayer(m);
      });
    }, [customs, destId]);

    // 도로
    useEffect(() => {
      const g = lay.current.roads; g.clearLayers();
      if (!S.showRoads) return;
      osmLines.forEach(r => g.addLayer(L.polyline(r.coords, { ...(ROAD_STYLE[r.kind] || ROAD_STYLE.u), interactive: false })));
      userRoads.forEach(r => g.addLayer(L.polyline(r.coords, { ...ROAD_STYLE.user, interactive: false })));
    }, [osmLines, userRoads, S.showRoads]);

    // 경로 / 목적지
    useEffect(() => {
      const g = lay.current.route, d = lay.current.dest; g.clearLayers(); d.clearLayers();
      if (!target) return;
      d.addLayer(L.marker(target, { interactive: false, icon: L.divIcon({ className: 'flag', html: '<div></div>', iconSize: [30, 30], iconAnchor: [4, 28] }) }));
      if (!here) return;
      g.addLayer(L.polyline([here, target], { color: '#fff', weight: 2, opacity: 0.8, dashArray: '4 8', interactive: false }));
      if (routeRes && routeRes.ok) {
        g.addLayer(L.polyline(routeRes.road, { color: '#111', weight: 9, opacity: 0.55, interactive: false }));
        g.addLayer(L.polyline(routeRes.road, { color: '#f0abfc', weight: 5.5, opacity: 1, interactive: false }));
        [routeRes.startConn, routeRes.endConn].forEach(c => g.addLayer(L.polyline(c, { color: '#f0abfc', weight: 4, opacity: 0.95, dashArray: '2 9', lineCap: 'round', interactive: false })));
      }
    }, [target, routeRes, pos]);

    // 내 위치
    useEffect(() => {
      const g = lay.current.me;
      if (!here) { g.clearLayers(); me.current = null; return; }
      if (!me.current) {
        const acc = L.circle(here, { radius: pos.acc || 0, color: '#60a5fa', weight: 1, fillOpacity: 0.12, interactive: false });
        const mk = L.marker(here, { interactive: false, zIndexOffset: 1000, icon: L.divIcon({ className: 'me', html: '<div class="me-dot"></div><div class="me-arrow"></div>', iconSize: [44, 44], iconAnchor: [22, 22] }) });
        g.addLayer(acc); g.addLayer(mk); me.current = { acc, mk };
        if (follow) mapRef.current.setView(here, Math.max(mapRef.current.getZoom(), 16));
      }
      me.current.acc.setLatLng(here).setRadius(pos.acc || 0);
      me.current.mk.setLatLng(here);
      const el = me.current.mk.getElement();
      if (el) { el.classList.toggle('has-hdg', heading != null); const a = el.querySelector('.me-arrow'); if (a) a.style.transform = `rotate(${heading || 0}deg)`; }
      if (follow) mapRef.current.panTo(here, { animate: true });
    }, [pos, heading]);

    // 기록/그리기 작업 레이어
    useEffect(() => {
      const g = lay.current.work; g.clearLayers();
      if (rec && rec.length) g.addLayer(L.polyline(rec, { color: '#f97316', weight: 4, interactive: false }));
      if (draw && draw.length) {
        g.addLayer(L.polyline(draw, { color: '#22d3ee', weight: 4, dashArray: '6 4', interactive: false }));
        draw.forEach(p => g.addLayer(L.circleMarker(p, { radius: 5, color: '#fff', weight: 2, fillColor: '#22d3ee', fillOpacity: 1, interactive: false })));
      }
    }, [rec, draw]);

    useEffect(() => { if (sheet === 'menu') refreshTileCount(); }, [sheet]);
    useEffect(() => { setTimeout(() => mapRef.current && mapRef.current.invalidateSize(), 50); }, [sheet]);

    // ---------- 동작 ----------
    function recenter() {
      setFollow(true);
      if (here) mapRef.current.setView(here, Math.max(mapRef.current.getZoom(), 16));
      else if (gps !== 'ok') say(t(gps === 'sim' ? 'simMode' : gps === 'insecure' ? 'gpsInsecure' : gps === 'denied' ? 'gpsDenied' : 'gpsWait'));
    }
    function overview() {
      setFollow(false);
      const pts = [...(here ? [here] : []), ...(target ? [target] : [])];
      if (routeRes && routeRes.ok) pts.push(...routeRes.road);
      if (pts.length >= 2) mapRef.current.fitBounds(L.latLngBounds(pts), { padding: [60, 60] });
      else mapRef.current.fitBounds(L.latLngBounds(ponds.flatMap(p => p.ring)), { padding: [20, 20] });
    }
    function chooseDest(id) {
      setDestId(id); setSheet(null);
      const d = dests.find(x => x.id === id);
      if (d && !here) mapRef.current.setView(d.center, 16);
      else if (d && here) setTimeout(overview, 50);
    }
    function saveModal() {
      const lat = parseFloat(modal.lat), lon = parseFloat(modal.lon);
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { say(t('lat') + '/' + t('lon') + ' ?'); return; }
      const name = (modal.name || '').trim() || `P ${lat.toFixed(4)},${lon.toFixed(4)}`;
      const c = { id: 'c:' + uid(), name, note: (modal.note || '').trim(), lat, lon, created: Date.now() };
      setCustoms(cs => [...cs, c]); setModal(null); say('★ ' + name);
    }
    function delCustom(id) { if (!confirm(t('confirmDel'))) return; setCustoms(cs => cs.filter(c => c.id !== id)); if (destId === id) setDestId(''); }
    function toggleHide(id) { setHidden(h => h.includes(id) ? h.filter(x => x !== id) : [...h, id]); }

    async function refreshOsm() {
      setBusy('osm');
      try {
        const [s, w, n, e] = OSM_BBOX;
        const q = `[out:json][timeout:60];way["highway"](${s},${w},${n},${e});out geom tags;`;
        const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const kind = { track: 't', unclassified: 'u', service: 's' };
        const lines = j.elements.filter(x => x.type === 'way' && x.geometry).map(w => ({
          id: 'osm:' + w.id, kind: kind[w.tags.highway] || 'u', name: w.tags.name || w.tags.ref || '',
          coords: G.simplify(w.geometry.map(g => [g.lat, g.lon]), 3),
        }));
        setOsm({ date: new Date().toISOString().slice(0, 10), lines });
        say(t('osmRoads') + ': ' + lines.length);
      } catch (e) { say('OSM: ' + e.message, 4000); }
      setBusy(null);
    }

    const tiles = useMemo(() => G.tilesForBBox(...siteBBox, S.zMin, S.zMax), [siteBBox, S.zMin, S.zMax]);
    async function refreshTileCount() {
      try { if (!('caches' in window)) return setTileCount(null); const c = await caches.open(TILE_CACHE); setTileCount((await c.keys()).length); } catch (e) { setTileCount(null); }
    }
    async function downloadTiles() {
      if (!('caches' in window) || !window.isSecureContext) { say(t('noSW'), 4000); return; }
      dlAbort.current = false;
      const cache = await caches.open(TILE_CACHE);
      let i = 0, done = 0, fail = 0; const total = tiles.length;
      setDl({ done, total, fail });
      const worker = async () => {
        while (i < total && !dlAbort.current) {
          const [z, y, x] = tiles[i++];
          const url = TILE_URL.replace('{z}', z).replace('{y}', y).replace('{x}', x);
          try {
            if (!(await cache.match(url, { ignoreVary: true }))) {
              const r = await fetch(url, { mode: 'cors' });
              if (r.ok) await cache.put(url, r.clone()); else fail++;
            }
          } catch (e) { fail++; }
          done++;
          if (done % 8 === 0 || done === total) setDl({ done, total, fail });
        }
      };
      await Promise.all([0, 1, 2, 3].map(worker));
      setDl(null); refreshTileCount();
      say(`${t('tilesCached')}: ${done - fail}/${total}`);
    }
    async function clearTiles() { if (!confirm(t('confirmDel'))) return; try { await caches.delete(TILE_CACHE); } catch (e) { } refreshTileCount(); }

    function exportData() {
      const fc = {
        type: 'FeatureCollection',
        lpn: { app: 'AR_Pond_Navigator', version: APP_VERSION, exported: new Date().toISOString(), hidden },
        features: [
          ...customs.map(c => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lon, c.lat] }, properties: { lpn: 'dest', name: c.name, note: c.note || '' } })),
          ...userRoads.map(r => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: r.coords.map(([a, b]) => [b, a]) }, properties: { lpn: 'road', name: r.name, source: r.source } })),
        ],
      };
      const blob = new Blob([JSON.stringify(fc, null, 1)], { type: 'application/geo+json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = 'pond-navi-' + new Date().toISOString().slice(0, 10) + '.geojson';
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
    function importFile(file) {
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const j = JSON.parse(rd.result);
          if (j.type !== 'FeatureCollection' || !Array.isArray(j.features)) throw new Error('GeoJSON FeatureCollection');
          const nc = [], nr = [], np = [];
          for (const f of j.features) {
            const g = f.geometry, p = f.properties || {}; if (!g) continue;
            if (g.type === 'Point') nc.push({ id: 'c:' + uid(), name: p.name || p.code || 'Point', note: p.note || '', lat: g.coordinates[1], lon: g.coordinates[0], created: Date.now() });
            else if (g.type === 'LineString') nr.push({ id: 'u:' + uid(), name: p.name || 'Road', coords: g.coordinates.map(([x, y]) => [y, x]), source: p.source || 'import', created: Date.now() });
            else if (g.type === 'MultiLineString') g.coordinates.forEach(ls => nr.push({ id: 'u:' + uid(), name: p.name || 'Road', coords: ls.map(([x, y]) => [y, x]), source: 'import', created: Date.now() }));
            else if ((g.type === 'Polygon' || g.type === 'MultiPolygon') && p.code) {
              let ring = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0];
              ring = ring.map(([x, y]) => [y, x]);
              if (ring.length > 3 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
              np.push({ code: p.code, site: p.site_code || p.site || p.code.split(/[-_]/)[0], string: p.string_code || '', pond: p.pond_code || '', area_m2: p.area_m2 || 0, ring });
            }
          }
          const key = c => c.name + '@' + c.lat.toFixed(6) + ',' + c.lon.toFixed(6);
          if (nc.length) setCustoms(cs => { const ks = new Set(cs.map(key)); return [...cs, ...nc.filter(c => !ks.has(key(c)))]; });
          if (nr.length) setUserRoads(rs => [...rs, ...nr]);
          if (np.length) setPondOverride(np);
          if (j.lpn && Array.isArray(j.lpn.hidden)) setHidden(h => [...new Set([...h, ...j.lpn.hidden])]);
          say(`${t('importDone')}: ★${nc.length} · ${t('tabRoads')} ${nr.length}` + (np.length ? ` · ${t('ponds')} ${np.length}` : ''), 4000);
        } catch (e) { say('Import: ' + e.message, 4000); }
      };
      rd.readAsText(file);
    }
    async function shareLoc() {
      if (!here) { say(t('gpsWait')); return; }
      const txt = `[Pond Navi] ${here[0].toFixed(6)}, ${here[1].toFixed(6)} (±${Math.round(pos.acc || 0)} m)` +
        (pos.alt != null ? `, alt ${Math.round(pos.alt)} m` : '') + ` · ${new Date(pos.ts).toLocaleString()}` +
        (near ? ` · ${near.inside ? t('inside') : t('near')} ${near.p.code}` : '') +
        `\nhttps://maps.google.com/?q=${here[0].toFixed(6)},${here[1].toFixed(6)}`;
      if (navigator.share) { try { await navigator.share({ text: txt }); return; } catch (e) { } }
      try { await navigator.clipboard.writeText(txt); say(t('copied')); } catch (e) { window.prompt('', txt); }
    }
    function resetAll() {
      if (!confirm(t('resetAll') + '?')) return;
      setCustoms([]); setHidden([]); setUserRoads([]); setOsm(null); setPondOverride(null); setDestId(''); setRec(null);
    }

    // ---------- 드롭다운 ----------
    const groups = useMemo(() => {
      const m = new Map();
      ponds.forEach(p => { if (hidden.includes(p.id) && p.id !== destId) return; if (!m.has(p.group)) m.set(p.group, []); m.get(p.group).push(p); });
      return [...m.entries()].map(([g, items]) => ({ g, items }));
    }, [ponds, hidden, destId]);
    const nearest = useMemo(() => {
      if (!here) return [];
      return dests.filter(d => !hidden.includes(d.id)).map(d => ({ d, m: d.type === 'pond' ? (G.pointInRing(here[0], here[1], d.ring) ? 0 : G.nearestOnRing(here[0], here[1], d.ring).d) : G.haversine(here, d.center) }))
        .sort((a, b) => a.m - b.m).slice(0, 5);
    }, [pos && Math.round(pos.lat * 2000), pos && Math.round(pos.lon * 2000), dests, hidden]);

    // ---------- 렌더 ----------
    const gpsMsg = { wait: 'gpsWait', denied: 'gpsDenied', insecure: 'gpsInsecure', unavailable: 'gpsUnavailable' }[gps];
    const routeNote = routeOn && dest && here && routeRes && !routeRes.ok && routeRes.reason !== 'direct' && !arrived ? t(routeRes.reason === 'far' ? 'noRoad' : 'disconnected') : null;
    const q = filter.trim().toUpperCase();

    return html`
      <div className=${'app' + (sheet ? ' sheet-open' : '')}>
        <div className="map" ref=${mapDiv}></div>

        <div className="top">
          <select className="dest-select" value=${destId} onChange=${e => chooseDest(e.target.value)} aria-label=${t('selectDest')}>
            <option value="">${t('selectDest')}</option>
            ${nearest.length > 0 && html`<optgroup label=${'📍 ' + t('near')}>
              ${nearest.map(({ d, m }) => html`<option key=${'n' + d.id} value=${d.id}>${(d.type === 'custom' ? '★ ' : '') + (d.code || d.name)} · ${fmtDist(m)}</option>`)}
            </optgroup>`}
            ${customs.length > 0 && html`<optgroup label=${'★ ' + t('custom')}>
              ${customs.map(c => html`<option key=${c.id} value=${c.id}>★ ${c.name}</option>`)}
            </optgroup>`}
            ${groups.map(({ g, items }) => html`<optgroup key=${g} label=${g.replace('_', ' · ')}>
              ${items.map(p => html`<option key=${p.id} value=${p.id}>${p.code}</option>`)}
            </optgroup>`)}
          </select>
          <button className="ibtn" onClick=${() => setSheet('menu')} aria-label=${t('menu')}>☰</button>
        </div>

        <div className="banners">
          ${gpsMsg && html`<div className=${'banner ' + (gps === 'wait' ? 'info' : 'warn')}>${t(gpsMsg)}</div>`}
          ${gps === 'sim' && html`<div className="banner sim">${t('simMode')}</div>`}
          ${pos && pos.acc > 50 && html`<div className="banner warn">${t('gpsWeak')} ±${Math.round(pos.acc)} m</div>`}
          ${rec && html`<div className="banner rec"><span className="dot"></span>${t('recording')} · ${fmtDist(G.lineLength(rec))}<button onClick=${stopRec}>${t('recStop')}</button></div>`}
          ${draw && html`<div className="banner draw">${t('drawHint')} (${draw.length})
            <button onClick=${() => setDraw(d => d.slice(0, -1))}>${t('drawUndo')}</button>
            <button onClick=${finishDraw}>${t('drawFinish')}</button>
            <button onClick=${() => setDraw(null)}>${t('cancel')}</button></div>`}
          ${routeNote && html`<div className="banner info">${routeNote}</div>`}
        </div>

        <div className="fabs">
          <button className=${'fab' + (follow ? ' on' : '')} onClick=${recenter} title=${t('recenter')}>◎</button>
          <button className=${'fab' + (routeOn ? ' on' : '')} onClick=${() => setRouteOn(!routeOn)} title=${t('routeOn')}>⤳</button>
          <button className="fab" onClick=${overview} title="Overview">⤢</button>
        </div>

        <div className=${'nav' + (arrived ? ' arrived' : '')}>
          ${dest ? html`
            <div className="nav-row">
              <div className="arrow-wrap" title=${heading != null ? t('relHeading') : t('absNorth')}>
                <svg className="arrow" viewBox="0 0 48 48" style=${{ transform: `rotate(${arrowRot}deg)` }}><path d="M24 3 L41 43 L24 34 L7 43 Z" /></svg>
                <span className="arrow-mode">${heading != null ? '▲' : 'N'}</span>
              </div>
              <div className="nav-main">
                <div className="nav-name">${dest.type === 'custom' ? '★ ' + dest.name : dest.code}
                  ${near && html`<span className="nav-near"> · ${near.inside ? t('inside') : t('near')} ${near.p.code.replace('CP2_', '')}</span>`}</div>
                ${arrived ? html`<div className="nav-big">🏁 ${t('arrived')}</div>` : html`
                  <div className="nav-big">${fmtDist(remain)}<small>${routeRes && routeRes.ok ? t('routeDist') : t('distance')}</small></div>
                  <div className="nav-sub">
                    ${routeRes && routeRes.ok && html`<span>${t('distance')} ${fmtDist(straight)}</span>`}
                    <span>${t('eta')} ${fmtTime(eta, t)}</span>
                    ${brgTarget != null && html`<span>${t('bearing')} ${Math.round(brgTarget)}° ${G.compass8(brgTarget)}</span>`}
                    ${routeRes && routeRes.ok && routeRes.offStart > 30 && html`<span className="warn-txt">${t('offroad')} ${fmtDist(routeRes.offStart)}</span>`}
                  </div>`}
              </div>
              <button className="ibtn sm" onClick=${() => setDestId('')} aria-label=${t('cancel')}>✕</button>
            </div>` : html`<div className="nav-empty">${t('noDest')}</div>`}
          <div className="nav-foot">
            <span>GPS ${pos ? '±' + Math.round(pos.acc || 0) + ' m' : '—'}</span>
            <span>${t('speed')} ${pos && pos.speed != null ? Math.round(pos.speed * 3.6) + ' km/h' : '—'}</span>
            <span>${t('altitude')} ${pos && pos.alt != null ? Math.round(pos.alt) + ' m' : '—'}</span>
            ${here && html`<span className="mono">${here[0].toFixed(5)}, ${here[1].toFixed(5)}</span>`}
          </div>
        </div>

        ${sheet && html`<div className="sheet-bg" onClick=${() => setSheet(null)}></div>
        <div className="sheet">
          <div className="tabs">
            ${['dest', 'roads', 'offline', 'settings', 'data'].map(k => html`<button key=${k} className=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${t('tab' + k[0].toUpperCase() + k.slice(1))}</button>`)}
            <button className="close" onClick=${() => setSheet(null)}>✕</button>
          </div>
          <div className="sheet-body">
            ${tab === 'dest' && html`
              <div className="btn-row">
                <button disabled=${!here} onClick=${() => { setModal({ lat: here[0].toFixed(6), lon: here[1].toFixed(6), name: '', note: '' }); }}>📍 ${t('addCurrent')}</button>
                <button onClick=${() => setModal({ lat: '', lon: '', name: '', note: '' })}>⌨ ${t('addCoord')}</button>
              </div>
              <p className="hint">💡 ${t('addHere')}: ${S.lang === 'ko' ? '지도를 길게 누르세요' : S.lang === 'es' ? 'mantenga presionado el mapa' : 'long-press the map'}</p>
              <h4>★ ${t('custom')} (${customs.length})</h4>
              ${customs.map(c => html`<div className="row" key=${c.id}>
                <div className="row-main" onClick=${() => chooseDest(c.id)}><b>${c.name}</b><small>${c.note ? c.note + ' · ' : ''}${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}${here ? ' · ' + fmtDist(G.haversine(here, [c.lat, c.lon])) : ''}</small></div>
                <button className="go" onClick=${() => chooseDest(c.id)}>➜</button>
                <button className="del" onClick=${() => delCustom(c.id)}>${t('del')}</button>
              </div>`)}
              <h4>${t('ponds')} (${ponds.length - hidden.length}/${ponds.length})
                ${hidden.length > 0 && html`<button className="link" onClick=${() => setHidden([])}>${t('restoreAll')}</button>`}</h4>
              <input className="search" placeholder=${t('filter')} value=${filter} onChange=${e => setFilter(e.target.value)} />
              ${ponds.filter(p => !q || p.code.toUpperCase().includes(q)).map(p => { const hid = hidden.includes(p.id); return html`<div className=${'row' + (hid ? ' dim' : '')} key=${p.id}>
                <div className="row-main" onClick=${() => !hid && chooseDest(p.id)}><b>${p.code}</b><small>${(p.area_m2 / 10000).toFixed(1)} ha${here ? ' · ' + fmtDist(G.nearestOnRing(here[0], here[1], p.ring).d) : ''}</small></div>
                ${!hid && html`<button className="go" onClick=${() => chooseDest(p.id)}>➜</button>`}
                <button className=${hid ? 'restore' : 'del'} onClick=${() => toggleHide(p.id)}>${hid ? t('restore') : t('del')}</button>
              </div>`; })}`}

            ${tab === 'roads' && html`
              <p className="hint">${t('roadHint')}</p>
              <label className="tog"><input type="checkbox" checked=${S.showRoads} onChange=${e => setS({ showRoads: e.target.checked })} /> ${t('showRoads')}</label>
              <label className="tog"><input type="checkbox" checked=${S.dikes} onChange=${e => setS({ dikes: e.target.checked })} /> ${t('useDikes')}</label>
              <div className="btn-row">
                ${rec ? html`<button className="danger" onClick=${stopRec}>■ ${t('recStop')}</button>` : html`<button onClick=${() => { setRec([]); setSheet(null); }}>● ${t('recStart')}</button>`}
                <button disabled=${!!draw} onClick=${() => { setDraw([]); setSheet(null); setFollow(false); }}>✎ ${t('drawStart')}</button>
              </div>
              <h4>${t('osmRoads')} · ${osmLines.length} <small>(${osm ? osm.date : t('snapshot') + ' ' + window.LPN_ROADS_SNAPSHOT_DATE})</small></h4>
              <div className="legend"><i className="lg u"></i>unclassified <i className="lg t"></i>track <i className="lg s"></i>service <i className="lg user"></i>${t('userRoads').split(' (')[0]}</div>
              <div className="btn-row"><button disabled=${busy === 'osm'} onClick=${refreshOsm}>⟳ ${busy === 'osm' ? t('refreshing') : t('refreshOsm')}</button></div>
              <h4>${t('userRoads')} (${userRoads.length})</h4>
              ${userRoads.map(r => html`<div className="row" key=${r.id}>
                <div className="row-main" onClick=${() => { mapRef.current.fitBounds(L.latLngBounds(r.coords), { padding: [40, 40] }); setFollow(false); setSheet(null); }}><b>${r.source === 'gps' ? '🛰 ' : r.source === 'draw' ? '✎ ' : '⇩ '}${r.name}</b><small>${fmtDist(G.lineLength(r.coords))} · ${r.coords.length} pts</small></div>
                <button className="del" onClick=${() => { if (confirm(t('confirmDel'))) setUserRoads(rs => rs.filter(x => x.id !== r.id)); }}>${t('del')}</button>
              </div>`)}`}

            ${tab === 'offline' && html`
              <p className="hint">${t('offlineInfo')}</p>
              <p className="hint small">${t('offlineLicense')}</p>
              <div className="field"><span>${t('zoomRange')}</span>
                <select value=${S.zMin} onChange=${e => setS({ zMin: +e.target.value })}>${[11, 12, 13, 14].map(z => html`<option key=${z} value=${z}>${z}</option>`)}</select> –
                <select value=${S.zMax} onChange=${e => setS({ zMax: +e.target.value })}>${[15, 16, 17].map(z => html`<option key=${z} value=${z}>${z}</option>`)}</select>
              </div>
              <p>${tiles.length} tiles · ≈ ${Math.round(tiles.length * 15 / 1024)} MB (est.)</p>
              <p>${t('tilesCached')}: ${tileCount == null ? '—' : tileCount}</p>
              ${dl ? html`<div className="prog"><div style=${{ width: (100 * dl.done / dl.total) + '%' }}></div><span>${t('downloading')} ${dl.done}/${dl.total}${dl.fail ? ' (fail ' + dl.fail + ')' : ''}</span></div>
                <div className="btn-row"><button onClick=${() => { dlAbort.current = true; }}>${t('cancel')}</button></div>`
                : html`<div className="btn-row"><button onClick=${downloadTiles}>⇩ ${t('download')}</button><button className="del" onClick=${clearTiles}>${t('clearTiles')}</button></div>`}`}

            ${tab === 'settings' && html`
              <div className="field"><span>${t('lang')}</span><select value=${S.lang} onChange=${e => setS({ lang: e.target.value })}><option value="ko">한국어</option><option value="en">English</option><option value="es">Español</option></select></div>
              <div className="field"><span>${t('pondTarget')}</span><select value=${S.pondTarget} onChange=${e => setS({ pondTarget: e.target.value })}><option value="edge">${t('pondEdge')}</option><option value="center">${t('pondCenter')}</option></select></div>
              <div className="field"><span>${t('arriveRadius')}</span><input type="number" min="5" max="500" value=${S.arriveRadius} onChange=${e => setS({ arriveRadius: Math.max(5, +e.target.value || 30) })} /></div>
              <div className="field"><span>${t('defSpeed')}</span><input type="number" min="5" max="80" value=${S.defSpeed} onChange=${e => setS({ defSpeed: Math.max(5, +e.target.value || 20) })} /></div>
              <div className="field"><span>${t('maxOff')}</span><input type="number" min="100" max="10000" step="100" value=${S.maxOff} onChange=${e => setS({ maxOff: Math.max(100, +e.target.value || 1500) })} /></div>
              <label className="tog"><input type="checkbox" checked=${S.showLabels} onChange=${e => setS({ showLabels: e.target.checked })} /> ${t('showLabels')}</label>
              <label className="tog"><input type="checkbox" checked=${S.keepAwake} onChange=${e => setS({ keepAwake: e.target.checked })} /> ${t('keepAwake')}</label>
              <label className="tog"><input type="checkbox" checked=${S.compass} onChange=${e => toggleCompass(e.target.checked)} /> ${t('compass')}</label>
              <label className="tog"><input type="checkbox" checked=${S.sim} onChange=${e => { setS({ sim: e.target.checked }); setPos(null); }} /> ${t('simMode')}</label>`}

            ${tab === 'data' && html`
              <p className="hint">${t('dataInfo')}</p>
              <div className="btn-row col">
                <button onClick=${shareLoc}>🆘 ${t('shareLoc')}</button>
                <button onClick=${exportData}>⇪ ${t('exportData')}</button>
                <label className="filebtn">⇩ ${t('importData')}<input type="file" accept=".geojson,.json,application/json" onChange=${e => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ''; }} /></label>
                ${pondOverride && html`<button onClick=${() => setPondOverride(null)}>↺ ${t('ponds')}: ${t('restore')} (93)</button>`}
                <button className="danger" onClick=${resetAll}>${t('resetAll')}</button>
              </div>
              <p className="hint small">AR_Pond_Navigator v${APP_VERSION} · ${t('ponds')} ${ponds.length}${pondOverride ? ' (import)' : ''} · Imagery © Esri · Roads © OpenStreetMap contributors (ODbL)</p>`}
          </div>
        </div>`}

        ${modal && html`<div className="modal-bg">
          <div className="modal">
            <h3>★ ${t('addHere')}</h3>
            <label>${t('name')}<input autoFocus value=${modal.name} onChange=${e => setModal({ ...modal, name: e.target.value })} /></label>
            <label>${t('note')}<input value=${modal.note} onChange=${e => setModal({ ...modal, note: e.target.value })} /></label>
            <div className="two">
              <label>${t('lat')}<input inputMode="decimal" value=${modal.lat} onChange=${e => setModal({ ...modal, lat: e.target.value })} /></label>
              <label>${t('lon')}<input inputMode="decimal" value=${modal.lon} onChange=${e => setModal({ ...modal, lon: e.target.value })} /></label>
            </div>
            <div className="btn-row"><button onClick=${() => setModal(null)}>${t('cancel')}</button><button className="primary" onClick=${saveModal}>${t('save')}</button></div>
          </div>
        </div>`}

        ${toast && html`<div className="toast">${toast}</div>`}
      </div>`;
  }

  ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
})();
