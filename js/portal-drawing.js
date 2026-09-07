/**
 * CRE Portal - 도형 검색 모듈
 * 사각형, 원, 다각형으로 영역 선택 후 빌딩 검색
 */

import { state } from './portal-state.js';
import { showToast } from './portal-utils.js';

// 도형 검색 상태
const drawingState = {
    manager: null,
    currentOverlay: null,
    drawingMode: null,      // 'rectangle', 'circle', 'polygon', null
    currentShape: null,     // ★ v4.6: 정규화된 도형 { kind, contains(lat,lng) }
    selectedBuildings: [],
    isToolsVisible: false
};

// DrawingManager 초기화
export function initDrawingManager() {
    if (!state.kakaoMap) {
        console.warn('카카오맵이 초기화되지 않았습니다.');
        return;
    }
    
    // drawing 라이브러리 로드 확인
    if (!kakao.maps.drawing) {
        console.warn('카카오맵 drawing 라이브러리가 필요합니다.');
        showToast('도형 검색을 사용하려면 drawing 라이브러리가 필요합니다.', 'warning');
        return;
    }
    
    drawingState.manager = new kakao.maps.drawing.DrawingManager({
        map: state.kakaoMap,
        drawingMode: [
            kakao.maps.drawing.OverlayType.RECTANGLE,
            kakao.maps.drawing.OverlayType.CIRCLE,
            kakao.maps.drawing.OverlayType.POLYGON
        ],
        guideTooltip: ['draw', 'drag'],
        rectangleOptions: {
            draggable: false,
            removable: false,
            editable: false,
            strokeWeight: 2,
            strokeColor: '#2563eb',
            strokeOpacity: 0.9,
            strokeStyle: 'solid',
            fillColor: '#2563eb',
            fillOpacity: 0.2
        },
        circleOptions: {
            draggable: false,
            removable: false,
            editable: false,
            strokeWeight: 2,
            strokeColor: '#dc2626',
            strokeOpacity: 0.9,
            strokeStyle: 'solid',
            fillColor: '#dc2626',
            fillOpacity: 0.2
        },
        polygonOptions: {
            draggable: false,
            removable: false,
            editable: false,
            strokeWeight: 2,
            strokeColor: '#16a34a',
            strokeOpacity: 0.9,
            strokeStyle: 'solid',
            fillColor: '#16a34a',
            fillOpacity: 0.2
        }
    });
    
    // 도형 완성 이벤트
    drawingState.manager.addListener('drawend', (data) => {
        // ★ v4.6: SDK 버전에 따라 drawend 가 넘겨주는 형태가 다르다.
        // data.target 이 오버레이 객체인 경우도 있고, 좌표만 오는 경우도 있다.
        // 어느 쪽이든 동작하도록 도형을 정규화해서 보관한다.
        drawingState.currentOverlay = data?.target || null;
        drawingState.currentShape = normalizeShape(data, drawingState.currentOverlay);

        console.log('[drawing] 도형 완성:', data?.overlayType,
            drawingState.currentShape ? drawingState.currentShape.kind : '판정 불가');

        if (!drawingState.currentShape) {
            console.warn('[drawing] 도형 좌표를 읽지 못했습니다. drawend 데이터:', data);
            showToast('도형 정보를 읽지 못했습니다. 다시 그려주세요.', 'error');
            return;
        }

        findBuildingsInArea();
        updateDrawingButtons();
    });
    
    // 도형 변경 이벤트 (드래그/편집 후)
    drawingState.manager.addListener('state_changed', () => {
        if (drawingState.currentOverlay) {
            drawingState.currentShape =
                normalizeShape(null, drawingState.currentOverlay) || drawingState.currentShape;
        }
        if (drawingState.currentShape) findBuildingsInArea();
    });
    
    console.log('DrawingManager 초기화 완료');
}

// 도형 그리기 모드 설정
export function setDrawingMode(type) {
    if (!drawingState.manager) {
        initDrawingManager();
        if (!drawingState.manager) return;
    }
    
    // 기존 도형 제거
    clearDrawing();
    
    // 같은 모드면 토글 (끄기)
    if (drawingState.drawingMode === type) {
        drawingState.drawingMode = null;
        drawingState.manager.cancel();
        updateDrawingButtons();
        return;
    }
    
    drawingState.drawingMode = type;
    
    // 카카오맵 DrawingManager 타입 설정
    const modeMap = {
        'rectangle': kakao.maps.drawing.OverlayType.RECTANGLE,
        'circle': kakao.maps.drawing.OverlayType.CIRCLE,
        'polygon': kakao.maps.drawing.OverlayType.POLYGON
    };
    
    if (modeMap[type]) {
        drawingState.manager.select(modeMap[type]);
    }
    
    updateDrawingButtons();
    showToast(getDrawingGuide(type), 'info');
}

