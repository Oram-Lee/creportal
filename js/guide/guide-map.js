/**
 * Leasing Guide - 카카오맵
 * 자동 지도, 로드뷰 연동
 * v4.8 - StaticMap API + 빌딩 이모지 마커
 */

import { state } from './guide-state.js?v=5.1';
import { showToast } from './guide-utils.js?v=5.1';
// renderBuildingEditor는 window 객체를 통해 호출 (순환 의존성 방지)

// 카카오맵 인스턴스 저장
const kakaoMapInstances = {};

// 빌딩별 좌표 저장 (캡처 시 사용)
const buildingCoords = {};

// 빌딩 이모지 마커 이미지 (Twemoji CDN - 🏢)
const BUILDING_MARKER_IMAGE = 'https://twemoji.maxcdn.com/v/latest/72x72/1f3e2.png';

// 지도 모드 변경
export function setMapMode(idx, mode) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    item.mapMode = mode;
    const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
    window.renderBuildingEditor(item, building);
    
    // 자동 모드일 때 카카오맵 초기화
    if (mode === 'auto') {
        setTimeout(() => initBuildingKakaoMap(idx, building), 100);
    }
}

// 빌딩별 카카오맵 초기화
export function initBuildingKakaoMap(idx, building) {
    const containerId = `kakaoMapContainer_${idx}`;
    const container = document.getElementById(containerId);
    
    if (!container) {
        console.log('지도 컨테이너를 찾을 수 없습니다:', containerId);
        return;
    }
    
    if (typeof kakao === 'undefined' || !kakao.maps) {
        container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#94a3b8;font-size:11px;">카카오맵 로드 실패</div>';
        return;
    }
    
    // 좌표가 있으면 바로 지도 표시, 없으면 주소로 검색
    if (building.lat && building.lng) {
        // 좌표 저장
        buildingCoords[idx] = { lat: building.lat, lng: building.lng };
        renderKakaoMap(container, idx, building, building.lat, building.lng);
    } else if (building.address || building.roadAddress) {
        // 주소로 좌표 검색
        container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#94a3b8;font-size:11px;">🔍 주소 검색중...</div>';
        
        kakao.maps.load(() => {
            const geocoder = new kakao.maps.services.Geocoder();
            const address = building.address || building.roadAddress;
            
            geocoder.addressSearch(address, function(result, status) {
                if (status === kakao.maps.services.Status.OK && result.length > 0) {
                    const lat = parseFloat(result[0].y);
                    const lng = parseFloat(result[0].x);
                    
                    // 검색된 좌표 저장 (나중에 재사용)
                    building.lat = lat;
                    building.lng = lng;
                    buildingCoords[idx] = { lat, lng };
                    
                    // 로드뷰 버튼 추가
                    const locationDiv = document.getElementById(`locationMap_${idx}`);
                    if (locationDiv && !locationDiv.querySelector('.roadview-btn')) {
                        locationDiv.insertAdjacentHTML('beforeend', `
                            <button class="roadview-btn" onclick="event.stopPropagation(); openRoadview(${lat}, ${lng})" title="로드뷰 보기">👁️</button>
                        `);
                    }
                    
                    renderKakaoMap(container, idx, building, lat, lng);
                } else {
                    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#94a3b8;font-size:11px;text-align:center;">주소를 찾을 수<br>없습니다</div>';
                }
            });
        });
    } else {
        container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#94a3b8;font-size:11px;text-align:center;">주소 정보가<br>없습니다</div>';
    }
}

