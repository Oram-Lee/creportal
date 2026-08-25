/**
 * CRE Portal - Comp List 템플릿 레지스트리
 *
 * 역할
 *  1) Comp List 유형(general / lg / sni)을 레지스트리로 관리 — 하드코딩 분기 제거
 *  2) S&I 시세자료 양식(sni) 템플릿의 화면 렌더 + 엑셀 다운로드 구현
 *
 * 의존성은 initTemplates(helpers)로 주입받는다 (portal-complist-page.js와 순환참조 방지).
 */

// ============================================================
// 의존성 주입
// ============================================================
let H = {};

/**
 * @param {object} helpers
 *   toWon, toManwon, formatNumber, escapeHtml, safeStringify,
 *   getExteriorUrl, showToast, getState, rerender
 */
export function initTemplates(helpers) {
    H = helpers || {};
}

// ============================================================
// 레지스트리
// ============================================================
const registry = {};

export function registerTemplate(template) {
    if (!template || !template.id) return;
    registry[template.id] = template;
}

export function getTemplate(type) {
    return registry[type] || registry.general || Object.values(registry)[0];
}

export function listTemplates() {
    return Object.values(registry);
}

/** 모든 템플릿의 스프레드시트 컨테이너 id 목록 (표시/숨김 처리용) */
export function allContainerIds() {
    return listTemplates().map(t => t.containerId).filter(Boolean);
}

// ============================================================
// S&I 양식 전용 빌딩 필드
//  - 상세 사양 4종: 이미 빌딩 스키마에 추가됨
//  - 딜 조건 4종 + 특이사항: 이번에 신설 (buildingData에 저장 → 저장+동기화 시 buildings 반영)
// ============================================================
export const SNI_BUILDING_KEYS = [
    'parkingSystem',          // 주차 방식
    'entranceDirection',      // 주 출입구 방향
    'restroomPerFloor',       // 층당 화장실 개수
    'remodelYear',            // 리모델링 년도
    'contractMonths',         // 계약기간 (개월)
    'fitoutMonths',           // Fit-out 총 제공 기간 (개월)
    'fitoutFreeMaintMonths',  // Fit-out 관리비 면제 (개월)
    'tiPerPy',                // TI 전용 1평당 지원금 (원)
    'leaseNote'               // 임차 특이사항 (수동 수정본)
];

const PY_TO_M2 = 3.305785;

// ============================================================
// 계산 유틸
// ============================================================
function num(v) {
    const n = parseFloat(String(v ?? '').replace(/,/g, ''));
    return isNaN(n) || !isFinite(n) ? 0 : n;
}

function won(v) {
    return Math.round(num(v));
}

/** 엔트리(빌딩+선택공실) 하나의 파생값 일괄 계산 */
function sniCalc(entry) {
    const bd = entry.building.buildingData || {};
    const v = entry.vacancy || {};

    const typicalPy = num(bd.typicalFloorPy);
    const rate = num(bd.exclusiveRate) || num(bd.dedicatedRate);
    const typicalExclPy = typicalPy * rate / 100;

    const rentArea = num(v.rentArea);
    const exclArea = num(v.exclusiveArea);

    const depositPy = H.toWon(v.depositPy);
    const rentPy = H.toWon(v.rentPy);
    const maintPy = H.toWon(v.maintenancePy);

    const rentFree = num(v.rentFree);
    const contractM = num(bd.contractMonths) || 60;
    const fitoutM = num(bd.fitoutMonths);
    const fitoutFreeM = num(bd.fitoutFreeMaintMonths);
    const tiPerPy = num(bd.tiPerPy);

    const contractY = contractM / 12;
    const occupyM = contractM + fitoutM;
    const occupyY = occupyM / 12;

    const monthlyRentTotal = rentPy * rentArea;
    const tiTotal = tiPerPy * exclArea;
    const tiMonths = monthlyRentTotal > 0 ? tiTotal / monthlyRentTotal : 0;

    const totalFavor = (rentFree * contractY) + fitoutM + tiMonths;
    const annualFavor = occupyY > 0 ? totalFavor / occupyY : 0;

    const avgRentPy = rentPy - ((rentPy * annualFavor) / 12);
    const avgMaintPy = occupyM > 0 ? (maintPy * (occupyM - fitoutFreeM)) / occupyM : 0;
    const exclRatio = rentArea > 0 ? exclArea / rentArea : 0;
    const noc = exclRatio > 0 ? (avgRentPy + avgMaintPy) / exclRatio : 0;

    const freeParkingBase = num(bd.freeParkingCondition);
    const freeParkingCount = freeParkingBase > 0 ? Math.floor(rentArea / freeParkingBase) : 0;

    return {
        bd, v,
        typicalPy, rate, typicalExclPy,
        rentArea, exclArea,
        depositPy, rentPy, maintPy,
        rentFree, contractM, contractY, fitoutM, fitoutFreeM, tiPerPy,
        occupyM, occupyY,
        tiTotal, tiMonths, totalFavor, annualFavor,
        avgRentPy, avgMaintPy, noc,
        freeParkingBase, freeParkingCount,
        totalDeposit: depositPy * rentArea,
        monthlyRentTotal,
        monthlyMaintTotal: maintPy * rentArea,
        avgRentTotal: avgRentPy * rentArea,
        avgMaintTotal: avgMaintPy * rentArea
    };
}

/** 임차 특이사항 자동 초안 */
export function sniLeaseNoteDraft(entry) {
    const c = sniCalc(entry);
    const lines = [];
    lines.push(`-Rent Free : ${c.rentFree > 0 ? `연 ${c.rentFree}개월` : '없음'}`);
    lines.push(`-Fit Out : ${c.fitoutM > 0 ? `${c.fitoutM}개월` : '없음'}`);
    if (c.tiPerPy > 0) {
        lines.push(`-T.I : 전용면적당 ${H.formatNumber(won(c.tiPerPy))}원`);
    }
    return lines.join('\n');
}

