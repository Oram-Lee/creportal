/**
 * mreport-main.js — 오피스 마켓 리포트 엔트리
 * 진입: market-report.html (rmap.html 헤더의 "📰 마켓리포트" 버튼에서 링크)
 */

import {
  buildDraftModel, loadModel, saveModel,
  generateAiDraft, mergeAiDraft, quarterLabel,
} from './mreport-data.js?v=1.2.1';
import { renderReport, collectModel } from './mreport-render.js?v=1.2.1';

const $ = sel => document.querySelector(sel);

const MR = {
  model: null,

  /* ── 초기화 ── */
  init() {
    // 연도 셀렉트: 2024 ~ 올해+1
    const ySel = $('#mrYear');
    const nowY = new Date().getFullYear();
    for (let y = 2024; y <= nowY + 1; y++) {
      ySel.insertAdjacentHTML('beforeend', `<option value="${y}" ${y === nowY ? 'selected' : ''}>${y}년</option>`);
    }
    // 기본 분기: 직전 분기 (리포트는 마감 분기 기준 작성)
    const m = new Date().getMonth();                       // 0~11
    const prevQ = m < 3 ? 4 : Math.ceil(m / 3);
    if (m < 3) ySel.value = String(nowY - 1);
    $('#mrQuarter').value = `Q${prevQ}`;
  },

  selectedQuarter() { return `${$('#mrYear').value}${$('#mrQuarter').value}`; },

  setStatus(msg) { $('#mrStatus').textContent = msg; },
  setButtons(on) { ['btnAi', 'btnSave', 'btnPdf', 'btnPptx'].forEach(id => { const b = $('#' + id); if (b) b.disabled = !on; }); },
  banner(msg) {
    const el = $('#mrBanner');
    if (msg) { el.textContent = msg; el.classList.add('warn'); }
    else el.classList.remove('warn');
  },

  /* ── ⚡ 초안 생성 ── */
  async generateDraft() {
    const q = this.selectedQuarter();
    // 기존 저장본 존재 시 덮어쓰기 확인
    this.loadingSteps(['공실률 통계 세션 로드', '전분기 비교 계산', '리포트 초안 조립'], 0);
    try {
      const saved = await loadModel(q);
      if (saved && !confirm(`${quarterLabel(q, 'kr')} 저장본(v${saved.version})이 이미 있습니다.\n새 초안으로 다시 생성할까요? (저장 전까지 기존 본은 유지됩니다)`)) {
        this.hideLoading();
        return this.applyModel(saved, `저장본 v${saved.version} 로드됨`);
      }
      this.loadingSteps(null, 1);
      const model = await buildDraftModel(q);
      // ★v1.2.0 버그픽스: 저장본이 있는 분기를 재생성하면 새 모델이 version 0 이 되어
      //   이후 저장이 항상 "버전 충돌"로 거부되던 문제 → 저장본 버전을 승계
      if (saved) model.version = saved.version;
      this.loadingSteps(null, 2);
      this.applyModel(model, model.vacancy.auto ? '초안 생성 완료 (공실률 자동 반영)' : '초안 생성 완료 (통계 세션 없음 — 수동 입력)');
      const warns = [];
      if (!model.vacancy.auto) {
        warns.push(`⚠ 저장된 다시점 세션(statsTrend)이 없어 공실률을 계산하지 못했습니다. '공실률 계산 및 비교 → 다시점'에서 세션을 저장하거나, 카드를 클릭해 직접 입력하세요.`);
      } else if (model.vacancy.statsStatus === 'auto') {
        warns.push(`⚠ ${quarterLabel(q, 'kr')}의 분기말 월이 다시점 세션에 저장돼 있지 않아 자동집계 수치입니다. 다시점 화면에서 해당 월을 추가·저장하면 확정 수치로 대체됩니다.`);
      }
      if (model._leaseApiError) {
        warns.push(`⚠ 계약사례 포털 연동 실패(${model._leaseApiError}) — 임대차 테이블을 수동 입력하세요. (crecons 슬립 상태였다면 잠시 후 초안을 다시 생성해보세요)`);
      }
      this.banner(warns.join('  ·  '));
    } catch (err) {
      console.error('[mreport] 초안 생성 실패:', err);
      this.toast(`초안 생성 실패: ${err.message || err}`, 'error');
    } finally { this.hideLoading(); }
  },

  applyModel(model, statusMsg) {
    this.model = model;
    renderReport(model);
    this.setButtons(true);
    this.setStatus(`${quarterLabel(model.quarter, 'kr')} · ${statusMsg}`);
  },

  /* ── 📎 지난 분기 리포트 참고자료 (.md/.txt) ── */
  refDoc: null,
  pickRefDoc() {
    // 이미 첨부돼 있으면 제거 여부 먼저 확인 (재클릭 = 교체 or 제거)
    if (this.refDoc && confirm(`참고자료 "${this.refDoc.name}" 를 제거할까요?\n[취소] 를 누르면 다른 파일로 교체합니다.`)) {
      this.refDoc = null;
      $('#mrRefFile').value = '';
      $('#btnRef').textContent = '📎 지난분기 참고';
      return this.toast('참고자료를 제거했습니다');
    }
    $('#mrRefFile').click();
  },
  onRefFile(input) {
    const f = input.files && input.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      this.refDoc = { name: f.name, text: String(reader.result || '') };
      $('#btnRef').textContent = `📎 ${f.name.length > 14 ? f.name.slice(0, 12) + '…' : f.name} ✓`;
      this.toast(`참고자료 첨부됨: ${f.name} — AI 초안 생성 시 문체·구성을 참고합니다`);
    };
    reader.onerror = () => this.toast('파일을 읽지 못했습니다', 'error');
    reader.readAsText(f);
  },

  /* ── 🤖 AI 문구 초안 ── */
  async generateAiTexts() {
    if (!this.model) return;
    collectModel(this.model);            // 수동 입력값(공실률·계약)을 근거에 포함
    this.loadingSteps(['입력 데이터 정리', 'AI 문구 생성 (10~20초)', '리포트 반영'], 1);
    try {
      const ai = await generateAiDraft(this.model, this.refDoc?.text || '');
      this.loadingSteps(null, 2);
      mergeAiDraft(this.model, ai);
      renderReport(this.model);
      this.toast('AI 초안이 반영되었습니다. 문구를 검토·수정하세요.');
    } catch (err) {
      console.error('[mreport] AI 초안 실패:', err);
      this.toast(`AI 초안 실패: ${err.message || err}`, 'error');
    } finally { this.hideLoading(); }
  },

  /* ── 💾 저장 ── */
  async saveReport() {
    if (!this.model) return;
    collectModel(this.model);
    try {
      const user = localStorage.getItem('crePortalUser') || 'unknown';
      let res = await saveModel(this.model, user);
      if (!res.ok && res.conflict) {
        // 진짜 다른 사용자/탭 충돌: 현재 편집본을 잃지 않도록 덮어쓰기 선택지 제공
        if (!confirm(`${res.reason}\n\n[확인] 지금 화면의 내용으로 덮어쓰기 (v${res.latest + 1})\n[취소] 저장 중단 (📂 불러오기로 최신본 확인 가능)`)) {
          return this.toast('저장을 중단했습니다', 'error');
        }
        res = await saveModel(this.model, user, true);
      }
      if (!res.ok) return this.toast(res.reason, 'error');
      this.toast(`저장 완료 (v${res.version})`);
      this.setStatus(`${quarterLabel(this.model.quarter, 'kr')} · 저장됨 v${res.version}`);
    } catch (err) {
      console.error('[mreport] 저장 실패:', err);
      this.toast(`저장 실패: ${err.message || err}`, 'error');
    }
  },

  /* ── 📂 저장본 불러오기 ── */
  async loadSaved() {
    const q = this.selectedQuarter();
    try {
      const saved = await loadModel(q);
      if (!saved) return this.toast(`${quarterLabel(q, 'kr')} 저장본이 없습니다`, 'error');
      this.applyModel(saved, `저장본 v${saved.version} 로드됨`);
      this.banner('');
    } catch (err) {
      this.toast(`불러오기 실패: ${err.message || err}`, 'error');
    }
  },

  /* ── 📄 PDF (window.print — rmap 방식) ── */
  printPDF() {
    if (!this.model) return;
    collectModel(this.model);
    // 차트 canvas → 정적 이미지 치환 후 인쇄, 인쇄 후 복원
    const cv = document.getElementById('mrLeaseChart');
    let restore = null;
    if (cv && cv.width > 10) {
      const img = document.createElement('img');
      img.src = cv.toDataURL('image/png');
      img.style.cssText = 'width:100%;height:70mm;object-fit:contain';
      cv.style.display = 'none';
      cv.parentNode.appendChild(img);
      restore = () => { img.remove(); cv.style.display = ''; };
    }
    const done = () => { if (restore) restore(); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    this.toast('인쇄 대화상자에서 "PDF로 저장"을 선택하세요');
    setTimeout(() => window.print(), 150);
  },

  /* ── 🖼 PPTX 내보내기 ── */
  async exportPptx() {
    if (!this.model) return;
    if (typeof PptxGenJS === 'undefined') return this.toast('PPTX 라이브러리가 로드되지 않았습니다 — 새로고침 후 재시도', 'error');
    collectModel(this.model);
    this.loadingSteps(['리포트 데이터 수집', 'PPTX 슬라이드 조립', '파일 생성'], 1);
    try {
      const { exportReportPPTX } = await import('./mreport-pptx.js?v=1.2.1');
      this.loadingSteps(null, 2);
      const fileName = await exportReportPPTX(this.model);
      this.toast(`PPTX 저장 완료: ${fileName}`);
    } catch (err) {
      console.error('[mreport] PPTX 실패:', err);
      this.toast(`PPTX 생성 실패: ${err.message || err}`, 'error');
    } finally { this.hideLoading(); }
  },

  /* ── 로딩/토스트 ── */
  loadingSteps(steps, activeIdx) {
    const box = $('#mrLoadingBox');
    if (steps) box.dataset.steps = JSON.stringify(steps);
    const list = JSON.parse(box.dataset.steps || '[]');
    box.innerHTML = `<b>리포트 생성 중...</b>` + list.map((s, i) =>
      `<div class="step ${i < activeIdx ? 'done' : i === activeIdx ? 'on' : ''}">${i < activeIdx ? '✅' : i === activeIdx ? '⏳' : '·'} ${s}</div>`).join('');
    $('#mrLoading').classList.add('show');
  },
  hideLoading() { $('#mrLoading').classList.remove('show'); },
  toast(msg, type = '') {
    const el = $('#mrToast');
    el.textContent = msg;
    el.className = `show ${type}`;
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 3200);
  },
};

window.MR = MR;
MR.init();