// 카카오맵 실제 렌더링
function renderKakaoMap(container, idx, building, lat, lng) {
    kakao.maps.load(() => {
        const buildingPos = new kakao.maps.LatLng(lat, lng);
        
        // 지도 옵션 - 레벨 3 (더 가까이)
        const mapOption = {
            center: buildingPos,
            level: 3
        };
        
        // 지도 생성
        const map = new kakao.maps.Map(container, mapOption);
        kakaoMapInstances[idx] = map;
        
        // 지도 타입 컨트롤 제거, 심플하게
        map.setMapTypeId(kakao.maps.MapTypeId.ROADMAP);
        
        // 커스텀 마커 (핑크/보라 계열)
        const markerContent = `
            <div style="position:relative;">
                <div style="
                    width: 28px;
                    height: 28px;
                    background: linear-gradient(135deg, #ec4899, #8b5cf6);
                    border-radius: 50% 50% 50% 0;
                    transform: rotate(-45deg);
                    box-shadow: 0 2px 6px rgba(236, 72, 153, 0.5);
                "></div>
                <div style="
                    position: absolute;
                    top: 6px;
                    left: 6px;
                    width: 16px;
                    height: 16px;
                    background: white;
                    border-radius: 50%;
                "></div>
            </div>
        `;
        
        const customOverlay = new kakao.maps.CustomOverlay({
            position: buildingPos,
            content: markerContent,
            yAnchor: 1.2
        });
        customOverlay.setMap(map);
    });
}

// 로드뷰 새 탭으로 열기
export function openRoadview(lat, lng) {
    const roadviewUrl = `https://map.kakao.com/link/roadview/${lat},${lng}`;
    window.open(roadviewUrl, '_blank');
}

// ★ v5.4: 자동 모드 지도 캡쳐 — 선택 영역 오버레이 방식
export function captureMap(idx, buildingName) {
    const mapContainer = document.getElementById(`kakaoMapContainer_${idx}`);
    if (!mapContainer) { showToast('지도 컨테이너를 찾을 수 없습니다', 'error'); return; }
    const coords = buildingCoords[idx];

    // 이미 오버레이가 열려있으면 닫기
    const existingOverlay = document.getElementById(`captureOverlay_${idx}`);
    if (existingOverlay) { existingOverlay.remove(); return; }

    const rect = mapContainer.getBoundingClientRect();
    const mapW = mapContainer.offsetWidth;
    const mapH = mapContainer.offsetHeight;

    // ── 선택 영역 오버레이 생성 ──────────────────────────────────────
    const overlay = document.createElement('div');
    overlay.id = `captureOverlay_${idx}`;
    overlay.style.cssText = `
        position:absolute; inset:0; z-index:9990;
        cursor:crosshair; user-select:none;
        background:rgba(0,0,0,0.25);
    `;

    // 선택 사각형
    const selection = document.createElement('div');
    selection.style.cssText = `
        position:absolute; border:2px dashed #fff;
        box-shadow:0 0 0 9999px rgba(0,0,0,0.35);
        pointer-events:none; display:none;
        box-sizing:border-box;
    `;
    overlay.appendChild(selection);

    // 안내 텍스트
    const guide = document.createElement('div');
    guide.textContent = '📐 드래그로 캡쳐 영역을 선택하세요   ESC: 취소';
    guide.style.cssText = `
        position:absolute; bottom:10px; left:50%; transform:translateX(-50%);
        background:rgba(0,0,0,0.75); color:#fff; font-size:12px;
        padding:6px 14px; border-radius:20px; white-space:nowrap; pointer-events:none;
    `;
    overlay.appendChild(guide);

    // 지도 컨테이너에 relative 포지션 설정
    const oldPosition = mapContainer.style.position;
    if (!oldPosition || oldPosition === 'static') mapContainer.style.position = 'relative';
    mapContainer.appendChild(overlay);

    let startX, startY, isDragging = false;

    const getLocal = (e) => {
        const r = mapContainer.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        return { x: Math.max(0, Math.min(mapW, clientX - r.left)), y: Math.max(0, Math.min(mapH, clientY - r.top)) };
    };

    const onDown = (e) => {
        e.preventDefault();
        const p = getLocal(e);
        startX = p.x; startY = p.y; isDragging = true;
        selection.style.display = 'block';
        selection.style.left = startX + 'px'; selection.style.top = startY + 'px';
        selection.style.width = '0'; selection.style.height = '0';
    };
    const onMove = (e) => {
        if (!isDragging) return;
        const p = getLocal(e);
        const x = Math.min(p.x, startX), y = Math.min(p.y, startY);
        const w = Math.abs(p.x - startX), h = Math.abs(p.y - startY);
        selection.style.left = x + 'px'; selection.style.top = y + 'px';
        selection.style.width = w + 'px'; selection.style.height = h + 'px';
    };
    const onUp = async (e) => {
        if (!isDragging) return;
        isDragging = false;
        const p = getLocal(e);
        const selX = Math.min(p.x, startX), selY = Math.min(p.y, startY);
        const selW = Math.abs(p.x - startX), selH = Math.abs(p.y - startY);
        cleanup();
        if (selW < 20 || selH < 20) { showToast('영역이 너무 작습니다. 다시 시도해 주세요.', 'warning'); return; }
        await cropAndSaveMap(idx, buildingName, coords, selX, selY, selW, selH, mapW, mapH);
    };

    const cleanup = () => {
        overlay.remove();
        if (!oldPosition || oldPosition === 'static') mapContainer.style.position = oldPosition || '';
        document.removeEventListener('keydown', onEsc);
    };
    const onEsc = (e) => { if (e.key === 'Escape') { cleanup(); showToast('캡쳐가 취소되었습니다', 'info'); } };

    overlay.addEventListener('mousedown', onDown);
    overlay.addEventListener('mousemove', onMove);
    overlay.addEventListener('mouseup', onUp);
    document.addEventListener('keydown', onEsc);
}