// 도형 그리기 가이드 메시지
function getDrawingGuide(type) {
    const guides = {
        'rectangle': '🔲 사각형: 클릭하여 시작점, 드래그하여 영역 선택',
        'circle': '⭕ 원: 클릭하여 중심점, 드래그하여 반경 설정',
        'polygon': '🔷 다각형: 클릭하여 꼭지점 추가, 더블클릭으로 완성'
    };
    return guides[type] || '';
}

// 도형 지우기
export function clearDrawing() {
    if (drawingState.manager) {
        drawingState.manager.cancel();
        
        // 모든 오버레이 제거
        const overlays = drawingState.manager.getOverlays();
        ['rectangle', 'circle', 'polygon'].forEach(type => {
            if (overlays[type] && overlays[type].length > 0) {
                overlays[type].forEach(o => {
                    if (o && typeof o.setMap === 'function') {
                        o.setMap(null);
                    }
                });
            }
        });
    }
    
    drawingState.currentOverlay = null;
    drawingState.currentShape = null;
    drawingState.drawingMode = null;
    drawingState.selectedBuildings = [];

    // ★ v4.6: 영역 조건 해제 후 목록·지도 복원
    if (state.drawnAreaIds) {
        state.drawnAreaIds = null;
        if (window.applyFilters) window.applyFilters();
    }

    updateDrawingButtons();
    hideDrawingResults();
}

// 버튼 상태 업데이트
function updateDrawingButtons() {
    const modeToBtn = {
        'rectangle': 'drawRectBtn',
        'circle': 'drawCircleBtn',
        'polygon': 'drawPolygonBtn'
    };
    
    // 모든 모드 버튼 초기화
    Object.values(modeToBtn).forEach(btnId => {
        const btn = document.getElementById(btnId);
        if (btn) {
            btn.style.background = '#fff';
            btn.style.borderColor = '#e5e7eb';
        }
    });
    
    // 활성 모드 버튼 하이라이트
    if (drawingState.drawingMode && modeToBtn[drawingState.drawingMode]) {
        const activeBtn = document.getElementById(modeToBtn[drawingState.drawingMode]);
        if (activeBtn) {
            activeBtn.style.background = '#2563eb';
            activeBtn.style.borderColor = '#2563eb';
        }
    }
    
    // 지우기 버튼 활성화
    const clearBtn = document.getElementById('drawClearBtn');
    if (clearBtn) {
        const hasOverlay = !!drawingState.currentOverlay;
        clearBtn.disabled = !hasOverlay;
        clearBtn.style.opacity = hasOverlay ? '1' : '0.5';
    }
}

// ============================================================
// 영역 내 빌딩 검색 알고리즘
// ============================================================

// ============================================================
// ★ v4.6: 도형 정규화
//
// kakao DrawingManager 의 drawend 데이터 형태가 SDK 버전에 따라 다르다.
// 오버레이 객체가 오기도 하고 좌표 배열만 오기도 한다.
// 어느 쪽이든 { kind, contains(lat, lng) } 형태로 통일해 사용한다.
// ============================================================

function _latOf(p) {
    if (!p) return null;
    if (typeof p.getLat === 'function') return p.getLat();
    if (typeof p.y === 'number') return p.y;
    if (typeof p.lat === 'number') return p.lat;
    return null;
}
function _lngOf(p) {
    if (!p) return null;
    if (typeof p.getLng === 'function') return p.getLng();
    if (typeof p.x === 'number') return p.x;
    if (typeof p.lng === 'number') return p.lng;
    return null;
}

function _toPointList(raw) {
    if (!raw) return null;
    const arr = Array.isArray(raw) ? raw : (typeof raw.length === 'number' ? Array.from(raw) : null);
    if (!arr || arr.length < 3) return null;
    const pts = arr.map(p => ({ lat: _latOf(p), lng: _lngOf(p) }))
                   .filter(p => p.lat != null && p.lng != null);
    return pts.length >= 3 ? pts : null;
}

