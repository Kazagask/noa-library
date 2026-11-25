export type Tokens = Record<string, string[]>;
const VALID_SCOPES = new Set(['read', 'write', 'admin']);

/** 生产环境禁止默认开发 token；配置错误一律 fail closed。 */
export function parseTokens(env: Record<string, string | undefined> = process.env): Tokens {
  const raw = env.NOA_API_TOKENS;
  if (!raw) {
    if (env.NODE_ENV === 'production') throw new Error('生产环境必须设置 NOA_API_TOKENS');
    return { 'dev-noa-token': ['read', 'write', 'admin'] };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('NOA_API_TOKENS 不是合法 JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('NOA_API_TOKENS 必须是对象');
  const result: Tokens = {};
  for (const [token, scopes] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(scopes) || !scopes.length || scopes.some(s => !VALID_SCOPES.has(String(s)))) {
      throw new Error(`token ${token} 的 scopes 非法`);
    }
    result[token] = scopes.map(String);
  }
  if (!Object.keys(result).length) throw new Error('NOA_API_TOKENS 至少需要一个 token');
  return result;
}
