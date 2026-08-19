/**
 * Leasing Guide - 빌딩 에디터
 * 빌딩 프리뷰, 이미지 관리, 정보 수정
 * 
 * v2.1 수정사항:
 * - 이미지 placeholder에 권장 크기 표시
 * - portal.html leasingGuides 공실 데이터 연동
 * - 타사 공실 탭에 "안내문 공실" 옵션 추가
 * 
 * v2.3 수정사항 (2026-01-14):
 * - ★ Firebase "Write too large" 오류 해결
 * - compressImage() 함수 추가: 이미지 압축 (800px, JPEG 70%)
 * - syncImageToBuilding() 함수 추가: buildings 컬렉션 동기화
 * - uploadImage() 수정: 압축 후 저장, buildings/{id}에도 동기화
 * - removeImage() 수정: 삭제 시 buildings/{id}에서도 삭제
 * 
 * v3.6 수정사항 (2026-01-20):
 * - ★ 층 표기 정규화 함수 추가 (FF 중복 방지)
 * 
 * v4.6 수정사항 (2026-01-21):
 * - ★ 담당자 변경/해지 버튼 추가
 * - window.renderContactSectionWithActions 함수 연동
 * 
 * v4.7 수정사항 (2026-01-22):
 * - ★ 수동 모드 LOCATION: Firebase Storage 이미지 자동 로드
 * - building.images.location URL이 있으면 해당 이미지 표시
 * - 삭제 버튼: 업로드한 이미지 삭제 기능
 * - 기본값 복원: Storage 이미지가 있으면 복원 버튼 표시
 * - resetToStorageMapImage() 함수 추가
 * 
 * v4.8 수정사항 (2026-01-22):
 * - ★ 플로팅 메뉴 개선: 미리보기/전체보기/출력 버튼 분리
 * - 현재 빌딩 미리보기, 전체 미리보기, PDF 출력 기능
 * 
 * v4.9 수정사항 (2026-01-22):
 * - ★ 플로팅 메뉴에 이전/다음 페이지 네비게이션 추가
 * - 페이지 번호 표시 (N / Total)
 * 
 * v5.0 수정사항 (2026-01-22):
 * - ★ 출력 페이지 분리 (leasing-guide-print.html)
 * - ★ 공실 최대 개수 제한 (12개) 및 UI 안내
 * - ★ Contact Point 기본값 처리 개선
 * 
 * v5.1 수정사항 (2026-02-03):
 * - ★ 지도 자동 생성 버튼 추가 (카카오 Static Map API)
 * - generateLocationMap() 함수: 서버 API 호출 → Firebase Storage 저장
 * - 수동 모드에서 좌표가 있으면 "🗺️ 지도 생성" 버튼 표시
 * 
 * v5.2 수정사항 (2026-02-10):
 * - ★ #11: 수동 모드 LOCATION 이미지 드래그앤드롭/Ctrl+V 지원
 * - setupLocationDropAndPaste(): 드래그앤드롭 + 클립보드 붙여넣기 이벤트 설정
 * - processLocationImage(): 이미지 파일 압축 후 mapImage에 적용
 * - 플레이스홀더 텍스트 변경: "드래그앤드롭, Ctrl+V 또는 클릭"
 */

import { state, db, ref, get, update, getAllRegions, getGuideType, VACANCY_COLUMNS, filterVacanciesByType, buildRetailRentRows, getRetailRoundUnit, RETAIL_ROUND_UNITS } from './guide-state.js?v=5.5';
import { showToast, formatNumber, formatArea, formatPercent, normalizeBuilding, toWon, formatPriceWon, getExteriorImages, getFloorPlanImages, imageMatchesUsage, normalizeImageList, cleanUnitValue, formatNumberInput, unformatNumber, bindCommaInputs } from './guide-utils.js?v=5.10';
import { 
    getUniqueSourcesHtml, 
    getUniqueDatesHtml, 
    renderExternalVacancyGroups, 
    renderExternalCartItems,
    renderExternalCartTags 
} from './guide-vacancy.js?v=5.18';

// ★ 메인 "선택된 공실" 표(tbody)만 즉시 재렌더 — 전체 에디터 재렌더 없이 라이브 반영
//   (타사 공실 체크 시 패널/아코디언을 닫지 않고 공실 현황 표를 갱신하기 위함)
function _parseFloorNumForSort(floor) {
    if (!floor || floor === '-') return 0;
    const str = String(floor).trim().toUpperCase();
    const basement = str.match(/^B(\d+)/);
    if (basement) return -parseInt(basement[1]);
    const above = str.match(/^(\d+)/);
    if (above) return parseInt(above[1]);
    return 0;
}
// ★ v6.9: 공실 금액/면적 표시 — 숫자면 천단위 콤마, 아니면(문의 등 텍스트) 원문 유지
function fmtVacMoney(v, fallback = '문의') {
    if (v === undefined || v === null || v === '') return fallback;
    const n = Number(String(v).replace(/,/g, ''));
    return isNaN(n) ? String(v) : n.toLocaleString();
}

// ★ 공실 3계통 합산 + 문서 타입 필터 — 합산 지점 3곳이 이 함수만 호출한다
//   직접입력(custom) 공실은 해당 안내문 문서에만 존재하므로 usage 가 없으면
//   현재 문서 타입 소유로 간주한다. (리테일 문서에서 추가한 공실이 표에서 사라지는 것 방지)
function mergeVacanciesForGuide(item) {
    const type = getGuideType();
    const merged = [
        ...(item.customVacancies || []).map((v, i) => ({ ...v, usage: v.usage || type, type: 'custom', id: `custom_${i}` })),
        ...(item.selectedExternalVacancies || []).map(v => ({ ...v, usage: v.usage || type })),
        ...(item.leasingGuideVacancies || []).map((v, i) => ({ ...v, usage: v.usage || type, type: 'guide', id: `guide_${i}` }))
    ];
    return filterVacanciesByType(merged, type);
}

export function refreshVacancyListTable(idx) {
    const item = state.tocItems?.[idx];
    if (!item) return;
    const tbody = document.getElementById('vacancyListBody_' + idx);
    if (!tbody) return;
    if (!item.customVacancies) item.customVacancies = [];
    if (!item.selectedExternalVacancies) item.selectedExternalVacancies = [];
    if (!item.leasingGuideVacancies) item.leasingGuideVacancies = [];
    const raw = mergeVacanciesForGuide(item);
    const order = item.vacancySortOrder || 'asc';
    const all = [...raw].sort((a, b) => {
        const fa = _parseFloorNumForSort(a.floor), fb = _parseFloorNumForSort(b.floor);
        return order === 'asc' ? fa - fb : fb - fa;
    });
    if (all.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:30px; color:#94a3b8;">등록된 공실이 없습니다</td></tr>`;
    } else {
        tbody.innerHTML = all.map((v, i) => `
            <tr id="vacRow_${idx}_${i}" data-vacid="${v.id}" data-vactype="${v.type}">
                <td class="floor">${formatFloorDisplay(v.floor)}</td>
                <td>${fmtVacMoney(v.exclusiveArea || v.area, '-')}</td>
                <td>${fmtVacMoney(v.rentArea || v.area, '-')}</td>
                <td>${fmtVacMoney(v.deposit ?? v.depositPy)}</td>
                <td>${fmtVacMoney(v.rent ?? v.rentPy)}</td>
                <td>${fmtVacMoney(v.maintenance ?? v.maintenancePy)}</td>
                <td>${v.moveIn || v.moveInDate || '협의'}</td>
                <td style="font-size:11px; line-height:1.35;">${(v.source || v.company) ? (v.source || v.company) : '<span style="color:#cbd5e1;">-</span>'}${(v.publishDate || v.date) ? '<br><span style="color:#94a3b8;">' + (v.publishDate || v.date) + '</span>' : ''}</td>
                <td>
                    <div class="actions">
                        <button onclick="startVacancyRowEdit(${idx}, '${v.id}', '${v.type}', this)" title="인라인 편집" style="font-size:13px; padding:2px 6px; border:1px solid #e2e8f0; border-radius:4px; background:#fff; color:#64748b; cursor:pointer;">✏️</button>
                        <button onclick="copyVacancyRow(${idx}, '${v.id}', '${v.type}')" title="이 공실 복사(행 추가)" style="font-size:13px; padding:2px 6px; border:1px solid #bbf7d0; border-radius:4px; background:#fff; color:#16a34a; cursor:pointer; margin-left:3px;">⧉</button>
                        <button onclick="removeSelectedVacancy(${idx}, '${v.id}', '${v.type}')" title="삭제" style="font-size:13px; padding:2px 7px; border:1px solid #fecaca; border-radius:4px; background:#fff; color:#dc2626; cursor:pointer; margin-left:3px;">×</button>
                    </div>
                </td>
            </tr>
        `).join('');
    }
    const cntEl = document.querySelector('#vacancySection .vacancy-current-count');
    if (cntEl) {
        cntEl.textContent = all.length;
        cntEl.classList.toggle('over-limit', all.length >= MAX_VACANCIES_PER_BUILDING);
    }
    // ★ 프리뷰(편집화면 A4) 공실표 즉시 동기화
    refreshPreviewVacancyTable(idx);
}

import { initBuildingKakaoMap } from './guide-map.js?v=6.5';

// ★ v5.0: 공실 최대 개수 (A4 가로 기준, 헤더/합계 포함)
const MAX_VACANCIES_PER_BUILDING = 12;

// ★ 입주시기 입력 비우기 — 기본값 '즉시'가 채워져 있어 직접 입력하려면 먼저 지워야 한다
export function clearMoveInField(inputId) {
    const el = document.getElementById(inputId);
    if (!el) return;
    el.value = '';
    el.focus();
}

// ★ v4.6: state를 전역으로 노출 (leasing-guide.html의 담당자 CRUD 함수에서 사용)
window.guideState = state;

// ★ v3.6: 층 표기 정규화 함수 (FF 중복 방지)
function formatFloorDisplay(floor) {
    if (!floor || floor === '-') return '-';
    
    let str = String(floor).trim().toUpperCase();
    
    // 이미 정규화된 형식인지 확인
    // "B1", "B2" 등 지하층 형식
    if (/^B\d+$/.test(str)) return str;
    
    // "12F", "3F" 등 이미 F가 붙은 형식 → 그대로 반환 (FF 방지)
    if (/^\d+F$/.test(str)) return str;
    
    // "B1F" → "B1" (지하층에 F가 붙은 경우 제거)
    if (/^B\d+F$/.test(str)) return str.replace('F', '');
    
    // "12층", "3층" 등 한글 층 → "12F", "3F"
    if (/^\d+층$/.test(str)) return str.replace('층', 'F');
    
    // "지하1층", "지하2층" → "B1", "B2"
    const basementMatch = str.match(/지하\s*(\d+)\s*층?/);
    if (basementMatch) return 'B' + basementMatch[1];
    
    // 숫자만 있는 경우 → "12F"
    if (/^\d+$/.test(str)) return str + 'F';
    
    // 그 외의 경우 그대로 반환
    return str;
}

// ★ 권장 이미지 크기 상수
const IMAGE_SIZES = {
    exterior: { width: 800, height: 600, label: '외관: 800×600px 권장' },
    floorplan: { width: 800, height: 600, label: '평면도: 800×600px 권장' },
    map: { width: 600, height: 400, label: '지도: 600×400px 권장' }
};

// ★ 타사 공실 자동 로드 함수
async function loadExternalVacancies(buildingId) {
    try {
        const vacancyRef = ref(db, `vacancies/${buildingId}`);
        const snapshot = await get(vacancyRef);
        
        if (snapshot.exists()) {
            const vacancyData = snapshot.val();
            // 배열로 변환
            return Object.entries(vacancyData)
                .map(([id, v]) => ({ id, ...(v && typeof v === 'object' ? v : {}) }))
                .filter(v => {
                    const _s = x => (x === undefined || x === null) ? '' : String(x).trim();
                    const _floor = _s(v.floor);
                    const _area = _s(v.rentArea) || _s(v.exclusiveArea) || _s(v.area);
                    return (_floor && _floor !== '-') || (_area && _area !== '-');
                });
        }
        return [];
    } catch (error) {
        console.error('타사 공실 로드 오류:', error);
        return [];
    }
}

// ★ v3.8: 기준가(floorPricing) 비동기 로드 - 공실 이관 시 동반 참조
async function loadFloorPricing(buildingId, item) {
    try {
        const fpRef = ref(db, `buildings/${buildingId}/floorPricing`);
        const snapshot = await get(fpRef);
        
        if (snapshot.exists()) {
            const data = snapshot.val();
            item.floorPricing = Array.isArray(data) ? data : Object.values(data);
            console.log(`✅ floorPricing 로드: ${buildingId} → ${item.floorPricing.length}개`);
        } else {
            item.floorPricing = [];
        }
        item.floorPricingLoaded = true;
    } catch (error) {
        console.error('floorPricing 로드 오류:', error);
        item.floorPricing = [];
        item.floorPricingLoaded = true;
    }
}

// 빌딩 에디터 렌더링
// ★ 프리뷰 공실표 행 HTML — renderBuildingEditor / refreshPreviewVacancyTable 공용
function buildPreviewVacancyRowsHTML(item, allVacancies, type) {
    const t = (type === 'retail') ? 'retail' : 'office';
    const colCount = VACANCY_COLUMNS[t].editor.length;

    // ★ 리테일: 매장층 / 전용면적 / 임대면적 / 입주시기 (금액 컬럼 없음)
    if (t === 'retail') {
        return `
                                ${allVacancies.length > 0 ? allVacancies.map(v => `
                                    <tr>
                                        <td class="floor">${formatFloorDisplay(v.floor)}</td>
                                        <td>${v.exclusiveArea || v.area || '-'}</td>
                                        <td>${v.rentArea || v.area || '-'}</td>
                                        <td>${v.moveIn || v.moveInDate || '-'}</td>
                                    </tr>
                                `).join('') : `
                                    <tr><td colspan="${colCount}" class="no-vacancy-cell">
                                        <div class="no-vacancy-message">
                                            <span class="no-vacancy-icon">🛍️</span>
                                            <span class="no-vacancy-text">등록된 리테일 공실이 없습니다</span>
                                        </div>
                                    </td></tr>
                                `}
                                ${allVacancies.length > 0 ? `
                                    <tr class="total-row">
                                        <td>합계</td>
                                        <td>${formatNumber(allVacancies.reduce((s,v) => s + (parseFloat(v.exclusiveArea || v.area || 0)), 0))}</td>
                                        <td>${formatNumber(allVacancies.reduce((s,v) => s + (parseFloat(v.rentArea || v.area || 0)), 0))}</td>
                                        <td>-</td>
                                    </tr>
                                ` : ''}
    `;
    }

    return `
                                ${allVacancies.length > 0 ? allVacancies.map(v => `
                                    <tr>
                                        <td class="floor">${formatFloorDisplay(v.floor)}</td>
                                        <td>${v.exclusiveArea || v.area || '-'}</td>
                                        <td>${v.rentArea || v.area || '-'}</td>
                                        <td>${v.deposit || v.depositPy || '문의'}</td>
                                        <td>${v.rent || v.rentPy || '문의'}</td>
                                        <td>${v.maintenance || v.maintenancePy || '문의'}</td>
                                        <td>${v.moveIn || v.moveInDate || '-'}</td>
                                    </tr>
                                `).join('') : `
                                    <tr><td colspan="7" class="no-vacancy-cell">
                                        <div class="no-vacancy-message">
                                            <span class="no-vacancy-icon">🏢</span>
                                            <span class="no-vacancy-text">${
                                                (item.customVacancies === null && item.selectedExternalVacancies === null && item.leasingGuideVacancies === null)
                                                ? '공실 데이터 없음 - 아래에서 추가해주세요'
                                                : '현재 공실 없음 (만실)'
                                            }</span>
                                        </div>
                                    </td></tr>
                                `}
                                ${allVacancies.length > 0 ? `
                                    <tr class="total-row">
                                        <td>합계</td>
                                        <td>${formatNumber(allVacancies.reduce((s,v) => s + (parseFloat(v.exclusiveArea || v.area || 0)), 0))}</td>
                                        <td>${formatNumber(allVacancies.reduce((s,v) => s + (parseFloat(v.rentArea || v.area || 0)), 0))}</td>
                                        <td colspan="4">-</td>
                                    </tr>
                                ` : ''}
    `;
}

// ★ 프리뷰 공실표만 부분 갱신 (전체 재렌더 없이 [반영] 즉시 반영)
export function refreshPreviewVacancyTable(idx) {
    const item = state.tocItems?.[idx];
    if (!item) return;
    const tbody = document.getElementById('previewVacancyBody_' + idx);
    if (!tbody) return;
    if (!item.customVacancies) item.customVacancies = [];
    if (!item.selectedExternalVacancies) item.selectedExternalVacancies = [];
    if (!item.leasingGuideVacancies) item.leasingGuideVacancies = [];
    const raw = mergeVacanciesForGuide(item);
    const all = [...raw].sort((a, b) => {
        const fa = _parseFloorNumForSort(a.floor), fb = _parseFloorNumForSort(b.floor);
        return item.vacancySortOrder === 'asc' ? fa - fb : fb - fa;
    });
    tbody.innerHTML = buildPreviewVacancyRowsHTML(item, all, getGuideType());
}

// ★ 리테일 RENT 표 (편집 프리뷰) — 층별 다행 + 월 총액(원) + 각주 인라인 편집
function renderRetailRentHTML(idx, item, vacancies) {
    const { rows, showDeposit } = buildRetailRentRows(vacancies, getRetailRoundUnit(item));
    const won = n => (n === null ? '문의' : n.toLocaleString());
    const span = showDeposit ? 4 : 3;
    return `
                            <tr>
                                <th>구분</th>
                                ${showDeposit ? '<th>보증금</th>' : ''}
                                <th>월 임대료</th>
                                <th>월 관리비</th>
                            </tr>
                            ${rows.length > 0 ? rows.map(r => `
                                <tr>
                                    <td>${formatFloorDisplay(r.floor)}</td>
                                    ${showDeposit ? `<td>${won(r.deposit)}</td>` : ''}
                                    <td>${won(r.rent)}</td>
                                    <td>${won(r.maintenance)}</td>
                                </tr>
                            `).join('') : `<tr><td colspan="${span}" style="color:#94a3b8;">등록된 리테일 공실이 없습니다</td></tr>`}
    `;
}

// ★ 리테일 RENT 각주 문구 저장 (빌딩 장표별)
// ★ v6.23: 장표별 금액 표기 단위 — 빈 값이면 문서 기본값을 따른다
export function setItemRoundUnit(idx, value) {
    const item = state.tocItems?.[idx];
    if (!item) return;
    if (value === '' || value === null || value === undefined) delete item.retailRoundUnit;
    else {
        const u = Number(value);
        if (u === 0 || u === 1000 || u === 10000) item.retailRoundUnit = u;
        else delete item.retailRoundUnit;
    }
    const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
    renderBuildingEditor(item, building);
}

export function updateRetailRentNote(idx, value) {
    const item = state.tocItems?.[idx];
    if (!item) return;
    item.retailRentNote = value;
}

// ★ 기준층 임대/전용 병기 (typicalFloorPy = 임대면적, 전용 = 임대 × 전용률)
function formatTypicalFloor(building) {
    const rentPy = parseFloat(building.typicalFloorPy || building.area?.typicalFloorPy || 0);
    if (!rentPy || rentPy <= 0) return '-';
    const raw = parseFloat(building.exclusiveRate || building.area?.exclusiveRate || 0);
    const rentTxt = formatArea(rentPy) + ' 평';
    // 전용률 표기 혼재 대응: 47.97(%) / 0.4797(비율) 모두 허용
    const ratio = raw > 1 ? raw / 100 : raw;
    // ★ 불변식: 전용면적 < 임대면적. 비율이 0~1 범위를 벗어나면 이상치로 보고 임대면적만 표기
    if (!ratio || ratio <= 0 || ratio > 1) return rentTxt + ' / -';
    return rentTxt + ' / ' + formatArea(rentPy * ratio) + ' 평 (전용률 ' + (ratio * 100).toFixed(1) + '%)';
}

// ★ 외관사진 표시 방식 토글 (기본 'contain' = 잘림 없음)
export function toggleExteriorFit(idx) {
    const item = state.tocItems?.[idx];
    if (!item) return;
    item.exteriorFit = (item.exteriorFit === 'cover') ? 'contain' : 'cover';
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (building) renderBuildingEditor(item, building);
}