function sniLeaseNoteText(entry) {
    const bd = entry.building.buildingData || {};
    const custom = (bd.leaseNote || '').trim();
    return custom || sniLeaseNoteDraft(entry);
}

/** 무료 주차 기준 표기 ("231.41㎡ (70평) 당 1대") */
function freeParkingLabel(c) {
    if (c.freeParkingBase > 0) {
        return `${(c.freeParkingBase * PY_TO_M2).toFixed(2)}㎡ (${c.freeParkingBase}평) 당 1대`;
    }
    return String(c.bd.parkingRatio || '').trim();
}

// ============================================================
// 엔트리 구성 (빌딩당 1열, 공실 복수 선택 시 열 추가)
// ============================================================
export function buildSniEntries(buildings) {
    const entries = [];
    (buildings || []).forEach((b, bIdx) => {
        const vacs = b.vacancies || [];
        let selected = Array.isArray(b.selectedVacancyIdxs)
            ? b.selectedVacancyIdxs.filter(i => vacs[i])
            : [];
        if (selected.length === 0) selected = vacs.length > 0 ? [0] : [-1];
        selected.forEach(vIdx => {
            entries.push({
                building: b,
                buildingIdx: bIdx,
                vacancy: vacs[vIdx] || {},
                vacancyIdx: vIdx
            });
        });
    });
    return entries;
}

/** 헤더의 공실 선택 토글 */
window.toggleSniVacancy = function (buildingIdx, vacancyIdx) {
    const state = H.getState();
    const b = state.editData.buildings[buildingIdx];
    if (!b) return;

    const vacs = b.vacancies || [];
    let selected = Array.isArray(b.selectedVacancyIdxs)
        ? b.selectedVacancyIdxs.filter(i => vacs[i])
        : [];
    if (selected.length === 0) selected = vacs.length > 0 ? [0] : [];

    if (selected.includes(vacancyIdx)) {
        if (selected.length === 1) {
            H.showToast('공실은 최소 1개를 선택해야 합니다', 'warning');
            return;
        }
        selected = selected.filter(i => i !== vacancyIdx);
    } else {
        selected = selected.concat(vacancyIdx);
    }

    b.selectedVacancyIdxs = selected.sort((a, z) => a - z);
    H.rerender();
};

/** 임차 특이사항 편집 (멀티라인) */
window.editSniLeaseNote = function (cell, buildingIdx) {
    if (cell.querySelector('textarea')) return;

    const state = H.getState();
    const b = state.editData.buildings[buildingIdx];
    if (!b) return;
    if (!b.buildingData) b.buildingData = {};

    const entry = buildSniEntries(state.editData.buildings).find(e => e.buildingIdx === buildingIdx);
    const current = (b.buildingData.leaseNote || '').trim() || (entry ? sniLeaseNoteDraft(entry) : '');

    const ta = document.createElement('textarea');
    ta.value = current;
    ta.rows = 4;
    ta.style.cssText = 'width:100%; padding:6px; border:2px solid #3b82f6; border-radius:4px; font-size:12px; box-sizing:border-box; resize:vertical; font-family:inherit;';
    cell.innerHTML = '';
    cell.appendChild(ta);
    ta.focus();

    ta.addEventListener('blur', () => {
        b.buildingData.leaseNote = ta.value.trim();
        H.rerender();
        H.showToast('임차 특이사항이 저장되었습니다', 'success');
    });
    ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') H.rerender();
    });
};

// ============================================================
// S&I 화면 렌더링
// ============================================================
const SNI_SECTION_STYLE = {
    note: 'background:#f1f5f9;',
    building: 'background:#e0f2fe;',
    detail: 'background:#e0f2fe;',
    parking: 'background:#e0f2fe;',
    lease: 'background:#f9d6ae;',
    rent: 'background:#d9ecf2;',
    period: 'background:#f8fafc;',
    incentive: 'background:#fff2cc;',
    cost: 'background:#ffc000;'
};

function fmtMoney(x) {
    if (!x || !isFinite(x)) return '-';
    return H.formatNumber(won(x)) + '원';
}

function fmtArea(x, unit) {
    if (!x || !isFinite(x)) return '-';
    return H.formatNumber(x.toFixed(2)) + unit;
}

function fmtMonths(x, unit = '개월') {
    if (!x || !isFinite(x)) return '-';
    return x.toFixed(1) + unit;
}

/** 편집 가능한 셀 HTML */
function editCellHtml(display, onclick, extraStyle = '') {
    const inner = display && display !== '-'
        ? H.escapeHtml(String(display))
        : '<span class="placeholder-input">입력</span>';
    return `<td class="col-building cell-editable" style="${extraStyle}" onclick="${onclick}">${inner}</td>`;
}

function readCellHtml(display, cls = 'cell-formula', extraStyle = '') {
    const text = (display === undefined || display === null || display === '') ? '-' : String(display);
    return `<td class="col-building ${cls}" style="${extraStyle}">${H.escapeHtml(text)}</td>`;
}

function ledgerCellHtml(rawValue, buildingIdx, key, extraStyle = '') {
    const has = rawValue !== undefined && rawValue !== null && String(rawValue).trim() !== '';
    if (has) {
        return `<td class="col-building cell-readonly" style="${extraStyle}" title="건축물대장 정보 (수정 불가)">${H.escapeHtml(String(rawValue))} <span style="font-size:10px;color:#94a3b8;">🔒</span></td>`;
    }
    return editCellHtml('-', `editBuildingCell(this, ${buildingIdx}, '${key}')`, extraStyle);
}

