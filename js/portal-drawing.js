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
        // data.target이 방금 그린 오버레이
        drawingState.currentOverlay = data.target;
        
        console.log('도형 완성:', data.overlayType, data.target);
        
        // 영역 내 빌딩 검색
        if (drawingState.currentOverlay) {
            findBuildingsInArea();
        }
        
        // 지우기 버튼 활성화
        updateDrawingButtons();
    });
    
    // 도형 변경 이벤트 (드래그/편집 후)
    drawingState.manager.addListener('state_changed', () => {
        if (drawingState.currentOverlay) {
            findBuildingsInArea();
        }
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
    drawingState.drawingMode = null;
    drawingState.selectedBuildings = [];
    
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

export function findBuildingsInArea() {
    if (!drawingState.currentOverlay) {
        drawingState.selectedBuildings = [];
        return;
    }
    
    const overlay = drawingState.currentOverlay;
    const type = drawingState.drawingMode;
    
    drawingState.selectedBuildings = state.filteredBuildings.filter(b => {
        if (!b.lat || !b.lng) return false;
        
        const point = new kakao.maps.LatLng(b.lat, b.lng);
        
        switch (type) {
            case 'rectangle':
                return isPointInRectangle(point, overlay);
            case 'circle':
                return isPointInCircle(point, overlay);
            case 'polygon':
                return isPointInPolygon(point, overlay);
            default:
                return false;
        }
    });
    
    console.log(`도형 내 빌딩: ${drawingState.selectedBuildings.length}개`);
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
