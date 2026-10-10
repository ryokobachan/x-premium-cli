#!/usr/bin/env node
// Local safety wrapper around the signed, official xAI Grok CLI.
// No external Node packages, API keys, alternate endpoints, or background service.
import { spawn } from 'node:child_process';
import { createReadStream, realpathSync } from 'node:fs';
import { readFile, lstat, mkdir, chmod, writeFile, rename, open, link, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { get as httpsGet } from 'node:https';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function storagePaths(home = homedir()) {
  if (!path.isAbsolute(home)) throw new SafeError('ABSOLUTE_HOME_REQUIRED');
  const data = path.join(home, '.local', 'share', 'x-premium-cli');
  const cache = path.join(home, '.cache', 'x-premium-cli');
  return { data_home: data, auth_home: path.join(data, 'auth'), quota_home: path.join(data, 'quota'),
    cache_home: cache, official_binary: path.join(cache, 'grok-1.0.50-macos-aarch64') };
}
const PATHS = storagePaths();
export const AUTH_HOME = PATHS.auth_home;
export const QUOTA_HOME = PATHS.quota_home;
const BIN = PATHS.official_binary;
const BINARY_URL = 'https://x.ai/cli/grok-1.0.50-macos-aarch64';
const BINARY_BYTES = 167936736;
const BINARY_SHA256 = 'af41b1d65d4116ff649a689ad9d070d4c2abe255737d46ba0b3e8161345696e6';
const PROXY = 'https://cli-chat-proxy.grok.com/v1';
const CLIENT = 'b1a00492-073a-47ea-816f-4c329264a828';
const MAX_BYTES = 1024 * 1024;
const CONFIG = '[auth]\npreferred_method = "oidc"\ndisable_api_key_auth = true\n[cli]\nuse_leader = false\nauto_update = false\n';
const QUOTA_CONFIRMATION = path.join(QUOTA_HOME, 'quota-confirmation.json');
const CONFIRMATION_TTL_MS = 120000;
const SNAPSHOT_AUTH = Symbol('snapshotAuth');

export class SafeError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function privateDirectory(dir, create = false) {
  if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
  let st;
  try { st = await lstat(dir); } catch { throw new SafeError('PRIVATE_DIRECTORY_MISSING'); }
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077)) {
    throw new SafeError('UNSAFE_PRIVATE_DIRECTORY');
  }
}

export function childEnvironment(source = process.env) {
  const env = {};
  for (const name of ['HOME', 'PATH', 'TMPDIR', 'USER', 'LOGNAME', 'LANG', 'LC_ALL']) {
    if (source[name]) env[name] = source[name];
  }
  return { ...env, GROK_HOME: AUTH_HOME, GROK_DISABLE_API_KEY_AUTH: '1' };
}

export async function loadAuth() {
  try { await privateDirectory(PATHS.data_home); await privateDirectory(AUTH_HOME); }
  catch (e) { if (e.code === 'PRIVATE_DIRECTORY_MISSING') throw new SafeError('LOGIN_REQUIRED'); throw e; }
  const file = path.join(AUTH_HOME, 'auth.json');
  let st;
  try { st = await lstat(file); } catch { throw new SafeError('LOGIN_REQUIRED'); }
  if (!st.isFile() || st.isSymbolicLink() || st.size > 256 * 1024 || (st.mode & 0o077) || st.uid !== process.getuid()) {
    throw new SafeError('UNSAFE_AUTH_FILE');
  }
  let all;
  try { all = JSON.parse(await readFile(file, 'utf8')); } catch { throw new SafeError('INVALID_AUTH_FILE'); }
  const auth = all[`https://auth.x.ai::${CLIENT}`];
  if (!auth || auth.auth_mode !== 'oidc' || auth.oidc_issuer !== 'https://auth.x.ai' ||
      auth.oidc_client_id !== CLIENT || typeof auth.key !== 'string' || !auth.key || auth.principal_type === 'Team') {
    throw new SafeError('OFFICIAL_PERSONAL_OAUTH_REQUIRED');
  }
  return auth;
}