export function renderBuildingEditor(item, building) {
    const editorMain = document.getElementById('editorMain');
    if (!editorMain) return;
    
    const isConfirmed = item?.closeConfirmed;
    // ★ 문서 타입 (공실표/RENT 표 분기 기준)
    const guideType = getGuideType();
    const vacCols = VACANCY_COLUMNS[guideType];
    const region = (item.region || building.region || 'ETC').toUpperCase();
    const idx = state.tocItems.indexOf(item);
    const allRegions = getAllRegions();
    
    // 이미지 데이터 초기화 (Firebase에서 기존 이미지 가져오기)
    if (!item.exteriorImages || item.exteriorImages.length === 0) {
        item.exteriorImages = getExteriorImages(building, guideType);
    }
    if (!item.floorPlanImages || item.floorPlanImages.length === 0) {
        item.floorPlanImages = getFloorPlanImages(building, guideType);
    }
    if (!item.mainImageIndex) item.mainImageIndex = 0;
    if (!item.customVacancies) item.customVacancies = [];
    if (!item.selectedExternalVacancies) item.selectedExternalVacancies = [];
    if (!item.leasingGuideVacancies) item.leasingGuideVacancies = [];  // ★ 안내문 공실
    
    // ★ v3.8: 기준가(floorPricing) 자동 로드 - 공실 이관 시 동반 참조용
    // ★ [B-2] 로드는 비동기 → 완료 후 재렌더해야 기준가 선택 UI 노출 + RENT 반영됨 (현재 편집 중인 항목일 때만)
    if (!item.floorPricingLoaded) {
        loadFloorPricing(building.id, item).then(() => {
            if (state.tocItems[state.selectedTocIndex] === item) {
                renderBuildingEditor(item, building);
            }
        });
    }
    
    // ★ 타사 공실 자동 로드 (vacancies가 없거나 로드되지 않은 경우)
    let externalVacancies = building.vacancies;
    if (!Array.isArray(externalVacancies)) {
        externalVacancies = [];
        // 비동기로 로드 후 UI 업데이트
        loadExternalVacancies(building.id).then(vacancies => {
            if (vacancies && vacancies.length > 0) {
                building.vacancies = vacancies;
                // 타사 공실 영역만 업데이트
                const extBody = document.getElementById('extVacancyBody_' + idx);
                if (extBody) {
                    extBody.innerHTML = renderExternalVacancyGroups(vacancies, item.selectedExternalVacancies || [], idx);
                    setTimeout(() => { if (window.refreshExternalArea) window.refreshExternalArea(idx); }, 50);
                }
                const countEl = document.querySelector('.external-vacancy-count');
                if (countEl) {
                    countEl.textContent = `${vacancies.length}건`;
                }
            }
        });
    }
    
    // ★ leasingGuides에서 해당 빌딩의 공실 정보 가져오기
    const leasingGuideVacancies = getLeasingGuideVacancies(building.id);
    
    // 빌딩 데이터 정규화
    normalizeBuilding(building);
    
    // 메인 이미지
    const mainImg = item.exteriorImages[item.mainImageIndex];
    const floorPlanImg = item.floorPlanImages[0];
    
    // ★ 공실 정렬 순서 초기화 (기본값: 오름차순)
    if (!item.vacancySortOrder) item.vacancySortOrder = 'asc';
    
    // 선택된 공실 통합 (customVacancies + selectedExternalVacancies + leasingGuideVacancies)
    // ★ 문서 타입(guideType)에 해당하는 공실만 남긴다
    const allVacanciesRaw = mergeVacanciesForGuide(item);
    
    // ★ 층 정렬 함수
    const sortVacancies = (vacancies, order) => {
        return [...vacancies].sort((a, b) => {
            const floorA = parseFloorNumber(a.floor);
            const floorB = parseFloorNumber(b.floor);
            return order === 'asc' ? floorA - floorB : floorB - floorA;
        });
    };
    
    // ★ 층 번호 파싱 (B1=-1, B2=-2, 1F=1, 12F=12 등)
    const parseFloorNumber = (floor) => {
        if (!floor || floor === '-') return 0;
        const str = String(floor).trim().toUpperCase();
        // 지하층: B1, B2 등
        const basement = str.match(/^B(\d+)/);
        if (basement) return -parseInt(basement[1]);
        // 일반층: 12F, 3F, 12, 3 등
        const above = str.match(/^(\d+)/);
        if (above) return parseInt(above[1]);
        return 0;
    };
    
    // 정렬 적용
    const allVacancies = sortVacancies(allVacanciesRaw, item.vacancySortOrder);
    
    // NOTE (임대안내문 표시용 메모) — 인라인 편집
    // ★ noteMode: 'shared'(빌딩 공용, 기본) | 'custom'(이 문서 전용)
    //   shared 는 buildings/{id}/memos 를 읽고 쓴다 — 같은 빌딩이 담긴 다른 안내문에도 함께 반영된다.
    //   custom 은 item.customNote 에만 저장한다 — 빌딩 레코드를 건드리지 않아 다른 안내문에 영향이 없다.
    //   기본값을 shared 로 두어 기존 안내문의 동작은 그대로 유지된다.
    const noteMode = (item.noteMode === 'custom') ? 'custom' : 'shared';
    const guideMemos = (building.memos || []).filter(m => m.showInLeasingGuide);
    const sharedNoteText = guideMemos.map(m => (m.content || '')).join('\n');
    const noteCurrentText = (noteMode === 'custom') ? (item.customNote || '') : sharedNoteText;
    // 미들닷: 각 줄마다 • 처리
    const renderNoteLines = (content) =>
        (content || '').split('\n')
            .filter(l => l.trim())
            .map(l => `<div class="note-item">• ${l.trim()}</div>`)
            .join('');
    const noteDisplayHtml = !noteCurrentText.trim()
        ? `<div class="preview-note-placeholder" onclick="startNoteInlineEdit(${idx}, '${building.id}')">📝 클릭하여 노트 추가</div>`
        : renderNoteLines(noteCurrentText);
    const noteModeBtn = (mode, label, title) => {
        const on = noteMode === mode;
        return `<button class="info-action-btn" title="${title}" onclick="setNoteMode(${idx}, '${mode}')"
            style="font-size:10px; padding:1px 7px; ${on ? 'background:#2563eb; color:#fff; border-color:#2563eb;' : 'color:#94a3b8;'}">${label}</button>`;
    };
    const noteHtml = `
        <div class="preview-note-section${guideMemos.length === 0 ? ' preview-note-empty' : ''}">
            <div class="preview-section-title" style="display:flex; justify-content:space-between; align-items:center;">
                <span>NOTE</span>
                <span style="display:flex; gap:6px; align-items:center;">
                    <span style="display:inline-flex; gap:2px;">
                        ${noteModeBtn('shared', '공용', '빌딩 공용 노트 — 같은 빌딩이 담긴 다른 안내문에도 함께 반영됩니다')}
                        ${noteModeBtn('custom', '이 문서', '이 문서 전용 노트 — 이 안내문에서만 보입니다')}
                    </span>
                    <button class="info-action-btn" onclick="startNoteInlineEdit(${idx}, '${building.id}')" title="노트 편집">✏️</button>
                </span>
            </div>
            <div id="noteDisplay_${idx}" class="preview-note-content">${noteDisplayHtml}</div>
            <div id="noteEditor_${idx}" style="display:none; margin-top:6px;">
                <textarea id="noteTextarea_${idx}"
                    style="width:100%; box-sizing:border-box; min-height:90px; font-size:12px; border:1px solid #bae6fd; border-radius:6px; padding:8px; resize:vertical; font-family:inherit; color:#1e293b;"
                    placeholder="줄바꿈(Enter)으로 항목을 구분합니다&#10;예) 6월 19일 사용승인예정&#10;2,3층 업무시설 가능"
                    data-note-mode="${noteMode}"
                >${noteCurrentText}</textarea>
                <div style="display:flex; gap:6px; margin-top:6px; justify-content:flex-end;">
                    <button class="info-action-btn" onclick="cancelNoteInlineEdit(${idx})" style="color:#64748b;">취소</button>
                    <button class="info-action-btn" onclick="saveNoteInline(${idx}, '${building.id}')" style="background:#2563eb; color:#fff; border-color:#2563eb;">💾 저장</button>
                </div>
            </div>
        </div>
    `;
    
    // ★ v4.9: 페이지 정보 가져오기
    const pageInfo = window.getPageInfo ? window.getPageInfo() : { current: idx + 3, total: '?' };
    
    // ★ v6.1: 섹션 입력 상태 (플로팅 점프 버튼 색상/태그용)
    const _secFilled = {
        exterior: (item.exteriorImages?.length || 0) > 0,
        floorplan: (item.floorPlanImages?.length || 0) > 0,
        map: !!(item.mapImage || building.images?.location),
        floorPricing: (item.floorPricing?.length || 0) > 0 || (item.selectedFloorPricingIds?.length || 0) > 0 || !!(building.rentPy || building.depositPy),
        vacancy: (allVacancies?.length || 0) > 0,
        note: guideMemos.length > 0,
        contact: (item.contactPoints || building.contactPoints || []).length > 0
    };
    const _jumpBtn = (key, target, icon, label) => {
        const f = _secFilled[key];
        return `<button class="floating-jump ${f ? 'filled' : 'empty'}" onclick="jumpToEditSection('${target}', ${idx}, '${building.id}')" title="${label} ${f ? '· 입력됨' : '· 비어있음 (클릭하여 편집)'}"><span class="floating-jump-dot">${f ? '✓' : '○'}</span>${icon} ${label}</button>`;
    };

    editorMain.innerHTML = `
        <!-- 플로팅 메뉴 (v6.1: 섹션 점프 + 상태 + 이동/저장/출력 그룹) -->
        <div class="floating-menu no-print">
            <!-- Row 1: 섹션 편집 점프 (입력됨/빈 상태) -->
            <div class="floating-row floating-row-sections">
                <span class="floating-row-label">편집</span>
                <div class="floating-jump-group">
                    ${_jumpBtn('exterior','exterior','🏞️','외관')}
                    ${_jumpBtn('floorplan','floorplan','📐','평면도')}
                    ${_jumpBtn('map','map','🗺️','지도')}
                </div>
                <div class="floating-jump-group">
                    ${_jumpBtn('floorPricing','floorPricing','💰','기준가')}
                    ${_jumpBtn('vacancy','vacancy','🏠','공실')}
                    ${_jumpBtn('note','note','📝','메모')}
                    ${_jumpBtn('contact','contact','👤','컨택')}
                </div>
            </div>
            <!-- Row 2: 이동 · 저장 · 출력 · 관리 -->
            <div class="floating-row floating-row-actions">
                <div class="floating-nav-buttons">
                    <button class="floating-nav-btn" onclick="navigateToPrev()" title="이전 페이지">◀ 이전</button>
                    <span class="floating-page-info">${pageInfo.current} / ${pageInfo.total}</span>
                    <button class="floating-nav-btn" onclick="navigateToNext()" title="다음 페이지">다음 ▶</button>
                    <button class="floating-nav-btn floating-nav-top" onclick="jumpToEditSection('top', ${idx}, '${building.id}')" title="편집화면 맨 위로">⤒ 맨위로</button>
                </div>
                <div class="floating-save-group">
                    <button class="floating-save-btn draft" onclick="if(window.saveDraft)window.saveDraft()" title="임시저장">💾 임시저장</button>
                    <button class="floating-save-btn final" onclick="if(window.saveFinal)window.saveFinal()" title="최종저장">✅ 최종저장</button>
                </div>
                <div class="floating-print-group">
                    <button class="floating-shortcut" onclick="openPrintPage(${idx})" title="현재 페이지 미리보기 (임시저장 후 출력)">🖨️ 미리보기</button>
                    <button class="floating-shortcut print-all" onclick="openPrintPage()" title="전체 페이지 출력 (임시저장 후 출력)">📄 전체</button>
                </div>
                <div class="floating-meta-group">
                    <select class="region-select-btn" onchange="changeItemRegion(${idx}, this.value)" title="권역 변경">
                        ${allRegions.map(r => `<option value="${r.code}" ${region === r.code ? 'selected' : ''}>${r.code} (${r.name})</option>`).join('')}
                    </select>
                    <div class="floating-status ${isConfirmed ? 'confirmed' : 'pending'}">${isConfirmed ? '✅ 확정' : '⏳ 대기'}</div>
                    <button class="btn btn-sm ${isConfirmed ? 'btn-secondary' : 'btn-primary'}" onclick="toggleCloseStatus(${idx})">${isConfirmed ? '🔓 마감해제' : '🔒 마감확정'}</button>
                </div>
            </div>
        </div>
        
        <!-- 가로형 임대안내문 프리뷰 (A4 Landscape) -->
        <div class="building-preview">
            <!-- 헤더: 빌딩명 + 권역정보 -->
            <div class="building-preview-header">
                <div class="building-title">
                    <span class="building-name">${building.name || '빌딩명'}</span>
                    ${item.exclusive ? '<span class="exclusive-badge">전속</span>' : ''}
                    <button onclick="window.open('https://oram-lee.github.io/portal-rmap.html?buildingId=${building.id}&panel=info', '_blank')" title="CRE Portal 상세패널 열기" style="font-size:11px; padding:3px 8px; border:1px solid #94a3b8; border-radius:4px; background:white; color:#475569; cursor:pointer; font-weight:500; margin-left:6px;">🔗 Portal</button>
                </div>
                <div class="region-info" style="text-align:right; line-height:1.5;">
                    ${(() => { const logo = state.coverSettings?.logoImage; return logo ? `<img src="${logo}" alt="로고" style="height:22px; display:block; margin-left:auto; margin-bottom:2px;">` : ''; })()}
                    <div>Leasing Information (${guideType === 'retail' ? `Retail · ${region}` : region})</div>
                </div>
            </div>
            
            <!-- 3열 메인 컨텐츠 -->
            <div class="building-preview-body">
                <!-- 좌측: 빌딩 사진 + 지도 -->
                <div class="preview-col-left">
                    <div>
                        <div class="preview-section-title" style="display:flex; justify-content:space-between; align-items:center;">
                            <span>BUILDING PHOTO</span>
                            <span style="display:flex; gap:4px;">
                                <button class="info-action-btn" onclick="event.stopPropagation(); toggleExteriorFit(${idx})" title="맞춤=사진 전체 노출(여백), 채우기=영역 꽉 채움(잘림)" style="font-size:11px; padding:3px 7px; font-weight:600;">${item.exteriorFit === 'cover' ? '🔲 채우기' : '🖼️ 맞춤'}</button>
                                <button class="info-action-btn" onclick="event.stopPropagation(); pasteExteriorFromClipboard(${idx})" title="복사한 외관 이미지를 바로 붙여넣기" style="font-size:11px; padding:3px 7px; color:#2563eb; border-color:#2563eb; font-weight:600;">📋 붙여넣기</button>
                            </span>
                        </div>
                        <!-- ★ 수정: 권장 크기 표시 -->
                        <div class="preview-building-photo preview-editable${item.exteriorFit === 'cover' ? '' : ' fit-contain'}" onclick="uploadImage(${idx}, 'exterior')">
                            ${mainImg ? `<img src="${typeof mainImg === 'string' ? mainImg : (mainImg.url || mainImg)}" alt="빌딩 외관">` : `
                                <div class="upload-placeholder">
                                    <span class="placeholder-icon">🏢</span>
                                    <span class="placeholder-text">클릭하여 업로드</span>
                                    <span class="placeholder-size">${IMAGE_SIZES.exterior.label}</span>
                                </div>
                            `}
                        </div>
                    </div>
                    <div>
                        <div class="preview-section-title" style="display:flex; justify-content:space-between; align-items:center;">
                            <span>LOCATION</span>
                            <div style="display:flex; gap:4px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
                                <!-- ★ v4.6: 로드뷰/캡처 버튼을 지도 밖으로 이동 -->
                                ${item.mapMode === 'auto' ? `
                                    ${building.lat && building.lng ? `<button class="info-action-btn" onclick="event.stopPropagation(); openRoadview(${building.lat}, ${building.lng})" title="로드뷰 보기" style="font-size:11px; padding:3px 7px;">👁️ 로드뷰</button>` : ''}
                                    <button class="info-action-btn" onclick="event.stopPropagation(); pasteMapFromClipboard(${idx})" title="복사한 스크린샷을 지도에 바로 붙여넣기" style="font-size:11px; padding:3px 7px; color:#2563eb; border-color:#2563eb; font-weight:600;">📋 붙여넣기</button>
                                    <button class="info-action-btn" onclick="event.stopPropagation(); generateLocationMap(${idx}, '${building.id}')" title="빌딩 중심 기본 지도 자동 생성·저장" style="font-size:11px; padding:3px 7px;">📸 지도생성</button>
                                ` : `
                                    <!-- 수동 모드: 붙여넣기 + (붙여넣은 경우만) 기본값 복원 -->
                                    <button class="info-action-btn" onclick="event.stopPropagation(); pasteMapFromClipboard(${idx})" title="복사한 스크린샷을 지도에 붙여넣기" style="font-size:11px; padding:3px 7px; color:#2563eb; border-color:#2563eb; font-weight:600;">📋 붙여넣기</button>
                                    ${item.mapImage ? `<button class="info-action-btn" onclick="event.stopPropagation(); resetToStorageMapImage(${idx}, '${building.id}')" title="붙여넣기 취소 → 저장된 기본 지도로 복원 (없으면 빈 상태)" style="font-size:11px; padding:3px 7px; color:#6b7280;">↩️ 기본값</button>` : ''}
                                `}
                                <div class="location-mode-toggle">
                                    <button class="location-mode-btn ${item.mapMode !== 'auto' ? 'active' : ''}" onclick="setMapMode(${idx}, 'manual')">📷수동</button>
                                    <button class="location-mode-btn ${item.mapMode === 'auto' ? 'active' : ''}" onclick="setMapMode(${idx}, 'auto')">🗺️자동</button>
                                </div>
                            </div>
                        </div>
                        <!-- ★ 수정: 권장 크기 표시 -->
                        <div class="preview-location-map ${item.mapMode !== 'auto' ? 'preview-editable' : ''}" 
                             id="locationMap_${idx}"
                             ${item.mapMode !== 'auto' ? `onclick="uploadImage(${idx}, 'map')"` : ''}>
                            ${item.mapMode === 'auto' ? `
                                <div class="kakao-map-container" id="kakaoMapContainer_${idx}"></div>
                            ` : ((item.mapImage || building.images?.location) ? `<img src="${item.mapImage || building.images?.location}" alt="위치">` : `
                                <div class="upload-placeholder">
                                    <span class="placeholder-icon">🗺️</span>
                                    <span class="placeholder-text">드래그앤드롭, Ctrl+V 또는 클릭</span>
                                    <span class="placeholder-size">${IMAGE_SIZES.map.label}</span>
                                </div>
                            `)}
                        </div>
                    </div>
                </div>
                
                <!-- 중앙: 빌딩 정보 + 평면도 -->
                <div class="preview-col-center">
                    <div>
                        <div class="preview-section-title" style="display:flex; justify-content:space-between; align-items:center;">
                            <span>GENERAL INFORMATION</span>
                            <div class="info-action-btns">
                                <button class="info-action-btn" onclick="fetchFromPortal('${building.id}')" title="Portal → 안내문 동기화" style="color:#0369a1; border-color:#0369a1; padding:4px 7px; font-size:15px;">⬇️</button>
                                <button class="info-action-btn" onclick="pushToPortal('${building.id}')" title="안내문 → Portal 동기화" style="color:#16a34a; border-color:#16a34a; padding:4px 7px; font-size:15px;">⬆️</button>
                                <button class="info-action-btn" onclick="openBuildingEditModal('${building.id}')" title="수동 정보 편집" style="padding:4px 7px; font-size:15px;">✏️</button>
                            </div>
                        </div>
                        <table class="preview-info-table">
                            <tr><th>주소</th><td>${building.address || '-'}</td></tr>
                            <tr><th>위치</th><td>${building.nearbyStation || '-'}</td></tr>
                            <tr><th>연면적</th><td>${formatArea(building.grossFloorPy)} 평 (${formatNumber((building.grossFloorPy || 0) * 3.3058)}㎡)</td></tr>
                            <tr><th>규모</th><td>B${building.floorsBelow || 0} / ${building.floorsAbove || 0}F</td></tr>
                            <tr><th>준공년도</th><td>${building.completionYear || '-'}</td></tr>
                            <tr><th>기준층(임대/전용)</th><td>${formatTypicalFloor(building)}</td></tr>
                            <tr><th>전용률</th><td>${(()=>{ const v = building.exclusiveRate || building.area?.exclusiveRate; const n = parseFloat(v); return (!v || isNaN(n) || n === 0) ? '-' : n.toFixed(2) + '%'; })()}</td></tr>
                            <tr><th>E/V</th><td>총 ${(()=>{ const n=cleanUnitValue(building.elevatorTotal??building.specs?.passengerElevator); return n!==null?n+'대':'-'; })()}</td></tr>
                            <tr><th>주차</th><td>총 ${(()=>{ const n=cleanUnitValue(building.parkingTotal??building.parking?.total); return n!==null?n+'대':'-'; })()}${building.parkingNote ? '<br><span style="font-size:10px; color:#555;">' + String(building.parkingNote).replace(/^대\s*/, '').replace(/\n/g, '<br>') + '</span>' : ''}</td></tr>
                        </table>
                    </div>
                    <div>
                        <div class="preview-section-title" style="display:flex; justify-content:space-between; align-items:center;">
                            <span>TYPICAL FLOOR PLAN</span>
                            <button class="info-action-btn" onclick="event.stopPropagation(); pasteFloorPlanFromClipboard(${idx})" title="복사한 평면도 이미지를 바로 붙여넣기" style="font-size:11px; padding:3px 7px; color:#2563eb; border-color:#2563eb; font-weight:600;">📋 붙여넣기</button>
                        </div>
                        <!-- ★ 수정: 권장 크기 표시 -->
                        <div class="preview-floor-plan preview-editable" id="floorPlanBox_${idx}" tabindex="0" title="클릭 업로드 · 드래그&드롭 · Ctrl+V 붙여넣기" onclick="uploadImage(${idx}, 'floorplan')">
                            ${floorPlanImg ? `<img src="${typeof floorPlanImg === 'string' ? floorPlanImg : (floorPlanImg.url || floorPlanImg)}" alt="평면도">` : `
                                <div class="upload-placeholder">
                                    <span class="placeholder-icon">📐</span>
                                    <span class="placeholder-text">평면도 업로드</span>
                                    <span class="placeholder-size">${IMAGE_SIZES.floorplan.label}</span>
                                </div>
                            `}
                        </div>
                    </div>
                </div>
                
                <!-- 우측: 공실 + 임대조건 + 담당자 -->
                <div class="preview-col-right">
                    <div>
                        <div class="preview-section-title" style="display:flex; justify-content:space-between; align-items:center;">
                            <span>SPACE AVAILABILITY</span>
                            <span class="preview-unit-note">${vacCols.unitNote}</span>
                        </div>
                        <table class="preview-vacancy-table">
                            <thead>
                                <tr>
                                    <th class="sortable-header" onclick="toggleVacancySort(${idx})" style="cursor:pointer;" title="클릭하여 정렬 변경">
                                        ${vacCols.editor[0]} ${item.vacancySortOrder === 'asc' ? '▲' : '▼'}
                                    </th>
                                    ${vacCols.editor.slice(1).map(h => `<th>${h}</th>`).join('')}
                                </tr>
                            </thead>
                            <tbody id="previewVacancyBody_${idx}">
                                ${buildPreviewVacancyRowsHTML(item, allVacancies, guideType)}
                            </tbody>
                        </table>
                    </div>
                    
                    <!-- 임대 조건 -->
                    <div class="preview-rent-section">
                        <div class="preview-section-title">RENT <span style="font-weight:normal; font-size:8px; color:#94a3b8;">${guideType === 'retail' ? '(단위:원/월 총액)' : '(단위:원/임대평)'}</span></div>
                        <table class="preview-rent-table">
                            ${guideType === 'retail' ? renderRetailRentHTML(idx, item, allVacancies) : `
                            <tr>
                                <th>구분</th>
                                <th>보증금</th>
                                <th>임대료</th>
                                <th>관리비</th>
                            </tr>
                            ${(() => {
                                const selectedIds = item.selectedFloorPricingIds || [];
                                const fps = item.floorPricing || [];
                                const selectedFps = selectedIds.map(id => fps.find((fp, i) => (fp.id || String(i)) === id)).filter(Boolean);
                                // 1) 명시적으로 선택·반영한 기준가가 있으면 그것을 표시
                                if (selectedFps.length > 0) {
                                    return selectedFps.map(fp => `
                                        <tr>
                                            <td>${fp.label || fp.floorRange || '기준층'}</td>
                                            <td>${formatPriceWon(fp.depositPy)}</td>
                                            <td>${formatPriceWon(fp.rentPy)}</td>
                                            <td>${formatPriceWon(fp.maintenancePy)}</td>
                                        </tr>
                                    `).join('');
                                }
                                // ★ [B-2] 2) 선택이 없으면 기준가 1순위(floorPricing[0])를 자동 표시
                                if (fps.length > 0) {
                                    const fp = fps[0];
                                    return `<tr>
                                        <td>${fp.label || fp.floorRange || '기준층'}</td>
                                        <td>${formatPriceWon(fp.depositPy)}</td>
                                        <td>${formatPriceWon(fp.rentPy)}</td>
                                        <td>${formatPriceWon(fp.maintenancePy)}</td>
                                    </tr>`;
                                }
                                // 3) 기준가가 전혀 없으면 빌딩 기본값으로 폴백
                                return `<tr>
                                    <td>${building.rentLabel || '기준층'}</td>
                                    <td>${formatPriceWon(building.depositPy)}</td>
                                    <td>${formatPriceWon(building.rentPy)}</td>
                                    <td>${formatPriceWon(building.maintenancePy)}</td>
                                </tr>`;
                            })()}
                            `}
                        </table>
                        ${guideType === 'retail' ? `
                        <div style="display:flex; gap:4px; align-items:center; margin-top:4px;">
                            <select onchange="setItemRoundUnit(${idx}, this.value)" title="이 장표의 금액 표기 단위 (문서 기본값을 덮어씁니다)"
                                style="flex:none; padding:3px 4px; border:1px dashed #cbd5e1; border-radius:4px; font-size:8px; color:#64748b; background:#fff; cursor:pointer;">
                                <option value="" ${item.retailRoundUnit === undefined ? 'selected' : ''}>문서기본(${RETAIL_ROUND_UNITS.find(u => u.value === (state.retailRoundUnit ?? 0))?.label || '원'})</option>
                                ${RETAIL_ROUND_UNITS.map(u => `<option value="${u.value}" ${item.retailRoundUnit === u.value ? 'selected' : ''}>${u.label}</option>`).join('')}
                            </select>
                            <input type="text" class="retail-rent-note-input"
                                value="${(item.retailRentNote || '').replace(/"/g, '&quot;')}"
                                onchange="updateRetailRentNote(${idx}, this.value)"
                                placeholder="각주 (예: *보증금 별도  *4구비 별도)"
                                style="flex:1; min-width:0; box-sizing:border-box; padding:3px 6px; border:1px dashed #cbd5e1; border-radius:4px; font-size:8px; color:#64748b;">
                        </div>
                        ` : ''}
                    </div>
                    
                    <!-- NOTE -->
                    ${noteHtml}
                    
                    <!-- Contact Point - v4.6: 변경/해지 버튼 추가 -->
                    <div class="preview-contact-section">
                        ${(() => {
                            // ★ v4.6: window.renderContactSectionWithActions 함수가 있으면 사용
                            if (typeof window.renderContactSectionWithActions === 'function') {
                                const buildingContacts = item.contactPoints || building.contactPoints || [];
                                return window.renderContactSectionWithActions(
                                    buildingContacts,
                                    building.id,
                                    building.name,
                                    idx
                                );
                            }
                            
                            // Fallback: 기존 담당자 테이블 (변경/해지 버튼 추가)
                            const buildingContacts = item.contactPoints || building.contactPoints || [];
                            const contacts = buildingContacts.length > 0 
                                ? buildingContacts 
                                : (window.DEFAULT_CONTACT_POINTS || []);
                            const isDefault = !(buildingContacts.length > 0) || window.isDefaultContactPoints?.(buildingContacts);
                            
                            let html = `
                                <div class="preview-section-title" style="display:flex; justify-content:space-between; align-items:center;">
                                    <span>CONTACT POINT</span>
                                    <div style="display:flex; gap:6px; align-items:center;">
                                        <span class="${isDefault ? 'default-badge' : 'custom-badge'}" style="font-size:10px; padding:2px 8px; border-radius:10px; ${isDefault ? 'background:#e5e7eb; color:#6b7280;' : 'background:#dbeafe; color:#1d4ed8;'}">
                                            ${isDefault ? '기본값' : '지정됨'}
                                        </span>
                                        <button class="info-action-btn" onclick="openContactChangeModal('${building.id}', '${building.name.replace(/'/g, "\\'")}', ${idx}, ${JSON.stringify(contacts).replace(/"/g, '&quot;')})" style="font-size:11px; padding:4px 8px;">변경</button>
                                        ${!isDefault ? `<button class="info-action-btn" onclick="resetBuildingToDefaultContacts(${idx})" style="font-size:11px; padding:4px 8px; color:#dc2626;">해지</button>` : ''}
                                    </div>
                                </div>
                                <table class="preview-contact-table">
                                    <tr>
                                        <th>Name</th>
                                        <th>Phone</th>
                                        <th>Email</th>
                                    </tr>
                            `;
                            
                            if (contacts.length > 0) {
                                html += contacts.slice(0, 4).map(c => {
                                    const nameDisplay = c.name ? (c.position ? c.name + '(' + c.position + ')' : c.name) : '-';
                                    const phoneDisplay = c.phone || c.mobile || '-';
                                    const emailDisplay = c.email || '-';
                                    return '<tr><td>' + nameDisplay + '</td><td>' + phoneDisplay + '</td><td>' + emailDisplay + '</td></tr>';
                                }).join('');
                            } else {
                                html += '<tr><td colspan="3" style="color:#94a3b8;">No contacts</td></tr>';
                            }
                            
                            html += '</table>';
                            return html;
                        })()}
                    </div>
                </div>
            </div>
        </div>
        
        <!-- 이미지 관리 섹션 -->
        <div class="image-manager" id="imageManagerSection">
            <div class="image-manager-header">
                <div class="image-manager-title">📷 이미지 관리</div>
                <div class="image-tabs">
                    <button class="image-tab active" data-type="exterior" onclick="switchImageTab(${idx}, 'exterior', this)">외관 (${item.exteriorImages.length})</button>
                    <button class="image-tab" data-type="floorplan" onclick="switchImageTab(${idx}, 'floorplan', this)">평면도 (${item.floorPlanImages.length})</button>
                    <button class="image-tab" data-type="map" onclick="switchImageTab(${idx}, 'map', this)">지도 (${(item.mapImage || building.images?.location) ? 1 : 0})</button>
                </div>
            </div>
            <div class="image-size-info">
                💡 권장 크기: 외관/평면도 <strong>800×600px</strong> | 지도 <strong>600×400px</strong> (가로 비율 4:3)
            </div>
            <div class="image-grid" id="imageGrid">
                ${item.exteriorImages.length > 0
                    ? item.exteriorImages.map((img, i) => renderImageThumb(idx, 'exterior', img, i, item.mainImageIndex === i)).join('')
                    : '<div class="image-empty">등록된 외관 이미지가 없습니다</div>'}
                <button class="image-add-btn" onclick="uploadImage(${idx}, 'exterior')" title="이미지 추가">+</button>
            </div>
        </div>
        
        <!-- 기준가 관리 섹션 -->
        <div class="image-manager" id="floorPricingSection">
            <div class="image-manager-header" style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                <div class="image-manager-title">💰 기준가 관리</div>
                <button onclick="refreshGuidePreview(${idx})" title="편집·추가한 값을 위 미리보기에 반영" style="padding:6px 14px; background:white; color:#0369a1; border:1px solid #7dd3fc; border-radius:6px; font-size:12px; font-weight:700; cursor:pointer; white-space:nowrap;">🔄 미리보기 새로고침</button>
            </div>
            ${guideType === 'retail' ? `
            <!-- ★ v6.23: 리테일에서는 기준가가 RENT 표에 반영되지 않는다.
                 안내는 접힘 바깥에 크게 두고, 조작 UI만 접는다.
                 섹션을 숨기지 않는 이유 — Portal 노출(직접입력) 대상 선택이 여기서만 가능하다. -->
            <div style="margin:10px 0 0; padding:14px 16px; background:#fffbeb; border:1px solid #fcd34d; border-left:4px solid #f59e0b; border-radius:8px; color:#92400e; line-height:1.7;">
                <div style="font-size:14px; font-weight:800; margin-bottom:6px;">🛍️ 리테일 문서 — 여기는 RENT 표와 무관합니다</div>
                <div style="font-size:12.5px;">
                    위 RENT 표는 <strong>공실 현황의 임대료·관리비 × 임대면적</strong>으로 만들어집니다.
                    금액을 고치려면 <strong>공실 현황</strong>의 해당 행을 수정하세요.
                </div>
                <div style="font-size:12.5px; margin-top:6px; padding-top:6px; border-top:1px dashed #fcd34d;">
                    이 영역은 <strong>Portal 빌딩 상세에 어떤 기준가를 노출할지 고르는</strong> 용도로만 동작합니다.
                </div>
            </div>
            <details id="fpFold_${idx}" style="margin-top:10px; border:1px solid #e2e8f0; border-radius:8px; background:#fff;">
                <summary style="cursor:pointer; padding:9px 12px; font-size:12px; font-weight:700; color:#475569; list-style:none; display:flex; align-items:center; justify-content:space-between; gap:8px;">
                    <span>📤 Portal 노출 기준가 설정</span>
                    <span style="font-weight:600; color:#94a3b8; font-size:11px;">
                        기준가 ${(item.floorPricing?.length || 0)}건 · Portal 노출 ${building.guideFloorPricing?.show ? 'ON' : 'OFF'} · 클릭하여 펼치기
                    </span>
                </summary>
                <div style="padding:0 4px 6px;">` : ''}
            
            <!-- 기준층 정보 -->
            <div class="standard-floor-section">
                <div style="margin-bottom:8px;">
                    <div class="standard-floor-title">📐 기준층 정보 직접 입력</div>
                    <div style="font-size:11px; color:#64748b; margin-top:3px; line-height:1.6;">
                        ${guideType === 'retail'
                            ? '입력한 값은 <strong>Portal 빌딩 기준가</strong>에만 저장됩니다. 안내문 RENT 표에는 반영되지 않습니다.'
                            : '기준가 정보가 미입력된 경우 직접 입력하거나 하단 기준가를 선택·반영하세요.'}
                        저장 시 CRE Portal 해당 빌딩 기준가에 <strong style="color:#0369a1;">직접입력</strong> 구분으로 저장됩니다.
                    </div>
                    <label style="display:flex; align-items:center; gap:7px; margin-top:8px; padding:8px 10px; background:#fff; border:1px solid #bae6fd; border-radius:6px; font-size:12px; color:#334155; cursor:pointer;">
                        <input type="checkbox" ${building.guideFloorPricing?.show ? 'checked' : ''} onchange="toggleFloorPricingPortalExpose(${idx}, '${building.id}', this.checked)" style="width:15px; height:15px; cursor:pointer; accent-color:#2563eb;">
                        <span>📤 선택·반영된 기준가를 <strong>Portal 빌딩 상세 · 안내문</strong>에 직접입력으로 노출 <span style="color:#94a3b8;">(반영 후 다시 체크하면 갱신)</span></span>
                    </label>
                </div>
                <!-- 직접입력 행 목록 -->
                <div id="directInputRows_${idx}">
                    ${renderDirectInputRows(idx, building)}
                </div>
                <!-- 헤더 라벨 + 추가 버튼 -->
                <div style="display:grid; grid-template-columns:1.1fr 1fr 1fr 1fr auto; gap:8px; align-items:center; padding:2px 8px; margin-bottom:4px;">
                    <span style="font-size:11px; color:#94a3b8; font-weight:600; text-transform:uppercase;">구분</span>
                    <span style="font-size:11px; color:#94a3b8; font-weight:600; text-transform:uppercase; text-align:right;">보증금(원/평)</span>
                    <span style="font-size:11px; color:#94a3b8; font-weight:600; text-transform:uppercase; text-align:right;">임대료(원/평)</span>
                    <span style="font-size:11px; color:#94a3b8; font-weight:600; text-transform:uppercase; text-align:right;">관리비(원/평)</span>
                    <button onclick="addDirectRow(${idx}, '${building.id}')"
                        style="padding:4px 10px; background:#f0f9ff; color:#0369a1; border:1px dashed #7dd3fc; border-radius:4px; font-size:11px; font-weight:600; cursor:pointer; white-space:nowrap;">
                        + 행 추가
                    </button>
                </div>
                ${item.floorPricing && item.floorPricing.length > 0 ? `
                    <div style="margin-top:12px; padding:12px; background:#f0f9ff; border:1px solid #bae6fd; border-radius:8px;">
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; flex-wrap:wrap;">
                            <div style="font-size:13px; font-weight:700; color:#0369a1; display:flex; align-items:center; gap:8px;">
                                ${guideType === 'retail' ? '📤 Portal 노출 기준가 선택' : '💰 기준가 선택'}
                                <span style="font-weight:400; color:#64748b; font-size:11px;">${guideType === 'retail'
                                    ? '체크한 항목만 Portal 빌딩 상세에 노출 · ↕로 노출 순서 변경'
                                    : '체크 후 반영 · 선택 항목은 ↕로 노출 순서 변경'}</span>
                            </div>
                            ${guideType === 'retail' ? '' : `
                            <button onclick="applyAllSelectedFloorPricing(${idx})"
                                style="padding:7px 18px; background:#2563eb; color:#fff; border:none; border-radius:6px; font-size:13px; font-weight:700; cursor:pointer; white-space:nowrap;">
                                ✓ 반영
                            </button>`}
                        </div>
                        <table style="width:100%; border-collapse:collapse; font-size:13px;">
                            <thead>
                                <tr style="background:#e0f2fe;">
                                    <th style="padding:5px 6px; text-align:center; font-weight:700; color:#0369a1; border-bottom:1px solid #bae6fd; width:30px;">
                                        <input type="checkbox" id="fpCheckAll_${idx}" onchange="toggleAllFloorPricingCheck(${idx}, this.checked)" style="cursor:pointer; width:15px; height:15px;">
                                    </th>
                                    <th style="padding:5px 8px; text-align:left; font-weight:700; color:#0369a1; border-bottom:1px solid #bae6fd;">구분</th>
                                    <th style="padding:5px 8px; text-align:right; font-weight:700; color:#0369a1; border-bottom:1px solid #bae6fd;">보증금</th>
                                    <th style="padding:5px 8px; text-align:right; font-weight:700; color:#0369a1; border-bottom:1px solid #bae6fd;">임대료</th>
                                    <th style="padding:5px 8px; text-align:right; font-weight:700; color:#0369a1; border-bottom:1px solid #bae6fd;">관리비</th>
                                    <th style="padding:5px 6px; text-align:center; font-weight:700; color:#0369a1; border-bottom:1px solid #bae6fd; font-size:11px;">출처</th>
                                    <th style="padding:5px 4px; text-align:center; font-weight:700; color:#0369a1; border-bottom:1px solid #bae6fd; width:50px;">순서</th>
                                    <th style="padding:5px 4px; border-bottom:1px solid #bae6fd; width:30px;"></th>
                                </tr>
                            </thead>
                            <tbody id="floorPricingList_${idx}">
                            ${item.floorPricing.map((fp, fi) => {
                                const fpId = fp.id || String(fi);
                                const selectedIds = item.selectedFloorPricingIds || [];
                                const selPos = selectedIds.indexOf(fpId);
                                const isSelected = selPos >= 0;
                                const label = fp.label || fp.floorRange || ('기준가 ' + (fi+1));
                                const dep = fp.depositPy ? fp.depositPy.toLocaleString() : '-';
                                const rent = fp.rentPy ? fp.rentPy.toLocaleString() : '-';
                                const maint = fp.maintenancePy ? fp.maintenancePy.toLocaleString() : '-';
                                const source = (fp.source || fp.company || '') + (fp.publishDate ? ' ' + fp.publishDate : '');
                                const rowBg = isSelected ? '#f0fdf4' : 'white';
                                const searchKey = (label + ' ' + source).toLowerCase().replace(/"/g, '');
                                const badge = isSelected ? '<span style="display:inline-block; min-width:17px; height:17px; line-height:17px; text-align:center; background:#16a34a; color:#fff; border-radius:50%; font-size:10px; font-weight:700; margin-right:6px;">' + (selPos+1) + '</span>' : '';
                                const orderCell = isSelected
                                    ? '<button onclick="moveFloorPricingOrder(' + idx + ', \'' + fpId + '\', -1)" title="위로" ' + (selPos === 0 ? 'disabled' : '') + ' style="font-size:11px; padding:1px 5px; border:1px solid #cbd5e1; border-radius:3px; background:#fff; color:#0369a1; cursor:pointer; opacity:' + (selPos === 0 ? '0.35' : '1') + ';">▲</button>'
                                      + '<button onclick="moveFloorPricingOrder(' + idx + ', \'' + fpId + '\', 1)" title="아래로" ' + (selPos === selectedIds.length - 1 ? 'disabled' : '') + ' style="font-size:11px; padding:1px 5px; border:1px solid #cbd5e1; border-radius:3px; background:#fff; color:#0369a1; cursor:pointer; opacity:' + (selPos === selectedIds.length - 1 ? '0.35' : '1') + '; margin-left:3px;">▼</button>'
                                    : '<span style="color:#cbd5e1; font-size:11px;">–</span>';
                                return '<tr id="fpRow_' + idx + '_' + fi + '" data-fpsearch="' + searchKey + '" style="background:' + rowBg + '; border-bottom:1px solid #e0f2fe;">'
                                    + '<td style="padding:6px 6px; text-align:center;">'
                                    +   '<input type="checkbox" data-fpid="' + fpId + '" ' + (isSelected ? 'checked' : '') + ' onchange="toggleFloorPricingCheck(' + idx + ', \'' + fpId + '\', this.checked)" style="cursor:pointer; width:15px; height:15px;">'
                                    + '</td>'
                                    + '<td style="padding:6px 8px; font-weight:600;">' + badge + label + '</td>'
                                    + '<td style="padding:6px 8px; text-align:right; color:#334155;">' + dep + '</td>'
                                    + '<td style="padding:6px 8px; text-align:right; color:#334155;">' + rent + '</td>'
                                    + '<td style="padding:6px 8px; text-align:right; color:#334155;">' + maint + '</td>'
                                    + '<td style="padding:6px 6px; text-align:center; color:#64748b; font-size:11px;">' + (source || '-') + '</td>'
                                    + '<td style="padding:6px 4px; text-align:center; white-space:nowrap;">' + orderCell + '</td>'
                                    + '<td style="padding:6px 4px; text-align:center;">'
                                    +   '<button onclick="editFloorPricingInline(' + idx + ',' + fi + ')" title="항목 편집" style="font-size:13px; padding:2px 5px; border:1px solid #e2e8f0; border-radius:4px; background:#fff; color:#64748b; cursor:pointer;">✏️</button>'
                                    + '</td>'
                                    + '</tr>';
                            }).join('')}
                            </tbody>
                        </table>
                    </div>
                ` : ''}
            </div>
            ${guideType === 'retail' ? `</div></details>` : ''}
        </div>

        <!-- 공실 관리 섹션 -->
        <div class="image-manager" id="vacancySection">
            <div class="image-manager-header" style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                <div class="image-manager-title">🏠 공실 관리</div>
                <button onclick="refreshGuidePreview(${idx})" title="편집·추가한 값을 위 미리보기에 반영" style="padding:6px 14px; background:white; color:#0369a1; border:1px solid #7dd3fc; border-radius:6px; font-size:12px; font-weight:700; cursor:pointer; white-space:nowrap;">🔄 미리보기 새로고침</button>
            </div>
            <div class="vacancy-section">
                <div class="vacancy-header">
                    <div class="vacancy-count-info">
                        <span class="vacancy-current-count ${allVacancies.length >= MAX_VACANCIES_PER_BUILDING ? 'over-limit' : ''}">${allVacancies.length}</span>
                        <span class="vacancy-max-count">/ ${MAX_VACANCIES_PER_BUILDING}개</span>
                        <span class="vacancy-limit-hint">(출력 최대)</span>
                    </div>
                    <button class="btn btn-sm btn-secondary" onclick="openVacancyAddPanel(${idx})" ${allVacancies.length >= MAX_VACANCIES_PER_BUILDING ? 'disabled title="최대 개수 초과"' : ''}>+ 공실 추가</button>
                </div>
                
                ${allVacancies.length >= MAX_VACANCIES_PER_BUILDING ? `
                <div class="vacancy-warning">
                    ⚠️ 출력 가능한 최대 공실 개수(${MAX_VACANCIES_PER_BUILDING}개)에 도달했습니다. 더 추가하면 인쇄 시 잘릴 수 있습니다.
                </div>
                ` : ''}
                
                <!-- 공실 추가 패널 -->
                <div class="vacancy-add-panel" id="vacancyAddPanel" style="display:none;">
                    <div style="display:flex; border-bottom:2px solid #e2e8f0; margin-bottom:0; background:#f8fafc; border-radius:8px 8px 0 0; overflow:hidden;">
                        <button id="vacTabDirect_${idx}" onclick="switchVacancyAddTab('direct',${idx})"
                            style="flex:1; padding:10px 16px; font-size:13px; font-weight:700; border:none; cursor:pointer; background:#2563eb; color:white; display:flex; align-items:center; justify-content:center; gap:6px; transition:all 0.15s;">
                            ✏️ 직접 입력
                        </button>
                        <button id="vacTabExternal_${idx}" onclick="switchVacancyAddTab('external',${idx})"
                            style="flex:1; padding:10px 16px; font-size:13px; font-weight:700; border:none; cursor:pointer; background:#f8fafc; color:#64748b; display:flex; align-items:center; justify-content:center; gap:6px; border-left:1px solid #e2e8f0; transition:all 0.15s;">
                            🏢 타사 공실에서 선택
                        </button>
                    </div>
                    
                    <!-- 직접 입력 (수동입력) -->
                    <div id="addVacancyDirect_${idx}" class="vacancy-add-content">
                        <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:12px 10px;">
                            <div style="display:flex; flex-direction:column; gap:4px;">
                                <label style="font-size:11px; font-weight:600; color:#64748b;">층</label>
                                <input type="text" id="newVacFloor" placeholder="예: 15" style="width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px; text-align:center;">
                            </div>
                            <div style="display:flex; flex-direction:column; gap:4px;">
                                <label style="font-size:11px; font-weight:600; color:#64748b;">전용면적(평)</label>
                                <input type="text" id="newVacExclusive" class="js-comma" inputmode="decimal" placeholder="0" style="width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px; text-align:right;">
                            </div>
                            <div style="display:flex; flex-direction:column; gap:4px;">
                                <label style="font-size:11px; font-weight:600; color:#64748b;">임대면적(평)</label>
                                <input type="text" id="newVacArea" class="js-comma" inputmode="decimal" placeholder="0" style="width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px; text-align:right;">
                            </div>
                            <div style="display:flex; flex-direction:column; gap:4px;">
                                <label style="font-size:11px; font-weight:600; color:#64748b;">보증금(원/평)</label>
                                <input type="text" id="newVacDeposit" class="js-comma" inputmode="decimal" placeholder="문의" style="width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px; text-align:right;">
                            </div>
                            <div style="display:flex; flex-direction:column; gap:4px;">
                                <label style="font-size:11px; font-weight:600; color:#64748b;">임대료(원/평)</label>
                                <input type="text" id="newVacRent" class="js-comma" inputmode="decimal" placeholder="문의" style="width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px; text-align:right;">
                            </div>
                            <div style="display:flex; flex-direction:column; gap:4px;">
                                <label style="font-size:11px; font-weight:600; color:#64748b;">관리비(원/평)</label>
                                <input type="text" id="newVacMaintenance" class="js-comma" inputmode="decimal" placeholder="문의" style="width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px; text-align:right;">
                            </div>
                        </div>
                        <div style="display:flex; gap:10px; align-items:flex-end; margin-top:12px;">
                            <div style="display:flex; flex-direction:column; gap:4px; width:200px;">
                                <label style="font-size:11px; font-weight:600; color:#64748b;">입주시기</label>
                                <div style="position:relative;">
                                    <input type="text" id="newVacMoveIn" value="즉시" style="width:100%; box-sizing:border-box; padding:8px 32px 8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px;">
                                    <button type="button" onclick="clearMoveInField('newVacMoveIn')" title="지우고 직접 입력" style="position:absolute; right:6px; top:50%; transform:translateY(-50%); width:20px; height:20px; border:none; background:#e2e8f0; color:#64748b; border-radius:50%; cursor:pointer; font-size:12px; line-height:1; display:flex; align-items:center; justify-content:center; padding:0;">×</button>
                                </div>
                            </div>
                            <button onclick="addDirectVacancy(${idx})" style="flex-shrink:0; padding:9px 26px; background:#2563eb; color:#fff; border:none; border-radius:6px; font-size:14px; font-weight:700; cursor:pointer;">+ 추가</button>
                        </div>
                    </div>
                    
                    <!-- 타사 공실 -->
                    <div id="addVacancyExternal_${idx}" class="vacancy-add-content" style="display:none;">
                        <div class="external-vacancy-container">
                            <!-- 리스트 영역 -->
                            <div class="external-vacancy-list">
                                <div class="external-vacancy-header">
                                    <div class="external-vacancy-filters">
                                        <select id="extSourceFilter_${idx}" onchange="filterExternalVacancies(${idx})">
                                            <option value="all">전체 출처</option>
                                            ${getUniqueSourcesHtml(externalVacancies)}
                                        </select>
                                        <select id="extDateFilter_${idx}" onchange="filterExternalVacancies(${idx})">
                                            <option value="all">전체 날짜</option>
                                            ${getUniqueDatesHtml(externalVacancies)}
                                        </select>
                                    </div>
                                    <span style="display:flex; align-items:center; gap:10px;">
                                        <button id="extExpandToggle_${idx}" onclick="expandAllExternalGroups(${idx})" style="font-size:11px; padding:4px 10px; border:1px solid #cbd5e1; border-radius:5px; background:#fff; color:#0369a1; cursor:pointer; white-space:nowrap;">▼ 모두 펼치기</button>
                                        <span class="external-vacancy-count" style="font-size:11px; color:#64748b;">총 ${externalVacancies.length}건</span>
                                    </span>
                                </div>
                                <!-- 컬럼 헤더 -->
                                <div class="external-vacancy-group-th">
                                    <span></span>
                                    <span>층</span>
                                    <span>전용/임대</span>
                                    <span>보증금</span>
                                    <span>임대료</span>
                                    <span>관리비</span>
                                    <span>입주시기</span>
                                </div>
                                <div class="external-vacancy-legend" style="display:flex; gap:14px; padding:5px 10px; font-size:10px; color:#64748b; background:#fafbfc; border-bottom:1px solid var(--border-color);">
                                    <span>🔵 선택 (반영 전)</span>
                                    <span>🟢 반영됨 (공실 현황에 추가됨)</span>
                                    <span style="margin-left:auto; color:#94a3b8;">클릭=선택 · 다시 클릭=해제</span>
                                </div>
                                <div class="external-vacancy-body" id="extVacancyBody_${idx}">
                                    ${renderExternalVacancyGroups(externalVacancies, item.selectedExternalVacancies || [], idx)}
                                </div>
                            </div>
                            
                            <!-- 하단 선택 현황 패널 -->
                            <div class="external-vacancy-cart" id="extCartPanel_${idx}">
                                <div class="external-vacancy-cart-header">
                                    <h5>🛒 선택 바구니 <span style="font-weight:400; color:#64748b; font-size:11px;">(반영 전)</span> <span id="extSelectedCount_${idx}" style="background:#2563eb; color:white; padding:1px 7px; border-radius:10px; font-size:11px; margin-left:4px;">${item.pendingExternalVacancies?.length || 0}</span></h5>
                                    <span id="extCartStatus_${idx}">${(() => { const _p = item.pendingExternalVacancies?.length || 0; const _c = item.selectedExternalVacancies?.length || 0; if (_p === 0) return _c ? '<span style="font-size:11px; color:#16a34a; font-weight:600;">🟢 반영됨 ' + _c + '</span>' : '<span style="font-size:11px; color:#94a3b8;">공실을 선택하세요</span>'; return '<span style="font-size:11px; color:#2563eb; font-weight:700;">🔵 선택 ' + _p + '</span>' + (_c ? ' <span style="font-size:11px; color:#16a34a; font-weight:600;">· 🟢 반영됨 ' + _c + '</span>' : '') + ' <span style="font-size:11px; color:#94a3b8;">— [반영] 누르면 공실 현황에 추가</span>'; })()}</span>
                                    <div class="ext-cart-actions">
                                        <button class="btn-reset" onclick="clearExternalCart(${idx})">선택 해제</button>
                                        <button class="btn-apply" onclick="applyPendingExternalVacancies(${idx})">✓ 반영</button>
                                    </div>
                                </div>
                                <div class="external-vacancy-cart-body" id="extCartBody_${idx}">
                                    ${renderExternalCartTags(item.selectedExternalVacancies || [], item.pendingExternalVacancies || [], idx)}
                                </div>
                            </div>
                            
                            <div class="external-vacancy-notice" style="border-radius:0 0 8px 8px; padding:8px 12px; font-size:11px;">
                                💡 리스트에서 공실을 <strong>클릭(체크)해 선택</strong>한 뒤 <strong>[반영]</strong>을 누르면 위 공실 현황 표에 추가됩니다. 여러 출처를 모아 한 번에 반영(중복 자동 정리)할 수 있어요.
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- 선택된 공실 목록 (기준가 선택 패널과 동일 스타일 카드) -->
                <div style="margin-top:12px; padding:12px; background:#f0f9ff; border:1px solid #bae6fd; border-radius:8px;">
                    <div style="font-size:13px; font-weight:700; color:#0369a1; margin-bottom:8px; display:flex; align-items:center; gap:8px;">✓ 선택된 공실 <span style="font-weight:400; color:#64748b; font-size:11px;">출력에 반영될 공실 목록</span></div>
                    <label style="display:flex; align-items:center; gap:7px; margin-bottom:10px; padding:8px 10px; background:#fff; border:1px solid #bae6fd; border-radius:6px; font-size:12px; color:#334155; cursor:pointer;">
                        <input type="checkbox" ${building.guideVacancy?.show ? 'checked' : ''} onchange="toggleVacancyPortalExpose(${idx}, '${building.id}', this.checked)" style="width:15px; height:15px; cursor:pointer; accent-color:#2563eb;">
                        <span>📤 이 공실을 <strong>Portal 빌딩 상세 · 안내문</strong>에 직접입력으로 노출 <span style="color:#94a3b8;">(수정 후 다시 체크하면 갱신)</span></span>
                    </label>
                    <table class="vacancy-list-table">
                    <thead>
                        <tr>
                            <th>층</th>
                            <th>전용(평)</th>
                            <th>임대(평)</th>
                            <th>보증금</th>
                            <th>임대료</th>
                            <th>관리비</th>
                            <th>입주시기</th>
                            <th>출처</th>
                            <th>관리</th>
                        </tr>
                    </thead>
                    <tbody id="vacancyListBody_${idx}">
                        ${allVacancies.length > 0 ? allVacancies.map((v, i) => `
                            <tr id="vacRow_${idx}_${i}" data-vacid="${v.id}" data-vactype="${v.type}">
                                <td class="floor">${formatFloorDisplay(v.floor)}</td>
                                <td>${fmtVacMoney(v.exclusiveArea || v.area, '-')}</td>
                                <td>${fmtVacMoney(v.rentArea || v.area, '-')}</td>
                                <td>${fmtVacMoney(v.deposit ?? v.depositPy)}</td>
                                <td>${fmtVacMoney(v.rent ?? v.rentPy)}</td>
                                <td>${fmtVacMoney(v.maintenance ?? v.maintenancePy)}</td>
                                <td>${v.moveIn || v.moveInDate || '협의'}</td>
                                <td style="font-size:11px; line-height:1.35;">${(v.source || v.company) ? (v.source || v.company) : '<span style="color:#cbd5e1;">-</span>'}${(v.publishDate || v.date) ? '<br><span style="color:#94a3b8;">' + (v.publishDate || v.date) + '</span>' : ''}</td>
                                <td>
                                    <div class="actions">
                                        <button onclick="startVacancyRowEdit(${idx}, '${v.id}', '${v.type}', this)" title="인라인 편집" style="font-size:13px; padding:2px 6px; border:1px solid #e2e8f0; border-radius:4px; background:#fff; color:#64748b; cursor:pointer;">✏️</button>
                                        <button onclick="copyVacancyRow(${idx}, '${v.id}', '${v.type}')" title="이 공실 복사(행 추가)" style="font-size:13px; padding:2px 6px; border:1px solid #bbf7d0; border-radius:4px; background:#fff; color:#16a34a; cursor:pointer; margin-left:3px;">⧉</button>
                                        <button onclick="removeSelectedVacancy(${idx}, '${v.id}', '${v.type}')" title="삭제" style="font-size:13px; padding:2px 7px; border:1px solid #fecaca; border-radius:4px; background:#fff; color:#dc2626; cursor:pointer; margin-left:3px;">×</button>
                                    </div>
                                </td>
                            </tr>
                        `).join('') : `<tr><td colspan="9" style="text-align:center; padding:30px; color:#94a3b8;">등록된 공실이 없습니다</td></tr>`}
                    </tbody>
                </table>
                </div>
            </div>
        </div>
    `;
        
    // ★ v6.2: 이중 바인딩 제거 — 아코디언 클릭은 인라인 onclick(toggleExternalVacancyItem) 단독 처리
        
    // 숨겨진 파일 input 추가
    if (!document.getElementById('imageUploadInput')) {
        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'imageUploadInput';
        input.accept = 'image/*';
        input.multiple = true;
        input.style.display = 'none';
        document.body.appendChild(input);
    }
    
    // ★ v5.2: 수동 모드 LOCATION 드래그앤드롭 + Ctrl+V 이벤트 바인딩
    if (item.mapMode !== 'auto') {
        setTimeout(() => {
            const locationMap = document.getElementById(`locationMap_${idx}`);
            if (locationMap) {
                setupLocationDropAndPaste(locationMap, idx);
            }
        }, 100);
    }

    // ★ v6.12: 평면도 미리보기 박스 드래그앤드롭 + Ctrl+V 붙여넣기 (지도와 동일)
    setTimeout(() => {
        const fpBox = document.getElementById(`floorPlanBox_${idx}`);
        if (fpBox) setupFloorPlanDropAndPaste(fpBox, idx);
    }, 100);
    
    // 자동 모드일 때 카카오맵 초기화
    if (item.mapMode === 'auto') {
        setTimeout(() => initBuildingKakaoMap(idx, building), 200);
    }
}

// ★ [B-4] 공실 고유 키 — id 우선(타사 공실=Firebase key), 없으면(직접입력) 식별 필드 조합.
//   기존 floor+면적+source 키는 같은 층의 서로 다른 공실(면적 비거나 동일 시) 2번째를 떨궜음.
function vacancyDedupKey(v) {
    if (v && (v.id || v.vacancyId)) return 'id:' + (v.id || v.vacancyId);
    const f = (x) => (x === undefined || x === null) ? '' : String(x);
    return 'k:' + [
        f(v.floor), f(v.exclusiveArea || v.area), f(v.rentArea || v.area),
        f(v.deposit ?? v.depositPy), f(v.rent ?? v.rentPy), f(v.maintenance ?? v.maintenancePy),
        f(v.moveIn ?? v.moveInDate), f(v.source), f(v.guideId), f(v.createdAt)
    ].join('|');
}

// ★ 신규: leasingGuides에서 해당 빌딩의 공실 정보 가져오기
function getLeasingGuideVacancies(buildingId) {
    const vacancies = [];
    
    // 모든 leasingGuides를 순회하며 해당 빌딩의 공실 찾기
    Object.values(state.leasingGuides || {}).forEach(guide => {
        const items = guide.items || [];
        items.forEach(item => {
            if (item.buildingId === buildingId) {
                // customVacancies
                if (item.customVacancies && item.customVacancies.length > 0) {
                    item.customVacancies.forEach(v => {
                        vacancies.push({
                            ...v,
                            source: `안내문: ${guide.title || '제목없음'}`,
                            guideId: guide.id
                        });
                    });
                }
                // selectedExternalVacancies
                if (item.selectedExternalVacancies && item.selectedExternalVacancies.length > 0) {
                    item.selectedExternalVacancies.forEach(v => {
                        vacancies.push({
                            ...v,
                            source: `안내문: ${guide.title || '제목없음'}`,
                            guideId: guide.id
                        });
                    });
                }
            }
        });
    });
    
    // ★ [B-4] 중복 제거 — id 기준(타사 공실은 Firebase key로 고유). 같은 층 중복 공실 보존.
    const uniqueVacancies = [];
    const seen = new Set();
    vacancies.forEach(v => {
        const key = vacancyDedupKey(v);
        if (!seen.has(key)) {
            seen.add(key);
            uniqueVacancies.push(v);
        }
    });
    
    return uniqueVacancies;
}

// ★ 신규: 안내문 공실 불러오기
export async function loadLeasingGuideVacancies(idx, buildingId) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    const vacancies = getLeasingGuideVacancies(buildingId);
    
    if (vacancies.length === 0) {
        showToast('저장된 안내문 공실 정보가 없습니다', 'info');
        return;
    }
    
    // 모두 선택
    item.leasingGuideVacancies = vacancies.map(v => ({
        ...v,
        type: 'guide'
    }));
    
    const building = state.allBuildings.find(b => b.id === buildingId) || {};
    renderBuildingEditor(item, building);
    showToast(`${vacancies.length}개의 공실 정보를 불러왔습니다`, 'success');
}

// ★ 신규: 안내문 공실 개별 토글
export function toggleGuideVacancy(idx, vacancyIdx) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    const buildingId = item.buildingId;
    const allGuideVacancies = getLeasingGuideVacancies(buildingId);
    const targetVacancy = allGuideVacancies[vacancyIdx];
    
    if (!targetVacancy) return;
    
    if (!item.leasingGuideVacancies) item.leasingGuideVacancies = [];
    
    // ★ [B-4] id 기준 비교 (같은 층 중복 공실도 개별 식별)
    const targetKey = vacancyDedupKey(targetVacancy);
    const existingIdx = item.leasingGuideVacancies.findIndex(v => vacancyDedupKey(v) === targetKey);
    
    if (existingIdx >= 0) {
        item.leasingGuideVacancies.splice(existingIdx, 1);
    } else {
        item.leasingGuideVacancies.push({
            ...targetVacancy,
            type: 'guide'
        });
    }
    
    const building = state.allBuildings.find(b => b.id === buildingId) || {};
    renderBuildingEditor(item, building);
}