function normalizeShape(data, overlay) {
    const type = (data && data.overlayType ? String(data.overlayType).toLowerCase() : '')
        || drawingState.drawingMode || '';

    // 다각형
    if (type.includes('polygon')) {
        let pts = null;
        if (overlay && typeof overlay.getPath === 'function') pts = _toPointList(overlay.getPath());
        if (!pts && data) pts = _toPointList(data.points || data.path || data.coordinates);
        if (!pts) return null;
        return {
            kind: 'polygon',
            contains(lat, lng) { return rayCast(lat, lng, pts); }
        };
    }

    // 사각형
    if (type.includes('rect')) {
        let sw = null, ne = null;
        if (overlay && typeof overlay.getBounds === 'function') {
            const bd = overlay.getBounds();
            if (bd) { sw = bd.getSouthWest(); ne = bd.getNorthEast(); }
        }
        if ((!sw || !ne) && data) {
            const a = data.sPoint || data.southWest || (data.bounds && data.bounds.sw);
            const b = data.ePoint || data.northEast || (data.bounds && data.bounds.ne);
            if (a && b) { sw = a; ne = b; }
        }
        const y1 = _latOf(sw), x1 = _lngOf(sw), y2 = _latOf(ne), x2 = _lngOf(ne);
        if ([y1, x1, y2, x2].some(v => v == null)) return null;
        const minLat = Math.min(y1, y2), maxLat = Math.max(y1, y2);
        const minLng = Math.min(x1, x2), maxLng = Math.max(x1, x2);
        return {
            kind: 'rectangle',
            contains(lat, lng) {
                return lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;
            }
        };
    }

    // 원
    if (type.includes('circle')) {
        let center = null, radius = null;
        if (overlay && typeof overlay.getPosition === 'function') {
            center = overlay.getPosition();
            radius = typeof overlay.getRadius === 'function' ? overlay.getRadius() : null;
        }
        if ((!center || radius == null) && data) {
            center = center || data.center || data.position;
            radius = radius != null ? radius : data.radius;
        }
        const clat = _latOf(center), clng = _lngOf(center);
        if (clat == null || clng == null || !radius) return null;
        return {
            kind: 'circle',
            contains(lat, lng) {
                return getDistanceFromLatLng(clat, clng, lat, lng) <= radius;
            }
        };
    }

    return null;
}