function renderSniSpreadsheet() {
    const state = H.getState();
    const container = document.getElementById('sniSpreadsheet');
    if (!container) return;

    const buildings = state.editData.buildings || [];
    if (buildings.length === 0) {
        container.innerHTML = `<div class="empty-state" style="padding:60px;"><p>빌딩을 추가하세요</p></div>`;
        return;
    }

    const entries = buildSniEntries(buildings);
    const calcs = entries.map(sniCalc);

    // ---------- 헤더 ----------
    const headerCells = entries.map((e, i) => {
        const vacs = e.building.vacancies || [];
        let selector = '';
        if (vacs.length > 1) {
            const selected = Array.isArray(e.building.selectedVacancyIdxs) && e.building.selectedVacancyIdxs.length
                ? e.building.selectedVacancyIdxs : [0];
            selector = `<div style="display:flex; flex-wrap:wrap; gap:3px; justify-content:center; margin-top:3px;">` +
                vacs.map((v, vi) => {
                    const on = selected.includes(vi);
                    return `<button class="action-btn" style="padding:1px 6px; font-size:10px; background:${on ? '#3b82f6' : '#e2e8f0'}; color:${on ? '#fff' : '#475569'};"
                        onclick="event.stopPropagation(); toggleSniVacancy(${e.buildingIdx}, ${vi})"
                        title="열에 표시할 공실 선택">${H.escapeHtml(v.floor || `공실${vi + 1}`)}</button>`;
                }).join('') + `</div>`;
        }

        const floorTag = e.vacancy?.floor ? `<div class="vacancy-status has-vacancy"><span>${H.escapeHtml(e.vacancy.floor)}</span></div>` : '';

        return `
        <th class="col-building header building-header-cell">
            <div style="font-size:11px; color:#64748b;">${i + 1}</div>
            <div class="building-name">${H.escapeHtml(e.building.buildingName || '-')}</div>
            ${floorTag}
            ${selector}
            <div class="actions">
                <button class="action-btn" onclick="event.stopPropagation(); refreshBuildingLedgerInComplist('${e.building.buildingId}')" title="건축물대장 불러오기" style="background: linear-gradient(135deg, #3b82f6, #1d4ed8); color: white;">🔄</button>
                <button class="action-btn" onclick="event.stopPropagation(); openVacancyManageModal('${e.building.buildingId}')" title="공실 관리" style="background: linear-gradient(135deg, #10b981, #059669); color: white;">📋</button>
                <button class="action-btn" onclick="event.stopPropagation(); addVacancyToBuilding('${e.building.buildingId}')" title="공실 추가">➕</button>
                <button class="action-btn" onclick="event.stopPropagation(); removeBuilding('${e.building.buildingId}')" title="삭제">🗑️</button>
            </div>
        </th>`;
    }).join('');

    let html = `
        <table class="spreadsheet sni-table">
            <thead>
                <tr>
                    <th class="col-category">구분</th>
                    <th class="col-label">항목</th>
                    ${headerCells}
                </tr>
            </thead>
            <tbody>
    `;

    // ---------- 외관사진 ----------
    html += `<tr>
        <td class="col-category section-image">외관사진</td>
        <td class="col-label">빌딩 이미지</td>
        ${entries.map(e => {
            const url = H.getExteriorUrl(e.building.buildingData || {});
            return `<td class="col-building image-cell">${url
                ? `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center;"><img src="${url}" onclick="openImageModal('${e.building.buildingId}')" alt="외관"></div>`
                : `<div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%;"><button class="upload-btn" onclick="openImageModal('${e.building.buildingId}')">📷 이미지 등록</button></div>`
            }</td>`;
        }).join('')}
    </tr>`;

    // ---------- 임차 특이사항 ----------
    html += `<tr>
        <td class="col-category" style="${SNI_SECTION_STYLE.note}">임차<br>특이사항</td>
        <td class="col-label">RF / FO / TI</td>
        ${entries.map(e => {
            const text = sniLeaseNoteText(e);
            const isAuto = !((e.building.buildingData || {}).leaseNote || '').trim();
            return `<td class="col-building cell-editable" style="text-align:left; white-space:pre-line; font-size:11px; line-height:1.5;"
                onclick="editSniLeaseNote(this, ${e.buildingIdx})" title="클릭해 수정 (비우면 자동 초안으로 복귀)">${H.escapeHtml(text)}${isAuto ? ' <span style="font-size:10px;color:#94a3b8;">✎자동</span>' : ''}</td>`;
        }).join('')}
    </tr>`;

    // ---------- 섹션 렌더 헬퍼 ----------
    const section = (title, styleKey, rows) => {
        rows.forEach((row, idx) => {
            html += '<tr>';
            if (idx === 0) {
                html += `<td class="col-category" rowspan="${rows.length}" style="${SNI_SECTION_STYLE[styleKey] || ''}">${title}</td>`;
            }
            html += `<td class="col-label">${row.label}</td>`;
            entries.forEach((e, i) => { html += row.cell(e, calcs[i], i); });
            html += '</tr>';
        });
    };

    // ---------- 빌딩 현황 ----------
    section('빌딩 현황', 'building', [
        { label: '주소', cell: (e, c) => ledgerCellHtml(c.bd.addressJibun || c.bd.address, e.buildingIdx, 'addressJibun') },
        { label: '도로명 주소', cell: (e, c) => ledgerCellHtml(c.bd.address, e.buildingIdx, 'address') },
        { label: '위치', cell: (e, c) => editCellHtml(c.bd.nearestStation || c.bd.station, `editBuildingCell(this, ${e.buildingIdx}, 'nearestStation')`, 'white-space:pre-line;') },
        { label: '빌딩 규모', cell: (e, c) => ledgerCellHtml(c.bd.floors || c.bd.scale, e.buildingIdx, 'floors') },
        {
            label: '사용승인일 / 리모델링 년도',
            cell: (e, c) => {
                const base = c.bd.completionYear ? `${c.bd.completionYear} / ${c.bd.remodelYear || '-'}` : '';
                return editCellHtml(base, `editBuildingCell(this, ${e.buildingIdx}, 'remodelYear')`);
            }
        },
        { label: '전용률 (%)', cell: (e, c) => editCellHtml(c.rate ? c.rate.toFixed(2) + ' %' : '-', `editBuildingCell(this, ${e.buildingIdx}, 'exclusiveRate')`) },
        { label: '기준층 임대면적 (m²)', cell: (e, c) => readCellHtml(fmtArea(c.typicalPy * PY_TO_M2, ' m²')) },
        { label: '기준층 전용면적 (m²)', cell: (e, c) => readCellHtml(fmtArea(c.typicalExclPy * PY_TO_M2, ' m²')) },
        { label: '기준층 임대면적 (평)', cell: (e, c) => editCellHtml(c.typicalPy ? fmtArea(c.typicalPy, ' 평') : '-', `editBuildingCell(this, ${e.buildingIdx}, 'typicalFloorPy')`) },
        { label: '기준층 전용면적 (평)', cell: (e, c) => readCellHtml(fmtArea(c.typicalExclPy, ' 평')) },
        { label: '층당 화장실 개수', cell: (e, c) => editCellHtml(c.bd.restroomPerFloor, `editBuildingCell(this, ${e.buildingIdx}, 'restroomPerFloor')`) },
        { label: '주차 방식', cell: (e, c) => editCellHtml(c.bd.parkingSystem, `editBuildingCell(this, ${e.buildingIdx}, 'parkingSystem')`) },
        { label: '냉난방 방식', cell: (e, c) => editCellHtml(c.bd.hvac || c.bd.heatingCooling, `editBuildingCell(this, ${e.buildingIdx}, 'hvac')`) }
    ]);

    // ---------- 빌딩 세부현황 ----------
    section('빌딩<br>세부현황', 'detail', [
        { label: '건물종류', cell: (e, c) => ledgerCellHtml(c.bd.buildingUse || c.bd.usage, e.buildingIdx, 'buildingUse') },
        { label: '주 출입구 방향', cell: (e, c) => editCellHtml(c.bd.entranceDirection, `editBuildingCell(this, ${e.buildingIdx}, 'entranceDirection')`) }
    ]);

    // ---------- 주차 관련 ----------
    section('주차 관련', 'parking', [
        { label: '무료 주차 기준', cell: (e, c) => editCellHtml(freeParkingLabel(c), `editBuildingCell(this, ${e.buildingIdx}, 'freeParkingCondition')`) },
        { label: '무료 주차 제공 (대)', cell: (e, c) => readCellHtml(c.freeParkingCount ? `${c.freeParkingCount}대` : '-', 'cell-formula', 'background:#f1f5f9;') },
        { label: '유료 주차 기준', cell: (e, c) => editCellHtml(c.bd.paidParking || c.bd.parkingFee, `editBuildingCell(this, ${e.buildingIdx}, 'paidParking')`) }
    ]);

    // ---------- 임차 제안 ----------
    const leaseStyle = 'background:#fdf3e7;';
    section('임차 제안', 'lease', [
        { label: '입주조건 최적 임차 층수', cell: (e) => editCellHtml(e.vacancy.floor, `editVacancyCell(this, ${e.buildingIdx}, ${e.vacancyIdx}, 'floor')`) },
        { label: '입주 가능 시기', cell: (e) => editCellHtml(e.vacancy.moveInDate, `editVacancyCell(this, ${e.buildingIdx}, ${e.vacancyIdx}, 'moveInDate')`) },
        { label: '거래유형', cell: () => readCellHtml('월세', 'cell-readonly') },
        { label: '임대면적 (m²)', cell: (e, c) => readCellHtml(fmtArea(c.rentArea * PY_TO_M2, ' m²'), 'cell-formula', leaseStyle) },
        { label: '전용면적 (m²)', cell: (e, c) => readCellHtml(fmtArea(c.exclArea * PY_TO_M2, ' m²'), 'cell-formula', leaseStyle) },
        { label: '임대면적 (평)', cell: (e, c) => editCellHtml(c.rentArea ? fmtArea(c.rentArea, ' 평') : '-', `editVacancyCell(this, ${e.buildingIdx}, ${e.vacancyIdx}, 'rentArea')`, leaseStyle) },
        { label: '전용면적 (평)', cell: (e, c) => editCellHtml(c.exclArea ? fmtArea(c.exclArea, ' 평') : '-', `editVacancyCell(this, ${e.buildingIdx}, ${e.vacancyIdx}, 'exclusiveArea')`, leaseStyle) }
    ]);

    // ---------- 임대 기준 ----------
    const rentStyle = 'background:#eaf4f8;';
    section('임대 기준', 'rent', [
        { label: '월 평당 보증금', cell: (e, c) => editCellHtml(c.depositPy ? fmtMoney(c.depositPy) : '-', `editVacancyCell(this, ${e.buildingIdx}, ${e.vacancyIdx}, 'depositPy')`) },
        { label: '월 평당 임대료', cell: (e, c) => editCellHtml(c.rentPy ? fmtMoney(c.rentPy) : '-', `editVacancyCell(this, ${e.buildingIdx}, ${e.vacancyIdx}, 'rentPy')`) },
        { label: '월 평당 관리비', cell: (e, c) => editCellHtml(c.maintPy ? fmtMoney(c.maintPy) : '-', `editVacancyCell(this, ${e.buildingIdx}, ${e.vacancyIdx}, 'maintenancePy')`) },
        { label: '월 평당 지출비용', cell: (e, c) => readCellHtml(fmtMoney(c.rentPy + c.maintPy), 'cell-formula', rentStyle) },
        { label: '총 보증금', cell: (e, c) => readCellHtml(fmtMoney(c.totalDeposit)) },
        { label: '월 임대료 총액', cell: (e, c) => readCellHtml(fmtMoney(c.monthlyRentTotal)) },
        { label: '월 관리비 총액', cell: (e, c) => readCellHtml(fmtMoney(c.monthlyMaintTotal)) },
        { label: '월 전용면적당 지출비용', cell: (e, c) => readCellHtml(c.exclArea > 0 ? fmtMoney((c.monthlyRentTotal + c.monthlyMaintTotal) / c.exclArea) : '-', 'cell-formula', rentStyle) }
    ]);

    // ---------- 기간 ----------
    section('기간', 'period', [
        { label: '계약기간 (개월)', cell: (e, c) => editCellHtml(fmtMonths(c.contractM), `editBuildingCell(this, ${e.buildingIdx}, 'contractMonths')`) },
        { label: '계약기간 (년)', cell: (e, c) => readCellHtml(fmtMonths(c.contractY, '년')) },
        { label: '점유기간 (계약+FO, 개월)', cell: (e, c) => readCellHtml(fmtMonths(c.occupyM)) },
        { label: '점유기간 (년)', cell: (e, c) => readCellHtml(fmtMonths(c.occupyY, '년')) }
    ]);

    // ---------- 임대 Incentive ----------
    const incStyle = 'background:#fff8e6;';
    section('임대<br>Incentive', 'incentive', [
        { label: '렌트프리 (개월/년)', cell: (e, c) => editCellHtml(fmtMonths(c.rentFree, '개월/년'), `editVacancyCell(this, ${e.buildingIdx}, ${e.vacancyIdx}, 'rentFree')`, incStyle) },
        { label: 'Fit-out (총 제공 기간)', cell: (e, c) => editCellHtml(fmtMonths(c.fitoutM), `editBuildingCell(this, ${e.buildingIdx}, 'fitoutMonths')`, incStyle) },
        { label: 'Fit-out (관리비 면제)', cell: (e, c) => editCellHtml(fmtMonths(c.fitoutFreeM), `editBuildingCell(this, ${e.buildingIdx}, 'fitoutFreeMaintMonths')`, incStyle) },
        { label: 'TI (총액)', cell: (e, c) => readCellHtml(c.tiTotal ? `총액 ${H.formatNumber(won(c.tiTotal))}원` : '-', 'cell-formula', incStyle) },
        { label: 'TI (전용 1평당)', cell: (e, c) => editCellHtml(c.tiPerPy ? `전용 1평당 ${H.formatNumber(won(c.tiPerPy))}원` : '-', `editBuildingCell(this, ${e.buildingIdx}, 'tiPerPy')`, incStyle) },
        { label: 'TI (RF 환산)', cell: (e, c) => readCellHtml(c.tiMonths ? `RF 환산 총 ${c.tiMonths.toFixed(1)}개월` : '-', 'cell-formula', incStyle) },
        { label: '계약기간 총 Favor', cell: (e, c) => readCellHtml(fmtMonths(c.totalFavor), 'cell-formula', incStyle) },
        { label: '연평균 Favor', cell: (e, c) => readCellHtml(fmtMonths(c.annualFavor, '개월/년'), 'cell-formula', 'background:#ffefc2; font-weight:600;') },
        { label: '평균 월 평당 임대료', cell: (e, c) => readCellHtml(fmtMoney(c.avgRentPy), 'cell-formula', incStyle) },
        { label: '평균 월 평당 관리비', cell: (e, c) => readCellHtml(fmtMoney(c.avgMaintPy), 'cell-formula', incStyle) },
        { label: '초년차 기준 NOC', cell: (e, c) => readCellHtml(fmtMoney(c.noc), 'cell-formula', 'background:#ffc000; font-weight:700;') }
    ]);

    // ---------- 예상 비용 ----------
    const costStyle = 'background:#ffe08a; font-weight:600;';
    section('예상 비용', 'cost', [
        { label: '보증금', cell: (e, c) => readCellHtml(fmtMoney(c.totalDeposit), 'cell-formula', costStyle) },
        { label: '평균 월 임대료', cell: (e, c) => readCellHtml(fmtMoney(c.avgRentTotal), 'cell-formula', costStyle) },
        { label: '평균 월 관리비', cell: (e, c) => readCellHtml(fmtMoney(c.avgMaintTotal), 'cell-formula', costStyle) },
        { label: '월 지출비용 (임대료+관리비)', cell: (e, c) => readCellHtml(fmtMoney(c.avgRentTotal + c.avgMaintTotal), 'cell-formula', 'background:#a6a6a6; font-weight:700;') },
        { label: '연 지출비용 (월 지출×12)', cell: (e, c) => readCellHtml(fmtMoney((c.avgRentTotal + c.avgMaintTotal) * 12), 'cell-formula', costStyle) }
    ]);

    html += '</tbody></table>';
    container.innerHTML = html;
}