// ★ 신규: 안내문 공실 전체 선택
export function selectAllGuideVacancies(idx, buildingId) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    const allGuideVacancies = getLeasingGuideVacancies(buildingId);
    
    item.leasingGuideVacancies = allGuideVacancies.map(v => ({
        ...v,
        type: 'guide'
    }));
    
    const building = state.allBuildings.find(b => b.id === buildingId) || {};
    renderBuildingEditor(item, building);
    showToast(`${allGuideVacancies.length}개 공실이 선택되었습니다`, 'success');
}


// ★ v2.3 신규: 이미지 압축 함수 (Firebase 용량 제한 해결)
function compressImage(dataUrl, maxWidth = 800, quality = 0.7) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = function() {
            const canvas = document.createElement('canvas');
            let width = img.width;
            let height = img.height;
            
            // 최대 너비 초과 시 리사이징
            if (width > maxWidth) {
                height = Math.round((height * maxWidth) / width);
                width = maxWidth;
            }
            
            canvas.width = width;
            canvas.height = height;
            
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            
            // JPEG로 압축 (PNG도 JPEG로 변환)
            const compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
            
            console.log(`[이미지 압축] ${Math.round(dataUrl.length/1024)}KB → ${Math.round(compressedDataUrl.length/1024)}KB`);
            
            resolve(compressedDataUrl);
        };
        img.src = dataUrl;
    });
}

