// submission_safety.mjs — 提交类控件判定与回执分类(2026-08-16 从生产 submission_safety.js 原样移植,仅改 ESM)

const SUBMIT_VERB_RE = /submit|提交|发送|\bsend\b|\bpublish\b|\bpost it\b/i;
const SUBMIT_META_RE = /submit|send|publish|提交|发送/i;

export function hasSubmitVerb(value) {
  return SUBMIT_VERB_RE.test(String(value || ''));
}

export function isSubmitElementMeta(meta, target = '') {
  if (!meta) return false;
  const tagName = String(meta.tagName || '').toUpperCase();
  const role = String(meta.role || '').toLowerCase();
  const type = String(meta.type || '').toLowerCase();
  const text = String(meta.text || '');
  const domMeta = String(meta.meta || '');
  const href = String(meta.href || '').trim();
  const verbHit = hasSubmitVerb(`${text} ${target}`);
  const metaHit = SUBMIT_META_RE.test(domMeta);

  // 只有指向其它地址的真链接才是导航入口；#、空 href、javascript: 常被老站当按钮。
  if (tagName === 'A' && (meta.hasHref || href) && href
      && !href.startsWith('#') && !/^javascript:/i.test(href)) return false;
  if (tagName === 'INPUT') {
    if (/^(submit|image)$/.test(type)) return true;
    return type === 'button' && (verbHit || metaHit);
  }
  if (tagName === 'BUTTON') {
    if (type === 'submit') return true;
    if (type === 'reset') return false;
    return verbHit || metaHit;
  }
  if (role === 'button' || tagName === 'A') return verbHit || metaHit;
  if (meta.inForm && (verbHit || metaHit)) return true;
  return verbHit;
}

export async function isSubmitClassClick(el, target) {
  const meta = await el.evaluate(e => {
    const action = e.closest('a[href],button,input,[role=button]') || e;
    const form = action.form || action.closest('form');
    return {
      tagName: action.tagName,
      role: action.getAttribute('role') || '',
      type: action.type || '',
      href: action.getAttribute('href') || '',
      hasHref: action.hasAttribute('href'),
      inForm: !!form,
      text: action.innerText || action.value || '',
      meta: `${action.id || ''} ${action.name || ''} ${action.className || ''}`,
    };
  }, undefined, { timeout: 2500 }).catch(() => null);
  return isSubmitElementMeta(meta, target);
}

// 否定/错误必须先行。保守漏判会留在 ambiguous；误判成功会造成重复投递与假记分。
const RECEIPT_NEGATIVE_RE = /\b(?:unsuccessful|failed|failure|error|invalid|incorrect|denied|rejected)\b|\bnot\s+successful\b|\b(?:has|have|had|was|were|is|are)?\s*not\s+(?:been\s+)?(?:successfully\s+)?(?:submitted|received|accepted|processed|sent)\b|\bnot\s+been\b|\bno\s+(?:submission|request|listing|application|comment|message)\b|提交失败|未(?:成功)?提交|未收到|没有收到|错误|无效|不正确|被拒/iu;

// 整页文本常保留提交前说明。含条件、操作指令或帮助说明的句子不是回执。
const RECEIPT_CONTEXT_RE = /\b(?:if|when|once|before|after|until|unless|whether)\b|\bonly\s+when\b|\bplease\s+(?:ensure|check|confirm|verify)\b|\b(?:check\s+whether|make\s+sure|ensure\s+(?:that\s+)?|learn\s+how|how\s+to)\b|\b(?:every|all)\b|如果|若|当|一旦|之前|之后|请(?:确保|检查|确认|验证)|如何/iu;

const RECEIPT_PENDING_RE = /\b(?:your\s+)?(?:submission|request|listing|application|comment|product)\b[^.!?。！？]{0,60}\b(?:is\s+)?(?:pending|awaiting)\s+(?:review|approval|moderation)\b|(?:提交|申请|收录|评论)[^.!?。！？]{0,20}(?:等待|进入|待)(?:审核|审批)|(?:envío|solicitud|listado|producto)[^.!?。！？]{0,60}(?:pendiente\s+de|esperando\s+)(?:revisión|aprobación)/iu;

const RECEIPT_SUCCESS_RE = /\bthank\s+you\s+for\s+(?:your\s+)?(?:submission|submitting\b(?:\s+(?:your\s+)?(?:product|listing|site|application|comment))?)\b|\b(?:your\s+)?(?:submission|request|listing|application|comment|message)\s+(?:has\s+been|was|is)\s+(?:successfully\s+)?(?:submitted|received|accepted|sent)(?:\s+successfully)?\b|\bwe(?:'ve|\s+have)\s+received\s+your\s+(?:submission|request|listing|application|comment|message)\b|\b(?:submitted|received|sent)\s+successfully\b|\b(?:submission|request|listing|application|comment)\s+(?:was\s+)?successful\b|\bgracias\s+por\s+(?:enviar|su\s+envío|tu\s+envío)\b|提交成功|(?:已经|已)收到.{0,12}(?:提交|申请|收录|信息|评论)|(?:已经|已)(?:成功)?提交|发送成功/iu;

function jsonReceipt(raw) {
  const trimmed = String(raw || '').trim();
  if (!/^[{[]/.test(trimmed)) return { handled: false, status: null };
  let value;
  try { value = JSON.parse(trimmed); } catch { return { handled: false, status: null }; }
  const rows = Array.isArray(value) ? value : [value];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row.success === false || row.ok === false
        || (row.error !== null && row.error !== undefined && row.error !== false && row.error !== '')) {
      return { handled: true, status: null };
    }
  }
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const status = String(row.status || row.result || '').toLowerCase().replace(/[ -]+/g, '_');
    if (/^(?:pending|pending_review|awaiting_review|awaiting_approval)$/.test(status)) {
      return { handled: true, status: 'pending_review' };
    }
    if (/^(?:success|submitted|received|accepted)$/.test(status)
        || row.success === true || row.ok === true || row.submitted === true || row.received === true) {
      return { handled: true, status: 'success' };
    }
  }
  return { handled: true, status: null };
}

export function classifyReceiptText(text) {
  const raw = String(text || '').replace(/\r/g, '\n');
  const json = jsonReceipt(raw);
  if (json.handled) return json.status;
  const normalized = raw.replace(/\s+/g, ' ').trim();
  // 错误/否定是全页总闸：同页仍有失败提示时，不得被另一处成功词覆盖。
  if (!normalized || RECEIPT_NEGATIVE_RE.test(normalized)) return null;
  const candidates = raw.split(/(?:[.!?。！？]+|\n+)/u)
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => s && !RECEIPT_CONTEXT_RE.test(s));
  if (candidates.some(s => RECEIPT_PENDING_RE.test(s))) return 'pending_review';
  if (candidates.some(s => RECEIPT_SUCCESS_RE.test(s))) return 'success';
  return null;
}

export function htmlText(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}
