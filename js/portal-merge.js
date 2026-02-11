/**
 * portal-merge.js — #13 동일주소 빌딩 통합 + 태그화
 * 
 * 기능:
 * 1. 중복 빌딩 탐지 (주소 기반 + 이름 유사도)
 * 2. 통합(병합) UI — 필드별 선택, 데이터 이관
 * 3. aliases 관리 — OCR 매칭 정확도 향상
 * 
 * v1.1 수정사항 (2026-02-10):
 * - ★ Firebase Modular SDK 호환: firebase.database() → portal-firebase.js 동적 import
 */

// ============================================================
// Firebase 참조 헬퍼 (Modular SDK 대응)
// ============================================================
async function getMergeFirebaseRefs() {
    const mod = await import('./portal-firebase.js');
    return {
        db: mod.db,
        ref: mod.ref,
        get: mod.get,
        set: mod.set,
        update: mod.update,
        remove: mod.remove,
        push: mod.push
    };
}

// ============================================================
// 주소 정규화 유틸 (admin-leasing.html과 동일 로직 공유)
// ============================================================

function mergeNormalizeAddress(address) {
    if (!address) return '';
    let n = address.trim();
    n = n.replace(/서울특별시/g, '서울').replace(/서울시/g, '서울');
    n = n.replace(/\s*\([^)]*\)/g, '');
    n = n.replace(/[,.]/, ' ').replace(/\s+/g, ' ').trim();
    return n;
}

function mergeExtractAddressKey(address) {
    const normalized = mergeNormalizeAddress(address);
    const guMatch = normalized.match(/(강남구|강동구|강북구|강서구|관악구|광진구|구로구|금천구|노원구|도봉구|동대문구|동작구|마포구|서대문구|서초구|성동구|성북구|송파구|양천구|영등포구|용산구|은평구|종로구|중구|중랑구)/);
    const gu = guMatch ? guMatch[1] : '';
    const roadMatch = normalized.match(/([가-힣]+로|[가-힣]+길)\s*\d+/);
    const dongNumMatch = normalized.match(/([가-힣]+동)\s*\d+/);
    const dongAlphaNumMatch = normalized.match(/([가-힣]+동)\s*([A-Za-z0-9][-A-Za-z0-9]*)/);
    const dongOnlyMatch = normalized.match(/([가-힣]+동)(?:\s|$)/);
    
    if (roadMatch) return `${gu} ${roadMatch[0]}`.trim();
    if (dongNumMatch) return `${gu} ${dongNumMatch[0]}`.trim();
    if (dongAlphaNumMatch) return `${gu} ${dongAlphaNumMatch[1]} ${dongAlphaNumMatch[2]}`.trim();
    if (dongOnlyMatch) return `${gu} ${dongOnlyMatch[1]}`.trim();
    return gu || normalized.slice(0, 20);
}

function mergeStringSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();
    if (s1 === s2) return 1;
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    if (longer.length === 0) return 1;
    if (longer.includes(shorter) || shorter.includes(longer)) {
        return Math.min(1, shorter.length / longer.length + 0.3);
    }
    // Dice coefficient (bigram)
    const bigrams = (s) => {
        const bg = new Set();
        for (let i = 0; i < s.length - 1; i++) bg.add(s.slice(i, i + 2));
        return bg;
    };
    const bg1 = bigrams(s1);
    const bg2 = bigrams(s2);
    let intersection = 0;
    bg1.forEach(b => { if (bg2.has(b)) intersection++; });
    return (2 * intersection) / (bg1.size + bg2.size) || 0;
}

function normalizeBuildingName(name) {
    if (!name) return '';
    return name.replace(/빌딩|타워|센터|오피스|B\/D|BD|Bldg|bldg/gi, '').replace(/\s+/g, '').trim().toLowerCase();
}

// ============================================================
// 중복 탐지 엔진
// ============================================================

/**
 * Firebase buildings 전체를 스캔하여 중복 후보 그룹을 반환
 * @returns {Array<{groupId, buildings: [{id, name, address, ...}], matchType, similarity}>}
 */