// ★ StaticMap API로 선택 영역 비율에 맞는 이미지 생성 후 저장 대화상자
async function cropAndSaveMap(idx, buildingName, coords, selX, selY, selW, selH, mapW, mapH) {
    const appKey = getKakaoAppKey();
    const mapInstance = kakaoMapInstances[idx];

    // StaticMap 출력 크기 (최대 800×600)
    const outW = Math.round(Math.min(800, selW * 2));
    const outH = Math.round(Math.min(600, selH * 2));

    // 선택 영역 중심점을 지도 픽셀 → 위경도 변환
    let centerLat = coords?.lat, centerLng = coords?.lng;
    if (mapInstance) {
        try {
            const cX = selX + selW / 2, cY = selY + selH / 2;
            const proj = mapInstance.getProjection();
            if (proj) {
                const offsetLatLng = proj.coordsFromPoint(new kakao.maps.Point(cX, cY));
                if (offsetLatLng) { centerLat = offsetLatLng.getLat(); centerLng = offsetLatLng.getLng(); }
            }
        } catch (_) { /* proj 실패 시 빌딩 좌표 사용 */ }
    }
    if (!centerLat || !centerLng) { showToast('좌표 정보가 없어 캡쳐할 수 없습니다', 'error'); return; }

    // 현재 지도 레벨 읽기
    const level = mapInstance ? mapInstance.getLevel() : 3;

    // 저장 선택 대화상자
    const safeName = (buildingName || '지도').replace(/[^a-zA-Z0-9가-힣]/g, '_');
    const timestamp = new Date().toISOString().slice(0, 10);
    const filename = `${safeName}_map_${timestamp}.png`;

    const modalId = `saveMapModal_${idx}_${Date.now()}`;
    document.body.insertAdjacentHTML('beforeend', `
        <div id="${modalId}" style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center;">
            <div style="background:#fff;border-radius:12px;padding:28px 32px;max-width:380px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,.35);">
                <div style="font-size:22px;text-align:center;margin-bottom:10px;">📸</div>
                <div style="font-size:15px;font-weight:600;text-align:center;color:#1e293b;margin-bottom:6px;">지도 캡쳐 저장</div>
                <div style="font-size:12px;color:#64748b;text-align:center;margin-bottom:22px;">${selW.toFixed(0)}×${selH.toFixed(0)}px 영역 → ${outW}×${outH}px 출력</div>
                <div style="display:flex;flex-direction:column;gap:8px;">
                    <button id="${modalId}_dl" style="padding:10px;border-radius:8px;background:#2563eb;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;">⬇️ 내 PC에 다운로드</button>
                    <button id="${modalId}_fb" style="padding:10px;border-radius:8px;background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0;font-size:13px;cursor:pointer;">☁️ Firebase Storage에 저장</button>
                    <button id="${modalId}_cancel" style="padding:8px;border-radius:8px;background:transparent;color:#94a3b8;border:none;font-size:12px;cursor:pointer;">취소</button>
                </div>
            </div>
        </div>
    `);

    const closeModal = () => document.getElementById(modalId)?.remove();

    // ★ CORS 해결: 브라우저에서 직접 dapi.kakao.com fetch 불가 → Flask 프록시 경유
    const API_BASE = window.CONFIG?.API_BASE || 'https://portal-dsyl.onrender.com';
    const fetchImage = async () => {
        const res = await fetch(`${API_BASE}/api/kakao-staticmap-proxy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                appkey: appKey,
                lat: centerLat,
                lng: centerLng,
                width: outW,
                height: outH,
                level: level
            })
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`프록시 HTTP ${res.status}: ${errText}`);
        }
        return res.blob();
    };

    document.getElementById(`${modalId}_dl`).onclick = async () => {
        closeModal();
        try {
            const blob = await fetchImage();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename;
            document.body.appendChild(a); a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast('지도 이미지가 다운로드되었습니다', 'success');
        } catch (err) {
            console.error('[캡쳐] 다운로드 실패:', err);
            showToast('다운로드에 실패했습니다. StaticMap API 키를 확인해주세요.', 'error');
        }
    };

    document.getElementById(`${modalId}_fb`).onclick = async () => {
        closeModal();
        try {
            const blob = await fetchImage();
            if (typeof window.uploadToFirebaseStorage === 'function') {
                const dlUrl = await window.uploadToFirebaseStorage(blob, `maps/${filename}`);

                // ★ 저장된 이미지 URL을 item.mapImage에 반영
                const item = state.tocItems[idx];
                if (item) {
                    item.mapImage = dlUrl;
                    // 수동 모드로 전환 (이미지가 location 영역에 표시되도록)
                    item.mapMode = 'manual';
                }

                // ★ building.images.location에도 반영 (출력 페이지 대비)
                const bId = item?.buildingId;
                const building = bId ? state.allBuildings.find(b => b.id === bId) : null;
                if (building) {
                    if (!building.images) building.images = {};
                    building.images.location = dlUrl;
                }

                // ★ 편집 화면 재렌더 (수동 모드 + 이미지 즉시 표시)
                if (item && building) {
                    window.renderBuildingEditor(item, building);
                }

                showToast('지도 캡쳐가 저장되었습니다. 수동 모드로 전환됩니다.', 'success');
                console.log('[캡쳐] Storage URL:', dlUrl);
            } else {
                // fallback: 다운로드로 대체
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = filename;
                document.body.appendChild(a); a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                showToast('Storage 함수 없음 — PC에 다운로드했습니다', 'warning');
            }
        } catch (err) {
            console.error('[캡쳐] Storage 저장 실패:', err);
            showToast('Storage 저장에 실패했습니다', 'error');
        }
    };

    document.getElementById(`${modalId}_cancel`).onclick = closeModal;
}

// 카카오맵 API 키 추출
function getKakaoAppKey() {
    // 1. 전역 변수에서 찾기
    if (window.KAKAO_MAP_KEY) return window.KAKAO_MAP_KEY;
    if (window.KAKAO_APP_KEY) return window.KAKAO_APP_KEY;
    if (window.kakaoMapKey) return window.kakaoMapKey;
    
    // 2. script 태그에서 추출
    const scripts = document.querySelectorAll('script[src*="dapi.kakao.com"]');
    for (const script of scripts) {
        const src = script.src;
        const match = src.match(/appkey=([^&]+)/);
        if (match) {
            return match[1];
        }
    }
    
    // 3. 환경변수나 config에서 (커스텀)
    if (window.ENV?.KAKAO_MAP_KEY) return window.ENV.KAKAO_MAP_KEY;
    
    return null;
}

// 전역 함수 등록
export function registerMapFunctions() {
    window.setMapMode = setMapMode;
    window.openRoadview = openRoadview;
    window.captureMap = captureMap;
}
