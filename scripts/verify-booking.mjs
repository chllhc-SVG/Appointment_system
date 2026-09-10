/**
 * 预约 MCP 端到端验证（临时脚本）：
 * 覆盖线上两个失败场景（note 误放门店名 / 完全未传门店）与门店模糊匹配。
 */
const BASE = 'http://127.0.0.1:4020/mcp';
const HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'X-Agent-Code': 'hsh',
  'X-Session-Id': `verify_${Date.now()}`,
  'X-Customer-Phone': '13800138000',
  'X-Customer-Name': encodeURIComponent('验证顾客'),
};

let id = 1;
async function call(name, args) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  const payload = json?.result?.structuredContent?.data ?? json?.result ?? json;
  return payload;
}

const pretty = (label, data) => {
  console.log(`\n===== ${label} =====`);
  console.log(JSON.stringify(data, null, 2).slice(0, 1800));
};

// 1) 查可约时段，拿一个真实 start_at
const slots = await call('query_slots', { service_name: '腹部管理', date: '2026-09-09' });
pretty('1) query_slots 腹部管理 2026-09-09', {
  success: slots.success,
  store: slots.store,
  store_auto_selected: slots.store_auto_selected,
  has_slots: slots.has_slots,
  first_slot: slots.slots?.[0],
});
const startAt = slots.slots?.[0]?.start_at;
const staffName = slots.slots?.[0]?.staff_name;
if (!startAt) { console.log('!! 没有可用时段，后续用例仍会执行'); }

// 2) 线上失败场景 A：门店名被 LLM 错放进 note（"用户确认上海徐汇门店"）
const caseA = await call('manage_booking', {
  action: 'create',
  service_name: '腹部管理',
  staff_name: staffName || '李美容师',
  start_at: startAt,
  note: '用户确认上海徐汇门店',
});
pretty('2) note="用户确认上海徐汇门店"（原 STORE_NOT_FOUND 场景）', {
  success: caseA.success,
  error_code: caseA.error_code,
  message: caseA.message,
  store_auto_selected: caseA.store_auto_selected,
  store: caseA.store,
  spoken: caseA.spoken,
  note_in_db: caseA.appointment?.note,
});

// 3) 场景 B：完全未传门店（原 NEEDS_MORE_INFO 场景）→ 单店自动兜底
//    （用第二个时段，避开 case2 的幂等命中：同客户+项目+员工+时段 会幂等去重）
const caseB = await call('manage_booking', {
  action: 'create',
  service_name: '腹部管理',
  staff_name: staffName || '李美容师',
  start_at: slots.slots?.[1]?.start_at ?? startAt,
});
pretty('3) 完全未传门店（单店自动兜底）', {
  success: caseB.success,
  error_code: caseB.error_code,
  message: caseB.message,
  store_auto_selected: caseB.store_auto_selected,
  store: caseB.store,
});

// 4) 场景 C：store_name 显式传成带前缀的脏值
const caseC = await call('manage_booking', {
  action: 'create',
  service_name: '腹部管理',
  staff_name: staffName || '李美容师',
  start_at: startAt,
  store_name: '用户确认上海徐汇门店',
});
pretty('4) store_name="用户确认上海徐汇门店"（脏值模糊匹配）', {
  success: caseC.success,
  error_code: caseC.error_code,
  message: caseC.message,
  store_auto_selected: caseC.store_auto_selected,
});

// 5) 场景 D：不存在的门店 → 报错文案与候选门店
const caseD = await call('manage_booking', {
  action: 'create',
  service_name: '腹部管理',
  staff_name: staffName || '李美容师',
  start_at: startAt,
  store_name: '火星门店XYZ',
});
pretty('5) store_name="火星门店XYZ"（应 STORE_NOT_FOUND + 候选门店）', {
  success: caseD.success,
  error_code: caseD.error_code,
  message: caseD.message,
  available_stores: caseD.available_stores,
});

// 6) 场景 E：仍缺门店但门店是多店时的追问（此处用 query_slots 模拟缺 service）
const caseE = await call('manage_booking', { action: 'create', start_at: startAt });
pretty('6) 缺项目/员工/门店（应按字段给出具体追问 + retry_hint）', {
  success: caseE.success,
  error_code: caseE.error_code,
  missing_fields: caseE.missing_fields,
  suggested_question: caseE.suggested_question,
  retry_hint: caseE.retry_hint,
});

// 7) 模糊门店名："徐汇店" 应命中"上海徐汇门店"
const caseF = await call('query_slots', { service_name: '腹部管理', date: '2026-09-09', store_name: '徐汇店' });
pretty('7) store_name="徐汇店"（去后缀模糊匹配）', {
  success: caseF.success,
  error_code: caseF.error_code,
  message: caseF.message,
  store: caseF.store,
  store_auto_selected: caseF.store_auto_selected,
  has_slots: caseF.has_slots,
});
