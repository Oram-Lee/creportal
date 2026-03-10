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

// ★ v4.8: StaticMap API + 빌딩 이모지 마커 캡처
export async function captureMap(idx, buildingName) {
    const coords = buildingCoords[idx];
    
    if (!coords || !coords.lat || !coords.lng) {
        alert('좌표 정보가 없어 캡처할 수 없습니다.');
        return;
    }
    
    // 카카오맵 API 키 가져오기
    const appKey = getKakaoAppKey();
    if (!appKey) {
        alert('카카오맵 API 키를 찾을 수 없습니다.');
        return;
    }
    
    // 캡처 버튼 상태 변경
    const mapContainer = document.getElementById(`kakaoMapContainer_${idx}`);
    const captureBtn = mapContainer?.parentElement?.querySelector('.capture-btn');
    if (captureBtn) {
        captureBtn.textContent = '⏳ 캡처 중...';
        captureBtn.disabled = true;
    }
    
    try {
        // StaticMap 이미지 URL 생성
        const width = 600;
        const height = 400;
        const level = 3;
        
        // 마커: 위치 + 빌딩 이모지 이미지
        const markerParam = `positions:${coords.lng} ${coords.lat},image:${encodeURIComponent(BUILDING_MARKER_IMAGE)}`;
        
        const staticMapUrl = `https://dapi.kakao.com/v2/maps/staticmap`
            + `?appkey=${appKey}`
            + `&center=${coords.lng},${coords.lat}`
            + `&width=${width}`
            + `&height=${height}`
            + `&level=${level}`
            + `&marker=${markerParam}`;
        
        console.log('[캡처] StaticMap URL 생성');
        
        // 이미지 다운로드 시도
        const response = await fetch(staticMapUrl);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const blob = await response.blob();
        
        // 파일명 생성
        const safeName = (buildingName || '지도').replace(/[^a-zA-Z0-9가-힣]/g, '_');
        const timestamp = new Date().toISOString().slice(0, 10);
        const filename = `${safeName}_location_${timestamp}.png`;
        
        // 다운로드
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        console.log('[캡처] 저장 완료:', filename);
        showToast && showToast('지도 캡처 완료', 'success');
        
    } catch (error) {
        console.error('[캡처] StaticMap 다운로드 실패:', error);
        
        // 폴백: 새 탭에서 열기
        const fallbackUrl = `https://map.kakao.com/link/map/${encodeURIComponent(buildingName || '위치')},${coords.lat},${coords.lng}`;
        
        const useNewTab = confirm(
            '직접 다운로드에 실패했습니다.\n' +
            '카카오맵을 새 탭에서 열까요?\n' +
            '(열린 페이지에서 직접 캡처해주세요)'
        );
        
        if (useNewTab) {
            window.open(fallbackUrl, '_blank');
        }
    } finally {
        // 버튼 복원
        if (captureBtn) {
            captureBtn.textContent = '📸 캡처';
            captureBtn.disabled = false;
        }
    }
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