// ★ v2.3 신규: 이미지를 buildings 컬렉션에 동기화하는 함수
// ★ v6.21: 머지 저장 — 화면(item) 배열은 문서 타입으로 걸러진 부분집합이므로 그대로 덮어쓰면
//   반대 타입 전용 사진이 빌딩 레코드에서 영구 소실된다. 저장 직전 원본을 읽어 보존한다.
//   로컬 캐시(building.exteriorImages)는 저장 직후 화면 배열로 덮어써지므로 머지 기준이 될 수 없다.
//   반환값은 병합된 전체 배열 — 호출부는 이 값을 로컬 building 객체에 넣어야 한다.
async function syncImageToBuilding(buildingId, type, images) {
    const list = images || [];
    const field = type === 'exterior' ? 'exteriorImages'
                : type === 'floorplan' ? 'floorPlanImages' : null;
    if (!buildingId || !field) return list;
    
    try {
        const docType = getGuideType();
        const snapshot = await get(ref(db, `buildings/${buildingId}/${field}`));
        const current = normalizeImageList(snapshot.exists() ? snapshot.val() : []);
        
        // 화면에 있는 URL은 화면 쪽(최신 태그)을 채택하고, 나머지 반대 타입 전용만 보존
        const shown = new Set(list.map(i => (typeof i === 'string' ? i : i?.url)).filter(Boolean));
        const keep = current.filter(img => !imageMatchesUsage(img, docType) && !shown.has(img.url));
        const merged = [...keep, ...list];
        
        await update(ref(db, `buildings/${buildingId}`), { [field]: merged });
        console.log(`[이미지 동기화] buildings/${buildingId} ${field} 저장 — 화면 ${list.length}건 + 보존 ${keep.length}건`);
        return merged;
    } catch (error) {
        console.error('[이미지 동기화 오류]', error);
        if (error.message && error.message.includes('too large')) {
            showToast('이미지 용량이 너무 큽니다. 더 작은 이미지를 사용해주세요.', 'error');
        }
        return list;
    }
}

