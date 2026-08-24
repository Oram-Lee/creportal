/**
 * CRE Portal - 카카오맵 관리
 */

import { state } from './portal-state.js';

// ★ PERF: idle 디바운스 타이머 (드래그·줌 연속 발생분을 하나로 묶는다)
let _idleTimer = null;
const IDLE_DEBOUNCE_MS = 120;

// 카카오맵 초기화
export function initKakaoMap() {
    if (typeof kakao === 'undefined') {
        document.getElementById('mapPlaceholder').innerHTML = 
            '<div class="icon">🗺️</div><p>카카오맵 API 키를 설정하세요</p>';
        return;
    }
    
    kakao.maps.load(() => {
        state.kakaoMap = new kakao.maps.Map(document.getElementById('kakaoMap'), {
            center: new kakao.maps.LatLng(37.5012, 127.0396),
            level: 5
        });
        
        document.getElementById('mapPlaceholder').style.display = 'none';
        
        state.clusterer = new kakao.maps.MarkerClusterer({
            map: state.kakaoMap,
            averageCenter: true,
            minLevel: 4,
            minClusterSize: 1,   // ★ 기본값 2 → 1개짜리도 기본 마커 대신 숫자 '1' 클러스터로 표시
            disableClickZoom: true,
            styles: [{
                width: '50px',
                height: '50px',
                background: 'rgba(37,99,235,0.8)',
                borderRadius: '50%',
                color: '#fff',
                textAlign: 'center',
                fontWeight: 'bold',
                lineHeight: '50px',
                fontSize: '14px'
            }]
        });
        
        kakao.maps.event.addListener(state.clusterer, 'clusterclick', c => 
            state.kakaoMap.setLevel(state.kakaoMap.getLevel() - 2, { anchor: c.getCenter() })
        );
        
        // ★ PERF: idle 이 드래그·줌마다 연속 발생하므로 디바운스로 묶는다
        kakao.maps.event.addListener(state.kakaoMap, 'idle', () => {
            clearTimeout(_idleTimer);
            _idleTimer = setTimeout(updateViewportBuildings, IDLE_DEBOUNCE_MS);
        });
        
        // 데이터가 이미 로드됐으면 마커 업데이트
        if (state.allBuildings.length > 0) {
            updateMapMarkers();
        }
    });
}

// ═══════════════════════════════════════════════════════════
// ★ PERF (2026-08-24): 마커 렌더링 재작성
//   기존: 호출될 때마다 전체 마커·오버레이를 파괴하고 다시 생성 →
//         지도를 조금만 움직여도 같은 자리 마커까지 전부 재생성
//   변경: id 기준 풀(pool)을 유지하고 화면에서 벗어난 것만 제거,
//         새로 들어온 것만 생성한다 (diff 렌더)
// ═══════════════════════════════════════════════════════════
const _ovPool = new Map();   // buildingId -> CustomOverlay (라벨 모드)
const _mkPool = new Map();   // buildingId -> Marker        (클러스터 모드)

/** 라벨 모드 상한 — 이보다 많으면 클러스터로 폴백해 DOM 폭증을 막는다 */
const LABEL_MAX = 250;
/** bounds 여유분 — 가장자리 마커가 잘리지 않게 */
const BOUNDS_PAD = 0.2;

function _clearPools() {
    _ovPool.forEach(o => o.setMap(null));
    _ovPool.clear();
    _mkPool.clear();
    state.clusterer && state.clusterer.clear();
}

/**
 * filteredBuildings 를 한 번만 순회해 두 목록을 동시에 만든다.
 *  - vp   : 화면 안(엄격) — 목록 패널용
 *  - draw : 화면 + 여유분  — 마커 렌더용
 * 기존에는 이 순회를 두 함수가 각각 돌아 2배로 걸렸다.
 */
function _computeLists() {
    const bounds = state.kakaoMap.getBounds && state.kakaoMap.getBounds();
    if (!bounds) {
        const all = state.filteredBuildings.filter(b => b.lat && b.lng);
        return { vp: all, draw: all };
    }
    const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
    const s0 = sw.getLat(), n0 = ne.getLat(), w0 = sw.getLng(), e0 = ne.getLng();
    const latPad = (n0 - s0) * BOUNDS_PAD, lngPad = (e0 - w0) * BOUNDS_PAD;
    const s1 = s0 - latPad, n1 = n0 + latPad, w1 = w0 - lngPad, e1 = e0 + lngPad;

    const vp = [], draw = [];
    const list = state.filteredBuildings;
    for (let i = 0; i < list.length; i++) {
        const b = list[i];
        const la = b.lat, ln = b.lng;
        if (!la || !ln) continue;
        if (la < s1 || la > n1 || ln < w1 || ln > e1) continue;
        draw.push(b);
        if (la >= s0 && la <= n0 && ln >= w0 && ln <= e0) vp.push(b);
    }
    return { vp, draw };
}

