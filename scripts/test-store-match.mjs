// 临时验证脚本：验证 note 回收的门店名提取逻辑（与 src/tools/tools.ts 保持同步）
function stripNotePrefix(value) {
  let text = value.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = text
      .replace(/^(?:用户|顾客|客人|客户|他|她|我|我们)/, '')
      .replace(/^(?:已经|已|最终|最后|然后|接着|所以|那么|那)?(?:确认|选定|选择|选了|挑选|挑了|确定|敲定|决定|定了|就选|就要|想要|想去|想约|要去|会去|选|定)/, '')
      .replace(/^(?:的话|就是|就|是|在|去|到|约|来)/, '')
      .trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

function extractStoreName(note) {
  const stripped = stripNotePrefix(note);
  const candidates = stripped.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,8}(?:门店|分店|店)/g);
  if (!candidates || candidates.length === 0) return null;
  const raw = candidates[candidates.length - 1];
  return stripNotePrefix(raw) || raw;
}

const cases = [
  '用户确认上海徐汇门店',
  '上海徐汇门店',
  '用户确认上海徐汇门店。',
  '那就上海徐汇门店吧',
  '我选徐汇店',
  '用户说去上海徐汇门店，李美容师，腹部管理',
  '帮我预约腹部管理',
  '确认在静安寺店',
];

for (const c of cases) {
  console.log(`note="${c}"  ->  store_name="${extractStoreName(c)}"`);
}

// 复现旧正则的 bug 作为对照
const old = '用户确认上海徐汇门店'.match(/([\u4e00-\u9fa5A-Za-z0-9]{2,12}?(?:门店|分店|店))/);
console.log(`OLD regex -> "${old ? old[1] : null}"  (bug: 带上"用户确认"前缀导致 STORE_NOT_FOUND)`);
