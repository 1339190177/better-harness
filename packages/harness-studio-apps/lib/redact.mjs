/**
 * Credential redaction for LLM-authored content this host serves back — the
 * Node twin of pass 1 (plaintext patterns) of ``kiro_crew/security/
 * redaction.py``.
 *
 * Every app that persists agent-authored text (auto-research findings and
 * reports, a notebook's cells, and so on) redacts it before serving to the
 * dashboard, so a credential the model echoed mid-task never reaches the UI.
 * The patterns below are the fixed-prefix, near-zero-false-positive branches
 * of the upstream scrubber, ported one-for-one with their spellings:
 *
 *   - AWS access key ids and secret/session/token key-value forms,
 *   - PEM private-key blocks (whole block, or subsequent body lines when the
 *     END marker is missing),
 *   - Slack / Telegram / Discord bot tokens,
 *   - vendor token prefixes: GitHub, GitLab, Stripe, SendGrid, OpenAI,
 *     Anthropic, npm, PyPI, DigitalOcean, Google OAuth,
 *   - connection-string userinfo (``scheme://user:pass@``),
 *   - JWTs / JWE / the 2-segment dashboard link token,
 *   - ``Authorization: Bearer <token>`` headers (case-insensitive).
 *
 * NOT ported, deliberately — this is the local compat host, whose
 * artifact/knowledge exports answer 503 rather than duplicating the
 * downstream surfaces the encoded passes exist to protect:
 *
 *   - pass 2, base64-encoded credentials (needs the decode probe),
 *   - pass 3, bare 40-char AWS secrets (needs the entropy/structure heuristic),
 *   - ``redact_exfiltration_urls`` (needs the query-shape heuristic set),
 *   - the ``_might_contain_credential`` pre-filter (a performance gate only —
 *     skipping it cannot change which spans match).
 *
 * A credential that appears ONLY in an encoded or unlabelled form therefore
 * reaches the local operator unredacted. Closing that needs the real
 * implementation upstream, not a wider regex here.
 */

const CREDENTIAL_TAG = '[REDACTED: credential]'

// The single alternation, branch order preserved from the upstream pattern.
// One JS caveat: JS has no scoped ``(?i:…)`` groups, so the case-insensitive
// ``Authorization: Bearer`` branch is scanned separately (BEARER_PATTERN
// below) instead of being folded into this one.
const CREDENTIAL_PATTERN = new RegExp(
  [
    // AWS key id — long-term (AKIA) and temporary/STS (ASIA).
    '(?:AKIA|ASIA)[A-Z0-9]{16}',
    // Key-value forms; the optional quote handling matches JSON spellings.
    // The value class stops at whitespace/quotes/commas/braces so compact
    // JSON cannot lose its structural delimiters.
    '(?:SecretAccessKey|aws_secret_access_key)["\']?\\s*[:=]\\s*["\']?[^\\s"\',}]+',
    '(?:SessionToken|aws_session_token)["\']?\\s*[:=]\\s*["\']?[^\\s"\',}]+',
    '(?:AccessKeyId|aws_access_key_id)["\']?\\s*[:=]\\s*["\']?[^\\s"\',}]+',
    // PEM private key: the whole block when END is present; otherwise only
    // subsequent PEM body/metadata lines (so an inline header in prose
    // matches just the header phrase and trailing prose survives).
    '-----BEGIN [A-Z ]*PRIVATE KEY-----' +
      '(?:[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----' +
      '|(?:\\r?\\n(?:Proc-Type:[^\\n]*|DEK-Info:[^\\n]*|[A-Za-z0-9+/=]+(?=\\r?\\n|$)' +
      '|(?=\\r?\\n[A-Za-z0-9+/=])))*)',
    // Slack token.
    'xox[bpas]-[0-9a-zA-Z-]{10,}',
    // Telegram bot token (bot_id:secret).
    '[0-9]{6,}:[A-Za-z0-9_-]{30,}',
    // Discord bot token: three anchored base64url segments.
    '(?<![A-Za-z0-9_-])[MNO][A-Za-z0-9_-]{22,30}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{25,}(?![A-Za-z0-9_-])',
    // Vendor token prefixes — fixed-case by design; do NOT case-fold.
    'gh[opsur]_[A-Za-z0-9]{30,255}',
    'github_pat_[A-Za-z0-9_]{40,}',
    'glpat-[A-Za-z0-9_-]{16,}',
    '(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}',
    'SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}',
    'sk-proj-[A-Za-z0-9_-]{16,}',
    'sk-ant-[A-Za-z0-9_-]{16,}',
    'npm_[A-Za-z0-9]{24,}',
    'pypi-[A-Za-z0-9_-]{16,}',
    'do[opr]_v1_[A-Za-z0-9]{40,}',
    'GOCSPX-[A-Za-z0-9_-]{20,}',
    // Connection strings with embedded userinfo.
    '(?:postgres(?:ql)?|mysql|mongodb(?:\\+srv)?|redis(?:s)?|amqp(?:s)?' +
      '|https?|ftps?):\\/\\/[^\\s:/@]*:[^\\s/]+@',
    // JWS (3 segments) / JWE (4-5 segments, incl. empty encrypted-key).
    'eyJ[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]*){2,4}',
    // The 2-segment dashboard link token (derived 96/43 floors).
    '(?<![A-Za-z0-9_.-])eyJ[A-Za-z0-9_-]{96,}\\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])',
  ].join('|'),
  'g',
)

// Case-insensitive branch: ``Authorization: Bearer <token>``, JSON-aware
// separators, token class per RFC 6750 ``b64token``.
const BEARER_PATTERN = /authorization["']?\s*[:=]\s*["']?bearer\s+[A-Za-z0-9._~+/-]+=*/gi

/**
 * Redact known credential spellings from *text*, spans merged in one pass.
 * Returns the cleaned text — warnings are not part of this host's contract
 * (the upstream list is consumed by its SEL audit, which has no twin here).
 */
export function redactCredentials(text) {
  if (typeof text !== 'string' || !text) return text
  const spans = []
  for (const m of text.matchAll(CREDENTIAL_PATTERN)) {
    spans.push([m.index, m.index + m[0].length])
  }
  for (const m of text.matchAll(BEARER_PATTERN)) {
    spans.push([m.index, m.index + m[0].length])
  }
  if (!spans.length) return text
  // Earlier start wins; on a tie the longer span wins. A span overlapping one
  // already claimed is dropped whole, so no character is rewritten twice —
  // the same "every pass sees the original text" property the upstream spans
  // guarantee.
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  let out = ''
  let cursor = 0
  for (const [start, end] of spans) {
    if (start < cursor) continue
    out += text.slice(cursor, start) + CREDENTIAL_TAG
    cursor = end
  }
  return out + text.slice(cursor)
}

/**
 * Recursively redact every string inside *value* (``_redact_value``): plain
 * objects and arrays are walked, primitives pass through.
 */
export function redactValue(value) {
  if (typeof value === 'string') return redactCredentials(value)
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = redactValue(item)
    return out
  }
  return value
}