async function detectDuplicateBuildings() {
    const { db, ref, get } = await getMergeFirebaseRefs();
    const snap = await get(ref(db, 'buildings'));
    const buildings = snap.val() || {};
    
    const entries = Object.entries(buildings)
        .filter(([id, b]) => b && typeof b === 'object' && b.name)
        .map(([id, b]) => ({
            id,
            name: b.name || '',
            address: b.address || '',
            addressJibun: b.addressJibun || '',
            aliases: b.aliases || [],
            addrKey: mergeExtractAddressKey(b.address || ''),
            addrKeyJibun: mergeExtractAddressKey(b.addressJibun || ''),
            nameNorm: normalizeBuildingName(b.name),
            data: b
        }));
    
    console.log(`🔍 중복 탐지 시작: ${entries.length}개 빌딩`);
    
    // Step 1: 주소키 기반 그룹핑
    const addrGroups = {};
    entries.forEach(e => {
        const keys = [e.addrKey, e.addrKeyJibun].filter(k => k && k.length > 3);
        keys.forEach(key => {
            if (!addrGroups[key]) addrGroups[key] = [];
            if (!addrGroups[key].find(x => x.id === e.id)) {
                addrGroups[key].push(e);
            }
        });
    });
    
    // Step 2: 2개 이상 빌딩이 같은 주소키를 공유하는 그룹 추출
    const candidateGroups = [];
    const processedPairs = new Set();
    
    Object.entries(addrGroups).forEach(([key, group]) => {
        if (group.length < 2) return;
        
        // 그룹 내 모든 쌍을 비교
        for (let i = 0; i < group.length; i++) {
            for (let j = i + 1; j < group.length; j++) {
                const a = group[i];
                const b = group[j];
                const pairKey = [a.id, b.id].sort().join('|');
                if (processedPairs.has(pairKey)) continue;
                processedPairs.add(pairKey);
                
                // 주소 유사도 (도로명 + 지번 교차 비교)
                const addrSims = [
                    mergeStringSimilarity(a.addrKey, b.addrKey),
                    mergeStringSimilarity(a.addrKey, b.addrKeyJibun),
                    mergeStringSimilarity(a.addrKeyJibun, b.addrKey),
                    mergeStringSimilarity(a.addrKeyJibun, b.addrKeyJibun)
                ];
                const bestAddrSim = Math.max(...addrSims);
                
                // 이름 유사도
                const nameSim = mergeStringSimilarity(a.nameNorm, b.nameNorm);
                
                // alias 체크
                const aliasMatch = (a.aliases || []).some(al => 
                    mergeStringSimilarity(normalizeBuildingName(al), b.nameNorm) > 0.7
                ) || (b.aliases || []).some(al => 
                    mergeStringSimilarity(normalizeBuildingName(al), a.nameNorm) > 0.7
                );
                
                let matchType = null;
                let similarity = 0;
                
                // Level 1: 주소 완전 일치
                if (bestAddrSim >= 0.95) {
                    matchType = 'address_exact';
                    similarity = bestAddrSim;
                }
                // Level 2: 주소 유사 + 이름 보조
                else if (bestAddrSim >= 0.7 && (nameSim >= 0.3 || aliasMatch)) {
                    matchType = 'address_similar';
                    similarity = bestAddrSim * 0.7 + nameSim * 0.3;
                }
                // Level 3: 이름 매우 유사 + 같은 구
                else if (nameSim >= 0.8 && a.addrKey.split(' ')[0] === b.addrKey.split(' ')[0]) {
                    matchType = 'name_similar';
                    similarity = nameSim;
                }
                // Level 4: alias 매칭
                else if (aliasMatch && bestAddrSim >= 0.5) {
                    matchType = 'alias_match';
                    similarity = 0.85;
                }
                
                if (matchType) {
                    candidateGroups.push({
                        buildings: [a, b],
                        matchType,
                        similarity: Math.round(similarity * 100) / 100,
                        addrKey: key
                    });
                }
            }
        }
    });
    
    // Step 3: 쌍을 그룹으로 병합 (A-B, B-C → A-B-C)
    const mergedGroups = mergePairsToGroups(candidateGroups);
    
    console.log(`✅ 중복 후보 그룹: ${mergedGroups.length}개`);
    return mergedGroups;
}