// ============================================================
// S&I 엑셀 다운로드 (원본 서식 재현)
// ============================================================
const SNI_FMT = {
    percent: '##0.00\\ "%"',
    m2: '#,##0.000\\ "m²"',
    py: '#,##0.000\\ "평"',
    comma: '_-* #,##0_-;\\-* #,##0_-;_-* "-"??_-;_-@_-',
    won: '\\₩* #,##0',
    wonAcc: '_-\\₩* #,##0_-;\\-\\₩* #,##0_-;_-\\₩* "-"_-;_-@_-',
    months: '0.0\\ "개월"',
    years: '0.0\\ "년"',
    monthsY: '0.0\\ "개월/년"',
    tiTotal: '"총액"\\ #,##0\\ "원"',
    tiPerPy: '"전용 1평당"\\ #,##0\\ "원"',
    tiMonths: '"RF 환산 총"\\ 0.0\\ "개월"'
};

const SNI_FILL = {
    header: 'FF2C2A2A',
    white: 'FFFFFFFF',
    gray: 'FFCCCCCC',
    lease: 'FFF9D6AE',
    rent: 'FFD9ECF2',
    inc: 'FFFFF2CC',
    incStrong: 'FFFFE699',
    accent: 'FFFFC000',
    dark: 'FFA6A6A6'
};

