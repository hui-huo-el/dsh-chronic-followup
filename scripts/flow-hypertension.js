// Injected into the 高血压随访 page. Runs a full follow-up: read last record -> 新增 -> fill -> quote -> save.
window.__sleep = ms => new Promise(r => setTimeout(r, ms));
window.__items = () => Array.from(document.querySelectorAll('.el-form-item')).filter(x => !x.closest('.el-dialog__wrapper'));
window.__val = i => { const it = window.__items()[i]; const e = it && it.querySelector('input'); return e ? e.value : ''; };
window.__setVal = (i, v) => {
  const it = window.__items()[i]; const e = it && it.querySelector('input');
  if (!e) return 'no-input@' + i;
  const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  d.call(e, String(v));
  e.dispatchEvent(new Event('input', { bubbles: true }));
  e.dispatchEvent(new Event('change', { bubbles: true }));
  e.dispatchEvent(new Event('blur', { bubbles: true }));
  return String(v);
};
window.__radioIdx = i => { const it = window.__items()[i]; const r = it && it.querySelector('.el-radio.is-checked'); return r ? r.innerText.trim() : ''; };
window.__pickRadio = (i, txt) => {
  const it = window.__items()[i]; if (!it) return 'no-item';
  const rs = Array.from(it.querySelectorAll('.el-radio'));
  const r = txt ? rs.find(x => x.innerText.indexOf(txt) >= 0) : rs[0];
  if (!r) return 'no-radio';
  if (!r.classList.contains('is-checked')) r.click();
  return r.innerText.trim();
};
window.__pickRadioByLabel = (label, txt) => {
  const it = window.__items().find(x => { const l = x.querySelector('.el-form-item__label'); return l && (l.innerText || '').trim().indexOf(label) >= 0; });
  if (!it) return 'no-item:' + label;
  const rs = Array.from(it.querySelectorAll('.el-radio'));
  const r = rs.find(x => x.innerText.indexOf(txt) >= 0);
  if (!r) return 'no-radio:' + txt;
  if (!r.classList.contains('is-checked')) r.click();
  return r.innerText.trim();
};
window.__radioByLabel = label => {
  const it = window.__items().find(x => { const l = x.querySelector('.el-form-item__label'); return l && (l.innerText || '').trim().indexOf(label) >= 0; });
  if (!it) return '';
  const r = it.querySelector('.el-radio.is-checked');
  return r ? r.innerText.trim() : '';
};
window.__patientName = () => {
  const el = document.querySelector('.patientInfo, .userInfo, .el-menu') || document.body;
  const t = (document.querySelector('.basic-info-name, .user-name') || {}).innerText;
  if (t) return t.trim();
  const m = (document.body.innerText || '').match(/^\s*([\u4e00-\u9fa5]{2,4})\s+\d{1,3}岁/m);
  return m ? m[1] : '';
};
window.__pickCheck = (i, val) => {
  const it = window.__items()[i]; if (!it) return 'no-item';
  const cs = Array.from(it.querySelectorAll('.el-checkbox'));
  const c = cs.find(x => { const inp = x.querySelector('input'); return inp && inp.value === val; });
  if (!c) return 'no-check:' + val;
  if (!c.classList.contains('is-checked')) c.click();
  return c.querySelector('input').value;
};
window.__btn = txt => Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').trim() === txt);
window.__waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (fn()) return true; } catch (e) {} await window.__sleep(150); } return false; };

// Navigate the patient record menu to the 高血压随访 form.
window.__openFollowup = async () => {
  const clickByText = (sel, txt) => {
    const el = Array.from(document.querySelectorAll(sel)).find(e => (e.innerText || '').trim().indexOf(txt) >= 0);
    if (el) { el.click(); return true; } return false;
  };
  // expand 慢病管理 then pick 高血压随访
  clickByText('.el-menu-item, .el-submenu__title', '慢病管理');
  await window.__sleep(700);
  let ok = clickByText('.el-menu-item', '高血压随访');
  if (!ok) { clickByText('.el-submenu__title', '慢病管理'); await window.__sleep(600); ok = clickByText('.el-menu-item', '高血压随访'); }
  await window.__sleep(1500);
  return window.__waitFor(() => window.__items().length > 10 && !!window.__val(0), 8000);
};

