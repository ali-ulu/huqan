#!/usr/bin/env node
'use strict';

/**
 * Deterministic hourly target selector for the Repo Radar automation
 * (docs/automations/repo-radar.md).
 *
 * The rotation is deliberately a pure function of the UTC hour so the choice
 * is reproducible from the clock alone: no randomness, no state file, no
 * ordering by network result. `index = floor(unixMillis / 3600000) % count`.
 * A run that fires late still lands on the hour it was scheduled for, and a
 * re-run for the same hour picks the same repository -- which is what makes
 * the automation testable and its output auditable.
 *
 * The config is validated fail-closed: a malformed entry refuses to run rather
 * than silently dropping a target, because a silently shorter list would move
 * every later hour's selection.
 *
 * Usage:
 *   node scripts/repo-radar/pick-target.js [--at <ISO-8601>] [--config <path>] [--json]
 */

const fs = require('node:fs');
const path = require('node:path');

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_CONFIG = path.join(__dirname, '..', '..', 'config', 'repo-radar.targets.json');
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Read and validate the target list. Throws on any malformed entry. */
function loadTargets(configPath = DEFAULT_CONFIG) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read target config ${configPath}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('target config must be a JSON object');
  }
  const repos = parsed.repos;
  if (!Array.isArray(repos) || repos.length === 0) {
    throw new Error('target config must list at least one repository in "repos"');
  }
  const seen = new Set();
  repos.forEach((entry, index) => {
    const where = `repos[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${where} must be an object`);
    }
    if (typeof entry.repo !== 'string' || !REPO_PATTERN.test(entry.repo)) {
      throw new Error(`${where}.repo must be an "owner/name" string`);
    }
    if (seen.has(entry.repo)) {
      throw new Error(`${where}.repo duplicates ${entry.repo}; rotation would repeat it`);
    }
    seen.add(entry.repo);
    if (typeof entry.why !== 'string' || entry.why.trim() === '') {
      throw new Error(`${where}.why must be a non-empty string`);
    }
    if (entry.focus !== undefined && (!Array.isArray(entry.focus) || entry.focus.some((f) => typeof f !== 'string'))) {
      throw new Error(`${where}.focus must be an array of strings when present`);
    }
  });
  return repos;
}

/**
 * Pure selection: the repository for the UTC hour containing `date`.
 * `repos` is assumed already validated by loadTargets.
 */
function selectTarget(repos, date = new Date()) {
  const millis = date.getTime();
  if (!Number.isFinite(millis)) {
    throw new Error('selectTarget requires a valid Date');
  }
  const hourIndex = Math.floor(millis / HOUR_MS);
  const index = ((hourIndex % repos.length) + repos.length) % repos.length;
  const hourStart = new Date(hourIndex * HOUR_MS);
  return {
    index,
    total: repos.length,
    selectedForHour: hourStart.toISOString(),
    repo: repos[index].repo,
    license: repos[index].license,
    focus: repos[index].focus || [],
    why: repos[index].why,
  };
}

/**
 * Render the automation prompt (docs/automations/repo-radar.md) from the
 * versioned target list.
 *
 * The prompt must NOT pin a repository: it is generated once, when the
 * automation is created, and then reused on every hourly run. The per-hour
 * choice is resolved at run time by asking the agent to run this same script
 * with --json. The rendered prompt is therefore a static template plus the
 * rotation roster, which is what keeps the automation reproducible.
 */
