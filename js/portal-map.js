/**
 * CRE Portal - 카카오맵 관리
 */

import { state } from './portal-state.js';

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
        
        kakao.maps.event.addListener(state.kakaoMap, 'idle', updateViewportBuildings);
        
        // 데이터가 이미 로드됐으면 마커 업데이트
        if (state.allBuildings.length > 0) {
            updateMapMarkers();
        }
    });
}

// 마커 업데이트
export function updateMapMarkers() {
    if (!state.kakaoMap || !state.clusterer) return;
    
    state.clusterer.clear();
    state.customOverlays.forEach(o => o.setMap(null));
    state.customOverlays = [];
    state.markers = [];
    
    const showLabels = state.kakaoMap.getLevel() <= 3;
    
    // ★ 성능: 전체(수천 개) 대신 현재 지도 화면(bounds) 안의 빌딩만 그린다.
    //   드래그/줌마다 idle → updateViewportBuildings → updateMapMarkers 로 재호출되므로
    //   화면을 옮기면 자연스럽게 새 영역 마커가 다시 그려진다.
    //   가장자리에서 마커가 잘리지 않도록 bounds를 약간(20%) 확장한다.
    //   bounds를 못 구하면 기존 동작(전체)으로 안전하게 폴백한다.
    let drawList = state.filteredBuildings;
    const _bounds = state.kakaoMap.getBounds && state.kakaoMap.getBounds();
    if (_bounds) {
        const _sw = _bounds.getSouthWest(), _ne = _bounds.getNorthEast();
        const _latPad = (_ne.getLat() - _sw.getLat()) * 0.2;
        const _lngPad = (_ne.getLng() - _sw.getLng()) * 0.2;
        const _minLat = _sw.getLat() - _latPad, _maxLat = _ne.getLat() + _latPad;
        const _minLng = _sw.getLng() - _lngPad, _maxLng = _ne.getLng() + _lngPad;
        drawList = state.filteredBuildings.filter(b =>
            b.lat && b.lng &&
            b.lat >= _minLat && b.lat <= _maxLat &&
            b.lng >= _minLng && b.lng <= _maxLng
        );
    }
    
    drawList.forEach(b => {
        if (!b.lat || !b.lng) return;
        
        const pos = new kakao.maps.LatLng(b.lat, b.lng);
        
        if (showLabels) {
            const hasData = b.hasData || b.hasVacancy;
            const isNew = b.isNew;
            const bgColor = isNew ? '#dc2626' : (hasData ? '#2563eb' : '#fff');
            const textColor = isNew ? '#fff' : (hasData ? '#fff' : '#333');
            const borderColor = isNew ? '#b91c1c' : (hasData ? '#1d4ed8' : '#d1d5db');
            const newBadge = isNew ? 
                '<span style="position:absolute;top:-8px;right:-8px;background:#f59e0b;color:#fff;font-size:8px;font-weight:700;padding:2px 4px;border-radius:3px;">NEW</span>' : '';
            
            const ov = new kakao.maps.CustomOverlay({
                position: pos,
                content: `<div class="map-marker-label" style="background:${bgColor};color:${textColor};border:2px solid ${borderColor};padding:4px 10px;border-radius:6px;font-size:11px;font-weight:600;box-shadow:0 2px 6px rgba(0,0,0,0.25);cursor:pointer;white-space:nowrap;position:relative;" onclick="window.openDetail('${b.id}')">
                    ${newBadge}
                    ${b.name || '이름없음'}
                    <span onclick="event.stopPropagation(); window.openBuildingRoadview('${b.id}')" title="로드뷰 열기" style="margin-left:6px;padding-left:6px;border-left:1px solid ${borderColor};cursor:pointer;">🛣️</span>
                    <div style="position:absolute;bottom:-8px;left:50%;transform:translateX(-50%);width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:8px solid ${borderColor};"></div>
                    <div style="position:absolute;bottom:-5px;left:50%;transform:translateX(-50%);width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:6px solid ${bgColor};"></div>
                </div>`,
                yAnchor: 1.5
            });
            ov.setMap(state.kakaoMap);
            state.customOverlays.push(ov);
        } else {
            const m = new kakao.maps.Marker({ position: pos });
            kakao.maps.event.addListener(m, 'click', () => window.openDetail(b.id));
            state.markers.push(m);
        }
    });
    
    if (!showLabels) state.clusterer.addMarkers(state.markers);
}

// 뷰포트 내 빌딩 업데이트
export function updateViewportBuildings() {
    if (!state.kakaoMap) return;
    
    const bounds = state.kakaoMap.getBounds();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    
    state.viewportBuildings = state.filteredBuildings.filter(b =>
        b.lat && b.lng &&
        b.lat >= sw.getLat() && b.lat <= ne.getLat() &&
        b.lng >= sw.getLng() && b.lng <= ne.getLng()
    );
    
    if (state.currentListTab === 'viewport' && window.renderBuildingList) {
        window.renderBuildingList();
    }
    
    updateMapMarkers();
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
