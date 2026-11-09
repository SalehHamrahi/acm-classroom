import crypto from 'node:crypto';

const PYTHON_KEYWORDS = new Set('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield'.split(' '));
const CPP_KEYWORDS = new Set('alignas alignof and and_eq asm auto bitand bitor bool break case catch char char8_t char16_t char32_t class compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq include define ifdef ifndef endif pragma'.split(' '));

function stripAndTokenize(source, language) {
  const text = String(source ?? '');
  const isCpp = language === 'cpp';
  const tokenPattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\r\n]*|#[^\r\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_$][\w$]*|(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|0[xX][\da-fA-F]+)|(?:==|!=|<=|>=|->|::|\+\+|--|&&|\|\||\+=|-=|\*=|\/=|%=|<<|>>|\*\*|:=)|[^\s])/g;
  const keywords = isCpp ? CPP_KEYWORDS : PYTHON_KEYWORDS;
  const tokens = [];
  for (const match of text.matchAll(tokenPattern)) {
    const token = match[0];
    if (token.startsWith('//') || token.startsWith('/*') || (token.startsWith('#') && !isCpp)) continue;
    if (token.startsWith('"') || token.startsWith("'") || token.startsWith('`')) { tokens.push('<STR>'); continue; }
    if (/^(?:\d|0[xX])/.test(token)) { tokens.push('<NUM>'); continue; }
    if (/^[A-Za-z_$]/.test(token) && !keywords.has(token)) { tokens.push('<ID>'); continue; }
    if (isCpp && token.startsWith('#')) continue;
    tokens.push(token);
  }
  return tokens;
}

function hashGram(value) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 12);
}

export function buildSimilarityFingerprint(source, language = 'python', { gramSize = 5, maxTokens = 12000, maxFingerprints = 3500 } = {}) {
  const tokens = stripAndTokenize(source, language).slice(0, maxTokens);
  if (tokens.length < 4) return { version: 1, language, tokenCount: tokens.length, hashes: [] };
  const size = Math.max(3, Math.min(10, Number(gramSize) || 5));
  const hashes = new Set();
  for (let i = 0; i <= tokens.length - size; i += 1) {
    hashes.add(hashGram(tokens.slice(i, i + size).join('\u001f')));
    if (hashes.size >= maxFingerprints) break;
  }
  return { version: 1, language, tokenCount: tokens.length, hashes: [...hashes] };
}

export function compareFingerprints(left, right) {
  const a = new Set(Array.isArray(left?.hashes) ? left.hashes : []);
  const b = new Set(Array.isArray(right?.hashes) ? right.hashes : []);
  if (!a.size || !b.size) return { score: 0, jaccard: 0, containment: 0, shared: 0 };
  let shared = 0;
  for (const hash of a) if (b.has(hash)) shared += 1;
  const jaccard = shared / (a.size + b.size - shared);
  const containment = shared / Math.min(a.size, b.size);
  const score = Math.round((jaccard * 0.65 + containment * 0.35) * 100);
  return { score, jaccard: Math.round(jaccard * 100), containment: Math.round(containment * 100), shared };
}

export function findSimilarPairs(items, { threshold = 45, maxPairs = 100 } = {}) {
  const groups = new Map();
  for (const item of items || []) {
    const key = `${item.problemId || 'unknown'}:${item.language || 'python'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const pairs = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        if (group[i].studentId === group[j].studentId) continue;
        const similarity = compareFingerprints(group[i].fingerprint, group[j].fingerprint);
        if (similarity.score < threshold || similarity.shared < 2) continue;
        pairs.push({ left: group[i], right: group[j], ...similarity });
      }
    }
  }
  return pairs.sort((a, b) => b.score - a.score || b.shared - a.shared).slice(0, maxPairs);
}