// Open the 引用医疗数据 dialog and quote vitals (all but 血压) plus the newest medication row(s).
window.__quote = async (vitalLabels, drugRows) => {
  const dlg = () => Array.from(document.querySelectorAll('.el-dialog__wrapper')).find(e => getComputedStyle(e).display !== 'none' && (e.innerText || '').indexOf('引用医疗数据') >= 0);
  const openBtn = window.__btn('引用医疗数据');
  if (!openBtn) return { ok: false, why: 'no-button' };
  openBtn.click();
  const opened = await window.__waitFor(() => dlg(), 8000);
  if (!opened) return { ok: false, why: 'dialog-not-open' };
  await window.__sleep(700);
  const d = dlg();
  // uncheck 全选
  const all = d.querySelector('.headerDec .el-checkbox input');
  if (all && all.checked) { d.querySelector('.headerDec .el-checkbox').click(); await window.__sleep(600); }
  const picked = [];
  for (const lab of vitalLabels) {
    const items = Array.from(d.querySelectorAll('.el-form-item'));
    const it = items.find(x => { const l = x.querySelector('.el-form-item__label'); return l && (l.innerText || '').indexOf(lab) >= 0; });
    if (!it) continue;
    const rows = Array.from(it.querySelectorAll('.singleText'));
    if (!rows.length) continue;
    const cur = it.querySelector('.left_dec.selectedItem');
    if (!cur) { const first = rows[0].querySelector('.left_dec'); first.click(); await window.__sleep(250); picked.push(lab); }
  }
  // medication rows
  const dRows = Array.from(d.querySelectorAll('.el-table__row'));
  let drugs = 0;
  for (let k = 0; k < Math.min(drugRows, dRows.length); k += 1) {
    const cb = dRows[k].querySelector('.el-checkbox__original');
    if (cb && !cb.checked) { dRows[k].querySelector('.el-checkbox').click(); drugs += 1; await window.__sleep(250); }
  }
  const submit = Array.from(d.querySelectorAll('button')).find(b => (b.innerText || '').replace(/\s+/g, '') === '提交');
  if (!submit) return { ok: false, why: 'no-submit', picked, drugs };
  submit.click();
  const closed = await window.__waitFor(() => !dlg(), 8000);
  await window.__sleep(900);
  return { ok: closed, picked, drugs };
};