function renderPrompt(repos) {
  const roster = repos.map((entry) => `- ${entry.repo} (${entry.license || 'license unknown'})`).join('\n');
  return `Görev: HUQAN için "Repo Radar" tersine mühendislik turu (saatlik).

Her turda TEK bir açık kaynak repoyu inceler ve HUQAN'a somut geliştirme önerileri üretirsin.
Hedef repoyu ASLA tahmin etme veya elle seçme. Önce şu komutu çalıştır ve çıktısını kullan:

    node scripts/repo-radar/pick-target.js --json

Bu komut, içinde bulunulan UTC saatine göre deterministik olarak seçilen tek repoyu verir
(alanlar: repo, license, focus, why). Seçim saate bağlıdır; aynı saatte aynı repoyu verir.

Rotasyon listesi (bilgi amaçlı):
${roster}

ADIMLAR
1. Depo kimliğini doğrula: \`git remote -v\` ve \`node scripts/agent-context.js\`. Bu depo ali-ulu/huqan olmalı.
2. Hedef repoyu derinlik-1 klonla ve tam commit SHA'sını kaydet:
   git clone --depth 1 https://github.com/<repo> /tmp/repo-radar/<name>
   git -C /tmp/repo-radar/<name> rev-parse HEAD
3. Tersine mühendislik: mimariyi çıkar — giriş noktaları, ana modüller, veri akışı, sözleşmeler/şemalar,
   test stratejisi, CI. \`focus\` alanındaki başlıkları önceliklendir.
4. HUQAN ile karşılaştır. HUQAN bağlamı: güven çekirdeği (kernel), graph motoru ve mutasyon
   günlüğü, bellek deposu + bellek kabul (admission) kapıları, MCP araç yüzeyi, onay/approval
   runtime'ı, Agent Action Firewall ve diğer fail-closed kapılar, A2A exchange + ajanlar arası
   makbuz zinciri (inter-agent receipt chain), trust receipt/ledger, inference katmanı.
   Her bulguyu dosya/satır kanıtına bağla (yol:satır). Kanıt yoksa bulguyu "doğrulanmadı" işaretle.
5. 3-7 somut, uygulanabilir geliştirme önerisi üret. Her öneri şunları içersin:
   (a) hedef repodaki kanıt (yol:satır), (b) HUQAN'daki ilgili yüzey, (c) önerilen değişiklik,
   (d) beklenen kazanç, (e) risk ve tahmini efor.
6. ali-ulu/huqan deposunda TEK bir issue aç. Issue Türkçe olmalı.
   Başlık: \`repo-radar: <repo> — <kısa özet>\`
   Gövde: repo linki, tam commit SHA, tarih (UTC), öneri tablosu ve doğrulanmayan maddeler.
   - Önce aynı repo için açık bir \`repo-radar: <repo>\` issue'su var mı kontrol et
     (\`gh issue list --search\`). Varsa yeni issue açma; mevcut olana yorum ekle.
   - \`gh\` CLI ve GH_TOKEN ortam değişkeni mevcuttur.

YASAKLAR
- Kod değiştirme, PR açma, main'e push etme, kapsam dışı dosya değiştirme. Sadece analiz + issue.
- Issue gövdesine, başlığa veya herhangi bir yoruma AI imzası, "OpenHands", "AI ajanı",
  "on behalf of" ya da \`Co-authored-by: openhands\` trailer EKLEME (AGENTS.md §10).
- Ücretli/kapalı API çağrısı yok. Sadece public repo klonu ve gh.

BİTİŞ
En sonda Türkçe kısa rapor ver: seçilen repo, commit SHA, açılan/yorumlanan issue numarası,
öneri sayısı, doğrulanmayan maddeler ve bir sonraki adım.
`;
}

function parseArgs(argv) {
  const opts = { at: null, config: DEFAULT_CONFIG, json: false, prompt: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--prompt') opts.prompt = true;
    else if (arg === '--at') opts.at = argv[++i];
    else if (arg === '--config') opts.config = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log('Usage: node scripts/repo-radar/pick-target.js [--at <ISO-8601>] [--config <path>] [--json|--prompt]');
    return;
  }

  if (opts.prompt) {
    try {
      process.stdout.write(renderPrompt(loadTargets(opts.config)));
    } catch (error) {
      console.error(`repo-radar: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  const at = opts.at ? new Date(opts.at) : new Date();
  if (opts.at && Number.isNaN(at.getTime())) {
    console.error(`--at is not a valid date: ${opts.at}`);
    process.exitCode = 2;
    return;
  }

  let selection;
  try {
    selection = selectTarget(loadTargets(opts.config), at);
  } catch (error) {
    console.error(`repo-radar: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(selection, null, 2));
    return;
  }
  console.log(`repo: ${selection.repo}`);
  console.log(`hour: ${selection.selectedForHour} (index ${selection.index + 1}/${selection.total})`);
  console.log(`why:  ${selection.why}`);
}

if (require.main === module) {
  main();
}

module.exports = { HOUR_MS, DEFAULT_CONFIG, loadTargets, selectTarget, renderPrompt, parseArgs };
