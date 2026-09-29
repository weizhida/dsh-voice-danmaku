#!/usr/bin/env node
/**
 * 敏感信息入库守卫。
 * ============================================================================
 * 目标只有一个：**在 push 之前把不该公开的东西拦下来**。
 *
 * 为什么要有它，而不是"提交前自己看一眼"：
 *
 *   1. 会泄露的往往不是密钥本身（那种东西大家都有警觉），而是**本机使用痕迹** ——
 *      绝对路径里的用户名、真实直播间号、调试时留下的口令。它们看起来人畜无害，
 *      但把一个公开仓库和你的真实账号绑定在一起；
 *   2. 这类东西一旦进了 Git 历史就**删不干净**（历史里还在，fork 里还在）。要改
 *      只能改写历史或弃用凭证，代价远高于在这里花 200 毫秒跑一遍；
 *   3. 它是**可执行的规矩**：`.gitignore` 漏了一行、测试里又粘了一个真实房间号，
 *      这里都会红。写进 CONTRIBUTING 的"请注意不要提交密钥"则不会。
 *
 * ## 扫描范围
 *
 * 只扫**会被提交的文件** —— 排除规则直接读 `.gitignore`，不另维护一份。
 * 两份清单迟早会分叉，而分叉的方向永远是"守卫以为排除了，其实没有"。
 * `--files` 可以把扫描范围打出来自己看一眼。
 *
 * ## 命中怎么办
 *
 * 报错信息会**遮蔽**敏感值（这个脚本的输出可能进 CI 日志）：它会告诉你文件、
 * 行号和规则名，但不复述那个值本身。你自己打开那一行就知道是什么。
 *
 * 用法：
 *   node tools/check-secrets.mjs            # 扫描并判定
 *   node tools/check-secrets.mjs --files    # 只列出会扫描哪些文件
 *
 * 和名字很像的 `check-secret-mask.mjs` 不是一回事：那个管"设置页会不会回显
 * 密钥"（界面上的一件事），这个管"仓库里有没有不该公开的东西"（入库前的一件事）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

console.log('[secrets] 敏感信息入库守卫\n');

// ---------------------------------------------------------------------------
// 1. .gitignore —— 唯一的排除规则来源
// ---------------------------------------------------------------------------

/**
 * 把 `.gitignore` 解析成可判定的规则。
 *
 * 只实现本项目实际用到的那几种写法（目录、根锚定路径、`*` 通配、裸名字）。
 * **不认识的写法会在这里报错**，而不是被静默忽略 —— "以为排除了，其实没有"
 * 正是这个脚本要防的事，它自己不能犯。
 */
function parseGitignore(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const anchored = line.startsWith('/');
    const body = anchored ? line.slice(1) : line;
    if (body.length === 0) throw new Error(`看不懂的 .gitignore 规则：${line}`);

    // 目录规则：`/lib/`、`node_modules/`、`/sidecar/bin/`
    if (body.endsWith('/')) {
      rules.push({ kind: anchored ? 'dirRoot' : 'dirAny', name: body.slice(0, -1), line });
      continue;
    }
    // 通配：`*.log`、`.env.*`、`credentials*.yaml`
    if (body.includes('*')) {
      const escaped = body.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      rules.push({ kind: 'glob', name: body, re: new RegExp(`^${escaped}$`), line });
      continue;
    }
    // 普通路径/文件名
    rules.push({ kind: anchored ? 'pathRoot' : 'anyName', name: body, line });
  }
  return rules;
}

const ignoreRules = parseGitignore(readFileSync(join(root, '.gitignore'), 'utf8'));

/**
 * 这个相对路径（用 `/` 分隔）是否被忽略？返回命中的规则，便于解释。
 *
 * `isDir` 只影响"精确名字"类规则（`*.log`、`Thumbs.db` 这种一般是文件）。
 * 目录规则不看它：`/lib/` 被忽略时，`lib/index.js` 当然也被忽略 —— 判断
 * "这个文件在不在被忽略的目录里"正是调用方最需要的用法。
 */