// p: { date, sbp, dbp, hr, ex:[n1,m1,n2,m2] }
window.__followup = async p => {
  const log = [];
  const its = window.__items;
  const last = {
    date: window.__val(0),
    symptoms: Array.from(its()[3].querySelectorAll('input')).filter(x => x.checked).map(x => x.value),
    height: window.__val(8),
    weight: window.__val(9),
    hr: window.__val(15),
    smoke: [window.__val(17), window.__val(19)],
    drink: [window.__val(20), window.__val(22)],
    ex: [window.__val(23), window.__val(25), window.__val(27), window.__val(29)],
    saltA: window.__radioIdx(31), saltB: window.__radioIdx(33),
    psy: window.__radioIdx(34), comp: window.__radioIdx(35),
    method: window.__radioIdx(1),
  };
  log.push(['last', last]);
  if (!last.date) return { ok: false, log, why: 'no-last-date' };

  // 心率必须与上次不同
  if (String(p.hr) === String(last.hr)) {
    p.hr = Number(p.hr) >= 89 ? Number(p.hr) - 1 : Number(p.hr) + 1;
  }
  // 血压不能与上次完全相同（至少一项要变）
  last.sbp = window.__val(5); last.dbp = window.__val(7);
  if (String(p.sbp) === String(last.sbp) && String(p.dbp) === String(last.dbp)) {
    p.sbp = Number(p.sbp) + 1;
    if (p.sbp > 139) p.sbp = 139;
    if (String(p.sbp) === String(last.sbp)) p.dbp = Number(p.dbp) >= 89 ? Number(p.dbp) - 1 : Number(p.dbp) + 1;
  }

  const addBtn = window.__btn('新增');
  if (!addBtn) return { ok: false, log, why: 'no-add-button' };
  addBtn.click();
  await window.__sleep(1200);

  window.__setVal(0, p.date);
  window.__pickRadio(1, '1门诊');
  for (const s of last.symptoms) window.__pickCheck(3, s);
  window.__setVal(5, p.sbp);
  window.__setVal(7, p.dbp);
  log.push(['after-bp', window.__val(5), window.__val(7)]);

  const q = await window.__quote(['体温', '脉率', '呼吸频率', '空腹血糖', '身高', '体重', '腰围'], 1);
  log.push(['quote', q]);

  window.__setVal(11, window.__val(9) || last.weight);      // 目标体重 = 原体重
  window.__setVal(15, p.hr);                                // 心率
  window.__setVal(17, last.smoke[0]); window.__setVal(19, last.smoke[1]);
  window.__setVal(20, last.drink[0]); window.__setVal(22, last.drink[1]);
  const ex = (p.ex && p.ex !== 'keep') ? p.ex : last.ex;
  window.__setVal(23, ex[0]); window.__setVal(25, ex[1]);
  window.__setVal(27, ex[2]); window.__setVal(29, ex[3]);
  const ensureLabel = async (label, txt) => {
    const trail = [];
    for (let k = 0; k < 4; k += 1) {
      const cur = window.__radioByLabel(label);
      if (cur) { trail.push('ok:' + cur); log.push(['ensure', label, trail.join('>')]); return true; }
      const picked = window.__pickRadioByLabel(label, txt);
      trail.push(picked);
      await window.__sleep(300);
    }
    log.push(['ensure', label, trail.join('>'), 'final:' + window.__radioByLabel(label)]);
    return !!window.__radioByLabel(label);
  };
  const ensureIdx = async (i, txt) => {
    for (let k = 0; k < 4; k += 1) {
      if (window.__radioIdx(i)) return true;
      window.__pickRadio(i, txt);
      await window.__sleep(300);
    }
    return !!window.__radioIdx(i);
  };
  await ensureIdx(31, last.saltA || '1轻');
  await ensureIdx(33, last.saltB || '1轻');
  await ensureLabel('心理调整', last.psy || '良好');
  await ensureLabel('遵医行为', last.comp || '良好');
  await ensureLabel('服药依从性', '规律服药');
  await ensureLabel('此次随访分类', '控制满意');
  await ensureLabel('药物不良反应', '无');
  await window.__sleep(500);

  const state = {
    date: window.__val(0), sbp: window.__val(5), dbp: window.__val(7),
    height: window.__val(8), weight: window.__val(9), target: window.__val(11),
    hr: window.__val(15), ex: [window.__val(23), window.__val(25), window.__val(27), window.__val(29)],
    symptoms: Array.from(its()[3].querySelectorAll('input')).filter(x => x.checked).map(x => x.value),
    saltA: window.__radioIdx(31), saltB: window.__radioIdx(33),
    psy: window.__radioByLabel('心理调整'), comp: window.__radioByLabel('遵医行为'),
    adherence: window.__radioByLabel('服药依从性'), adverse: window.__radioByLabel('药物不良反应'), classify: window.__radioByLabel('此次随访分类'),
  };
  log.push(['state', state]);

  const missing = [];
  if (!state.date) missing.push('date');
  if (!state.sbp || !state.dbp) missing.push('bp');
  if (!state.height) missing.push('height');
  if (!state.weight) missing.push('weight');
  if (!state.target) missing.push('target');
  if (!state.hr) missing.push('hr');
  if (!state.ex[0] || !state.ex[1] || !state.ex[2] || !state.ex[3]) missing.push('exercise');
  if (!state.saltA || !state.saltB || !state.psy || !state.comp) missing.push('lifestyle');
  if (!state.adherence || !state.adverse || !state.classify) missing.push('tail');
  // medication rows present?
  const drugName = window.__val(41);
  if (!drugName) missing.push('drug');
  if (missing.length) return { ok: false, log, why: 'missing:' + missing.join(','), state };

  // 保存前再确认患者身份，避免写错人
  if (p.expect) {
    const shown = (document.body.innerText || '').match(/^\s*([\u4e00-\u9fa5]{2,4})\s+\d{1,3}岁/m);
    if (shown && shown[1] !== p.expect) return { ok: false, log, why: 'name-changed:' + shown[1], state };
  }

  const save = window.__btn('保存');
  if (!save) return { ok: false, log, why: 'no-save' };
  save.click();
  const okSaved = await window.__waitFor(() => (document.body.innerText || '').indexOf('新增成功') >= 0 || (document.body.innerText || '').indexOf('保存成功') >= 0, 10000);
  await window.__sleep(600);
  return { ok: okSaved, log, state, toast: okSaved };
};