export async function readBoundedJson(response, limit = MAX_BYTES) {
  let bytes = 0, text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw new SafeError('RESPONSE_TOO_LARGE');
    text += decoder.decode(chunk, { stream: true });
  }
  try { return JSON.parse(text + decoder.decode()); } catch { throw new SafeError('INVALID_RESPONSE'); }
}

async function get(auth, route, extra = {}, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(PROXY + route, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${auth.key}`, 'X-XAI-Token-Auth': 'xai-grok-cli',
        'x-grok-client-version': '1.0.50', 'x-grok-client-mode': 'headless', ...extra,
      },
    });
  } catch { throw new SafeError('STATUS_NETWORK_ERROR'); }
  if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new SafeError(`STATUS_HTTP_${res.status}`); }
  return readBoundedJson(res);
}

export function billingSummary(user, billing, topup) {
  const c = billing?.config ?? {};
  // The official Cent schema uses proto3 JSON: an explicitly present {} means 0.
  // An absent Cent object is unknown, never zero.
  const cents = v => v && typeof v === 'object' && !Array.isArray(v) &&
    (Object.keys(v).length === 0 || (Number.isSafeInteger(v.val) && v.val >= 0)) ? (v.val ?? 0) : null;
  const tier = user?.subscriptionTier ?? user?.subscription_tier ?? billing?.subscriptionTier;
  const rule = topup?.rule;
  const topupEnabled = rule && typeof rule === 'object' && !Array.isArray(rule)
    ? (rule.enabled === undefined ? false : typeof rule.enabled === 'boolean' ? rule.enabled : null)
    : topup && typeof topup === 'object' && !Array.isArray(topup) &&
      (rule === null || Object.keys(topup).length === 0) ? false : null;
  return {
    subscription_tier: typeof tier === 'string' && /^[A-Za-z0-9 +_-]{1,80}$/.test(tier) ? tier : null,
    on_demand_cap_cents: cents(c.onDemandCap), on_demand_used_cents: cents(c.onDemandUsed),
    prepaid_balance_cents: cents(c.prepaidBalance),
    auto_topup_enabled: topupEnabled,
    credit_usage_percent: typeof c.creditUsagePercent === 'number' && Number.isFinite(c.creditUsagePercent) ? c.creditUsagePercent : null,
    billing_fields: Object.keys(c).filter(k => /^[A-Za-z]{1,60}$/.test(k)),
  };
}

export function enforceNoPaidBilling(summary) {
  if (!/^X[ _-]?Premium$/i.test(summary.subscription_tier ?? '')) throw new SafeError('X_PREMIUM_ENTITLEMENT_UNCONFIRMED');
  if (summary.on_demand_cap_cents !== 0) throw new SafeError('ZERO_ON_DEMAND_CAP_UNCONFIRMED');
  if (summary.prepaid_balance_cents !== 0) throw new SafeError('ZERO_PREPAID_BALANCE_UNCONFIRMED');
  if (summary.auto_topup_enabled !== false) throw new SafeError('AUTO_TOPUP_DISABLED_UNCONFIRMED');
  if (summary.on_demand_used_cents === null) throw new SafeError('ON_DEMAND_USAGE_UNAVAILABLE');
  return true;
}

export function enforceSubscriptionOnly(summary) {
  enforceNoPaidBilling(summary);
  if (!Number.isFinite(summary.credit_usage_percent) || summary.credit_usage_percent < 0 || summary.credit_usage_percent >= 100) throw new SafeError('INCLUDED_QUOTA_UNAVAILABLE');
  return true;
}

function accountBinding(auth) {
  if (typeof auth.user_id !== 'string' || !auth.user_id) throw new SafeError('ACCOUNT_BINDING_UNAVAILABLE');
  return createHash('sha256').update(auth.user_id).digest('hex');
}

export function validateQuotaConfirmation(witness, binding, period, now = Date.now()) {
  const verified = Date.parse(witness?.verified_at);
  const start = Date.parse(period?.start), end = Date.parse(period?.end);
  return ['human_official_usage_ui','computer_use_official_usage_ui'].includes(witness?.source) && witness.account_binding === binding &&
    Number.isFinite(verified) && now >= verified && now - verified < CONFIRMATION_TTL_MS &&
    Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end &&
    period?.type === 'USAGE_PERIOD_TYPE_WEEKLY' && witness.period_start === period.start && witness.period_end === period.end &&
    Number.isFinite(witness.used_percent) && witness.used_percent >= 0 && witness.used_percent < 100;
}

async function quotaConfirmation(auth, period) {
  try {
    const st = await lstat(QUOTA_CONFIRMATION);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 4096 || st.uid !== process.getuid() || (st.mode & 0o077)) return null;
    const w = JSON.parse(await readFile(QUOTA_CONFIRMATION, 'utf8'));
    return validateQuotaConfirmation(w, accountBinding(auth), period) ? w : null;
  } catch { return null; }
}

async function confirmQuota(percent, origin = 'human', observedAt) {
  if (!Number.isFinite(percent) || percent < 0 || percent >= 100 || !['human','computer-use'].includes(origin)) throw new SafeError('INVALID_OFFICIAL_UI_QUOTA_CONFIRMATION');
  if (origin === 'computer-use' && (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt)))) throw new SafeError('OFFICIAL_UI_OBSERVATION_TIME_REQUIRED');
  observedAt ??= new Date().toISOString();
  const auth = await loadAuth();
  const user = await get(auth, '/user?include=subscription');
  if (/team/i.test(user.principalType ?? '') || user.teamId) throw new SafeError('PERSONAL_X_PREMIUM_ACCOUNT_REQUIRED');
  const billing = await get(auth, '/billing?format=credits', { 'x-userid': user.userId });
  const topup = await get(auth, '/auto-topup-rule', { 'x-userid': user.userId });
  enforceNoPaidBilling(billingSummary(user, billing, topup));
  if (Object.hasOwn(billing.config ?? {}, 'creditUsagePercent')) throw new SafeError('USE_LIVE_QUOTA_INSTEAD_OF_HUMAN_CONFIRMATION');
  const p = billing.config?.currentPeriod;
  const witness = { source: origin === 'computer-use' ? 'computer_use_official_usage_ui' : 'human_official_usage_ui', account_binding: accountBinding(auth), used_percent: percent,
    period_start: p?.start, period_end: p?.end, verified_at: observedAt };
  if (!validateQuotaConfirmation(witness, accountBinding(auth), p)) throw new SafeError('VALID_WEEKLY_PERIOD_REQUIRED');
  await privateDirectory(QUOTA_HOME, true);
  await writeFile(QUOTA_CONFIRMATION, JSON.stringify(witness), { mode: 0o600 }); await chmod(QUOTA_CONFIRMATION, 0o600);
  return { ok: true, confirmed_used_percent: percent, confirmation_source: witness.source, expires_in_seconds: CONFIRMATION_TTL_MS / 1000, inference_requests_allowed: 1 };
}

export async function status(fetchImpl = fetch) {
  const auth = await loadAuth();
  const user = await get(auth, '/user?include=subscription', {}, fetchImpl);
  if (/team/i.test(user.principalType ?? '') || (typeof user.teamId === 'string' && user.teamId)) {
    throw new SafeError('PERSONAL_X_PREMIUM_ACCOUNT_REQUIRED');
  }
  const id = user.userId ?? user.user_id;
  if (typeof id !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(id)) throw new SafeError('USER_ID_UNAVAILABLE');
  const billing = await get(auth, '/billing?format=credits', { 'x-userid': id }, fetchImpl);
  const topup = await get(auth, '/auto-topup-rule', { 'x-userid': id }, fetchImpl);
  const summary = billingSummary(user, billing, topup);
  summary.quota_source = summary.credit_usage_percent === null ? 'unavailable' : 'live_billing_api';
  if (!Object.hasOwn(billing.config ?? {}, 'creditUsagePercent')) {
    const w = await quotaConfirmation(auth, billing.config?.currentPeriod);
    if (w) {
      summary.credit_usage_percent = w.used_percent;
      summary.quota_source = w.source === 'computer_use_official_usage_ui' ? 'computer_use_official_ui_single_request' : 'human_official_ui_single_request';
      summary.quota_confirmation_valid_until = new Date(Date.parse(w.verified_at) + CONFIRMATION_TTL_MS).toISOString();
    }
  }
  let guard = 'PASS';
  try { enforceSubscriptionOnly(summary); } catch (e) { guard = e.code; }
  const result = { ok: guard === 'PASS', authenticated: true, official_oauth: true, expires_at: auth.expires_at ?? null,
    ...summary, subscription_only_guard: guard };
  Object.defineProperty(result, SNAPSHOT_AUTH, { value: auth }); // excluded from JSON and normal inspection
  return result;
}

async function codeSign(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/codesign', args, { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '', bytes = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    const collect = chunk => { bytes += chunk.byteLength; if (bytes > 16384) child.kill('SIGKILL'); else text += chunk.toString('utf8'); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', () => { clearTimeout(timer); reject(new SafeError('OFFICIAL_SIGNATURE_CHECK_FAILED')); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(text) : reject(new SafeError('OFFICIAL_SIGNATURE_CHECK_FAILED')); });
  });
}

export async function verifyOfficialBinary(file = BIN) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new SafeError('SUPPORTED_PLATFORM_MACOS_ARM64_ONLY');
  let st;
  try { st = await lstat(file); } catch { throw new SafeError('OFFICIAL_BINARY_MISSING_RUN_SETUP'); }
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o022) || st.size !== BINARY_BYTES) {
    throw new SafeError('UNSAFE_OFFICIAL_BINARY');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== BINARY_SHA256) throw new SafeError('OFFICIAL_BINARY_CHANGED');
  await codeSign(['--verify', '--strict', file]);
  const signature = await codeSign(['--display', '--verbose=4', file]);
  if (!signature.includes('TeamIdentifier=5Y6N3AJ54S') || !signature.includes('Authority=Developer ID Application: X.AI Corporation (5Y6N3AJ54S)')) {
    throw new SafeError('OFFICIAL_SIGNATURE_IDENTITY_MISMATCH');
  }
}

// Stream to disk, never buffer the 168 MB CLI in RAM. Only setup calls this.
export async function writeBinaryStream(body, file, expectedBytes, expectedHash) {
  const out = await open(file, 'wx', 0o500);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of body) {
      bytes += chunk.byteLength;
      if (bytes > expectedBytes) throw new SafeError('OFFICIAL_BINARY_SIZE_MISMATCH');
      hash.update(chunk); await out.writeFile(chunk);
    }
    if (bytes !== expectedBytes) throw new SafeError('OFFICIAL_BINARY_SIZE_MISMATCH');
    if (hash.digest('hex') !== expectedHash) throw new SafeError('OFFICIAL_BINARY_CHANGED');
  } finally { await out.close(); }
}

async function officialDownloadStream() {
  return new Promise((resolve, reject) => {
    const request = httpsGet(BINARY_URL, { signal: AbortSignal.timeout(300000) }, response => {
      // No redirect, alternate host, credentials, cookies or installer execution.
      if (response.statusCode !== 200) { response.destroy(); reject(new SafeError('OFFICIAL_DOWNLOAD_FAILED')); }
      else resolve(response);
    });
    request.once('error', () => reject(new SafeError('OFFICIAL_DOWNLOAD_FAILED')));
  });
}

async function setupOfficial(source) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new SafeError('SUPPORTED_PLATFORM_MACOS_ARM64_ONLY');
  await privateDirectory(PATHS.cache_home, true);
  try {
    await lstat(BIN); await verifyOfficialBinary();
    return { ok: true, official_cli_version: '1.0.50', sha256_verified: true, signature_verified: true, reused_cache: true };
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const temp = path.join(PATHS.cache_home, `.download-${randomUUID()}`);
  try {
    let body;
    if (source) body = createReadStream(path.resolve(source));
    else body = await officialDownloadStream();
    await writeBinaryStream(body, temp, BINARY_BYTES, BINARY_SHA256);
    await verifyOfficialBinary(temp);
    // Atomic publication without replacing a concurrent install or following a symlink.
    try { await link(temp, BIN); } catch (e) { if (e.code !== 'EEXIST') throw e; await verifyOfficialBinary(); }
    return { ok: true, official_cli_version: '1.0.50', sha256_verified: true, signature_verified: true, reused_cache: false };
  } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}

async function runOfficial(args, { timeoutMs = 180000, discard = false } = {}) {
  await privateDirectory(PATHS.cache_home);
  await verifyOfficialBinary();
  if (await readFile(path.join(AUTH_HOME, 'config.toml'), 'utf8') !== CONFIG) throw new SafeError('ISOLATED_CONFIG_CHANGED');
  return new Promise((resolve, reject) => {
    const child = spawn(BIN, args, { env: childEnvironment(), cwd: AUTH_HOME, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', bytes = 0, killed = false;
    let forceTimer;
    const stop = () => { killed = true; child.kill('SIGTERM'); forceTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000); };
    const timer = setTimeout(stop, timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.byteLength;
      if (bytes > 4 * MAX_BYTES) stop();
      else if (!discard) stdout += chunk.toString('utf8');
    });
    // Never forward raw auth/server error output into the model's transcript.
    child.stderr.resume();
    child.once('error', () => { clearTimeout(timer); reject(new SafeError('OFFICIAL_CLI_START_FAILED')); });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(forceTimer);
      if (killed) reject(new SafeError('OFFICIAL_CLI_LIMIT_EXCEEDED'));
      else if (code !== 0) reject(new SafeError(`OFFICIAL_CLI_EXIT_${code}`));
      else resolve(stdout);
    });
  });
}

export function normalizeResponse(data) {
  const texts = [], tools = [], citations = new Set();
  const addUrl = url => { try { const u = new URL(url); if (u.protocol === 'https:' && !u.username && !u.password) citations.add(u.href); } catch {} };
  for (const item of data?.output ?? []) {
    if (item.type === 'message') for (const part of item.content ?? []) {
      if (part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
      for (const a of part.annotations ?? []) if (a.type === 'url_citation') addUrl(a.url);
    }
    if (item.type === 'x_search_call' || item.type === 'web_search_call' ||
        (item.type === 'custom_tool_call' && typeof item.call_id === 'string' && item.call_id.startsWith('xs_'))) {
      tools.push({ type: item.type, call_id: item.call_id ?? null, status: item.status ?? null });
    }
  }
  for (const c of data?.citations ?? []) addUrl(typeof c === 'string' ? c : c.url);
  if (!texts.join('\n').trim()) throw new SafeError('RESPONSE_OUTPUT_UNRECOGNIZED');
  const usage = data?.usage?.server_side_tool_usage_details ?? {};
  const count = key => Number.isSafeInteger(usage[key]) && usage[key] >= 0 ? usage[key] : null;
  return { answer: texts.join('\n').trim(), tools, citations: [...citations],
    resolved_model: typeof data.model === 'string' && /^grok-[A-Za-z0-9._-]+$/.test(data.model) ? data.model : null,
    x_posts_fetched: count('x_posts_fetched'), x_users_fetched: count('x_users_fetched') };
}

export function extractPosts(text) {
  const posts = new Map();
  for (const match of text.matchAll(/https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/(?:[A-Za-z0-9_]+|i)\/status\/(\d{16,20})/g)) {
    const id = match[1];
    const ms = Number((BigInt(id) >> 22n) + 1288834974657n);
    if (ms < Date.UTC(2010, 10, 4) || ms > Date.now() + 60000) continue;
    posts.set(id, { url: match[0], post_id: id, posted_at_utc: new Date(ms).toISOString(), date_source: 'post_id_snowflake_derived', existence_verified: false });
  }
  return [...posts.values()];
}

export function requestPayload(mode, query, model) {
  if (!['chat', 'x-search', 'web-search'].includes(mode)) throw new SafeError('UNKNOWN_COMMAND');
  return { model, input: [{ role: 'user', content: query }], store: false, max_output_tokens: 2048,
    tools: mode === 'chat' ? [] : [{ type: mode === 'x-search' ? 'x_search' : 'web_search' }] };
}

async function search(mode, query, model) {
  const before = await status(); enforceSubscriptionOnly(before);
  const auth = before[SNAPSHOT_AUTH];
  const expiry = Date.parse(auth.expires_at);
  if (!Number.isFinite(expiry) || expiry - Date.now() < 300000) throw new SafeError('LOGIN_OR_OFFICIAL_REFRESH_REQUIRED');
  if (!/^grok-[A-Za-z0-9._-]{1,70}$/.test(model)) throw new SafeError('INVALID_MODEL');
  const catalog = await get(auth, '/models');
  if (!(catalog.data ?? []).some(m => (m.id ?? m.name) === model)) throw new SafeError('MODEL_NOT_IN_SUBSCRIPTION_CATALOG');
  if (['human_official_ui_single_request','computer_use_official_ui_single_request'].includes(before.quota_source)) {
    if (Date.parse(before.quota_confirmation_valid_until) <= Date.now()) throw new SafeError('OFFICIAL_UI_QUOTA_CONFIRMATION_EXPIRED');
    // Atomic single-use claim: two clients cannot spend the same UI confirmation twice.
    try { await rename(QUOTA_CONFIRMATION, QUOTA_CONFIRMATION + '.consumed'); }
    catch (e) { throw new SafeError(e.code === 'ENOENT' ? 'OFFICIAL_UI_QUOTA_CONFIRMATION_ALREADY_CONSUMED' : 'OFFICIAL_UI_QUOTA_STATE_NOT_WRITABLE'); }
  }
  const instruction = mode === 'x-search' ? 'Use x_search to answer. Include direct X post URLs and original post timestamps when available. Do not invent missing posts or dates.\n\n' :
    mode === 'web-search' ? 'Use web_search to answer. Include source URLs.\n\n' : '';
  const started = Date.now();
  let normalized, operationError;
  try {
    // Official CLI proxy only. No public metered endpoint or local tools exist here.
    const res = await fetch(PROXY + '/responses', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180000),
      headers: { Authorization: `Bearer ${auth.key}`, 'Content-Type': 'application/json',
        'X-XAI-Token-Auth': 'xai-grok-cli', 'x-grok-client-version': '1.0.50', 'x-grok-client-mode': 'headless',
        'x-grok-model-override': model }, body: JSON.stringify(requestPayload(mode, instruction + query, model)) });
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new SafeError(`SUBSCRIPTION_HTTP_${res.status}`); }
    normalized = normalizeResponse(await readBoundedJson(res, 4 * MAX_BYTES));
  } catch (e) { operationError = e instanceof SafeError ? e.code : 'SUBSCRIPTION_NETWORK_ERROR_NO_RETRY'; }
  // Defense in depth: exact secret values never leave this process, even if an upstream echoes them.
  for (const secret of [auth.key, auth.refresh_token]) {
    if (secret && normalized && JSON.stringify(normalized).includes(secret)) {
      normalized = undefined; operationError = 'SECRET_IN_UPSTREAM_OUTPUT';
    }
  }
  const after = await status();
  if (accountBinding(after[SNAPSHOT_AUTH]) !== accountBinding(auth)) throw new SafeError('ACCOUNT_CHANGED_STOP');
  const paidUnchanged = after.on_demand_used_cents === before.on_demand_used_cents && after.prepaid_balance_cents === before.prepaid_balance_cents;
  let afterBillingGuard = 'PASS';
  try { enforceNoPaidBilling(after); } catch (e) { afterBillingGuard = e.code; }
  const toolVerified = mode === 'chat' || (normalized?.tools ?? []).some(t => t.status === 'completed' &&
    (mode === 'x-search' ? t.type === 'x_search_call' || t.call_id?.startsWith('xs_') : t.type === 'web_search_call')) ||
    (mode === 'x-search' && normalized?.x_posts_fetched > 0);
  const ok = !operationError && paidUnchanged && afterBillingGuard === 'PASS' && toolVerified;
  return { ok, code: operationError ?? (!paidUnchanged ? 'PAID_USAGE_CHANGED_STOP' : afterBillingGuard !== 'PASS' ? afterBillingGuard : !toolVerified ? 'SEARCH_EXECUTION_UNCONFIRMED' : 'PASS'),
    mode, requested_model: model, ...normalized, posts: extractPosts((normalized?.answer ?? '') + '\n' + (normalized?.citations ?? []).join('\n')),
    search_execution_verified: toolVerified, elapsed_ms: Date.now() - started,
    billing_before: before, billing_after: after, paid_usage_unchanged: paidUnchanged,
    further_requests_allowed: after.subscription_only_guard === 'PASS' };
}

async function main() {
  const [mode = 'help', ...rest] = process.argv.slice(2);
  if (mode === 'help') {
    console.log('Usage: node x-premium-cli.mjs paths | setup [existing-official-binary] | status | models | login | confirm-quota <official-ui-percent> [computer-use <observed-at-iso>] | chat|x-search|web-search "query" [grok-model]'); return;
  }
  if (mode === 'paths') {
    console.log(JSON.stringify({ ok: true, ...PATHS }, null, 2)); return;
  }
  if (mode === 'setup') {
    if (rest.length > 1) throw new SafeError('INVALID_SETUP_ARGUMENTS');
    console.log(JSON.stringify(await setupOfficial(rest[0]))); return;
  }
  if (mode === 'login') {
    await privateDirectory(PATHS.data_home, true); await privateDirectory(AUTH_HOME, true);
    try { await writeFile(path.join(AUTH_HOME, 'config.toml'), CONFIG, { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    console.error('Official OAuth opens in your browser. No codes or tokens are printed.');
    await runOfficial(['login', '--oauth'], { timeoutMs: 610000, discard: true });
    console.log(JSON.stringify({ ok: true, authenticated: true })); return;
  }
  let result;
  if (mode === 'status') result = await status();
  else if (mode === 'confirm-quota') result = await confirmQuota(rest[0]?.trim() ? Number(rest[0]) : NaN, rest[1] ?? 'human', rest[2]);
  else if (mode === 'models') {
    const auth = await loadAuth(); const models = await get(auth, '/models');
    result = { ok: true, models: (models.data ?? []).map(m => m.id ?? m.name).filter(v => typeof v === 'string' && /^grok-[A-Za-z0-9._-]+$/.test(v)) };
  } else if (['chat', 'x-search', 'web-search'].includes(mode)) {
    if (typeof rest[0] !== 'string' || !rest[0].trim() || rest[0].length > 10000) throw new SafeError('INVALID_QUERY');
    result = await search(mode, rest[0], rest[1] ?? 'grok-4.7');
  } else throw new SafeError('UNKNOWN_COMMAND');
  console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1;
}

function calledDirectly() {
  try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}
if (calledDirectly()) {
  main().catch(e => { console.log(JSON.stringify({ ok: false, code: e instanceof SafeError ? e.code : 'LOCAL_OPERATION_FAILED' })); process.exitCode = 1; });
}
