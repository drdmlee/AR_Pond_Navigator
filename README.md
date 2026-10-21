# AR_Pond_Navigator — Li-Pond 현장 내비게이션 (스마트폰 웹앱)

Hombre Muerto Li-Pond 현장용 위성지도 내비게이션. React + Leaflet, 빌드 도구 없이 정적 파일만으로 동작하며 PWA(홈 화면 설치·오프라인)를 지원.

## 1. 실행
| 환경 | 방법 | GPS |
|---|---|---|
| PC 테스트 | 폴더에서 `python -m http.server 8000` → `http://localhost:8000` | Chrome DevTools > Sensors로 위치 지정, 또는 앱 설정의 **시뮬레이션 모드** |
| 스마트폰 | **HTTPS** 서버에 폴더 그대로 업로드 (사내 웹서버, GitHub Pages, Netlify 등) | 동작 |
| 스마트폰 + `http://PC-IP` | 사용 불가 — 브라우저가 HTTP에서 GPS를 차단함 | ✕ |

폰에서 열고 브라우저 메뉴의 **홈 화면에 추가**를 누르면 앱처럼 실행됩니다.

## 2. 기능
- **위성지도 + Pond 93개**: Esri World Imagery(이 지역 실영상은 z17까지) 위에 사이트별 색상(CP1 하늘, CP2 청록, DP 노랑)으로 표시. z15 이상에서 Pond 코드 라벨 표시. Pond를 누르면 정보 + 목적지 설정.
- **목적지 드롭다운**: 근처 5곳(거리순) / 사용자 지점 / 구역별(CP1, CP2 PC·PL·RP, DP) Pond.
- **목적지 추가/삭제**: 지도 길게 누르기, 현재 위치 저장, 좌표 입력으로 추가. 사용자 지점은 삭제, 기본 Pond는 숨김·복원.
- **경로 안내**
  - 도로: OSM 도로 45개 스냅샷 내장(2026-10-22) + 온라인 시 최신 데이터 갱신
  - 임시 도로: **GPS 주행 기록** 또는 **위성사진 위에 직접 그리기**로 추가 → 경로탐색에 자동 포함
  - Pond 제방을 주행로로 간주(설정에서 끌 수 있음)
  - 비도로 구간은 Pond 내부를 가로지르지 않게 탐색. 도로가 불리하거나 없으면 직선 방위로 안내
  - Pond 도착 지점: 가장 가까운 제방(기본) 또는 중심
- **안내 표시**: 방향 화살표(이동 중에는 GPS 진행방향 기준, 정지 시 나침반 사용 가능), 경로/직선 거리, 예상 소요, 방위, GPS 정확도·속도·고도, 근처 Pond, 도착 시 진동.
- **현장 대응**: 오프라인 지도 저장(z12–17 약 1,700 타일), 화면 꺼짐 방지, GPS 정확도 경고, 기록 중 앱이 종료돼도 궤적 복구, 비상 위치 공유(좌표 + 지도 링크).
- **데이터**: 사용자 지점·내 도로·숨긴 Pond를 GeoJSON으로 내보내기/가져오기(다른 폰과 공유). HMI `/api/map/ponds` GeoJSON을 가져오면 Pond 데이터가 교체됨.
- **언어**: 한국어 / English / Español.

## 3. 파일 구조
```
index.html, manifest.webmanifest, sw.js   앱 진입점, PWA, 오프라인 캐시
css/app.css
js/app.js     UI (React + htm)
js/geo.js     좌표계·도로 그래프·경로탐색(Dijkstra)
js/i18n.js    다국어
js/ponds.js   Pond 93개 좌표 (HMI /api/map/ponds에서 추출, 원본과 SHA-256 일치 확인)
js/roads.js   OSM 도로 스냅샷 (ODbL)
lib/          React 18.3.1, Leaflet 1.9.4, htm 3.1.1 (로컬 포함 → CDN 불필요)
```

## 4. 운영 시 확인할 점
- **위성 영상 시점**: 영상 촬영일이 최신이 아닐 수 있습니다. 최근에 만든 임시 도로는 GPS 주행 기록으로 보완하세요.
- **OSM 도로**: 일부 track이 Pond 위를 지나는 등 현재 상태와 다를 수 있습니다(과거 기준으로 작성된 데이터).
- **제방 주행 가정**: 실제로 주행할 수 없는 제방이 있으면 설정에서 끄거나, 실제 주행로를 기록해 사용하세요.
- **Esri 타일 오프라인 저장**: Esri 이용약관 범위 안에서 사용하세요.
- **iOS**: 나침반은 설정에서 켤 때 권한을 요청합니다. 화면 꺼짐 방지는 iOS 16.4 이상에서 지원됩니다.
- **앱 갱신**: 파일을 바꾸면 `sw.js`의 `APP_CACHE` 버전(`lpn-app-v1`)을 올려야 폰에 확실히 반영됩니다.

## 5. GitHub Pages 배포 (수동)
1. GitHub에서 새 저장소 생성 (예: `AR_Pond_Navigator`)
2. 이 폴더의 파일 전체를 저장소 루트에 업로드 (`.nojekyll` 포함)
3. Settings → Pages → Source: `Deploy from a branch`, Branch: `main` / `(root)` → Save
4. 1–2분 후 `https://<계정>.github.io/AR_Pond_Navigator/` 접속 → 폰에서 "홈 화면에 추가"
> 공개 저장소의 Pages 사이트는 URL을 아는 누구나 접속할 수 있습니다. Pond 좌표가 포함되어 있으므로 공개 범위를 확인하세요.
