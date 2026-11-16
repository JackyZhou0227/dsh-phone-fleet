import assert from 'node:assert/strict'
import { ensureGoal } from '../host/routes.js'

// 目标模式的创建规则：没有目标就建；已有未完成目标不覆盖；完成过可以替换。
const agent = { id: 'session-1' }
let created = []
let current

const ctx = (overrides = {}) => ({
  get(name) {
    if (name === 'goals') {
      if (overrides.noGoals) return undefined
      return {
        get() {
          return current
        },
        create(owner, request) {
          created.push({ owner, ...request })
          current = { id: 'goal-1', phase: 'active' }
        },
      }
    }
    if (name === 'sessionController') {
      return {
        async resolveAgent() {
          return overrides.resolveError ? { error: new Error('session/not-found') } : { agent }
        },
      }
    }
    return undefined
  },
})

await ensureGoal(ctx(), 'session-1', '把亮度调到最高')
assert.equal(created.length, 1, '没有目标时应该创建')
assert.equal(created[0].owner, agent)
assert.equal(created[0].objective, '把亮度调到最高')

created = []
current = { id: 'goal-running', phase: 'active' }
await ensureGoal(ctx(), 'session-1', '另一个任务')
assert.equal(created.length, 0, '已有进行中的目标时不该覆盖')

created = []
current = { id: 'goal-done', phase: 'complete' }
await ensureGoal(ctx(), 'session-1', '新任务')
assert.equal(created.length, 1, '完成过的目标可以替换')

await assert.rejects(
  () => ensureGoal(ctx({ noGoals: true }), 'session-1', 'x'),
  /不支持目标模式/,
  '宿主没有 goals 服务时应明确报错',
)
await assert.rejects(
  () => ensureGoal(ctx({ resolveError: true }), 'session-1', 'x'),
  /session\/not-found/,
  '会话解析失败时应透传错误',
)

console.log('ok 目标模式：创建 / 不覆盖 / 可替换 / 缺服务报错')