// ★ v2.3 수정: 이미지 업로드 (압축 + buildings 컬렉션 동기화)
export function uploadImage(idx, type) {
    const input = document.getElementById('imageUploadInput');
    if (!input) return;
    
    input.onchange = async function(e) {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;
        
        const item = state.tocItems[idx];
        if (!item) return;
        
        showToast('이미지 처리 중...', 'info');
        
        // 파일 읽기 및 압축 Promise 배열
        const processPromises = files.map(file => {
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = async function(ev) {
                    const originalDataUrl = ev.target.result;
                    
                    // ★ 이미지 압축 (800px, 70% 품질)
                    const compressedDataUrl = await compressImage(originalDataUrl, 800, 0.7);
                    
                    // ★ 업로드 기본 구분 = 현재 문서 타입 (썸네일 배지로 즉시 공용 전환 가능)
                    resolve({ url: compressedDataUrl, fileName: file.name, usage: getGuideType() });
                };
                reader.readAsDataURL(file);
            });
        });
        
        // 모든 파일 처리 완료 대기
        const newImages = await Promise.all(processPromises);
        
        // 타입별로 이미지 추가
        let mergedImages = null;
        if (type === 'exterior') {
            if (!item.exteriorImages) item.exteriorImages = [];
            item.exteriorImages.push(...newImages);
            
            // ★ buildings 컬렉션에도 동기화 (머지 저장 결과를 로컬 캐시에 쓴다)
            mergedImages = await syncImageToBuilding(item.buildingId, 'exterior', item.exteriorImages);
            
        } else if (type === 'floorplan') {
            if (!item.floorPlanImages) item.floorPlanImages = [];
            // ★ v2.3.2: 새 이미지를 맨 앞에 추가 (미리보기에 바로 반영)
            item.floorPlanImages.unshift(...newImages);
            
            // ★ buildings 컬렉션에도 동기화
            mergedImages = await syncImageToBuilding(item.buildingId, 'floorplan', item.floorPlanImages);
            
        } else if (type === 'map') {
            // 지도 이미지도 압축
            item.mapImage = newImages[0]?.url || '';
        }
        
        const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
        
        // 로컬 building 객체도 업데이트
        if (building && building.id && mergedImages) {
            if (type === 'exterior') {
                building.exteriorImages = mergedImages;
            } else if (type === 'floorplan') {
                building.floorPlanImages = mergedImages;
            }
        }
        
        renderBuildingEditor(item, building);
        showToast('이미지가 추가되었습니다', 'success');
        
        // ★ v2.3.1: 업로드 완료 후 해당 타입의 탭 자동 활성화
        if (type === 'exterior' || type === 'floorplan' || type === 'map') {
            setTimeout(() => {
                const tabBtn = document.querySelector(`.image-tab[data-type="${type}"]`);
                if (tabBtn) {
                    switchImageTab(idx, type, tabBtn);
                }
            }, 100);
        }
        
        e.target.value = '';
    };
    
    input.click();
}

// 메인 이미지 설정
export function setMainImage(idx, imageIdx) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    item.mainImageIndex = imageIdx;
    const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
    renderBuildingEditor(item, building);
}

// ★ v2.3 수정: 이미지 삭제 (buildings 컬렉션 동기화 포함)
export async function removeImage(idx, type, imageIdx) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    let shown = [];
    let merged = null;
    if (type === 'exterior') {
        item.exteriorImages.splice(imageIdx, 1);
        if (item.mainImageIndex >= item.exteriorImages.length) {
            item.mainImageIndex = Math.max(0, item.exteriorImages.length - 1);
        }
        shown = item.exteriorImages;
        
        // buildings 컬렉션에도 동기화
        merged = await syncImageToBuilding(item.buildingId, 'exterior', item.exteriorImages);
        
    } else if (type === 'floorplan') {
        item.floorPlanImages.splice(imageIdx, 1);
        shown = item.floorPlanImages;
        
        // buildings 컬렉션에도 동기화
        merged = await syncImageToBuilding(item.buildingId, 'floorplan', item.floorPlanImages);
    }
    
    const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
    
    // 로컬 building 객체도 업데이트 (머지 결과 기준)
    if (building && building.id && merged) {
        if (type === 'exterior') {
            building.exteriorImages = merged;
        } else if (type === 'floorplan') {
            building.floorPlanImages = merged;
        }
    }
    
    renderBuildingEditor(item, building);
    // ★ 머지 저장이 보존한 반대 타입 전용 사진 건수를 알린다 (포털에 남아 보이는 이유)
    const kept = Math.max(0, (merged?.length || 0) - shown.length);
    showToast(kept > 0
        ? `이미지가 삭제되었습니다 (다른 문서 타입 전용 사진 ${kept}건은 유지됩니다)`
        : '이미지가 삭제되었습니다', 'success');
}

// 지도 이미지 삭제
export function removeMapImage(idx) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    item.mapImage = null;
    const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
    renderBuildingEditor(item, building);
    showToast('지도 이미지가 삭제되었습니다', 'success');
}

// ★ v6.7: 기본값 = 붙여넣기 취소 → 저장된 기본 지도(building.images.location)로 복원. 없으면 빈 상태.
export function resetToStorageMapImage(idx, buildingId) {
    const item = state.tocItems[idx];
    if (!item) return;

    const building = state.allBuildings.find(b => b.id === (buildingId || item.buildingId)) || {};

    item.mapImage = null;  // 붙여넣기 override 제거 → 저장된 기본 이미지 or 빈 상태 표시
    renderBuildingEditor(item, building);
    showToast(building.images?.location ? '저장된 기본 지도로 복원되었습니다' : '지도를 비웠습니다', 'success');
}

// ★ v5.2: LOCATION 영역 드래그앤드롭 + Ctrl+V 설정
function setupLocationDropAndPaste(container, idx) {
    // 기존 이벤트 제거 (중복 방지)
    container.removeAttribute('data-dnd-bound');
    
    // --- 드래그앤드롭 ---
    container.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        container.style.outline = '2px dashed #3b82f6';
        container.style.outlineOffset = '-2px';
        container.style.background = 'rgba(59, 130, 246, 0.05)';
    });
    
    container.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        container.style.outline = '';
        container.style.outlineOffset = '';
        container.style.background = '';
    });
    
    container.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        container.style.outline = '';
        container.style.outlineOffset = '';
        container.style.background = '';
        
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
            const file = files[0];
            if (file.type.startsWith('image/')) {
                processLocationImage(file, idx);
            } else {
                showToast('이미지 파일만 업로드 가능합니다', 'warning');
            }
        }
    });
    
    // --- Ctrl+V (클립보드 붙여넣기) ---
    // container에 tabindex를 설정하여 포커스 가능하게
    container.setAttribute('tabindex', '0');
    container.style.outline = container.style.outline || '';  // focus 시 기본 outline 유지
    
    container.addEventListener('paste', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        const items = e.clipboardData?.items;
        if (!items) return;
        
        for (const clipItem of items) {
            if (clipItem.type.startsWith('image/')) {
                const file = clipItem.getAsFile();
                if (file) {
                    processLocationImage(file, idx);
                    return;
                }
            }
        }
        showToast('클립보드에 이미지가 없습니다', 'warning');
    });
    
    // 클릭 시 포커스 (Ctrl+V 수신 가능하도록)
    container.addEventListener('focus', () => {
        container.style.boxShadow = '0 0 0 2px rgba(59, 130, 246, 0.3)';
    });
    container.addEventListener('blur', () => {
        container.style.boxShadow = '';
    });
    
    container.setAttribute('data-dnd-bound', 'true');
}

// ★ v6.12: 평면도 영역 드래그앤드롭 + Ctrl+V 설정 (지도 setupLocationDropAndPaste와 동일 패턴, 대상만 floorplan)
function setupFloorPlanDropAndPaste(container, idx) {
    if (container.getAttribute('data-dnd-bound') === 'true') return;

    container.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        container.style.outline = '2px dashed #3b82f6';
        container.style.outlineOffset = '-2px';
        container.style.background = 'rgba(59, 130, 246, 0.05)';
    });

    container.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        container.style.outline = '';
        container.style.outlineOffset = '';
        container.style.background = '';
    });

    container.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        container.style.outline = '';
        container.style.outlineOffset = '';
        container.style.background = '';

        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
            const file = files[0];
            if (file.type.startsWith('image/')) {
                processGuideImage(file, idx, 'floorplan');
            } else {
                showToast('이미지 파일만 업로드 가능합니다', 'warning');
            }
        }
    });

    // Ctrl+V (박스가 포커스된 상태에서 수신) — 문서 레벨 핸들러와 충돌 없게 stopPropagation
    container.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const clipItem of items) {
            if (clipItem.type.startsWith('image/')) {
                const file = clipItem.getAsFile();
                if (file) {
                    e.preventDefault();
                    e.stopPropagation();
                    processGuideImage(file, idx, 'floorplan');
                    return;
                }
            }
        }
    });

    container.addEventListener('focus', () => { container.style.boxShadow = '0 0 0 2px rgba(59, 130, 246, 0.3)'; });
    container.addEventListener('blur', () => { container.style.boxShadow = ''; });

    container.setAttribute('data-dnd-bound', 'true');
}

// ★ v5.2: LOCATION 이미지 파일 처리 (압축 후 적용)
async function processLocationImage(file, idx) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    showToast('이미지 처리 중...', 'info');
    
    try {
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (ev) => resolve(ev.target.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
        
        // 압축 (800px, 70% 품질)
        const compressed = await compressImage(dataUrl, 800, 0.7);
        item.mapImage = compressed;
        
        const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
        renderBuildingEditor(item, building);
        showToast('지도 이미지가 적용되었습니다', 'success');
        
        // 지도 탭 자동 활성화
        setTimeout(() => {
            const tabBtn = document.querySelector('.image-tab[data-type="map"]');
            if (tabBtn) switchImageTab(idx, 'map', tabBtn);
        }, 100);
        
    } catch (error) {
        console.error('이미지 처리 오류:', error);
        showToast('이미지 처리 중 오류가 발생했습니다', 'error');
    }
}

// ★ v6.6: 클립보드에서 이미지를 직접 읽어 지도(수동)에 삽입 — 포커스/paste 이벤트 불필요, 버튼 클릭만으로 동작
//   Win+Shift+S 등으로 캡쳐 → 이 버튼 클릭 → 지도 영역에 바로 삽입. Ctrl+V 라우팅 quirk를 우회하는 확실한 경로.
export async function pasteMapFromClipboard(idx) {
    const item = state.tocItems[idx];
    if (!item) return;

    if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
        showToast('이 브라우저는 클립보드 읽기를 지원하지 않습니다. Ctrl+V를 사용해주세요.', 'warning');
        return;
    }

    try {
        const clipboardItems = await navigator.clipboard.read();
        for (const clipItem of clipboardItems) {
            const imgType = (clipItem.types || []).find(t => t.startsWith('image/'));
            if (imgType) {
                const blob = await clipItem.getType(imgType);
                const ext = imgType.split('/')[1] || 'png';
                const file = new File([blob], `pasted-map.${ext}`, { type: imgType });
                // 수동 모드 보장 + 붙여넣기 타깃 동기화 후, 기존 지도 이미지 처리 경로 재사용
                item.mapMode = 'manual';
                state._pasteTarget = { idx, kind: 'map' };
                await processLocationImage(file, idx);
                return;
            }
        }
        showToast('클립보드에 이미지가 없습니다. 먼저 지도를 캡쳐(Win+Shift+S)하세요.', 'warning');
    } catch (err) {
        console.error('[클립보드 붙여넣기] 실패:', err);
        // 대개 권한 거부(NotAllowedError). 주소창 좌측 자물쇠/아이콘에서 클립보드 허용 안내
        showToast('클립보드 읽기 권한이 필요합니다. 주소창 좌측 아이콘에서 클립보드를 허용해주세요.', 'error');
    }
}

// ★ v6.13: 평면도 클립보드 붙여넣기 (📋 버튼) — pasteMapFromClipboard와 동일 패턴, 대상만 floorplan
export async function pasteFloorPlanFromClipboard(idx) {
    const item = state.tocItems[idx];
    if (!item) return;

    if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
        showToast('이 브라우저는 클립보드 읽기를 지원하지 않습니다. Ctrl+V를 사용해주세요.', 'warning');
        return;
    }

    try {
        const clipboardItems = await navigator.clipboard.read();
        for (const clipItem of clipboardItems) {
            const imgType = (clipItem.types || []).find(t => t.startsWith('image/'));
            if (imgType) {
                const blob = await clipItem.getType(imgType);
                const ext = imgType.split('/')[1] || 'png';
                const file = new File([blob], `pasted-floorplan.${ext}`, { type: imgType });
                await processGuideImage(file, idx, 'floorplan');
                return;
            }
        }
        showToast('클립보드에 이미지가 없습니다. 먼저 평면도를 캡쳐(Win+Shift+S)하세요.', 'warning');
    } catch (err) {
        console.error('[평면도 클립보드 붙여넣기] 실패:', err);
        showToast('클립보드 읽기 권한이 필요합니다. 주소창 좌측 아이콘에서 클립보드를 허용해주세요.', 'error');
    }
}

// ★ v6.13: 외관 클립보드 붙여넣기 (📋 버튼) — pasteFloorPlanFromClipboard와 동일 패턴, 대상만 exterior
export async function pasteExteriorFromClipboard(idx) {
    const item = state.tocItems[idx];
    if (!item) return;

    if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
        showToast('이 브라우저는 클립보드 읽기를 지원하지 않습니다. Ctrl+V를 사용해주세요.', 'warning');
        return;
    }

    try {
        const clipboardItems = await navigator.clipboard.read();
        for (const clipItem of clipboardItems) {
            const imgType = (clipItem.types || []).find(t => t.startsWith('image/'));
            if (imgType) {
                const blob = await clipItem.getType(imgType);
                const ext = imgType.split('/')[1] || 'png';
                const file = new File([blob], `pasted-exterior.${ext}`, { type: imgType });
                await processGuideImage(file, idx, 'exterior');
                return;
            }
        }
        showToast('클립보드에 이미지가 없습니다. 먼저 외관 이미지를 캡쳐(Win+Shift+S)하세요.', 'warning');
    } catch (err) {
        console.error('[외관 클립보드 붙여넣기] 실패:', err);
        showToast('클립보드 읽기 권한이 필요합니다. 주소창 좌측 아이콘에서 클립보드를 허용해주세요.', 'error');
    }
}