function mergePairsToGroups(pairs) {
    const parent = {};
    const find = (x) => parent[x] === x ? x : (parent[x] = find(parent[x]));
    const union = (a, b) => { parent[find(a)] = find(b); };
    
    // 모든 빌딩 ID 초기화
    pairs.forEach(p => {
        p.buildings.forEach(b => {
            if (!parent[b.id]) parent[b.id] = b.id;
        });
    });
    
    // Union-Find로 그룹핑
    pairs.forEach(p => {
        if (p.buildings.length >= 2) {
            union(p.buildings[0].id, p.buildings[1].id);
        }
    });
    
    // 그룹별로 빌딩 수집
    const groups = {};
    const buildingMap = {};
    pairs.forEach(p => {
        p.buildings.forEach(b => { buildingMap[b.id] = b; });
    });
    
    Object.keys(parent).forEach(id => {
        const root = find(id);
        if (!groups[root]) groups[root] = { 
            buildings: [], 
            matchType: 'mixed', 
            similarity: 0,
            matchTypes: new Set()
        };
        if (!groups[root].buildings.find(b => b.id === id)) {
            groups[root].buildings.push(buildingMap[id]);
        }
    });
    
    // 매치 타입 및 유사도 집계
    pairs.forEach(p => {
        const root = find(p.buildings[0].id);
        if (groups[root]) {
            groups[root].matchTypes.add(p.matchType);
            groups[root].similarity = Math.max(groups[root].similarity, p.similarity);
        }
    });
    
    return Object.values(groups)
        .filter(g => g.buildings.length >= 2)
        .map((g, idx) => ({
            groupId: `dup_${idx}`,
            buildings: g.buildings,
            matchType: g.matchTypes.size === 1 ? [...g.matchTypes][0] : 'mixed',
            similarity: g.similarity,
            count: g.buildings.length
        }))
        .sort((a, b) => b.similarity - a.similarity);
}

// ============================================================
// 중복 관리 UI
// ============================================================

let _duplicateGroups = [];
let _currentMergeGroup = null;

async function openDuplicateManager() {
    const overlay = document.getElementById('duplicateManagerOverlay');
    if (!overlay) {
        console.error('duplicateManagerOverlay 없음');
        return;
    }
    
    overlay.style.display = 'flex';
    document.getElementById('dupManagerContent').innerHTML = `
        <div style="text-align: center; padding: 60px;">
            <div style="font-size: 32px; margin-bottom: 12px;">🔍</div>
            <div style="font-size: 14px; color: #64748b;">중복 빌딩을 탐지하고 있습니다...</div>
            <div style="margin-top: 12px; font-size: 12px; color: #94a3b8;">Firebase에서 모든 빌딩을 로드 중</div>
        </div>
    `;
    
    try {
        _duplicateGroups = await detectDuplicateBuildings();
        renderDuplicateList();
    } catch (err) {
        console.error('중복 탐지 오류:', err);
        document.getElementById('dupManagerContent').innerHTML = `
            <div style="text-align: center; padding: 60px; color: #ef4444;">
                <div style="font-size: 32px; margin-bottom: 12px;">❌</div>
                <div>중복 탐지 중 오류가 발생했습니다</div>
                <div style="font-size: 12px; margin-top: 8px;">${err.message}</div>
            </div>
        `;
    }
}

function closeDuplicateManager() {
    const overlay = document.getElementById('duplicateManagerOverlay');
    if (overlay) overlay.style.display = 'none';
}