function _makeOverlay(b) {
    const hasData = b.hasData || b.hasVacancy;
    const isNew = b.isNew;
    const bgColor = isNew ? '#dc2626' : (hasData ? '#2563eb' : '#fff');
    const textColor = isNew ? '#fff' : (hasData ? '#fff' : '#333');
    const borderColor = isNew ? '#b91c1c' : (hasData ? '#1d4ed8' : '#d1d5db');
    const newBadge = isNew ?
        '<span style="position:absolute;top:-8px;right:-8px;background:#f59e0b;color:#fff;font-size:8px;font-weight:700;padding:2px 4px;border-radius:3px;">NEW</span>' : '';

    return new kakao.maps.CustomOverlay({
        position: new kakao.maps.LatLng(b.lat, b.lng),
        content: `<div class="map-marker-label" style="background:${bgColor};color:${textColor};border:2px solid ${borderColor};padding:4px 10px;border-radius:6px;font-size:11px;font-weight:600;box-shadow:0 2px 6px rgba(0,0,0,0.25);cursor:pointer;white-space:nowrap;position:relative;" onclick="window.openDetail('${b.id}')">
            ${newBadge}
            ${b.name || '이름없음'}
            <span onclick="event.stopPropagation(); window.openBuildingRoadview('${b.id}')" title="로드뷰 열기" style="margin-left:6px;padding-left:6px;border-left:1px solid ${borderColor};cursor:pointer;">🛣️</span>
            <div style="position:absolute;bottom:-8px;left:50%;transform:translateX(-50%);width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:8px solid ${borderColor};"></div>
            <div style="position:absolute;bottom:-5px;left:50%;transform:translateX(-50%);width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:6px solid ${bgColor};"></div>
        </div>`,
        yAnchor: 1.5
    });
}

function _makeMarker(b) {
    const m = new kakao.maps.Marker({ position: new kakao.maps.LatLng(b.lat, b.lng) });
    kakao.maps.event.addListener(m, 'click', () => window.openDetail(b.id));
    return m;
}

/**
 * 마커 렌더링.
 * @param {Array} [drawList] 이미 계산된 렌더 대상. 없으면 내부에서 계산한다.
 */
export function updateMapMarkers(drawList) {
    if (!state.kakaoMap || !state.clusterer) return;

    // 필터/데이터가 바뀌어 배열 자체가 교체됐으면 풀을 비우고 새로 그린다
    if (state._mapListRef !== state.filteredBuildings) {
        _clearPools();
        state._mapListRef = state.filteredBuildings;
    }

    const draw = drawList || _computeLists().draw;
    const showLabels = state.kakaoMap.getLevel() <= 3 && draw.length <= LABEL_MAX;

    // 표시 모드가 바뀌면 남아 있는 반대편 객체를 정리
    if (state._mapLabelMode !== showLabels) {
        _clearPools();
        state._mapLabelMode = showLabels;
    }

    const need = new Set();
    for (let i = 0; i < draw.length; i++) need.add(draw[i].id);

    if (showLabels) {
        // 화면에서 벗어난 것만 제거
        for (const [id, ov] of _ovPool) {
            if (!need.has(id)) { ov.setMap(null); _ovPool.delete(id); }
        }
        // 새로 들어온 것만 생성
        for (let i = 0; i < draw.length; i++) {
            const b = draw[i];
            if (_ovPool.has(b.id)) continue;
            const ov = _makeOverlay(b);
            ov.setMap(state.kakaoMap);
            _ovPool.set(b.id, ov);
        }
    } else {
        let changed = false;
        for (const id of [..._mkPool.keys()]) {
            if (!need.has(id)) { _mkPool.delete(id); changed = true; }
        }
        for (let i = 0; i < draw.length; i++) {
            const b = draw[i];
            if (_mkPool.has(b.id)) continue;
            _mkPool.set(b.id, _makeMarker(b));
            changed = true;
        }
        // 구성이 바뀐 경우에만 클러스터를 다시 계산한다
        if (changed) {
            state.clusterer.clear();
            state.clusterer.addMarkers([..._mkPool.values()]);
        }
    }

    // 외부에서 참조하는 기존 필드 유지
    state.customOverlays = [..._ovPool.values()];
    state.markers = [..._mkPool.values()];
}

// 뷰포트 내 빌딩 업데이트 — 목록 패널과 마커를 한 번의 순회로 함께 갱신
export function updateViewportBuildings() {
    if (!state.kakaoMap) return;

    const { vp, draw } = _computeLists();
    state.viewportBuildings = vp;

    if (state.currentListTab === 'viewport' && window.renderBuildingList) {
        window.renderBuildingList();
    }

    updateMapMarkers(draw);
}

// 줌 인
export function zoomIn() {
    if (state.kakaoMap) {
        state.kakaoMap.setLevel(state.kakaoMap.getLevel() - 1);
    }
}

// 줌 아웃
export function zoomOut() {
    if (state.kakaoMap) {
        state.kakaoMap.setLevel(state.kakaoMap.getLevel() + 1);
    }
}

// 지도 리셋
export function resetMap() {
    if (state.kakaoMap) {
        state.kakaoMap.setCenter(new kakao.maps.LatLng(37.5012, 127.0396));
        state.kakaoMap.setLevel(5);
    }
}

// 빌딩 위치로 이동
export function panToBuilding(b, keepLevel = false) {
    if (state.kakaoMap && b.lat && b.lng) {
        state.kakaoMap.setCenter(new kakao.maps.LatLng(b.lat, b.lng));
        if (!keepLevel && state.kakaoMap.getLevel() > 4) {
            state.kakaoMap.setLevel(3);
        }
    }
}

// 카카오맵 외부 링크 열기
export function openKakaoMap(name, lat, lng) {
    const url = `https://map.kakao.com/link/map/${encodeURIComponent(name)},${lat},${lng}`;
    window.open(url, '_blank');
}

// window에 등록
window.initKakaoMap = initKakaoMap;
window.updateMapMarkers = updateMapMarkers;
window.updateViewportBuildings = updateViewportBuildings;
window.zoomIn = zoomIn;
window.zoomOut = zoomOut;
window.resetMap = resetMap;
window.panToBuilding = panToBuilding;
window.openKakaoMap = openKakaoMap;