// ★ [B-1] 붙여넣기/드롭 이미지 처리 — uploadImage와 동일 경로(압축 → 배열 → RTDB 동기화) 재사용
async function processGuideImage(file, idx, type) {
    const item = state.tocItems[idx];
    if (!item) return;
    if (!file || !file.type || !file.type.startsWith('image/')) {
        showToast('이미지 파일만 가능합니다', 'warning');
        return;
    }
    showToast('이미지 처리 중...', 'info');
    try {
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (ev) => resolve(ev.target.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
        const compressed = await compressImage(dataUrl, 800, 0.7);
        const newImg = { url: compressed, fileName: file.name || 'pasted.png', usage: getGuideType() };
        const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
        if (type === 'exterior') {
            if (!item.exteriorImages) item.exteriorImages = [];
            item.exteriorImages.push(newImg);
            // ★ v6.15 fix: 붙여넣은 이미지를 메인으로 지정 (기존엔 push 후 mainImageIndex=0 유지 →
            //   BUILDING PHOTO 미리보기가 안 바뀌어 "붙여넣기 안 됨"으로 보이던 문제)
            item.mainImageIndex = item.exteriorImages.length - 1;
            const merged = await syncImageToBuilding(item.buildingId, 'exterior', item.exteriorImages);
            if (building.id) building.exteriorImages = merged;
        } else if (type === 'floorplan') {
            if (!item.floorPlanImages) item.floorPlanImages = [];
            item.floorPlanImages.unshift(newImg);  // uploadImage와 동일하게 맨 앞에
            const merged = await syncImageToBuilding(item.buildingId, 'floorplan', item.floorPlanImages);
            if (building.id) building.floorPlanImages = merged;
        } else {
            // map 등은 기존 지도 처리로 위임
            return processLocationImage(file, idx);
        }
        renderBuildingEditor(item, building);
        showToast('이미지가 추가되었습니다', 'success');
        setTimeout(() => {
            const tabBtn = document.querySelector(`.image-tab[data-type="${type}"]`);
            if (tabBtn) switchImageTab(idx, type, tabBtn);
        }, 100);
    } catch (error) {
        console.error('이미지 붙여넣기 처리 오류:', error);
        showToast('이미지 처리 중 오류가 발생했습니다', 'error');
    }
}

// ★ [B-1] 문서 레벨 클립보드 이미지 붙여넣기 — 활성 이미지 탭(외관/평면도/지도)으로 라우팅 (1회 등록)
//   입력창/리치텍스트 붙여넣기는 건드리지 않음. 지도 영역 자체 paste는 stopPropagation이라 충돌 없음.
let _guideImagePasteBound = false;
function bindGuideImagePaste() {
    if (_guideImagePasteBound) return;
    _guideImagePasteBound = true;
    document.addEventListener('paste', (e) => {
        const t = e.target;
        const tag = (t && t.tagName ? t.tagName : '').toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
        // 빌딩 편집 중일 때만 (divider 등 buildingId 없는 항목 제외)
        const idx = state.selectedTocIndex;
        const item = state.tocItems && state.tocItems[idx];
        if (!item || !item.buildingId) return;
        const clip = e.clipboardData && e.clipboardData.items;
        if (!clip) return;
        for (const ci of clip) {
            if (ci.type && ci.type.startsWith('image/')) {
                const file = ci.getAsFile();
                if (file) {
                    e.preventDefault();
                    // ★ v6.5 라우팅 우선순위: 최근 지정 붙여넣기 타깃(_pasteTarget) > 활성 이미지 탭 > exterior
                    //   LOCATION '수동' 토글 시 setMapMode가 _pasteTarget을 map으로 지정 → 지도 영역에 정확히 붙음
                    let activeType;
                    const pt = state._pasteTarget;
                    if (pt && pt.idx === idx && pt.kind) {
                        activeType = pt.kind;
                    } else {
                        activeType = document.querySelector('.image-tab.active')?.dataset?.type || 'exterior';
                    }
                    if (activeType === 'map') processLocationImage(file, idx);
                    else processGuideImage(file, idx, activeType);
                    return;
                }
            }
        }
    });
}

// ★ v5.1: 지도 이미지 자동 생성 (카카오 Static Map API)
export async function generateLocationMap(idx, buildingId) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    const building = state.allBuildings.find(b => b.id === buildingId) || {};
    
    // 좌표 확인 (coordinates 또는 직접 lat/lng)
    const lat = building.coordinates?.lat || building.lat;
    const lng = building.coordinates?.lng || building.lng;
    
    if (!lat || !lng) {
        showToast('빌딩 좌표 정보가 없습니다', 'error');
        return;
    }
    
    // 로딩 표시
    const mapContainer = document.getElementById(`locationMap_${idx}`);
    if (mapContainer) {
        mapContainer.innerHTML = `
            <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; color:#666;">
                <div style="font-size:24px; animation: spin 1s linear infinite;">⏳</div>
                <div style="margin-top:8px; font-size:12px;">지도 생성 중...</div>
            </div>
        `;
    }
    
    try {
        // API 서버 URL (CONFIG에서 가져오거나 기본값 사용)
        const API_BASE = window.CONFIG?.API_BASE || 'https://portal-dsyl.onrender.com';
        
        console.log(`🗺️ 지도 생성 요청: ${building.name} (${lat}, ${lng})`);
        
        const response = await fetch(`${API_BASE}/api/generate-location-map`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                buildingId: buildingId,
                lat: lat,
                lng: lng,
                name: building.name || 'Building',
                level: 3,
                width: 600,
                height: 400,
                saveToFirebase: true
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            const imageUrl = result.imageUrl || result.imageBase64;
            
            // state 업데이트
            if (!building.images) building.images = {};
            building.images.location = imageUrl;
            
            // item에도 반영 (mapImage는 null로 유지 → Storage 이미지 사용)
            item.mapImage = null;
            item.mapMode = 'manual';  // ★ [A-1] 생성된 네이버 정적지도를 미리보기에 표시 (화면=저장 일치)
            
            // 에디터 다시 렌더링
            renderBuildingEditor(item, building);
            
            showToast('지도 이미지가 생성되었습니다', 'success');
            console.log('  ✅ 지도 생성 완료:', imageUrl?.substring(0, 80) + '...');
            
        } else {
            throw new Error(result.error || '지도 생성 실패');
        }
        
    } catch (error) {
        console.error('지도 생성 오류:', error);
        showToast(`지도 생성 실패: ${error.message}`, 'error');
        
        // 에러 시 원래 상태로 복원
        renderBuildingEditor(item, building);
    }
}

// 이미지 탭 전환
// ★ v6.21: 이미지 구분(usage) — 배지 + 3단 순환
//   '' = 공용(양쪽 문서에 노출) | 'office' | 'retail'
const IMAGE_USAGE_LABEL = { '': '공용', office: '오피스', retail: '리테일' };
const IMAGE_USAGE_STYLE = {
    '':       'background:#e2e8f0; color:#475569;',
    office:   'background:#dbeafe; color:#1d4ed8;',
    retail:   'background:#fde68a; color:#92400e;'
};

// 썸네일 1개 렌더 (초기 렌더와 switchImageTab이 공유 — 한쪽만 고쳐 어긋나지 않도록)
function renderImageThumb(idx, type, img, i, isMain) {
    const src = typeof img === 'string' ? img : (img.url || img);
    const usage = (img && typeof img === 'object' && img.usage) || '';
    const label = IMAGE_USAGE_LABEL[usage] || '공용';
    const style = IMAGE_USAGE_STYLE[usage] || IMAGE_USAGE_STYLE[''];
    const isExterior = type === 'exterior';
    const alt = isExterior ? '외관' : '평면도';
    const mainAttrs = isExterior
        ? ` onclick="setMainImage(${idx}, ${i})" title="${isMain ? '메인 이미지' : '클릭하여 메인으로 설정'}"`
        : '';
    return `
        <div class="image-thumb ${isExterior && isMain ? 'main' : ''}"${mainAttrs}>
            <img src="${src}" alt="${alt} ${i + 1}">
            <button class="image-usage-badge" title="클릭: 공용 → 오피스 → 리테일 순으로 변경"
                onclick="event.stopPropagation(); cycleImageUsage(${idx}, '${type}', ${i})"
                style="position:absolute; left:2px; bottom:2px; padding:1px 5px; border:none; border-radius:8px; font-size:9px; font-weight:700; line-height:1.5; cursor:pointer; ${style}">${label}</button>
            <button class="remove-btn" onclick="event.stopPropagation(); removeImage(${idx}, '${type}', ${i})">×</button>
        </div>`;
}

// ★ 이미지 구분 지정 — usage가 falsy면 공용(필드 제거)
export async function setImageUsage(idx, type, imageIdx, usage) {
    const item = state.tocItems[idx];
    if (!item) return;
    const list = type === 'exterior' ? item.exteriorImages : item.floorPlanImages;
    if (!Array.isArray(list) || !list[imageIdx]) return;
    
    // 문자열로 저장된 옛 이미지는 { url } 객체로 승격한다 (URL은 그대로 유지)
    const cur = list[imageIdx];
    const next = (typeof cur === 'string') ? { url: cur } : { ...cur };
    if (usage === 'office' || usage === 'retail') next.usage = usage;
    else delete next.usage;
    list[imageIdx] = next;
    
    const merged = await syncImageToBuilding(item.buildingId, type, list);
    const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
    if (building.id && merged) {
        if (type === 'exterior') building.exteriorImages = merged;
        else building.floorPlanImages = merged;
    }
    
    const tabBtn = document.querySelector(`.image-tab[data-type="${type}"]`);
    if (tabBtn) switchImageTab(idx, type, tabBtn);
    showToast(`구분을 '${IMAGE_USAGE_LABEL[next.usage || '']}'으로 변경했습니다`, 'success');
}

// 배지 클릭 = 공용 → 오피스 → 리테일 → 공용
export function cycleImageUsage(idx, type, imageIdx) {
    const item = state.tocItems[idx];
    if (!item) return;
    const list = type === 'exterior' ? item.exteriorImages : item.floorPlanImages;
    const cur = list?.[imageIdx];
    const usage = (cur && typeof cur === 'object' && cur.usage) || '';
    const next = usage === '' ? 'office' : usage === 'office' ? 'retail' : '';
    setImageUsage(idx, type, imageIdx, next);
}

export function switchImageTab(idx, type, btn) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    // ★ v6.5: 이미지 탭 클릭 = 붙여넣기 타깃을 이 탭으로 동기화 (외관/평면도/지도)
    state._pasteTarget = { idx, kind: type };
    
    // 탭 버튼 활성화
    document.querySelectorAll('.image-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    
    // 그리드 업데이트
    const grid = document.getElementById('imageGrid');
    if (!grid) return;
    
    if (type === 'exterior') {
        grid.innerHTML = `
            ${item.exteriorImages.length > 0
                ? item.exteriorImages.map((img, i) => renderImageThumb(idx, 'exterior', img, i, item.mainImageIndex === i)).join('')
                : '<div class="image-empty">등록된 외관 이미지가 없습니다</div>'}
            <button class="image-add-btn" onclick="uploadImage(${idx}, 'exterior')" title="이미지 추가">+</button>
        `;
    } else if (type === 'floorplan') {
        grid.innerHTML = `
            ${item.floorPlanImages.length > 0
                ? item.floorPlanImages.map((img, i) => renderImageThumb(idx, 'floorplan', img, i, false)).join('')
                : '<div class="image-empty">등록된 평면도 이미지가 없습니다</div>'}
            <button class="image-add-btn" onclick="uploadImage(${idx}, 'floorplan')" title="이미지 추가">+</button>
        `;
    } else if (type === 'map') {
        grid.innerHTML = `
            ${item.mapImage ? `
                <div class="image-thumb">
                    <img src="${item.mapImage}" alt="지도">
                    <button class="remove-btn" onclick="event.stopPropagation(); removeMapImage(${idx})">×</button>
                </div>
            ` : '<div class="image-empty">등록된 지도 이미지가 없습니다</div>'}
            <button class="image-add-btn" onclick="uploadImage(${idx}, 'map')" title="지도 업로드">+</button>
        `;
    }
}

// 기준층 임대조건 저장
export async function saveStandardFloor(buildingId) {
    try {
        const depositPy = document.getElementById('stdDeposit')?.value || '';
        const rentPy = document.getElementById('stdRent')?.value || '';
        const maintenancePy = document.getElementById('stdMaintenance')?.value || '';
        const rentLabel = document.getElementById('stdLabel')?.value || '기준층';
        
        await update(ref(db, `buildings/${buildingId}`), {
            depositPy,
            rentPy,
            maintenancePy,
            rentLabel
        });
        
        // 로컬 상태 업데이트
        const building = state.allBuildings.find(b => b.id === buildingId);
        if (building) {
            building.depositPy = depositPy;
            building.rentPy = rentPy;
            building.maintenancePy = maintenancePy;
            building.rentLabel = rentLabel;
        }
        
        showToast('기준층 임대조건이 저장되었습니다', 'success');
        
        // 프리뷰 갱신
        if (state.selectedTocIndex >= 0) {
            const item = state.tocItems[state.selectedTocIndex];
            if (item && building) {
                renderBuildingEditor(item, building);
            }
        }
    } catch (error) {
        console.error('저장 오류:', error);
        showToast('저장 중 오류가 발생했습니다', 'error');
    }
}