/** 행별 배경/표시형식/강조 정의 */
const SNI_ROW_STYLE = {
    23: { fill: SNI_FILL.gray }, 27: { fill: SNI_FILL.gray },
    29: { fill: SNI_FILL.lease, fmt: SNI_FMT.m2, bold: true },
    30: { fill: SNI_FILL.lease, fmt: SNI_FMT.m2, bold: true },
    31: { fill: SNI_FILL.lease, fmt: SNI_FMT.py, bold: true },
    32: { fill: SNI_FILL.lease, fmt: SNI_FMT.py, bold: true },
    36: { fill: SNI_FILL.rent, fmt: SNI_FMT.won, bold: true },
    40: { fill: SNI_FILL.rent, fmt: SNI_FMT.won, bold: true },
    41: { fill: SNI_FILL.white, fmt: SNI_FMT.months },
    42: { fill: SNI_FILL.white, fmt: SNI_FMT.years },
    43: { fill: SNI_FILL.white, fmt: SNI_FMT.months },
    44: { fill: SNI_FILL.white, fmt: SNI_FMT.years },
    45: { fill: SNI_FILL.inc, fmt: SNI_FMT.monthsY, bold: true, color: 'FFFF0000' },
    46: { fill: SNI_FILL.inc, fmt: SNI_FMT.months },
    47: { fill: SNI_FILL.inc, fmt: SNI_FMT.months },
    48: { fill: SNI_FILL.inc, fmt: SNI_FMT.tiTotal, bold: true },
    49: { fill: SNI_FILL.inc, fmt: SNI_FMT.tiPerPy },
    50: { fill: SNI_FILL.inc, fmt: SNI_FMT.tiMonths },
    51: { fill: SNI_FILL.inc, fmt: SNI_FMT.months },
    52: { fill: SNI_FILL.incStrong, fmt: SNI_FMT.monthsY, bold: true, color: 'FFFF0000' },
    53: { fill: SNI_FILL.inc, fmt: SNI_FMT.wonAcc, bold: true },
    54: { fill: SNI_FILL.inc, fmt: SNI_FMT.wonAcc, bold: true },
    55: { fill: SNI_FILL.accent, fmt: SNI_FMT.wonAcc, bold: true, color: 'FFFF0000' },
    57: { fill: SNI_FILL.accent, fmt: SNI_FMT.wonAcc, bold: true },
    58: { fill: SNI_FILL.accent, fmt: SNI_FMT.wonAcc, bold: true },
    59: { fill: SNI_FILL.accent, fmt: SNI_FMT.wonAcc, bold: true },
    60: { fill: SNI_FILL.dark, fmt: SNI_FMT.wonAcc, bold: true, color: 'FFFF0000' },
    61: { fill: SNI_FILL.accent, fmt: SNI_FMT.wonAcc, bold: true }
};