function rayCast(lat, lng, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const yi = pts[i].lat, xi = pts[i].lng;
        const yj = pts[j].lat, xj = pts[j].lng;
        const intersect = ((yi > lat) !== (yj > lat)) &&
            (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

export function findBuildingsInArea() {
    const shape = drawingState.currentShape;
    if (!shape) {
        drawingState.selectedBuildings = [];
        state.drawnAreaIds = null;
        if (window.applyFilters) window.applyFilters();
        return;
    }

    // ★ v4.6: 전체 빌딩을 대상으로 판정하고, 결과를 필터 파이프라인에 넘긴다.
    // 이전에는 filteredBuildings 를 다시 걸러 별도 패널에만 표시했기 때문에
    // 왼쪽 빌딩 목록과 지도 마커에는 영역 조건이 반영되지 않았다.
    const inArea = state.allBuildings.filter(b =>
        b.lat && b.lng && shape.contains(Number(b.lat), Number(b.lng)));

    state.drawnAreaIds = new Set(inArea.map(b => b.id));

    // 다른 필터(권역·면적·공실 등)와 AND 로 합성한 최종 목록
    if (window.applyFilters) window.applyFilters();
    drawingState.selectedBuildings = (state.filteredBuildings || []).filter(b =>
        state.drawnAreaIds.has(b.id));

    console.log(`[drawing] ${shape.kind} 내 빌딩 ${inArea.length}개 · 필터 적용 후 ${drawingState.selectedBuildings.length}개`);
    showDrawingResults();
}

// 사각형 내부 판정
function isPointInRectangle(point, rectangle) {
    const bounds = rectangle.getBounds();
    return bounds.contain(point);
}

// 원 내부 판정
function isPointInCircle(point, circle) {
    const center = circle.getPosition();
    const radius = circle.getRadius();
    
    // Haversine 공식으로 두 점 사이 거리 계산
    const distance = getDistanceFromLatLng(
        center.getLat(), center.getLng(),
        point.getLat(), point.getLng()
    );
    
    return distance <= radius;
}

// 두 좌표 사이 거리 (미터)
function getDistanceFromLatLng(lat1, lng1, lat2, lng2) {
    const R = 6371000; // 지구 반경 (미터)
    const dLat = deg2rad(lat2 - lat1);
    const dLng = deg2rad(lng2 - lng1);
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function deg2rad(deg) {
    return deg * (Math.PI / 180);
}

// 다각형 내부 판정 (Ray Casting 알고리즘)
function isPointInPolygon(point, polygon) {
    const path = polygon.getPath();
    const x = point.getLng();
    const y = point.getLat();
    
    let inside = false;
    const n = path.length;
    
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = path[i].getLng();
        const yi = path[i].getLat();
        const xj = path[j].getLng();
        const yj = path[j].getLat();
        
        const intersect = ((yi > y) !== (yj > y)) &&
                          (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        
        if (intersect) inside = !inside;
    }
    
    return inside;
}

// ============================================================
// 결과 표시 UI
// ============================================================

function showDrawingResults() {
    let panel = document.getElementById('drawingResultsPanel');
    
    if (!panel) {
        panel = createResultsPanel();
    }
    
    const buildings = drawingState.selectedBuildings;
    const count = buildings.length;
    
    // 통계
    const withVacancy = buildings.filter(b => b.hasVacancy).length;
    const withData = buildings.filter(b => b.hasData).length;
    
    // ★ 초기 표시 개수 (5개씩 표시)
    const initialShowCount = 5;
    const showLoadMore = buildings.length > initialShowCount;
    
    panel.innerHTML = `
        <div class="drawing-results-header">
            <h4>🎯 선택 영역 (${count}개 빌딩)</h4>
            <button onclick="window.clearDrawing()" class="drawing-close-btn">×</button>
        </div>
        <div class="drawing-results-stats">
            <span>공실 有: <strong>${withVacancy}</strong></span>
            <span>데이터 有: <strong>${withData}</strong></span>
        </div>
        <div class="drawing-results-list" id="drawingResultsList" style="max-height: 300px; overflow-y: auto;">
            ${buildings.length === 0 ? 
                '<div class="drawing-no-results">선택 영역에 빌딩이 없습니다.</div>' :
                buildings.slice(0, initialShowCount).map(b => `
                    <div class="drawing-result-item" onclick="window.openDetail('${b.id}')">
                        <div class="drawing-result-name">
                            ${b.hasVacancy ? '🟢' : '⚪'} ${b.name}
                        </div>
                        <div class="drawing-result-info">
                            ${b.region || ''} ${b.grossFloorPy ? `· ${Math.round(b.grossFloorPy).toLocaleString()}평` : ''}
                        </div>
                    </div>
                `).join('')
            }
        </div>
        ${showLoadMore ? `
            <div class="drawing-load-more" id="drawingLoadMore" style="text-align:center; padding:8px;">
                <button onclick="window.loadMoreDrawingResults()" class="btn btn-sm" style="background:#f3f4f6; border:1px solid #e5e7eb; border-radius:4px; padding:6px 16px; cursor:pointer; font-size:12px;">
                    📋 더보기 (${buildings.length - initialShowCount}개 더)
                </button>
            </div>
        ` : ''}
        <div class="drawing-results-actions">
            <button onclick="window.addToCompList()" class="btn btn-sm btn-secondary">📋 Comp List 추가</button>
            <button onclick="window.exportDrawingSelection()" class="btn btn-sm btn-primary">📥 내보내기</button>
        </div>
    `;
    
    panel.style.display = 'block';
}

// ★ 더보기 버튼 클릭 시 전체 목록 로드
function loadMoreDrawingResults() {
    const buildings = drawingState.selectedBuildings;
    const listContainer = document.getElementById('drawingResultsList');
    const loadMoreContainer = document.getElementById('drawingLoadMore');
    
    if (!listContainer) return;
    
    // 전체 목록으로 교체
    listContainer.innerHTML = buildings.map(b => `
        <div class="drawing-result-item" onclick="window.openDetail('${b.id}')">
            <div class="drawing-result-name">
                ${b.hasVacancy ? '🟢' : '⚪'} ${b.name}
            </div>
            <div class="drawing-result-info">
                ${b.region || ''} ${b.grossFloorPy ? `· ${Math.round(b.grossFloorPy).toLocaleString()}평` : ''}
            </div>
        </div>
    `).join('');
    
    // 더보기 버튼 숨기기
    if (loadMoreContainer) {
        loadMoreContainer.style.display = 'none';
    }
}

function hideDrawingResults() {
    const panel = document.getElementById('drawingResultsPanel');
    if (panel) {
        panel.style.display = 'none';
    }
}

function createResultsPanel() {
    const panel = document.createElement('div');
    panel.id = 'drawingResultsPanel';
    panel.className = 'drawing-results-panel';
    document.body.appendChild(panel);
    return panel;
}

// ============================================================
// 도구 패널 토글
// ============================================================

export function toggleDrawingTools() {
    drawingState.isToolsVisible = !drawingState.isToolsVisible;
    
    const toolsPanel = document.getElementById('drawingToolsPanel');
    if (toolsPanel) {
        // 직접 display 스타일 조작 (CSS 클래스 충돌 방지)
        if (drawingState.isToolsVisible) {
            toolsPanel.style.display = 'flex';
            toolsPanel.classList.add('visible');
        } else {
            toolsPanel.style.display = 'none';
            toolsPanel.classList.remove('visible');
        }
    }
    
    // 도구 닫으면 도형도 초기화
    if (!drawingState.isToolsVisible) {
        clearDrawing();
    }
}

// ============================================================
// Comp List / 내보내기
// ============================================================

export function addToCompList() {
    const buildings = drawingState.selectedBuildings;
    if (buildings.length === 0) {
        showToast('선택된 빌딩이 없습니다.', 'warning');
        return;
    }
    
    // Comp List 모듈 함수 호출
    if (window.addBuildingsToCompList) {
        window.addBuildingsToCompList(buildings);
    } else {
        showToast('Comp List 모듈을 찾을 수 없습니다.', 'error');
    }
}

export function exportDrawingSelection() {
    const buildings = drawingState.selectedBuildings;
    if (buildings.length === 0) {
        showToast('선택된 빌딩이 없습니다.', 'warning');
        return;
    }
    
    // CSV 생성
    const headers = ['빌딩명', '주소', '권역', '연면적(평)', '기준층(평)', '준공연도', '공실여부'];
    const rows = buildings.map(b => [
        b.name || '',
        b.address || '',
        b.region || '',
        b.grossFloorPy || '',
        b.typicalFloorPy || '',
        b.completionYear || '',
        b.hasVacancy ? 'Y' : 'N'
    ]);
    
    const csv = [headers, ...rows]
        .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
        .join('\n');
    
    const BOM = '\uFEFF';
    const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `선택영역_빌딩목록_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    
    URL.revokeObjectURL(url);
    showToast(`${buildings.length}개 빌딩 내보내기 완료`, 'success');
}

// ============================================================
// CSS 스타일 주입
// ============================================================

function injectDrawingStyles() {
    // CSS는 portal.html에 직접 포함되어 있음
    // 이 함수는 호환성을 위해 유지
}

// ============================================================
// 초기화 및 전역 등록
// ============================================================

export function initDrawing() {
    injectDrawingStyles();
    
    // 이벤트 리스너 직접 연결
    setupDrawingEventListeners();
    
    // 지도가 준비되면 DrawingManager 초기화
    if (state.kakaoMap) {
        initDrawingManager();
    } else {
        // 지도 초기화 대기
        const checkMap = setInterval(() => {
            if (state.kakaoMap) {
                clearInterval(checkMap);
                initDrawingManager();
            }
        }, 500);
        
        // 10초 후 타임아웃
        setTimeout(() => clearInterval(checkMap), 10000);
    }
}

// 이벤트 리스너 설정
function setupDrawingEventListeners() {
    // 토글 버튼
    const toggleBtn = document.getElementById('drawingToggleBtn');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleDrawingTools();
        });
    }
    
    // 사각형 버튼
    const rectBtn = document.getElementById('drawRectBtn');
    if (rectBtn) {
        rectBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            setDrawingMode('rectangle');
        });
    }
    
    // 원 버튼
    const circleBtn = document.getElementById('drawCircleBtn');
    if (circleBtn) {
        circleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            setDrawingMode('circle');
        });
    }
    
    // 다각형 버튼
    const polygonBtn = document.getElementById('drawPolygonBtn');
    if (polygonBtn) {
        polygonBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            setDrawingMode('polygon');
        });
    }
    
    // 지우기 버튼
    const clearBtn = document.getElementById('drawClearBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            clearDrawing();
        });
    }
    
    console.log('Drawing 이벤트 리스너 설정 완료');
}

// window에 등록
window.initDrawing = initDrawing;
window.initDrawingManager = initDrawingManager;
window.setDrawingMode = setDrawingMode;
window.clearDrawing = clearDrawing;
window.toggleDrawingTools = toggleDrawingTools;
window.findBuildingsInArea = findBuildingsInArea;
window.addToCompList = addToCompList;
window.exportDrawingSelection = exportDrawingSelection;
window.loadMoreDrawingResults = loadMoreDrawingResults;

// drawingState 노출 (디버깅용)
window.drawingState = drawingState;