// ========== 빌딩 정보 수정 모달 ==========
export function openBuildingEditModal(buildingId) {
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (!building) return;
    
    const modalHtml = `
        <div class="modal-overlay show" id="buildingEditModal" onclick="if(event.target===this)closeBuildingEditModal()">
            <div class="modal" style="max-width:600px;">
                <div class="modal-header">
                    <h2 class="modal-title">🏢 빌딩 정보 수정</h2>
                    <button class="modal-close" onclick="closeBuildingEditModal()">×</button>
                </div>
                <div class="modal-body" style="max-height:60vh; overflow-y:auto;">
                    <div class="form-group">
                        <label>빌딩명</label>
                        <input type="text" id="editBldName" value="${building.name || ''}">
                    </div>
                    <div class="form-group">
                        <label>주소</label>
                        <input type="text" id="editBldAddress" value="${building.address || ''}">
                    </div>
                    <div class="form-group">
                        <label>인근역 (위치)</label>
                        <input type="text" id="editBldStation" value="${building.nearbyStation || ''}" placeholder="예: 2호선 강남역 도보 5분">
                    </div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                        <div class="form-group">
                            <label>연면적 (평)</label>
                            <input type="text" id="editBldGrossFloor" class="js-comma" inputmode="decimal" value="${building.grossFloorPy ? formatNumberInput(String(building.grossFloorPy)) : ''}">
                        </div>
                        <div class="form-group">
                            <label>기준층 전용면적 (평)</label>
                            <input type="text" id="editBldTypicalFloor" class="js-comma" inputmode="decimal" value="${building.typicalFloorPy ? formatNumberInput(String(building.typicalFloorPy)) : ''}">
                        </div>
                    </div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                        <div class="form-group">
                            <label>전용률 (%)</label>
                            <input type="text" id="editBldExclusiveRate" value="${building.exclusiveRate || ''}">
                        </div>
                        <div class="form-group">
                            <label>준공년도</label>
                            <input type="text" id="editBldYear" value="${building.completionYear || ''}">
                        </div>
                    </div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                        <div class="form-group">
                            <label>지상 층수</label>
                            <input type="text" id="editBldFloorsAbove" value="${building.floorsAbove || ''}">
                        </div>
                        <div class="form-group">
                            <label>지하 층수</label>
                            <input type="text" id="editBldFloorsBelow" value="${building.floorsBelow || ''}">
                        </div>
                    </div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                        <div class="form-group">
                            <label>엘리베이터 (총 대수)</label>
                            <input type="text" id="editBldElevator" value="${building.elevatorTotal || ''}">
                        </div>
                        <div class="form-group">
                            <label>주차 (총 대수)</label>
                            <input type="text" id="editBldParking" class="js-comma" inputmode="numeric" value="${building.parkingTotal ? formatNumberInput(String(building.parkingTotal)) : ''}">
                        </div>
                    </div>
                    <div class="form-group">
                        <label>주차 비고</label>
                        <input type="text" id="editBldParkingNote" value="${building.parkingNote || ''}" placeholder="예: (1대/120평)">
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeBuildingEditModal()">취소</button>
                    <button class="btn btn-primary" onclick="saveBuildingEdit('${buildingId}')">💾 저장</button>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

export function closeBuildingEditModal() {
    const modal = document.getElementById('buildingEditModal');
    if (modal) modal.remove();
}

export async function saveBuildingEdit(buildingId) {
    if (!confirm('이 변경사항은 CRE Portal의 해당 빌딩 기본정보에도 반영됩니다.\n저장하시겠습니까?')) return;
    try {
        // ★ [B-6] 숫자 입력값에서 콤마 제거 후 파싱 (parseFloat("1,234")=1 방지)
        const numV = id => unformatNumber(document.getElementById(id)?.value);
        const updateData = {
            name: document.getElementById('editBldName')?.value || '',
            address: document.getElementById('editBldAddress')?.value || '',
            nearbyStation: document.getElementById('editBldStation')?.value || '',
            'area/grossFloorPy': parseFloat(numV('editBldGrossFloor')) || 0,
            'area/typicalFloorPy': parseFloat(numV('editBldTypicalFloor')) || 0,
            'area/exclusiveRate': parseFloat(numV('editBldExclusiveRate')) || 0,
            'floors/above': parseInt(numV('editBldFloorsAbove')) || 0,
            'floors/below': parseInt(numV('editBldFloorsBelow')) || 0,
            'specs/completionYear': document.getElementById('editBldYear')?.value || '',
            'specs/passengerElevator': parseInt(numV('editBldElevator')) || 0,
            'parking/total': parseInt(numV('editBldParking')) || 0,
            parkingNote: document.getElementById('editBldParkingNote')?.value || ''
        };
        
        await update(ref(db, `buildings/${buildingId}`), updateData);
        
        // 로컬 상태 업데이트 (플랫 + 중첩 구조 동시 업데이트 → normalizeBuilding 재호출 보장)
        const building = state.allBuildings.find(b => b.id === buildingId);
        if (building) {
            building.name = document.getElementById('editBldName')?.value || building.name;
            building.address = document.getElementById('editBldAddress')?.value || building.address;
            building.nearbyStation = document.getElementById('editBldStation')?.value || building.nearbyStation;
            building.grossFloorPy = parseFloat(numV('editBldGrossFloor')) || building.grossFloorPy;
            building.typicalFloorPy = parseFloat(numV('editBldTypicalFloor')) || building.typicalFloorPy;
            building.exclusiveRate = parseFloat(numV('editBldExclusiveRate')) || building.exclusiveRate;
            building.floorsAbove = parseInt(numV('editBldFloorsAbove')) || building.floorsAbove;
            building.floorsBelow = parseInt(numV('editBldFloorsBelow')) || building.floorsBelow;
            building.completionYear = document.getElementById('editBldYear')?.value || building.completionYear;
            building.elevatorTotal = parseInt(numV('editBldElevator')) || building.elevatorTotal;
            building.parkingTotal = parseInt(numV('editBldParking')) || building.parkingTotal;
            building.parkingNote = document.getElementById('editBldParkingNote')?.value || building.parkingNote;
            // ★ 중첩 키도 동기화 (출력 페이지 Firebase 재읽기 시 반영)
            if (!building.area) building.area = {};
            building.area.grossFloorPy = building.grossFloorPy;
            building.area.typicalFloorPy = building.typicalFloorPy;
            building.area.exclusiveRate = building.exclusiveRate;
            if (!building.floors) building.floors = {};
            building.floors.above = building.floorsAbove;
            building.floors.below = building.floorsBelow;
            if (!building.specs) building.specs = {};
            building.specs.completionYear = building.completionYear;
            building.specs.passengerElevator = building.elevatorTotal;
            if (!building.parking) building.parking = {};
            building.parking.total = building.parkingTotal;
            // ★ normalizeBuilding 재호출로 floorsDisplay 등 파생 필드 갱신
            normalizeBuilding(building);
        }
        
        closeBuildingEditModal();
        showToast('빌딩 정보가 저장되었습니다', 'success');
        
        // 프리뷰 갱신
        if (state.selectedTocIndex >= 0) {
            const item = state.tocItems[state.selectedTocIndex];
            if (item && building) {
                renderBuildingEditor(item, building);
            }
        }
    } catch (error) {
        console.error('빌딩 정보 저장 오류:', error);
        showToast('저장 중 오류가 발생했습니다', 'error');
    }
}

// ========== 건축물대장 자동 가져오기 ==========
// ★ v5.4: Portal → 안내문 (Firebase DB → 편집화면)
export async function fetchFromPortal(buildingId) {
    showToast('Portal DB에서 최신 빌딩 정보를 가져오는 중...', 'info');
    try {
        const snapshot = await get(ref(db, `buildings/${buildingId}`));
        if (!snapshot.exists()) { showToast('빌딩 정보를 찾을 수 없습니다', 'error'); return; }
        const freshData = snapshot.val();
        freshData.id = buildingId;
        normalizeBuilding(freshData);
        const bIdx = state.allBuildings.findIndex(b => b.id === buildingId);
        if (bIdx >= 0) state.allBuildings[bIdx] = { ...state.allBuildings[bIdx], ...freshData };
        const building = state.allBuildings[bIdx] || freshData;
        showToast('Portal DB 최신 정보를 안내문 편집화면에 반영했습니다', 'success');
        if (state.selectedTocIndex >= 0) {
            const item = state.tocItems[state.selectedTocIndex];
            if (item) renderBuildingEditor(item, building);
        }
    } catch (e) {
        console.error('fetchFromPortal 오류:', e);
        showToast('불러오기에 실패했습니다', 'error');
    }
}

// ★ v5.4: 안내문 → Portal (편집화면 현재값 → Firebase DB + BroadcastChannel)
export async function pushToPortal(buildingId) {
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (!building) { showToast('빌딩 데이터를 찾을 수 없습니다', 'error'); return; }
    if (!confirm('현재 편집화면의 GENERAL INFORMATION 값을\nPortal DB 및 상세패널에 반영합니다.\n계속하시겠습니까?')) return;
    try {
        const updateData = {
            name: building.name || '',
            address: building.address || '',
            nearbyStation: building.nearbyStation || '',
            'area/grossFloorPy': building.grossFloorPy || 0,
            grossFloorPy: building.grossFloorPy || 0,
            'area/typicalFloorPy': building.typicalFloorPy || 0,
            typicalFloorPy: building.typicalFloorPy || 0,
            'area/exclusiveRate': building.exclusiveRate || 0,
            exclusiveRate: building.exclusiveRate || 0,
            'floors/above': building.floorsAbove || 0,
            'floors/below': building.floorsBelow || 0,
            'specs/completionYear': String(building.completionYear || ''),
            completionYear: String(building.completionYear || ''),
            'specs/passengerElevator': building.elevatorTotal || 0,
            elevatorTotal: building.elevatorTotal || 0,
            'parking/total': building.parkingTotal || 0,
            parkingTotal: building.parkingTotal || 0,
            parkingNote: building.parkingNote || ''
        };
        await update(ref(db, `buildings/${buildingId}`), updateData);
        try {
            const bc = new BroadcastChannel('cre_portal_sync');
            bc.postMessage({ type: 'buildingUpdated', origin: 'guide', buildingId, data: { ...building, ...updateData } });
            bc.close();
        } catch (_) {}
        window.dispatchEvent(new CustomEvent('buildingUpdated', { detail: { buildingId, data: building } }));
        showToast('Portal DB 및 상세패널에 반영되었습니다', 'success');
        if (state.selectedTocIndex >= 0) {
            const item = state.tocItems[state.selectedTocIndex];
            if (item) renderBuildingEditor(item, building);
        }
    } catch (e) {
        console.error('pushToPortal 오류:', e);
        showToast('Portal 반영에 실패했습니다', 'error');
    }
}

// 구 함수명 호환 유지
export async function fetchBuildingRegistry(buildingId) {
    return fetchFromPortal(buildingId);
}

// ========== 빌딩 권역 변경 ==========
export function changeItemRegion(idx, newRegion) {
    if (idx < 0 || idx >= state.tocItems.length) return;
    
    const item = state.tocItems[idx];
    if (!item) return;
    
    item.region = newRegion.toUpperCase();
    
    // 목차 갱신
    window.renderToc();
    
    showToast(`권역이 ${newRegion}으로 변경되었습니다`, 'success');
}

// ★ v5.0: 출력 페이지 열기 (별도 페이지로 분리)
export function openPrintPage(pageIndex = null) {
    const guideId = state.currentGuide?.id;
    if (!guideId) {
        showToast('안내문을 먼저 저장해주세요', 'warning');
        return;
    }
    
    const doOpen = () => {
        let url = `leasing-guide-print.html?id=${guideId}`;
        if (pageIndex !== null) url += `&page=${pageIndex}`;
        window.open(url, '_blank');
        showToast('출력 페이지를 새 탭에서 열었습니다', 'success');
    };
    
    if (state.hasUnsavedChanges) {
        // ★ 커스텀 3버튼 모달 (이슈 #9)
        const modalId = 'printConfirmModal_' + Date.now();
        const html = `
            <div id="${modalId}" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;">
                <div style="background:#fff;border-radius:12px;padding:28px 32px;max-width:400px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,.3);">
                    <div style="font-size:22px;text-align:center;margin-bottom:12px;">⚠️</div>
                    <div style="font-size:15px;font-weight:600;text-align:center;color:#1e293b;margin-bottom:8px;">저장되지 않은 변경사항이 있습니다</div>
                    <div style="font-size:12px;color:#64748b;text-align:center;margin-bottom:24px;">임시저장 후 출력하면 최신 내용이 반영됩니다.</div>
                    <div style="display:flex;flex-direction:column;gap:8px;">
                        <button id="${modalId}_saveprint" style="padding:10px;border-radius:8px;background:#2563eb;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;">💾 임시저장 후 출력</button>
                        <button id="${modalId}_print" style="padding:10px;border-radius:8px;background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;font-size:13px;cursor:pointer;">그냥 출력 (현재 저장본 기준)</button>
                        <button id="${modalId}_cancel" style="padding:10px;border-radius:8px;background:transparent;color:#94a3b8;border:none;font-size:12px;cursor:pointer;">취소</button>
                    </div>
                </div>
            </div>`;
        document.body.insertAdjacentHTML('beforeend', html);
        const close = () => document.getElementById(modalId)?.remove();
        document.getElementById(modalId + '_saveprint').onclick = async () => {
            close();
            // 임시저장 함수가 있으면 호출, 없으면 안내
            if (typeof window.autoSaveGuide === 'function') {
                await window.autoSaveGuide();
            } else if (typeof window.saveGuide === 'function') {
                await window.saveGuide();
            }
            doOpen();
        };
        document.getElementById(modalId + '_print').onclick = () => { close(); doOpen(); };
        document.getElementById(modalId + '_cancel').onclick = close;
        return;
    }
    doOpen();
}

// ★ v6.1: 플로팅 섹션 점프 (스크롤 + 해당 탭/편집기 오픈)
export function jumpToEditSection(target, idx, buildingId) {
    const scrollTo = (sel) => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    const byId = (id) => { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    switch (target) {
        case 'exterior':
        case 'floorplan':
        case 'map':
            byId('imageManagerSection');
            setTimeout(() => document.querySelector(`.image-tab[data-type="${target}"]`)?.click(), 350);
            break;
        case 'floorPricing':
            // 리테일에서는 접혀 있으므로 먼저 펼친다
            document.getElementById(`fpFold_${idx}`)?.setAttribute('open', '');
            byId('floorPricingSection');
            break;
        case 'vacancy': byId('vacancySection'); break;
        case 'note':
            scrollTo('.preview-note-section');
            setTimeout(() => { if (typeof window.startNoteInlineEdit === 'function') window.startNoteInlineEdit(idx, buildingId); }, 420);
            break;
        case 'contact': scrollTo('.preview-contact-section'); break;
        case 'top': scrollTo('.building-preview'); break;
    }
}

// ★ 공실 정렬 토글 함수
export function toggleVacancySort(idx) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    // 오름차순 ↔ 내림차순 토글
    item.vacancySortOrder = item.vacancySortOrder === 'asc' ? 'desc' : 'asc';
    
    // 빌딩 에디터 다시 렌더링
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (building) {
        renderBuildingEditor(item, building);
    }
    
    showToast(`층 정렬: ${item.vacancySortOrder === 'asc' ? '오름차순 (낮은층→높은층)' : '내림차순 (높은층→낮은층)'}`, 'info');
}

// 전역 함수 등록

// ★ 기준가 선택 토글
// ★ v5.5: 직접입력 행 HTML 렌더 (템플릿 리터럴 중첩 방지용 헬퍼)
function renderDirectInputRows(idx, building) {
    const rows = building.directInputRows || (
        (building.depositPy || building.rentPy || building.maintenancePy) ? [{
            label: building.rentLabel || '기준층',
            depositPy: building.depositPy || '',
            rentPy: building.rentPy || '',
            maintenancePy: building.maintenancePy || '',
            source: '직접입력'
        }] : []
    );
    if (!rows.length) {
        return '<div style="color:#94a3b8; font-size:12px; text-align:center; padding:12px 0;">아래 + 행 추가 버튼으로 기준층 임대조건을 입력하세요</div>';
    }
    return rows.map((row, ri) => {
        const bId = building.id || '';
        return '<div class="direct-input-row" id="dirRow_' + idx + '_' + ri + '" style="display:grid; grid-template-columns:1.1fr 1fr 1fr 1fr auto; gap:8px; align-items:center; padding:8px; margin-bottom:6px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px;">'
            + '<input type="text" value="' + (row.label || '') + '" placeholder="구분명 (예: 기준층)" data-field="label" data-ri="' + ri + '" style="width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px;" onchange="updateDirectRow(' + idx + ', ' + ri + ', \'label\', this.value)">'
            + '<input type="text" class="js-comma" inputmode="decimal" value="' + (row.depositPy || '') + '" placeholder="보증금" data-field="depositPy" data-ri="' + ri + '" style="width:100%; box-sizing:border-box; text-align:right; padding:8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px;" onchange="updateDirectRow(' + idx + ', ' + ri + ', \'depositPy\', this.value)">'
            + '<input type="text" class="js-comma" inputmode="decimal" value="' + (row.rentPy || '') + '" placeholder="임대료" data-field="rentPy" data-ri="' + ri + '" style="width:100%; box-sizing:border-box; text-align:right; padding:8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px;" onchange="updateDirectRow(' + idx + ', ' + ri + ', \'rentPy\', this.value)">'
            + '<input type="text" class="js-comma" inputmode="decimal" value="' + (row.maintenancePy || '') + '" placeholder="관리비" data-field="maintenancePy" data-ri="' + ri + '" style="width:100%; box-sizing:border-box; text-align:right; padding:8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px;" onchange="updateDirectRow(' + idx + ', ' + ri + ', \'maintenancePy\', this.value)">'
            + '<div style="display:flex; gap:6px; flex-shrink:0;">'
            +   '<button onclick="saveDirectRow(' + idx + ', ' + ri + ', \'' + bId + '\')" title="이 행 저장" style="padding:7px 11px; background:#2563eb; color:white; border:none; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer;">💾</button>'
            +   '<button onclick="deleteDirectRow(' + idx + ', ' + ri + ', \'' + bId + '\')" title="이 행 삭제" style="padding:7px 11px; background:#fee2e2; color:#dc2626; border:1px solid #fca5a5; border-radius:6px; font-size:13px; cursor:pointer;">🗑</button>'
            + '</div>'
            + '</div>';
    }).join('');
}

// ========== 공실 탭 전환 ==========
export function switchVacancyAddTab(mode, idx) {
    // idx가 없으면 현재 열려있는 빌딩 에디터의 활성 idx 탐색
    if (idx === undefined || idx === null) {
        // fallback: 열린 패널에서 idx 추출
        const openPanel = document.querySelector('.vacancy-add-panel[style*="block"], .vacancy-add-panel:not([style*="none"])');
        if (openPanel) {
            const m = openPanel.id?.match(/\d+/);
            if (m) idx = parseInt(m[0]);
        }
    }
    const sfx = (idx !== undefined && idx !== null) ? '_' + idx : '';
    const direct = document.getElementById('addVacancyDirect' + sfx);
    const external = document.getElementById('addVacancyExternal' + sfx);
    const tabDirect = document.getElementById('vacTabDirect' + sfx);
    const tabExternal = document.getElementById('vacTabExternal' + sfx);
    if (mode === 'direct') {
        if (direct) direct.style.display = '';
        if (external) external.style.display = 'none';
        if (tabDirect) { tabDirect.style.background = '#2563eb'; tabDirect.style.color = 'white'; }
        if (tabExternal) { tabExternal.style.background = '#f8fafc'; tabExternal.style.color = '#64748b'; }
    } else {
        if (direct) direct.style.display = 'none';
        if (external) external.style.display = '';
        if (tabExternal) { tabExternal.style.background = '#2563eb'; tabExternal.style.color = 'white'; }
        if (tabDirect) { tabDirect.style.background = '#f8fafc'; tabDirect.style.color = '#64748b'; }
    }
}

// ========== 기준층 직접입력 행 관리 ==========

// 직접입력 행 메모리 업데이트
export function updateDirectRow(itemIdx, ri, field, value) {
    const item = state.tocItems[itemIdx];
    if (!item) return;
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (!building) return;
    if (!building.directInputRows) building.directInputRows = [];
    if (!building.directInputRows[ri]) building.directInputRows[ri] = {};
    building.directInputRows[ri][field] = value;
}

// 단일 행 저장 → Firebase floorPricing에 직접입력 source로 저장
export async function saveDirectRow(itemIdx, ri, buildingId) {
    const item = state.tocItems[itemIdx];
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (!item || !building) return;
    if (!building.directInputRows) building.directInputRows = [];
    const row = building.directInputRows[ri];
    if (!row) return;

    // 행 DOM에서 최신 값 읽기 (onchange 미발생 경우 대비)
    const rowEl = document.getElementById(`dirRow_${itemIdx}_${ri}`);
    if (rowEl) {
        const inputs = rowEl.querySelectorAll('input[data-field]');
        inputs.forEach(inp => { row[inp.dataset.field] = inp.value; });
    }

    const fpEntry = {
        label: row.label || '직접입력',
        depositPy: parseFloat(String(row.depositPy).replace(/,/g, '')) || 0,
        rentPy: parseFloat(String(row.rentPy).replace(/,/g, '')) || 0,
        maintenancePy: parseFloat(String(row.maintenancePy).replace(/,/g, '')) || 0,
        source: '직접입력',
        publishDate: new Date().toISOString().slice(0, 7)
    };

    try {
        // floorPricing 배열 읽기 후 직접입력 항목 업데이트
        // (제거) 미사용 SDK 동적 import — dbRef/dbGet은 사용되지 않았음. 아래는 state 주입분 사용.
        const snapshot = await get(ref(db, `buildings/${buildingId}/floorPricing`));
        let fps = [];
        if (snapshot.exists()) {
            const val = snapshot.val();
            fps = Array.isArray(val) ? [...val] : Object.values(val);
        }
        // 같은 label의 직접입력 항목 교체 or 추가
        const existing = fps.findIndex(f => f.source === '직접입력' && f.label === fpEntry.label);
        if (existing >= 0) fps[existing] = fpEntry;
        else fps.push(fpEntry);

        await update(ref(db, `buildings/${buildingId}`), { floorPricing: fps });

        // 메모리 갱신
        building.floorPricing = fps;
        item.floorPricing = fps;
        item.floorPricingLoaded = true;

        showToast(`"${fpEntry.label}" 항목이 CRE Portal 기준가(직접입력)에 저장되었습니다.`, 'success');
        renderBuildingEditor(item, building);
    } catch (e) {
        console.error('직접입력 저장 오류:', e);
        showToast('저장 중 오류가 발생했습니다', 'error');
    }
}

// 직접입력 행 추가
export function addDirectRow(itemIdx, buildingId) {
    const item = state.tocItems[itemIdx];
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (!item || !building) return;
    if (!building.directInputRows) building.directInputRows = [];
    building.directInputRows.push({ label: '', depositPy: '', rentPy: '', maintenancePy: '', source: '직접입력' });
    renderBuildingEditor(item, building);
    // 새 행 첫 input 포커스
    setTimeout(() => {
        const rows = document.querySelectorAll(`#directInputRows_${itemIdx} .direct-input-row`);
        if (rows.length) rows[rows.length - 1].querySelector('input')?.focus();
    }, 100);
}

// 직접입력 행 삭제
export async function deleteDirectRow(itemIdx, ri, buildingId) {
    const item = state.tocItems[itemIdx];
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (!item || !building) return;
    if (!building.directInputRows) return;
    const row = building.directInputRows[ri];
    if (!row) return;

    if (!confirm(`"${row.label || '이 행'}"을 삭제하시겠습니까?`)) return;
    building.directInputRows.splice(ri, 1);

    // Firebase에서도 해당 직접입력 항목 제거
    try {
        const snapshot = await get(ref(db, `buildings/${buildingId}/floorPricing`));
        if (snapshot.exists()) {
            const val = snapshot.val();
            let fps = Array.isArray(val) ? [...val] : Object.values(val);
            fps = fps.filter(f => !(f.source === '직접입력' && f.label === row.label));
            await update(ref(db, `buildings/${buildingId}`), { floorPricing: fps });
            building.floorPricing = fps;
            item.floorPricing = fps;
        }
    } catch (e) { console.warn('Firebase 삭제 오류:', e); }

    showToast('삭제되었습니다', 'success');
    renderBuildingEditor(item, building);
}

// ========== 기준가 체크박스 다중 선택 ==========

// 체크박스 개별 토글
export function toggleFloorPricingCheck(itemIdx, fpId, checked) {
    const item = state.tocItems[itemIdx];
    if (!item) return;
    if (!item.selectedFloorPricingIds) item.selectedFloorPricingIds = [];
    if (checked) {
        if (!item.selectedFloorPricingIds.includes(fpId)) item.selectedFloorPricingIds.push(fpId);
    } else {
        item.selectedFloorPricingIds = item.selectedFloorPricingIds.filter(id => id !== fpId);
    }
    // 전체선택 체크박스 동기화
    const allCheck = document.getElementById(`fpCheckAll_${itemIdx}`);
    if (allCheck) {
        const total = (item.floorPricing || []).length;
        allCheck.checked = item.selectedFloorPricingIds.length === total;
        allCheck.indeterminate = item.selectedFloorPricingIds.length > 0 && item.selectedFloorPricingIds.length < total;
    }
    // 행 배경색만 업데이트 (전체 재렌더 없이)
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (building) window.renderBuildingEditor(item, building);
}

// 전체 체크박스
export function toggleAllFloorPricingCheck(itemIdx, checked) {
    const item = state.tocItems[itemIdx];
    if (!item) return;
    const fps = item.floorPricing || [];
    item.selectedFloorPricingIds = checked ? fps.map((fp, i) => fp.id || String(i)) : [];
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (building) window.renderBuildingEditor(item, building);
}

// 선택된 모든 항목 전체 반영
export function applyAllSelectedFloorPricing(itemIdx) {
    const item = state.tocItems[itemIdx];
    if (!item) return;
    const selected = item.selectedFloorPricingIds || [];
    if (!selected.length) { showToast('반영할 항목을 먼저 선택하세요', 'warning'); return; }
    // 마지막 선택 항목 기준으로 RENT 필드 채움
    const fps = item.floorPricing || [];
    const last = fps.find((fp, i) => selected.includes(fp.id || String(i)));
    if (last) {
        const depositEl = document.getElementById('stdDeposit');
        const rentEl = document.getElementById('stdRent');
        const maintEl = document.getElementById('stdMaintenance');
        const labelEl = document.getElementById('stdLabel');
        if (depositEl) depositEl.value = last.depositPy?.toLocaleString() || '';
        if (rentEl) rentEl.value = last.rentPy?.toLocaleString() || '';
        if (maintEl) maintEl.value = last.maintenancePy?.toLocaleString() || '';
        if (labelEl) labelEl.value = last.label || '';
    }
    showToast(`${selected.length}개 항목이 선택되었습니다. 저장 버튼으로 확정하세요.`, 'success');
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (building) window.renderBuildingEditor(item, building);
}