const SNI_LABELS = {
    6: ['임차 특이사항', null],
    7: ['빌딩 현황', '주소'],
    8: [null, '도로명 주소'],
    9: [null, '위치'],
    10: [null, '빌딩 규모'],
    11: [null, '사용승인일 / 리모델링 년도'],
    12: [null, '전용률 (%)'],
    13: [null, '기준층 임대면적 (m2)'],
    14: [null, '기준층 전용면적 (m2)'],
    15: [null, '기준층 임대면적 (평)'],
    16: [null, '기준층 전용면적 (평)'],
    17: [null, '층당 화장실 개수'],
    18: [null, '주차 방식'],
    19: [null, '냉난방 방식'],
    20: ['빌딩 세부현황', '건물종류'],
    21: [null, '주 출입구 방향'],
    22: ['주차 관련', '무료 주차 기준'],
    23: [null, '무료 주차 제공 (대)'],
    24: [null, '유료 주차 기준'],
    26: ['임차 제안', '입주조건 최적 임차 층수'],
    27: [null, '입주 가능 시기'],
    28: [null, '거래유형'],
    29: [null, '임대면적 (m2)'],
    30: [null, '전용면적 (m2)'],
    31: [null, '임대면적 (평)'],
    32: [null, '전용면적 (평)'],
    33: ['임대 기준', '월 평당 보증금'],
    34: [null, '월 평당 임대료'],
    35: [null, '월 평당 관리비'],
    36: [null, '월 평당 지출비용'],
    37: [null, '총 보증금'],
    38: [null, '월 임대료 총액'],
    39: [null, '월 관리비 총액'],
    40: [null, '월 전용면적당 지출비용'],
    41: ['기간', '계약기간'],
    43: [null, '점유기간\n(계약기간+FO)'],
    45: ['임대\nIncentive', '렌트프리(개월/년)'],
    46: [null, 'Fit-out (총 제공 기간)'],
    47: [null, 'Fit-out (관리비 면제)'],
    48: [null, 'TI (이전비용 지원)'],
    51: [null, '계약기간 총 Favor'],
    52: [null, '연평균 Favor'],
    53: [null, '평균 월 평당 임대료'],
    54: [null, '평균 월 평당 관리비'],
    55: [null, '초년차 기준 NOC'],
    57: ['예상 비용', '보증금'],
    58: [null, '평균 월 임대료'],
    59: [null, '평균 월 관리비'],
    60: [null, '월 지출비용 (임대료+관리비)'],
    61: [null, '연 지출 비용 (월 지출비용*12)']
};