function renderDuplicateList() {
    const container = document.getElementById('dupManagerContent');
    
    if (_duplicateGroups.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; padding: 60px;">
                <div style="font-size: 48px; margin-bottom: 16px;">✅</div>
                <div style="font-size: 16px; font-weight: 600; color: #10b981;">중복 빌딩이 없습니다</div>
                <div style="font-size: 13px; color: #64748b; margin-top: 8px;">모든 빌딩이 고유하게 관리되고 있습니다</div>
            </div>
        `;
        return;
    }
    
    const matchTypeLabels = {
        'address_exact': { label: '주소 일치', color: '#ef4444', bg: '#fef2f2' },
        'address_similar': { label: '주소 유사', color: '#f59e0b', bg: '#fffbeb' },
        'name_similar': { label: '이름 유사', color: '#3b82f6', bg: '#eff6ff' },
        'alias_match': { label: '별칭 매칭', color: '#8b5cf6', bg: '#f5f3ff' },
        'mixed': { label: '복합', color: '#6b7280', bg: '#f9fafb' }
    };
    
    let html = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
            <div>
                <span style="font-size: 14px; font-weight: 600;">발견된 중복 후보</span>
                <span style="margin-left: 8px; padding: 2px 8px; background: #fef2f2; color: #ef4444; border-radius: 10px; font-size: 12px; font-weight: 600;">${_duplicateGroups.length}그룹</span>
            </div>
            <div style="font-size: 11px; color: #94a3b8;">유사도 높은 순</div>
        </div>
    `;
    
    _duplicateGroups.forEach((group, idx) => {
        const mt = matchTypeLabels[group.matchType] || matchTypeLabels['mixed'];
        const buildingNames = group.buildings.map(b => b.name).join(' / ');
        const addresses = [...new Set(group.buildings.map(b => b.address).filter(Boolean))];
        
        html += `
        <div style="border: 1px solid #e2e8f0; border-radius: 10px; margin-bottom: 10px; overflow: hidden; cursor: pointer; transition: all 0.2s;"
             onmouseover="this.style.borderColor='#3b82f6'; this.style.boxShadow='0 2px 8px rgba(59,130,246,0.15)'"
             onmouseout="this.style.borderColor='#e2e8f0'; this.style.boxShadow='none'"
             onclick="openMergeView(${idx})">
            <div style="padding: 14px 16px;">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                    <div style="flex: 1;">
                        <div style="font-size: 14px; font-weight: 600; color: #1e293b; margin-bottom: 4px;">
                            ${buildingNames}
                        </div>
                        <div style="font-size: 12px; color: #64748b;">
                            ${addresses.slice(0, 2).join(' | ')}
                        </div>
                    </div>
                    <div style="display: flex; gap: 6px; align-items: center; flex-shrink: 0;">
                        <span style="padding: 3px 8px; background: ${mt.bg}; color: ${mt.color}; border-radius: 6px; font-size: 11px; font-weight: 600;">
                            ${mt.label}
                        </span>
                        <span style="padding: 3px 8px; background: #f1f5f9; color: #475569; border-radius: 6px; font-size: 11px;">
                            ${Math.round(group.similarity * 100)}%
                        </span>
                        <span style="padding: 3px 8px; background: #f1f5f9; color: #64748b; border-radius: 6px; font-size: 11px;">
                            ${group.count}개
                        </span>
                    </div>
                </div>
                <div style="display: flex; gap: 4px; flex-wrap: wrap;">
                    ${group.buildings.map(b => `
                        <span style="padding: 2px 8px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 11px; color: #475569;">
                            ${b.name}${b.aliases?.length ? ` (+${b.aliases.length} 별칭)` : ''}
                        </span>
                    `).join('')}
                </div>
            </div>
        </div>
        `;
    });
    
    container.innerHTML = html;
}

// ============================================================
// 병합 뷰
// ============================================================

async function openMergeView(groupIdx) {
    const group = _duplicateGroups[groupIdx];
    if (!group) return;
    
    _currentMergeGroup = group;
    
    const container = document.getElementById('dupManagerContent');
    
    // Firebase에서 최신 데이터 로드
    const { db, ref, get } = await getMergeFirebaseRefs();
    const freshBuildings = [];
    for (const b of group.buildings) {
        const snap = await get(ref(db, `buildings/${b.id}`));
        const data = snap.val();
        if (data) freshBuildings.push({ id: b.id, ...data });
    }
    
    if (freshBuildings.length < 2) {
        if (typeof showToast === 'function') showToast('병합할 빌딩이 부족합니다', 'warning');
        renderDuplicateList();
        return;
    }
    
    // 데이터 풍부도 점수로 Master 추천 (필드가 더 많이 채워진 쪽)
    const richness = freshBuildings.map(b => {
        let score = 0;
        const fields = ['name','address','addressJibun','nearbyStation','exclusiveRate','typicalFloorPy',
                        'depositPy','rentPy','maintenancePy','grade','hvac','pm','owner','completionYear',
                        'grossFloorSqm','parkingTotal','description'];
        fields.forEach(f => { if (b[f]) score++; });
        return score;
    });
    const recommendedMasterIdx = richness.indexOf(Math.max(...richness));
    
    // 비교 필드 목록
    const compareFields = [
        { key: 'name', label: '빌딩명' },
        { key: 'address', label: '도로명주소' },
        { key: 'addressJibun', label: '지번주소' },
        { key: 'nearbyStation', label: '인근역' },
        { key: 'grade', label: '등급' },
        { key: 'completionYear', label: '준공년도' },
        { key: 'totalFloors', label: '지상층수' },
        { key: 'basementFloors', label: '지하층수' },
        { key: 'grossFloorSqm', label: '연면적(㎡)' },
        { key: 'typicalFloorPy', label: '기준층전용(평)' },
        { key: 'typicalFloorLeasePy', label: '기준층임대(평)' },
        { key: 'exclusiveRate', label: '전용률(%)' },
        { key: 'depositPy', label: '보증금(만원/평)' },
        { key: 'rentPy', label: '임대료(만원/평)' },
        { key: 'maintenancePy', label: '관리비(만원/평)' },
        { key: 'hvac', label: '냉난방' },
        { key: 'parkingTotal', label: '총주차' },
        { key: 'parkingFree', label: '무료주차' },
        { key: 'parkingPaid', label: '유료주차' },
        { key: 'parkingNote', label: '주차비고' },
        { key: 'pm', label: 'PM' },
        { key: 'owner', label: '소유자' },
        { key: 'description', label: '설명' },
    ];
    
    let html = `
        <div style="margin-bottom: 16px;">
            <button onclick="renderDuplicateList()" style="padding: 6px 14px; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 6px; cursor: pointer; font-size: 12px; color: #475569;">
                ← 목록으로
            </button>
        </div>
        
        <!-- Master 선택 -->
        <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 16px; margin-bottom: 16px;">
            <div style="font-size: 13px; font-weight: 600; color: #1e40af; margin-bottom: 10px;">👑 Master 빌딩 선택</div>
            <div style="font-size: 12px; color: #3b82f6; margin-bottom: 12px;">
                Master로 선택된 빌딩에 나머지 빌딩의 데이터가 병합됩니다. 나머지 빌딩명은 별칭(aliases)으로 등록됩니다.
            </div>
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
    `;
    
    freshBuildings.forEach((b, idx) => {
        const isRecommended = idx === recommendedMasterIdx;
        html += `
            <label style="flex: 1; min-width: 200px; cursor: pointer;">
                <input type="radio" name="masterBuilding" value="${b.id}" ${isRecommended ? 'checked' : ''} 
                       data-idx="${idx}" onchange="updateMergePreview()">
                <div style="margin-top: 4px; padding: 12px; background: white; border: 2px solid ${isRecommended ? '#3b82f6' : '#e2e8f0'}; border-radius: 8px;">
                    <div style="font-size: 13px; font-weight: 600;">${b.name}</div>
                    <div style="font-size: 11px; color: #64748b; margin-top: 4px;">${b.address || b.addressJibun || '-'}</div>
                    <div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">채움률: ${richness[idx]}/${compareFields.length}</div>
                    ${isRecommended ? '<div style="font-size: 10px; color: #3b82f6; font-weight: 600; margin-top: 4px;">⭐ 추천</div>' : ''}
                </div>
            </label>
        `;
    });
    
    html += `</div></div>`;
    
    // 필드별 비교 테이블
    html += `
        <div style="font-size: 13px; font-weight: 600; margin-bottom: 10px; color: #1e293b;">📊 필드별 비교</div>
        <div style="font-size: 11px; color: #64748b; margin-bottom: 12px;">
            각 필드별로 사용할 값을 선택하세요. 기본적으로 Master 빌딩의 값이 선택됩니다.
        </div>
        <div id="mergeFieldComparison" style="border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;">
    `;
    
    compareFields.forEach((field, fIdx) => {
        const values = freshBuildings.map(b => {
            const v = b[field.key];
            return v != null && v !== '' ? String(v) : '';
        });
        
        // 모든 값이 동일하거나 빈 경우 축소 표시
        const uniqueVals = [...new Set(values.filter(v => v))];
        const isConflict = uniqueVals.length > 1;
        const hasValue = uniqueVals.length > 0;
        
        if (!hasValue) return; // 모든 빌딩에 값이 없으면 스킵
        
        const bgColor = isConflict ? '#fffbeb' : '#f8fafc';
        const borderColor = isConflict ? '#fde68a' : '#f1f5f9';
        
        html += `
            <div style="padding: 10px 14px; background: ${bgColor}; border-bottom: 1px solid ${borderColor};">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: ${isConflict ? '8' : '0'}px;">
                    <span style="font-size: 12px; font-weight: 600; color: #334155; min-width: 120px;">${field.label}</span>
                    ${isConflict 
                        ? '<span style="font-size: 10px; padding: 1px 6px; background: #fef3c7; color: #92400e; border-radius: 4px;">⚠️ 다름</span>' 
                        : `<span style="font-size: 12px; color: #64748b;">${uniqueVals[0] || '-'}</span>`
                    }
                </div>
                ${isConflict ? `
                <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                    ${freshBuildings.map((b, bIdx) => {
                        const val = values[bIdx];
                        if (!val) return '';
                        return `
                        <label style="flex: 1; min-width: 150px; cursor: pointer;">
                            <input type="radio" name="merge_${field.key}" value="${bIdx}" 
                                   ${bIdx === recommendedMasterIdx ? 'checked' : ''}
                                   data-field="${field.key}" data-val="${val.replace(/"/g, '&quot;')}">
                            <div style="margin-top: 2px; padding: 6px 10px; background: white; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 12px;">
                                <div style="font-size: 10px; color: #94a3b8; margin-bottom: 2px;">${b.name}</div>
                                <div style="color: #1e293b; word-break: break-all;">${val}</div>
                            </div>
                        </label>
                        `;
                    }).join('')}
                    <label style="flex: 1; min-width: 150px; cursor: pointer;">
                        <input type="radio" name="merge_${field.key}" value="custom"
                               data-field="${field.key}">
                        <div style="margin-top: 2px; padding: 6px 10px; background: white; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 12px;">
                            <div style="font-size: 10px; color: #94a3b8; margin-bottom: 2px;">직접 입력</div>
                            <input type="text" id="mergeCustom_${field.key}" placeholder="직접 입력" 
                                   style="width: 100%; border: none; font-size: 12px; outline: none; background: transparent; padding: 0;"
                                   onfocus="document.querySelector('input[name=merge_${field.key}][value=custom]').checked=true">
                        </div>
                    </label>
                </div>
                ` : ''}
            </div>
        `;
    });
    
    html += `</div>`;
    
    // 데이터 이관 안내
    html += `
        <div style="margin-top: 20px; padding: 14px 16px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px;">
            <div style="font-size: 13px; font-weight: 600; color: #166534; margin-bottom: 8px;">📦 병합 시 자동 이관되는 데이터</div>
            <div style="font-size: 12px; color: #15803d; line-height: 1.8;">
                • <strong>공실 정보 (vacancies)</strong>: 흡수 빌딩의 모든 공실이 Master로 이관<br>
                • <strong>렌트롤 (rentrolls)</strong>: 흡수 빌딩의 렌트롤이 Master로 이관<br>
                • <strong>메모 (memos)</strong>: 흡수 빌딩의 메모가 Master로 이관<br>
                • <strong>기준가 (floorPricing)</strong>: 흡수 빌딩의 기준가가 Master로 이관<br>
                • <strong>담당자 (contactPoints)</strong>: 흡수 빌딩의 담당자가 Master로 이관<br>
                • <strong>인센티브 (incentives)</strong>: 흡수 빌딩의 인센티브가 Master로 이관<br>
                • <strong>별칭 (aliases)</strong>: 흡수 빌딩의 빌딩명이 Master의 aliases에 추가
            </div>
        </div>
        
        <!-- 실행 버튼 -->
        <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; padding-top: 16px; border-top: 1px solid #e2e8f0;">
            <button onclick="renderDuplicateList()" 
                    style="padding: 12px 24px; background: #f1f5f9; color: #64748b; border: 1px solid #e2e8f0; border-radius: 8px; cursor: pointer; font-size: 13px;">
                취소
            </button>
            <button onclick="executeMerge()" 
                    style="padding: 12px 24px; background: linear-gradient(135deg, #ef4444, #dc2626); color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600;">
                🔗 병합 실행
            </button>
        </div>
    `;
    
    container.innerHTML = html;
    
    // freshBuildings를 전역에 저장
    window._mergeFreshBuildings = freshBuildings;
}

// ============================================================
// 병합 실행
// ============================================================

async function executeMerge() {
    const freshBuildings = window._mergeFreshBuildings;
    if (!freshBuildings || freshBuildings.length < 2) return;
    
    // Master 선택
    const masterRadio = document.querySelector('input[name="masterBuilding"]:checked');
    if (!masterRadio) {
        if (typeof showToast === 'function') showToast('Master 빌딩을 선택해주세요', 'warning');
        return;
    }
    const masterId = masterRadio.value;
    const masterData = freshBuildings.find(b => b.id === masterId);
    const absorbedBuildings = freshBuildings.filter(b => b.id !== masterId);
    
    const absorbedNames = absorbedBuildings.map(b => b.name).join(', ');
    if (!confirm(`⚠️ 병합을 실행합니다.\n\nMaster: ${masterData.name}\n흡수: ${absorbedNames}\n\n흡수된 빌딩은 삭제됩니다. 계속하시겠습니까?`)) {
        return;
    }
    
    const { db, ref, get, set, update, remove, push } = await getMergeFirebaseRefs();
    
    try {
        // 1. 필드별 선택값 수집
        const mergedFields = {};
        document.querySelectorAll('input[type="radio"][name^="merge_"]:checked').forEach(radio => {
            const field = radio.dataset.field;
            if (radio.value === 'custom') {
                const customInput = document.getElementById(`mergeCustom_${field}`);
                if (customInput && customInput.value.trim()) {
                    mergedFields[field] = customInput.value.trim();
                }
            } else {
                const val = radio.dataset.val;
                if (val) mergedFields[field] = val;
            }
        });
        
        // 2. aliases 구성
        const existingAliases = masterData.aliases || [];
        const newAliases = [...existingAliases];
        absorbedBuildings.forEach(ab => {
            // 흡수 빌딩의 이름 추가
            if (ab.name && !newAliases.includes(ab.name) && ab.name !== masterData.name) {
                newAliases.push(ab.name);
            }
            // 흡수 빌딩의 기존 aliases도 추가
            (ab.aliases || []).forEach(al => {
                if (al && !newAliases.includes(al) && al !== masterData.name) {
                    newAliases.push(al);
                }
            });
        });
        mergedFields.aliases = newAliases;
        
        // 3. Master 빌딩 업데이트
        mergedFields.updatedAt = new Date().toISOString();
        mergedFields.mergeHistory = [
            ...(masterData.mergeHistory || []),
            {
                date: new Date().toISOString(),
                absorbed: absorbedBuildings.map(b => ({ id: b.id, name: b.name })),
                fieldsUpdated: Object.keys(mergedFields)
            }
        ];
        
        await update(ref(db, `buildings/${masterId}`), mergedFields);
        console.log(`✅ Master ${masterId} 업데이트 완료`, mergedFields);
        
        // 4. 하위 데이터 이관
        const collections = ['vacancies', 'rentrolls', 'memos', 'floorPricing', 'contactPoints', 'incentives'];
        
        for (const ab of absorbedBuildings) {
            for (const col of collections) {
                try {
                    const colSnap = await get(ref(db, `${col}/${ab.id}`));
                    const colData = colSnap.val();
                    if (colData && typeof colData === 'object') {
                        // Master에 데이터 복사 (기존 키와 충돌 방지)
                        for (const [key, val] of Object.entries(colData)) {
                            const newKey = key.startsWith(`${ab.id}_`) ? key : `merged_${ab.id}_${key}`;
                            // Master에 같은 키가 있으면 merged_ 접두사
                            const existSnap = await get(ref(db, `${col}/${masterId}/${key}`));
                            const targetKey = existSnap.exists() ? newKey : key;
                            await set(ref(db, `${col}/${masterId}/${targetKey}`), val);
                        }
                        console.log(`📦 ${col}/${ab.id} → ${masterId} 이관 완료`);
                    }
                } catch (e) {
                    console.warn(`${col}/${ab.id} 이관 실패:`, e);
                }
            }
            
            // 5. 흡수 빌딩 삭제
            await remove(ref(db, `buildings/${ab.id}`));
            // 흡수 빌딩의 원본 하위 데이터도 삭제
            for (const col of collections) {
                await remove(ref(db, `${col}/${ab.id}`));
            }
            console.log(`🗑️ 흡수 빌딩 ${ab.id} (${ab.name}) 삭제 완료`);
            
            // 6. buildingEditLogs에 병합 기록
            await push(ref(db, `buildingEditLogs/${masterId}`), {
                action: 'merge',
                absorbed: { id: ab.id, name: ab.name },
                timestamp: new Date().toISOString(),
                user: 'portal-merge'
            });
        }
        
        if (typeof showToast === 'function') {
            showToast(`✅ 병합 완료! ${masterData.name}에 ${absorbedBuildings.length}개 빌딩 통합`, 'success');
        }
        
        // 목록에서 해당 그룹 제거 후 새로고침
        _duplicateGroups = _duplicateGroups.filter(g => g !== _currentMergeGroup);
        _currentMergeGroup = null;
        window._mergeFreshBuildings = null;
        renderDuplicateList();
        
    } catch (err) {
        console.error('병합 실행 오류:', err);
        if (typeof showToast === 'function') showToast('병합 중 오류 발생: ' + err.message, 'error');
    }
}

// ============================================================
// 개별 빌딩 aliases 관리 (빌딩 상세에서 사용)
// ============================================================

function renderAliasesSection(building) {
    const aliases = building.aliases || [];
    if (aliases.length === 0) return '';
    
    return `
        <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 12px; padding: 8px 12px; background: #faf5ff; border: 1px solid #e9d5ff; border-radius: 8px;">
            <span style="font-size: 11px; color: #7c3aed; font-weight: 600; white-space: nowrap;">🏷️ 별칭:</span>
            <div style="display: flex; gap: 4px; flex-wrap: wrap;">
                ${aliases.map(al => `
                    <span style="padding: 2px 8px; background: #ede9fe; color: #6d28d9; border-radius: 4px; font-size: 11px;">${al}</span>
                `).join('')}
            </div>
        </div>
    `;
}

// ============================================================
// Global 등록
// ============================================================

window.openDuplicateManager = openDuplicateManager;
window.closeDuplicateManager = closeDuplicateManager;
window.openMergeView = openMergeView;
window.executeMerge = executeMerge;
window.renderDuplicateList = renderDuplicateList;
window.renderAliasesSection = renderAliasesSection;
window.mergeExtractAddressKey = mergeExtractAddressKey;
window.mergeStringSimilarity = mergeStringSimilarity;
window.normalizeBuildingName = normalizeBuildingName;
window.updateMergePreview = updateMergePreview;

// ★ Master 변경 시 필드별 라디오 기본값 업데이트
function updateMergePreview() {
    const masterRadio = document.querySelector('input[name="masterBuilding"]:checked');
    if (!masterRadio) return;
    const masterIdx = masterRadio.dataset.idx;
    
    // 모든 필드 비교 라디오에서 master 빌딩 값을 기본 선택
    document.querySelectorAll('#mergeFieldComparison input[type="radio"]').forEach(radio => {
        if (radio.value === masterIdx) {
            radio.checked = true;
        }
    });
    
    // Master 라디오 버튼 스타일 업데이트
    document.querySelectorAll('input[name="masterBuilding"]').forEach(radio => {
        const container = radio.closest('label')?.querySelector('div');
        if (container) {
            container.style.borderColor = radio.checked ? '#3b82f6' : '#e2e8f0';
        }
    });
}