// ★ v5.5: 기준가 → RENT 필드 단건 반영 (반영 버튼 클릭 시)
export function applyFloorPricingToRent(itemIdx, fpId) {
    const item = state.tocItems[itemIdx];
    if (!item) return;
    const fps = item.floorPricing || [];
    const fp = fps.find((f, i) => (f.id || String(i)) === fpId);
    if (!fp) return;

    // selectedFloorPricingIds 단독 선택으로 교체
    item.selectedFloorPricingIds = [fpId];

    // stdDeposit / stdRent / stdMaintenance 입력 필드에 반영
    const depositEl = document.getElementById('stdDeposit');
    const rentEl = document.getElementById('stdRent');
    const maintEl = document.getElementById('stdMaintenance');
    const labelEl = document.getElementById('stdLabel');
    if (depositEl && fp.depositPy != null) depositEl.value = fp.depositPy.toLocaleString();
    if (rentEl && fp.rentPy != null) rentEl.value = fp.rentPy.toLocaleString();
    if (maintEl && fp.maintenancePy != null) maintEl.value = fp.maintenancePy.toLocaleString();
    if (labelEl && fp.label) labelEl.value = fp.label;

    showToast(`"${fp.label || fpId}" 기준가가 RENT 필드에 적용되었습니다. 저장 버튼으로 확정하세요.`, 'success');

    // 표 UI 새로고침
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (building) window.renderBuildingEditor(item, building);
}

export function toggleFloorPricing(itemIdx, fpId) {
    const item = state.tocItems[itemIdx];
    if (!item) return;
    const fps = item.floorPricing || [];
    if (!item.selectedFloorPricingIds) {
        item.selectedFloorPricingIds = fps.length > 0 ? [fps[0].id || '0'] : [];
    }
    const i = item.selectedFloorPricingIds.indexOf(fpId);
    if (i >= 0) item.selectedFloorPricingIds.splice(i, 1);
    else item.selectedFloorPricingIds.push(fpId);
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (building) window.renderBuildingEditor(item, building);
}

export function toggleAllFloorPricing(itemIdx, selectAll) {
    const item = state.tocItems[itemIdx];
    if (!item) return;
    const fps = item.floorPricing || [];
    item.selectedFloorPricingIds = selectAll ? fps.map((fp, i) => fp.id || String(i)) : [];
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (building) window.renderBuildingEditor(item, building);
}

// ★ [B-3] 기준가 검색 필터 — 행 show/hide만, 선택/로직 변경 없음
export function filterFloorPricingRows(itemIdx, query) {
    const q = (query || '').trim().toLowerCase();
    const tbody = document.getElementById(`floorPricingList_${itemIdx}`);
    if (!tbody) return;
    tbody.querySelectorAll('tr').forEach(tr => {
        const hay = tr.getAttribute('data-fpsearch') || '';
        tr.style.display = (!q || hay.includes(q)) ? '' : 'none';
    });
}

// ★ [B-3] 선택된 기준가 노출 순서 변경 (selectedFloorPricingIds 재정렬 → RENT 표시 순서)
export function moveFloorPricingOrder(itemIdx, fpId, dir) {
    const item = state.tocItems[itemIdx];
    if (!item || !Array.isArray(item.selectedFloorPricingIds)) return;
    const arr = item.selectedFloorPricingIds;
    const i = arr.indexOf(fpId);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (building) window.renderBuildingEditor(item, building);
}

// ★ [B-3] 미리보기 새로고침 — 편집/추가한 현재 상태를 상단 미리보기에 반영
export function refreshGuidePreview(itemIdx) {
    const item = state.tocItems[itemIdx];
    if (!item) return;
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (building) window.renderBuildingEditor(item, building);
    const prev = document.querySelector('.building-preview');
    if (prev) prev.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (typeof showToast === 'function') showToast('미리보기를 새로고침했습니다', 'success');
}

// ★ v5.4: 기준가 선택 항목 인라인 편집
export function editFloorPricingInline(itemIdx, fpIdx) {
    const item = state.tocItems[itemIdx];
    if (!item || !item.floorPricing) return;
    const fp = item.floorPricing[fpIdx];
    if (!fp) return;
    const rowEl = document.getElementById(`fpRow_${itemIdx}_${fpIdx}`);
    if (!rowEl) return;
    const fpId = fp.id || String(fpIdx);
    const selectedIds = item.selectedFloorPricingIds || [fpId];
    const isChecked = selectedIds.includes(fpId);
    const label = fp.label || fp.floorRange || ('기준가 ' + (fpIdx+1));
    rowEl.innerHTML = `
        <td style="padding:6px 6px; text-align:center;">
            <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="toggleFloorPricing(${itemIdx}, '${fpId}')" style="cursor:pointer; width:15px; height:15px;">
        </td>
        <td style="padding:6px 8px;">
            <input type="text" id="fpLabel_${itemIdx}_${fpIdx}" value="${label}" placeholder="구분명" style="width:100%; box-sizing:border-box; font-size:13px; padding:8px 10px; border:1px solid #2563eb; border-radius:6px; outline:none;">
        </td>
        <td style="padding:6px 8px;">
            <input type="text" id="fpDep_${itemIdx}_${fpIdx}" class="js-comma" inputmode="decimal" value="${fp.depositPy || ''}" placeholder="보증금" style="width:100%; box-sizing:border-box; text-align:right; font-size:13px; padding:8px 10px; border:1px solid #2563eb; border-radius:6px; outline:none;">
        </td>
        <td style="padding:6px 8px;">
            <input type="text" id="fpRent_${itemIdx}_${fpIdx}" class="js-comma" inputmode="decimal" value="${fp.rentPy || ''}" placeholder="임대료" style="width:100%; box-sizing:border-box; text-align:right; font-size:13px; padding:8px 10px; border:1px solid #2563eb; border-radius:6px; outline:none;">
        </td>
        <td style="padding:6px 8px;">
            <input type="text" id="fpMaint_${itemIdx}_${fpIdx}" class="js-comma" inputmode="decimal" value="${fp.maintenancePy || ''}" placeholder="관리비" style="width:100%; box-sizing:border-box; text-align:right; font-size:13px; padding:8px 10px; border:1px solid #2563eb; border-radius:6px; outline:none;">
        </td>
        <td style="padding:6px 6px;"></td>
        <td colspan="2" style="padding:6px 6px; text-align:center; white-space:nowrap;">
            <button onclick="saveFloorPricingInline(${itemIdx}, ${fpIdx})" style="font-size:13px; padding:7px 13px; border-radius:6px; background:#2563eb; color:#fff; border:none; cursor:pointer; font-weight:700;">저장</button>
            <button onclick="cancelFloorPricingInline(${itemIdx})" style="font-size:13px; padding:7px 11px; border-radius:6px; background:#f1f5f9; color:#64748b; border:1px solid #e2e8f0; cursor:pointer; margin-left:4px;">취소</button>
        </td>
    `;
}

export async function saveFloorPricingInline(itemIdx, fpIdx) {
    const item = state.tocItems[itemIdx];
    if (!item || !item.floorPricing) return;
    const fp = item.floorPricing[fpIdx];
    if (!fp) return;
    const newLabel = document.getElementById(`fpLabel_${itemIdx}_${fpIdx}`)?.value || fp.label;
    const newDep = document.getElementById(`fpDep_${itemIdx}_${fpIdx}`)?.value;
    const newRent = document.getElementById(`fpRent_${itemIdx}_${fpIdx}`)?.value;
    const newMaint = document.getElementById(`fpMaint_${itemIdx}_${fpIdx}`)?.value;
    const toNum = v => { const n = parseFloat(String(v).replace(/[^0-9.]/g, '')); return isNaN(n) ? (v || null) : n; };
    fp.label = newLabel;
    fp.depositPy = toNum(newDep);
    fp.rentPy = toNum(newRent);
    fp.maintenancePy = toNum(newMaint);
    // Firebase 동기화
    try {
        const buildingId = item.buildingId;
        const fpId = fp.id || String(fpIdx);
        await update(ref(db, `buildings/${buildingId}/floorPricing/${fpIdx}`), {
            label: fp.label, depositPy: fp.depositPy, rentPy: fp.rentPy, maintenancePy: fp.maintenancePy
        });
        showToast('기준가 항목이 저장되었습니다', 'success');
    } catch(e) {
        console.error('기준가 저장 오류:', e);
        showToast('저장 중 오류가 발생했습니다', 'error');
    }
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (building) renderBuildingEditor(item, building);
}

export function cancelFloorPricingInline(itemIdx) {
    const item = state.tocItems[itemIdx];
    if (!item) return;
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (building) renderBuildingEditor(item, building);
}

// ★ NOTE 인라인 편집 함수들
export function startNoteInlineEdit(idx, buildingId) {
    const display = document.getElementById(`noteDisplay_${idx}`);
    const editor = document.getElementById(`noteEditor_${idx}`);
    if (!display || !editor) return;
    display.style.display = 'none';
    editor.style.display = 'block';
    const ta = document.getElementById(`noteTextarea_${idx}`);
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

export function cancelNoteInlineEdit(idx) {
    const display = document.getElementById(`noteDisplay_${idx}`);
    const editor = document.getElementById(`noteEditor_${idx}`);
    if (!display || !editor) return;
    display.style.display = '';
    editor.style.display = 'none';
}

// ★ NOTE 소스 전환 — 'shared'(빌딩 공용) | 'custom'(이 문서 전용)
//   전용으로 처음 바꿀 때 공용 노트를 시작점으로 복사해 둔다. 빈 화면에서 다시 쓰게 만들지 않기 위해서다.
//   한 번 복사한 뒤에는 두 노트가 완전히 분리되어 서로 영향을 주지 않는다.
export function setNoteMode(idx, mode) {
    const item = state.tocItems?.[idx];
    if (!item) return;
    const next = (mode === 'custom') ? 'custom' : 'shared';
    if ((item.noteMode === 'custom' ? 'custom' : 'shared') === next) return;

    const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
    if (next === 'custom' && item.customNote === undefined) {
        item.customNote = (building.memos || [])
            .filter(m => m.showInLeasingGuide)
            .map(m => m.content || '')
            .join('\n');
    }
    item.noteMode = next;
    renderBuildingEditor(item, building);
    showToast(next === 'custom'
        ? '이 문서 전용 노트로 바꿨습니다 — 다른 안내문에는 반영되지 않습니다'
        : '빌딩 공용 노트로 바꿨습니다', 'info');
}

export async function saveNoteInline(idx, buildingId) {
    const ta = document.getElementById(`noteTextarea_${idx}`);
    if (!ta) return;
    const newText = ta.value.trim();

    // ★ 전용 노트는 item 에만 저장한다 — 빌딩 레코드를 건드리지 않으므로 다른 안내문에 영향이 없다.
    //   Firebase 반영은 안내문 저장([임시저장]/[발행]) 시점에 items 와 함께 이뤄진다.
    const itemForNote = state.tocItems?.[idx];
    if (itemForNote && itemForNote.noteMode === 'custom') {
        itemForNote.customNote = newText;
        const b = state.allBuildings.find(x => x.id === buildingId) || {};
        renderBuildingEditor(itemForNote, b);
        showToast('노트를 저장했습니다 — 안내문 저장 시 반영됩니다', 'success');
        return;
    }

    try {
        const building = state.allBuildings.find(b => b.id === buildingId);
        if (!building) return;
        // memos 배열에서 showInLeasingGuide 메모 찾아 업데이트 or 신규 생성
        if (!building.memos) building.memos = [];
        const guideIdx = building.memos.findIndex(m => m.showInLeasingGuide);
        if (newText === '') {
            // 내용 비우면 삭제
            if (guideIdx >= 0) building.memos.splice(guideIdx, 1);
            await update(ref(db, `buildings/${buildingId}`), { memos: building.memos });
        } else {
            if (guideIdx >= 0) {
                building.memos[guideIdx].content = newText;
            } else {
                building.memos.push({ content: newText, showInLeasingGuide: true, createdAt: new Date().toISOString() });
            }
            await update(ref(db, `buildings/${buildingId}`), { memos: building.memos });
        }
        showToast('노트가 저장되었습니다', 'success');
        const item = state.tocItems[idx];
        if (item) renderBuildingEditor(item, building);
    } catch (e) {
        console.error('saveNoteInline 오류:', e);
        showToast('저장에 실패했습니다', 'error');
    }
}

// ★ v6.11: 안내문 공실/기준가를 Portal 빌딩 상세에 '직접입력'으로 노출 (옵션)
//   buildings/{id}/guideVacancy · guideFloorPricing 에 스냅샷 저장 + cre_portal_sync 브로드캐스트.
//   portal.html이 이 필드를 읽어 상세 패널 안내문/기준가 영역에 렌더한다.
export async function toggleVacancyPortalExpose(idx, buildingId, checked) {
    const item = state.tocItems[idx];
    if (!item || !buildingId) { showToast('빌딩 정보가 없습니다', 'error'); return; }

    let payload;
    if (checked) {
        const all = mergeVacanciesForGuide(item);
        payload = {
            show: true,
            vacancies: all.map(v => ({
                floor: v.floor || '',
                exclusiveArea: v.exclusiveArea ?? v.area ?? '',
                rentArea: v.rentArea ?? v.area ?? '',
                deposit: v.deposit ?? v.depositPy ?? '문의',
                rent: v.rent ?? v.rentPy ?? '문의',
                maintenance: v.maintenance ?? v.maintenancePy ?? '문의',
                moveIn: v.moveIn ?? v.moveInDate ?? '즉시',
                source: v.source || v.company || '수동입력',
                usage: v.usage || 'office',   // ★ 리테일: 값이 없으면 오피스로 간주
                note: v.note || ''            // ★ 리테일: 매장 위치·업종 등
            })),
            guideId: state.currentGuide?.id || '',
            updatedAt: new Date().toISOString()
        };
    } else {
        payload = { show: false, updatedAt: new Date().toISOString() };
    }

    try {
        await update(ref(db, `buildings/${buildingId}`), { guideVacancy: payload });
        const b = state.allBuildings.find(x => x.id === buildingId); if (b) b.guideVacancy = payload;
        try { const bc = new BroadcastChannel('cre_portal_sync'); bc.postMessage({ type: 'buildingUpdated', origin: 'guide', buildingId, data: { guideVacancy: payload } }); bc.close(); } catch (_) {}
        showToast(checked ? '✅ Portal 빌딩 상세 안내문에 공실이 노출됩니다' : 'Portal 상세 공실 노출을 해제했습니다', 'success');
    } catch (e) {
        console.error('toggleVacancyPortalExpose 오류:', e);
        showToast('Portal 반영에 실패했습니다', 'error');
    }
}

export async function toggleFloorPricingPortalExpose(idx, buildingId, checked) {
    const item = state.tocItems[idx];
    if (!item || !buildingId) { showToast('빌딩 정보가 없습니다', 'error'); return; }

    let payload;
    if (checked) {
        const ids = item.selectedFloorPricingIds || [];
        const fps = item.floorPricing || [];
        let rows;
        if (ids.length) {
            rows = ids.map(id => fps.find((fp, i) => (fp.id || String(i)) === id)).filter(Boolean);
        } else {
            rows = fps;
        }
        payload = {
            show: true,
            rows: rows.map(fp => ({
                label: fp.label || fp.floorRange || '기준층',
                deposit: fp.depositPy ?? '',
                rent: fp.rentPy ?? '',
                maintenance: fp.maintenancePy ?? '',
                source: fp.source || fp.company || '수동입력'
            })),
            guideId: state.currentGuide?.id || '',
            updatedAt: new Date().toISOString()
        };
    } else {
        payload = { show: false, updatedAt: new Date().toISOString() };
    }

    try {
        await update(ref(db, `buildings/${buildingId}`), { guideFloorPricing: payload });
        const b = state.allBuildings.find(x => x.id === buildingId); if (b) b.guideFloorPricing = payload;
        try { const bc = new BroadcastChannel('cre_portal_sync'); bc.postMessage({ type: 'buildingUpdated', origin: 'guide', buildingId, data: { guideFloorPricing: payload } }); bc.close(); } catch (_) {}
        showToast(checked ? '✅ Portal 빌딩 상세에 기준가가 노출됩니다' : 'Portal 상세 기준가 노출을 해제했습니다', 'success');
    } catch (e) {
        console.error('toggleFloorPricingPortalExpose 오류:', e);
        showToast('Portal 반영에 실패했습니다', 'error');
    }
}

export function registerBuildingFunctions() {
    bindCommaInputs();  // ★ [B-6] 숫자 입력 실시간 콤마 (이벤트 위임, 1회 등록)
    bindGuideImagePaste();  // ★ [B-1] 클립보드 이미지 붙여넣기 (활성 탭 라우팅, 1회 등록)
    window.renderBuildingEditor = renderBuildingEditor;
    window.uploadImage = uploadImage;
    window.startNoteInlineEdit = startNoteInlineEdit;
    window.cancelNoteInlineEdit = cancelNoteInlineEdit;
    window.saveNoteInline = saveNoteInline;
    window.setNoteMode = setNoteMode;   // ★ NOTE 공용/전용 전환
    window.setMainImage = setMainImage;
    window.removeImage = removeImage;
    window.removeMapImage = removeMapImage;
    window.resetToStorageMapImage = resetToStorageMapImage;
    window.switchImageTab = switchImageTab;
    window.setImageUsage = setImageUsage;
    window.cycleImageUsage = cycleImageUsage;
    window.saveStandardFloor = saveStandardFloor;
    window.toggleFloorPricing = toggleFloorPricing;
    window.toggleAllFloorPricing = toggleAllFloorPricing;
    window.applyFloorPricingToRent = applyFloorPricingToRent;
    window.applyAllSelectedFloorPricing = applyAllSelectedFloorPricing;
    window.toggleFloorPricingCheck = toggleFloorPricingCheck;
    window.toggleAllFloorPricingCheck = toggleAllFloorPricingCheck;
    window.filterFloorPricingRows = filterFloorPricingRows;
    window.moveFloorPricingOrder = moveFloorPricingOrder;
    window.refreshGuidePreview = refreshGuidePreview;
    window.switchVacancyAddTab = switchVacancyAddTab;
    // switchAddVacancyMode 오버라이드 (guide-vacancy.js보다 나중에 등록)
    // guide-vacancy.js 충돌 방지: 버튼에서 직접 switchVacancyAddTab 호출하므로 override 불필요
    // 타사 공실 토글/필터/초기화 함수는 guide-vacancy.js에서 단일 등록 (중복 제거)
    window.refreshVacancyListTable = refreshVacancyListTable;
    window.updateRetailRentNote = updateRetailRentNote;   // ★ 리테일 RENT 각주
    window.setItemRoundUnit = setItemRoundUnit;           // ★ 리테일 장표별 금액 표기 단위
    window.refreshPreviewVacancyTable = refreshPreviewVacancyTable;
    window.toggleExteriorFit = toggleExteriorFit;
    window.updateDirectRow = updateDirectRow;
    window.saveDirectRow = saveDirectRow;
    window.addDirectRow = addDirectRow;
    window.deleteDirectRow = deleteDirectRow;
    window.openBuildingEditModal = openBuildingEditModal;
    window.closeBuildingEditModal = closeBuildingEditModal;
    window.saveBuildingEdit = saveBuildingEdit;
    window.fetchBuildingRegistry = fetchBuildingRegistry;
    window.fetchFromPortal = fetchFromPortal;
    window.pushToPortal = pushToPortal;
    window.changeItemRegion = changeItemRegion;
    window.openPrintPage = openPrintPage;
    window.jumpToEditSection = jumpToEditSection;
    // ★ v5.0: 상수 노출
    window.MAX_VACANCIES_PER_BUILDING = MAX_VACANCIES_PER_BUILDING;
    window.clearMoveInField = clearMoveInField;
    // ★ 신규: 안내문 공실 관련
    window.loadLeasingGuideVacancies = loadLeasingGuideVacancies;
    window.toggleGuideVacancy = toggleGuideVacancy;
    // ★ 신규: 공실 정렬
    window.editFloorPricingInline = editFloorPricingInline;
    window.saveFloorPricingInline = saveFloorPricingInline;
    window.cancelFloorPricingInline = cancelFloorPricingInline;
    window.toggleVacancySort = toggleVacancySort;
    window.selectAllGuideVacancies = selectAllGuideVacancies;
    // ★ v5.1: 지도 자동 생성
    window.generateLocationMap = generateLocationMap;
    // ★ v6.11: 안내문 → Portal 상세 노출 옵션
    window.toggleVacancyPortalExpose = toggleVacancyPortalExpose;
    window.toggleFloorPricingPortalExpose = toggleFloorPricingPortalExpose;
    // ★ v6.6: 클립보드 직접 붙여넣기
    window.pasteMapFromClipboard = pasteMapFromClipboard;
    // ★ v6.13: 평면도 클립보드 붙여넣기
    window.pasteFloorPlanFromClipboard = pasteFloorPlanFromClipboard;
    window.pasteExteriorFromClipboard = pasteExteriorFromClipboard;
}