const SNI_MERGES = ['B3:C4', 'B5:C5', 'B6:C6', 'B7:B19', 'B20:B21', 'B22:B24', 'B26:B32',
    'B33:B40', 'B41:B44', 'C41:C42', 'C43:C44', 'B45:B55', 'C48:C50', 'B57:B61'];

function colLetter(n) {
    let s = '';
    while (n > 0) {
        const m = (n - 1) % 26;
        s = String.fromCharCode(65 + m) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

async function downloadExcelSni(data) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(data.title ? String(data.title).slice(0, 28) : '시세자료');

    const entries = buildSniEntries(data.buildings || []);
    if (entries.length === 0) {
        H.showToast('다운로드할 데이터가 없습니다', 'warning');
        return;
    }

    sheet.columns = [
        { width: 2.66 },   // A
        { width: 13.22 },  // B
        { width: 24.55 },  // C
        ...entries.map(() => ({ width: 26.33 }))
    ];

    const border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

    const put = (ref, value, opts = {}) => {
        const cell = sheet.getCell(ref);
        if (opts.formula) cell.value = { formula: opts.formula };
        else cell.value = (value === '' || value === undefined || value === null) ? null : value;
        cell.font = {
            name: '맑은 고딕', size: 9,
            bold: !!opts.bold,
            color: { argb: opts.color || 'FF000000' }
        };
        cell.alignment = {
            horizontal: opts.align || 'center',
            vertical: 'middle',
            wrapText: opts.wrap !== false
        };
        cell.border = opts.border || border;
        if (opts.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } };
        if (opts.fmt) cell.numFmt = opts.fmt;
        return cell;
    };

    // ---------- 헤더 (행 3~4) ----------
    sheet.mergeCells('B3:C4');
    put('B3', 'PRESENT TO :', { fill: SNI_FILL.header, color: 'FFFFFFFF', bold: true });
    entries.forEach((e, i) => {
        const col = colLetter(4 + i);
        put(`${col}3`, i + 1, { fill: SNI_FILL.header, color: 'FFFFFFFF', bold: true });
        // 같은 빌딩이 여러 열로 나뉜 경우에만 층을 병기 (1열이면 원본과 동일하게 빌딩명만)
        const multi = entries.filter(x => x.buildingIdx === e.buildingIdx).length > 1;
        const floorTag = (multi && e.vacancy?.floor) ? ` (${e.vacancy.floor})` : '';
        put(`${col}4`, (e.building.buildingName || '-') + floorTag, { fill: SNI_FILL.header, color: 'FFFFFFFF', bold: true });
    });

    // ---------- 행 높이 ----------
    for (let r = 1; r <= 61; r++) sheet.getRow(r).height = 16.9;
    sheet.getRow(5).height = 190.15;
    sheet.getRow(6).height = 79.9;
    sheet.getRow(9).height = 60;

    // ---------- 라벨 (B/C열) ----------
    sheet.mergeCells('B5:C5');
    put('B5', '외관사진', { fill: SNI_FILL.white, bold: true });
    Object.entries(SNI_LABELS).forEach(([row, [bLabel, cLabel]]) => {
        const r = Number(row);
        const style = SNI_ROW_STYLE[r] || {};
        if (bLabel !== null && bLabel !== undefined) {
            put(`B${r}`, bLabel, { fill: style.fill || SNI_FILL.white, bold: true });
        }
        if (cLabel !== null && cLabel !== undefined) {
            put(`C${r}`, cLabel, { fill: style.fill || SNI_FILL.white, bold: !!style.bold, align: 'left' });
        }
    });
    // 병합 대상 빈 라벨 셀 서식 보정
    [42, 44, 49, 50].forEach(r => {
        const style = SNI_ROW_STYLE[r] || {};
        put(`C${r}`, null, { fill: style.fill || SNI_FILL.white, align: 'left' });
    });
    [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 23, 24, 27, 28, 29, 30, 31, 32,
        34, 35, 36, 37, 38, 39, 40, 42, 43, 44, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55,
        58, 59, 60, 61].forEach(r => {
            const style = SNI_ROW_STYLE[r] || {};
            put(`B${r}`, null, { fill: style.fill || SNI_FILL.white });
        });
    SNI_MERGES.forEach(m => { try { sheet.mergeCells(m); } catch (err) { /* 이미 병합됨 */ } });

    // ---------- 빌딩 열 ----------
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const c = sniCalc(e);
        const col = colLetter(4 + i);
        const bd = c.bd;

        // 외관사진 (행 5)
        const url = H.getExteriorUrl(bd);
        put(`${col}5`, null, {});
        if (url && url.startsWith('data:image')) {
            try {
                const imageId = workbook.addImage({
                    base64: url.split(',')[1],
                    extension: url.includes('png') ? 'png' : 'jpeg'
                });
                sheet.addImage(imageId, {
                    tl: { col: 3 + i, row: 4 },
                    br: { col: 4 + i, row: 5 },
                    editAs: 'oneCell'
                });
            } catch (err) {
                console.error('이미지 삽입 실패:', err);
            }
        } else if (url) {
            put(`${col}5`, '이미지 있음', {});
        }

        // 임차 특이사항 (행 6)
        put(`${col}6`, sniLeaseNoteText(e), { align: 'left' });

        // 빌딩 현황 (행 7~19)
        put(`${col}7`, bd.addressJibun || bd.address || '');
        put(`${col}8`, bd.address || '');
        put(`${col}9`, bd.nearestStation || bd.station || '', { align: 'left' });
        put(`${col}10`, bd.floors || bd.scale || '');
        put(`${col}11`, bd.completionYear ? `${bd.completionYear} / ${bd.remodelYear || '-'}` : '');
        put(`${col}12`, null, { formula: `IFERROR((${col}16/${col}15)*100,0)`, fmt: SNI_FMT.percent });
        put(`${col}13`, null, { formula: `ROUNDDOWN(${col}15*3.305785, 3)`, fmt: SNI_FMT.m2 });
        put(`${col}14`, null, { formula: `ROUNDDOWN(${col}16*3.305785, 3)`, fmt: SNI_FMT.m2 });
        put(`${col}15`, c.typicalPy || null, { fmt: SNI_FMT.py });
        put(`${col}16`, c.typicalExclPy || null, { fmt: SNI_FMT.py });
        put(`${col}17`, bd.restroomPerFloor || '');
        put(`${col}18`, bd.parkingSystem || '');
        put(`${col}19`, bd.hvac || bd.heatingCooling || '');

        // 빌딩 세부현황 (행 20~21)
        put(`${col}20`, bd.buildingUse || bd.usage || '');
        put(`${col}21`, bd.entranceDirection || '');

        // 주차 관련 (행 22~24)
        put(`${col}22`, freeParkingLabel(c));
        put(`${col}23`, c.freeParkingCount ? `${c.freeParkingCount}대` : '', { fill: SNI_FILL.gray });
        put(`${col}24`, bd.paidParking || bd.parkingFee || '');

        // 임차 제안 (행 26~32)
        const st = (r) => SNI_ROW_STYLE[r] || {};
        put(`${col}26`, c.v.floor || '');
        put(`${col}27`, c.v.moveInDate || '', { fill: SNI_FILL.gray });
        put(`${col}28`, '월세');
        put(`${col}29`, null, { formula: `ROUNDDOWN(${col}31*3.305785, 3)`, ...st(29) });
        put(`${col}30`, null, { formula: `ROUNDDOWN(${col}32*3.305785, 3)`, ...st(30) });
        put(`${col}31`, c.rentArea || null, st(31));
        put(`${col}32`, c.exclArea || null, st(32));

        // 임대 기준 (행 33~40)
        // 보증금: 입력값 우선, 없으면 원본 양식 관례(임대료 × 10) 수식으로 대체
        if (c.depositPy > 0) {
            put(`${col}33`, c.depositPy, { fmt: SNI_FMT.comma, align: 'right' });
        } else {
            put(`${col}33`, null, { formula: `${col}34*10`, fmt: SNI_FMT.comma, align: 'right' });
        }
        put(`${col}34`, c.rentPy || null, { fmt: SNI_FMT.won, align: 'right' });
        put(`${col}35`, c.maintPy || null, { fmt: SNI_FMT.won, align: 'right' });
        put(`${col}36`, null, { formula: `${col}34+${col}35`, align: 'right', ...st(36) });
        put(`${col}37`, null, { formula: `${col}33*${col}31`, fmt: SNI_FMT.won, align: 'right' });
        put(`${col}38`, null, { formula: `${col}34*${col}31`, fmt: SNI_FMT.won, align: 'right' });
        put(`${col}39`, null, { formula: `${col}35*${col}31`, fmt: SNI_FMT.won, align: 'right' });
        put(`${col}40`, null, { formula: `IFERROR((${col}38+${col}39)/${col}32,0)`, align: 'right', ...st(40) });

        // 기간 (행 41~44)
        put(`${col}41`, c.contractM || null, st(41));
        put(`${col}42`, null, { formula: `${col}41/12`, ...st(42) });
        put(`${col}43`, null, { formula: `${col}41+${col}46`, ...st(43) });
        put(`${col}44`, null, { formula: `${col}43/12`, ...st(44) });

        // 임대 Incentive (행 45~55)
        put(`${col}45`, c.rentFree || 0, st(45));
        put(`${col}46`, c.fitoutM || 0, st(46));
        put(`${col}47`, c.fitoutFreeM || 0, st(47));
        put(`${col}48`, null, { formula: `${col}49*${col}32`, ...st(48) });
        put(`${col}49`, c.tiPerPy || 0, st(49));
        put(`${col}50`, null, { formula: `IFERROR(${col}48/${col}38,0)`, ...st(50) });
        put(`${col}51`, null, { formula: `(${col}45*${col}42)+${col}46+${col}50`, ...st(51) });
        put(`${col}52`, null, { formula: `IFERROR(${col}51/${col}44,0)`, ...st(52) });
        put(`${col}53`, null, { formula: `${col}34-((${col}34*${col}52)/12)`, ...st(53) });
        put(`${col}54`, null, { formula: `IFERROR((${col}35*(${col}43-${col}47))/${col}43,0)`, ...st(54) });
        put(`${col}55`, null, { formula: `IFERROR((${col}53+${col}54)/(${col}32/${col}31),0)`, ...st(55) });

        // 예상 비용 (행 57~61)
        put(`${col}57`, null, { formula: `${col}33*${col}31`, ...st(57), border: { ...border, top: { style: 'thick' } } });
        put(`${col}58`, null, { formula: `${col}53*${col}31`, ...st(58) });
        put(`${col}59`, null, { formula: `${col}54*${col}31`, ...st(59) });
        put(`${col}60`, null, { formula: `${col}58+${col}59`, ...st(60) });
        put(`${col}61`, null, { formula: `${col}60*12`, ...st(61), border: { ...border, bottom: { style: 'thick' } } });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `시세자료_${data.title || 'CompList'}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);

    H.showToast('✅ 엑셀 다운로드 완료', 'success');
}

// ============================================================
// S&I 템플릿 등록
// ============================================================
registerTemplate({
    id: 'sni',
    label: 'S&I 시세자료',
    icon: '📑',
    badgeClass: 'general',
    badgeStyle: 'background:#fef3c7; color:#92400e;',
    containerId: 'sniSpreadsheet',
    render: renderSniSpreadsheet,
    exportExcel: downloadExcelSni
});