function ignoredBy(rel, isDir) {
  const segments = rel.split('/');
  const base = segments[segments.length - 1];
  for (const rule of ignoreRules) {
    switch (rule.kind) {
      case 'dirRoot':
        if (rel === rule.name || rel.startsWith(`${rule.name}/`)) return rule;
        break;
      case 'dirAny':
        if (segments.includes(rule.name)) return rule;
        break;
      case 'pathRoot':
        if (rel === rule.name) return rule;
        break;
      case 'anyName':
        if (base === rule.name) return rule;
        break;
      case 'glob':
        if (rule.re.test(base)) return rule;
        break;
      default:
        throw new Error(`内部错误：未知规则类型 ${rule.kind}`);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 2. 收集"将要提交的文件"
// ---------------------------------------------------------------------------

const files = [];
const skipped = [];
(function walk(relDir) {
  const full = relDir.length > 0 ? join(root, relDir) : root;
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const rel = relDir.length > 0 ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // `.git/` 硬编码跳过：它永远不会出现在提交里（git 自己不追踪它），扫它只是
      // 噪音 —— 而且里面有 .git/config 这种**本地**配置（远程地址、凭证），
      // 那属于"不该公开但也永远不会被提交"的东西，报出来只会让人白紧张。
      if (entry.name === '.git') { skipped.push(rel); continue; }
      if (ignoredBy(rel, true)) { skipped.push(rel); continue; }
      walk(rel);
    } else if (entry.isFile()) {
      if (ignoredBy(rel, false)) { skipped.push(rel); continue; }
      files.push(rel);
    }
  }
})('');

if (process.argv.includes('--files')) {
  console.log(`  会扫描 ${files.length} 个文件（排除 ${skipped.length} 项）：\n`);
  for (const file of files) console.log(`    ${file}`);
  console.log('');
  process.exit(0);
}

// --- 守卫：排除规则本身不能腐烂 --------------------------------------------
// 这几项是**本机上真实存在**的敏感路径。它们必须被判为忽略 —— 只要有一条失效，
// 下面的"没扫到"就变成了假阴性，而这个脚本会开开心心地报"通过"。
const mustBeIgnored = [
  ['tsconfig.check.json', false],      // 由本机 DSH 安装位置生成，含绝对路径
  ['lib/index.js', false],             // 构建产物
  ['node_modules/typescript/package.json', false],
  ['sidecar/bin/dsh-voice-danmaku-sidecar.exe', false],
  ['.verify/hotkey-x.jsonl', false]     // 本机按键自检存档
];
const leaky = mustBeIgnored.filter(([rel, isDir]) => !ignoredBy(rel, isDir));
check(leaky.length === 0, `应有的排除规则都在（${mustBeIgnored.length} 项）`,
  leaky.map(([rel]) => rel).join(', '));

// ---------------------------------------------------------------------------
// 3. 规则表
// ---------------------------------------------------------------------------

/** 看起来像占位符的用户名。测试里必须用这些，而不是真名。 */
const FAKE_USERS = new Set(['u', 'user', 'username', '<user>', '%username%', 'you', 'your-name', 'example']);

/**
 * 允许出现的直播间号。
 *
 * 这条规则值得解释：直播间号是**公开信息**，单看它不算秘密。但把它写进一个
 * 公开仓库，等于告诉所有人"这个插件是这个直播间的（也就是这个账号的）" ——
 * 而这个项目本身是绕平台风控的自动化工具。两者一关联，风险就从"匿名工具"
 * 变成了"具名账号在违反用户协议"。
 *
 * 所以测试里一律用假号。这里用白名单而不是"位数够短就算假"，是因为白名单会
 * 逼下一个加测试的人**确认**自己写的号是假的。
 */
const FAKE_ROOM_IDS = new Set([
  '1', '2', '123', '111', '222',   // 纯粹为了区分"两个标签页"的
  '12345',                          // 最像占位符的那个
  '99999'                           // 用来当"别人的房间"
]);

/** 允许出现的邮箱域名：文档里的示例地址与 GitHub 自己的 noreply。 */
const FAKE_EMAIL_DOMAINS = ['example.com', 'example.org', 'example.net', 'users.noreply.github.com'];

const RULES = [
  {
    id: 'windows-home',
    label: '路径里有本机用户名',
    hint: '改成相对路径，或用 %USERPROFILE%、C:\\Users\\u 这类占位符。',
    re: /[A-Za-z]:[\\/]Users[\\/]([^\\/\s"',;)]+)/g,
    allow: (m) => FAKE_USERS.has(m[1].toLowerCase()) || m[1].startsWith('%')
  },
  {
    id: 'unix-home',
    label: 'Unix 家目录路径',
    hint: '改成相对路径，或用 /home/user 这类占位符。',
    re: /(?:^|[\s"'(])\/(?:home|Users)\/([A-Za-z][\w.-]*)/g,
    allow: (m) => FAKE_USERS.has(m[1].toLowerCase())
  },
  {
    id: 'private-key',
    label: '私钥块',
    hint: '任何私钥都不该进仓库。',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g
  },
  {
    id: 'api-key',
    label: 'API 密钥字面量',
    hint: '密钥只应存在于 ~/.dsh/settings.yaml，代码里永远从配置读。',
    re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}/g
  },
  {
    id: 'cloud-key',
    label: '云厂商密钥字面量',
    hint: '同上：从环境或配置读，不要写死。',
    re: /\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b/g
  },
  {
    id: 'webhook',
    label: '聊天服务 webhook 地址',
    hint: 'webhook URL 等同于凭证（拿到就能以你的身份发消息）。',
    re: /https:\/\/(?:discord(?:app)?\.com\/api\/webhooks|hooks\.slack\.com)\/\S+/g
  },
  {
    id: 'bilibili-credential',
    label: 'B 站登录凭证出现在赋值里',
    hint: '本项目刻意不存任何 B 站凭证；出现了就是有东西不该在这里。',
    re: /(?:SESSDATA|bili_jct|DedeUserID|buvid3|buvid4)\s*[=:]\s*["']?([A-Za-z0-9%_*.+-]{8,})/g
  },
  {
    id: 'bridge-token',
    label: '写死的桥口令（32 位十六进制）',
    hint: '口令必须由宿主随机生成并写回设置，测试里请用 test-token-… 这类假值。',
    re: /["']([0-9a-f]{32})["']/g
  },
  {
    id: 'room-id',
    label: '直播间号看着像真实房间',
    hint: '测试与文档里请用假号（111、222、12345、99999…），需要新号就加进本脚本的白名单。',
    re: /(?:live\.bilibili\.com\/|setTargetRoomId\(\s*["'])(\d{2,})/g,
    allow: (m) => FAKE_ROOM_IDS.has(m[1])
  },
  {
    id: 'email',
    label: '邮箱地址',
    hint: '文档里用 example.com；真要留联系方式，用 GitHub 的 noreply 地址。',
    re: /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/g,
    allow: (m) => FAKE_EMAIL_DOMAINS.some((d) => m[0].toLowerCase().endsWith(d))
  }
];

// ---------------------------------------------------------------------------
// 4. 扫描
// ---------------------------------------------------------------------------

const MAX_BYTES = 1024 * 1024;   // 超过 1MB 的不看：这个规模里不会有手写的内容
const hits = [];
let scanned = 0;

/** 命中的值要遮蔽 —— 脚本的输出可能进 CI 日志，不能由它自己复述敏感值。 */
function mask(match) {
  const secret = match[1];
  return secret === undefined
    ? `<已遮蔽 ${match[0].length} 字符>`
    : match[0].replace(secret, '<已遮蔽>');
}

for (const rel of files) {
  const full = join(root, rel);
  if (statSync(full).size > MAX_BYTES) continue;

  let text;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    continue;   // 读不了（权限/编码）就当二进制跳过
  }
  if (text.includes('\u0000')) continue;   // 二进制
  scanned += 1;

  const lines = text.split(/\r?\n/);
  for (const rule of RULES) {
    // 每条规则单独一份 lastIndex：正则带 g，复用时状态会串。
    const re = new RegExp(rule.re.source, rule.re.flags);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(line)) !== null) {
        if (rule.allow === undefined || !rule.allow(match)) {
          hits.push({ rel, line: i + 1, rule, excerpt: mask(match) });
        }
        if (match.index === re.lastIndex) re.lastIndex += 1;   // 零宽匹配保护
      }
    }
  }
}

check(scanned > 0, `扫描了待提交的文件（${scanned} 个文本文件，排除 ${skipped.length} 项）`);
check(hits.length === 0, '没有发现敏感信息',
  hits.length > 0 ? `${hits.length} 处命中` : '');

if (hits.length > 0) {
  console.log('');
  // 同类命中聚在一起：修的时候是一类一类修的，散着看会来回跳。
  const byRule = new Map();
  for (const hit of hits) {
    if (!byRule.has(hit.rule.id)) byRule.set(hit.rule.id, []);
    byRule.get(hit.rule.id).push(hit);
  }
  for (const [, group] of byRule) {
    const rule = group[0].rule;
    console.log(`  【${rule.label}】${group.length} 处 —— ${rule.hint}`);
    for (const hit of group.slice(0, 20)) {
      console.log(`      ${hit.rel}:${hit.line}  ${hit.excerpt}`);
    }
    if (group.length > 20) console.log(`      …还有 ${group.length - 20} 处`);
    console.log('');
  }
}

if (failures === 0) {
  console.log('\n[secrets] 没有发现敏感信息，可以推。');
} else if (hits.length > 0) {
  console.log(`\n[secrets] 发现 ${hits.length} 处敏感信息 —— 处理掉再推（上面按类别列了文件与行号）。`);
} else {
  // 没有命中但仍然失败 = 守卫自身的前提没满足（比如排除规则失效）。
  console.log(`\n[secrets] 有 ${failures} 项前提检查没通过，见上 —— 在它修好之前，"没扫到"不算数。`);
}
process.exit(failures === 0 ? 0 : 1);
