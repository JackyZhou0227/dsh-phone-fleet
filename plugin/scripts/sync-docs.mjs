// 发布前把仓库根的 README / LICENSE 同步进包目录。
// npm 页面只认包内根目录的 README.md，仓库根那份不会跟着走；
// 而相对链接（CONTRIBUTING.md 之类）在 npm 上是死链，所以顺手改成 GitHub 绝对地址。
// 由 package.json 的 prepublishOnly 调用，不需要手动跑。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..')
const repoDir = join(pluginDir, '..')
const blob = 'https://github.com/JackyZhou0227/dsh-phone-fleet/blob/main'

const readme = readFileSync(join(repoDir, 'README.md'), 'utf8').replace(
  /\]\((?!https?:)([^)#\s]+\.md)(#[^)]*)?\)/g,
  (_, file, hash = '') => `](${blob}/${file}${hash})`,
)
writeFileSync(join(pluginDir, 'README.md'), readme)
writeFileSync(join(pluginDir, 'LICENSE'), readFileSync(join(repoDir, 'LICENSE'), 'utf8'))
console.log('sync-docs: README.md / LICENSE 已从仓库根同步')