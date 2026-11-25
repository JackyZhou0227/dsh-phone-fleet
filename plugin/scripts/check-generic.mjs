#!/usr/bin/env node
/**
 * 项目原则检查：插件只提供通用能力，不针对特定 App / 特定任务。
 *
 *   node plugin/scripts/check-generic.mjs
 *
 * 规则：
 * - **代码**里出现 App 包名/产品名、业务动作词（关注、点赞、私信、话术…） → 失败。
 * - **注释**里出现 → 只是提示（实测例子可以留，但不能影响分支）。
 * - 平台/机型的例子（如 com.android.settings 当作包名格式示例）不算违规。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 只扫真正跑在宿主里的代码；测试夹具和文档允许出现 App 名。 */
const TARGETS = ['index.js', 'client.js']
const TARGET_DIRS = ['host', 'scripts']

const RULES = [
  {
    label: 'App 包名/产品名',
    pattern:
      /\b(aweme|douyin|tiktok|kuaishou|xiaohongshu|weibo|bilibili|wechat|com\.ss\.android|com\.tencent\.)|抖音|快手|微信|微博|小红书|哔哩|B站/i,
  },
  {
    label: '业务动作',
    pattern: /(关注按钮|取消关注|点赞按钮|批量关注|批量私信|私信话术|话术库|取关)/,
  },
]

function collectFiles(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'vendor') continue
      collectFiles(path, out)
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      if (entry.name === 'check-generic.mjs') continue
      out.push(path)
    }
  }
  return out
}

/** 粗略区分「代码」和「注释」：行首注释，或 // 之前的部分。 */
function codePart(line) {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return ''
  const index = line.indexOf('//')
  if (index < 0) return line
  // 跳过 http:// 这类协议
  if (index > 0 && line[index - 1] === ':') return line
  return line.slice(0, index)
}

const files = []
for (const name of TARGETS) files.push(join(ROOT, name))
for (const dir of TARGET_DIRS) {
  try {
    collectFiles(join(ROOT, dir), files)
  } catch {
    // 目录不存在就跳过
  }
}

const errors = []
const warnings = []
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      const match = rule.pattern.exec(line)
      if (!match) continue
      const hit = {
        file: relative(ROOT, file),
        line: index + 1,
        rule: rule.label,
        text: line.trim().slice(0, 120),
      }
      if (rule.pattern.test(codePart(line))) errors.push(hit)
      else warnings.push(hit)
    }
  })
}

console.log(`扫描 ${files.length} 个源码文件（不含测试夹具）`)
if (warnings.length > 0) {
  console.log('\n提示：注释里提到了具体 App / 业务词（允许，但别让它影响分支）：')
  for (const hit of warnings) console.log(`  ${hit.file}:${hit.line} [${hit.rule}] ${hit.text}`)
}
if (errors.length > 0) {
  console.log('\n✗ 代码里出现特定 App / 业务语义（违反项目原则）：')
  for (const hit of errors) console.log(`  ${hit.file}:${hit.line} [${hit.rule}] ${hit.text}`)
  console.log('\n改法：把它变成通用机制或通用参数——插件只负责「看得见、点得准、知道成没成」。')
  process.exit(1)
}
console.log('\n✓ 通过：源码里没有针对特定 App / 特定任务的代码')