/**
 * UI 树读取的离线测试：不需要连手机。
 *
 * 重点是四件事：
 * 1. 失败时绝不返回旧树、失败原因可判定；
 * 2. 有文案和「无文案但可点」的节点都要能定位（图标类 UI 全靠后者）；
 * 3. 动画页面靠「暂停一次并记住状态」救援，绝不在每次 dump 前无脑发 127；
 * 4. 每帧有 frame_id，上层拿旧 frame 来操作必须被拒绝。
 */
import assert from 'node:assert/strict'
import { AndroidAdapter, UiDumpError, classifyDumpFailure, compactUiTree, parseUiNodes } from '../host/adapters/android.js'
import { matchNodes, scrollGeometry, verifyAfter } from '../host/tools.js'
import { cropPng, decodePng, encodePng } from '../host/png.js'

const XML = (bounds = '[0,0][1080,2310]') =>
  `<hierarchy rotation="0"><node class="android.widget.FrameLayout" bounds="${bounds}">` +
  '<node class="android.widget.TextView" text="暂停视频" bounds="[100,1000][980,1124]" clickable="true"/>' +
  '<node class="android.widget.ImageView" content-desc="返回" bounds="[0,48][96,144]" clickable="false"/>' +
  '</node></hierarchy>'

const FOCUS = '  mCurrentFocus=Window{bc386b1 u0 com.ss.android.ugc.aweme/com.ss.android.ugc.aweme.splash.SplashActivity}'
const RESUME = '  mResumedActivity: ActivityRecord{abc u0 com.ss.android.ugc.aweme/.main.MainActivity t123}'

function resume(activity = 'com.ss.android.ugc.aweme/.main.MainActivity') {
  return `  mResumedActivity: ActivityRecord{abc u0 ${activity} t123}`
}

/**
 * 用脚本化的 adb 响应替换真实调用。
 * onDump 决定每次 `uiautomator dump` 的返回（成功文案或 ERROR）。
 */
function makeDevice(options = {}) {
  const state = { dumps: 0, keyevents: 0, taps: 0, swipes: 0 }
  const handler = (args) => {
    const command = String(args[1] ?? '')
    if (command.startsWith('dumpsys window')) {
      if (options.failFocus) throw new Error('grep: mCurrentFocus: No such file')
      return Buffer.from(options.focus ?? FOCUS)
    }
    if (command.startsWith('dumpsys activity')) {
      if (options.failResume) throw new Error('dumpsys: permission denied')
      return Buffer.from(options.resume ?? RESUME)
    }
    if (command === 'wm size') return Buffer.from(options.wmSize ?? 'Physical size: 1080x2310\n')
    if (command.startsWith('rm -f')) return Buffer.from('')
    if (command.startsWith('input keyevent')) {
      state.keyevents += 1
      return Buffer.from('')
    }
    if (command.startsWith('input tap')) {
      state.taps += 1
      return Buffer.from('')
    }
    if (command.startsWith('input swipe')) {
      state.swipes += 1
      return Buffer.from('')
    }
    if (command.startsWith('uiautomator dump')) {
      state.dumps += 1
      const output = options.onDump
        ? options.onDump(state)
        : 'UI hierchary dumped to: /data/local/tmp/x.xml'
      return Buffer.from(output)
    }
    if (args[0] === 'exec-out' && String(command).startsWith('cat ')) {
      return Buffer.from(typeof options.xml === 'function' ? options.xml(state) : (options.xml ?? XML()))
    }
    if (args[0] === 'exec-out' && String(command).startsWith('screencap')) {
      return Buffer.from(options.png ?? Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    }
    throw new Error(`未预期的命令 ${args.join(' ')}`)
  }
  return { state, handler }
}

/** 用脚本化的 adb 响应替换真实调用；返回 adapter 和调用记录。 */
function fakeAdapter(handlerOrOptions, config = {}) {
  const { handler, state } = handlerOrOptions.handler
    ? handlerOrOptions
    : makeDevice(handlerOrOptions)
  const adapter = new AndroidAdapter({ adbPath: 'adb', ...config })
  const calls = []
  adapter.call = async (deviceId, args, timeout) => {
    calls.push({ args, timeout })
    return handler(args, calls)
  }
  return { adapter, calls, state }
}

// ---- 离线：分类与解析 ----
{
  assert.equal(classifyDumpFailure('ERROR: could not get idle state.'), 'idle_timeout')
  assert.equal(classifyDumpFailure('error: device offline'), 'device_offline')
  assert.equal(classifyDumpFailure('adb 超时（20000ms）'), 'dump_timeout')
  assert.equal(classifyDumpFailure('cat: /data/local/tmp/x.xml: No such file or directory'), 'xml_missing')
  assert.equal(classifyDumpFailure('whatever'), 'dump_failed')
  console.log('ok 失败分类')
}

{
  const { text, nodes, width, height, origin } = compactUiTree(XML())
  assert.equal(width, 1080)
  assert.equal(height, 2310)
  assert.deepEqual(origin, { x: 0, y: 0 })
  assert.equal(nodes.length, 2)
  assert.equal(nodes[0].bounds, '[100,1000][980,1124]')
  assert.deepEqual(nodes[0].center, { x: 540, y: 1062 })
  assert.match(text, /暂停视频/)
  console.log('ok UI 树空间与 bounds')
}

// ---- 属性解析：`clickable` 不能被 `long-clickable` 抢先命中 ----
{
  const parsed = parseUiNodes(
    '<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][1080,2090]">' +
      '<node class="android.view.View" long-clickable="true" clickable="false" bounds="[0,0][100,100]"/>' +
      '</node></hierarchy>',
  )
  assert.equal(parsed.nodes[1].clickable, false, 'long-clickable 不能当成 clickable')
  assert.equal(parsed.nodes[1].parentIndex, 0)
  assert.equal(parsed.nodes[0].parentIndex, -1)
  console.log('ok 属性边界与父子关系')
}

// ---- MC-02：无文案但可点的节点必须能定位 ----
{
  const pixelTree =
    '<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][1080,2090]">' +
    // 列表项头像：没有 text/desc，只有 clickable
    '<node class="android.view.View" bounds="[48,1046][156,1154]" clickable="true"/>' +
    // 可点行容器：范围比子节点大，是另一个可点目标，要单独列
    '<node class="android.widget.LinearLayout" bounds="[0,1200][1080,1400]" clickable="true">' +
    '<node class="android.widget.TextView" text="第1条" bounds="[20,1250][400,1330]" clickable="true"/>' +
    '</node>' +
    // 容器和可点子节点完全同范围：只保子节点，别列两遍
    '<node class="android.widget.FrameLayout" bounds="[500,1500][700,1600]" clickable="true">' +
    '<node class="android.view.View" bounds="[500,1500][700,1600]" clickable="true"/>' +
    '</node>' +
    '</node></hierarchy>'
  const legacy = compactUiTree(pixelTree)
  assert.equal(legacy.nodes.length, 1, '旧行为：没有 resource-id 的可点节点会丢')

  const all = compactUiTree(pixelTree, { includeAllClickable: true })
  assert.equal(all.nodes.length, 4, '头像 + 行容器 + 第1条 + 同范围里的子节点')
  assert.deepEqual(all.nodes[0].center, { x: 102, y: 1100 })
  assert.match(all.text, /\[102,1100\] View \[可点\]/)
  assert.equal(all.totalNodes, 6)
  console.log('ok 图标类可点节点')
}

// ---- MC-03：树原点可以直接换算截图坐标 ----
{
  const { origin } = compactUiTree(
    `<hierarchy><node class="android.widget.FrameLayout" bounds="[0,96][1080,2100]"/></hierarchy>`,
  )
  assert.deepEqual(origin, { x: 0, y: 96 })
  console.log('ok 树原点')
}

// ---- dump 失败时必须抛错，不能把旧文件当结果 ----
{
  const { adapter } = fakeAdapter({
    onDump: () => 'ERROR: could not get idle state.',
  }, { uiDumpAttempts: 1, pauseOnIdle: false })

  await assert.rejects(
    () => adapter.uiDump('dev-1'),
    (error) => {
      assert.ok(error instanceof UiDumpError, '应该抛 UiDumpError')
      assert.equal(error.code, 'idle_timeout')
      assert.match(error.message, /idle_timeout/)
      assert.match(error.message, /SplashActivity/)
      return true
    },
  )
  console.log('ok idle 超时不会读到旧树')
}

// ---- MC-01：空闲超时先暂停一次媒体再试，并记住这个窗口 ----
{
  const device = makeDevice({
    onDump: (state) => (state.dumps === 1 ? 'ERROR: could not get idle state.' : 'UI hierchary dumped to: x'),
  })
  const { adapter, state } = fakeAdapter(device)
  const dump = await adapter.uiDump('dev-1')
  assert.equal(state.dumps, 2, '救援后应该再读一次')
  assert.equal(state.keyevents, 1, '只该发一次 127')
  assert.equal(dump.mediaPaused, true)
  assert.equal(dump.attempts, 2)
  assert.equal(dump.frameId.length, 12)

  // 同一个窗口已经知道会卡：下一轮先暂停（状态已是 paused，不再发键）
  const again = await adapter.uiDump('dev-1')
  assert.equal(state.dumps, 3)
  assert.equal(state.keyevents, 1, '已经记成 paused，不该再发 127')
  assert.equal(again.mediaPaused, true)
  console.log('ok idle 救援 + 状态记忆')
}

// ---- 救援也失败：要还原媒体状态，别把用户的视频放着 ----
{
  const device = makeDevice({ onDump: () => 'ERROR: could not get idle state.' })
  const { adapter, state } = fakeAdapter(device)
  await assert.rejects(
    () => adapter.uiDump('dev-1'),
    (error) => error.code === 'idle_timeout' && error.details.attempts === 2,
  )
  assert.equal(state.dumps, 2)
  assert.equal(state.keyevents, 2, '救援失败要再发一次 127 还原调用前的状态')
  assert.equal(adapter.mediaState('dev-1'), 'unknown', '还原后不留下假状态')
  console.log('ok 救援失败会还原媒体状态')
}

// ---- 换页之后「已暂停」不再可信 ----
{
  const device = makeDevice({
    onDump: (state) => (state.dumps === 1 ? 'ERROR: could not get idle state.' : 'UI hierchary dumped to: x'),
  })
  const { adapter, state } = fakeAdapter(device)
  await adapter.uiDump('dev-1')
  assert.equal(adapter.mediaState('dev-1'), 'paused')
  await adapter.tap('dev-1', 540, 1062)
  assert.equal(adapter.mediaState('dev-1'), 'unknown', '点完/翻页后媒体状态要清掉')
  await adapter.uiDump('dev-1')
  assert.equal(state.keyevents, 2, '换页后卡住要重新发一次 127')
  console.log('ok 翻页后重新判断媒体状态')
}

// ---- 成功路径：独立文件、先删后 dump、返回坐标空间 ----
{
  const { adapter, calls } = fakeAdapter({}, { uiDumpAttempts: 1 })
  const dump = await adapter.uiDump('dev-1')
  assert.equal(dump.width, 1080)
  assert.equal(dump.height, 2310)
  assert.equal(dump.nodes.length, 2)
  assert.equal(dump.foreground, 'com.ss.android.ugc.aweme/com.ss.android.ugc.aweme.splash.SplashActivity')
  assert.equal(dump.foregroundPackage, 'com.ss.android.ugc.aweme')
  assert.equal(dump.activity, 'com.ss.android.ugc.aweme.splash.SplashActivity')
  assert.equal(dump.focusSource, 'focus', 'mCurrentFocus 优先')
  assert.equal(dump.attempts, 1)
  assert.equal(dump.spaceMismatch, undefined, '树与 wm size 一致时不该报坐标错位')
  assert.ok(dump.elapsedMs >= 0)
  assert.equal(dump.frameId.length, 12)

  const dumpIndex = calls.findIndex((call) => String(call.args[1] ?? '').startsWith('uiautomator dump'))
  const firstRm = calls.findIndex((call) => String(call.args[1] ?? '').startsWith('rm -f'))
  assert.ok(firstRm >= 0 && firstRm < dumpIndex, 'dump 之前必须先删掉目标文件')
  assert.match(String(calls[dumpIndex].args[1]), /dsh-ui-\d+-[a-z0-9]+\.xml/)
  // uiautomator 的 ERROR 走 stderr，必须合并进 stdout，否则 idle 超时会被误判成空文件。
  assert.match(String(calls[dumpIndex].args[1]), /2>&1/)
  console.log('ok 成功路径（先删后 dump、独立文件名、合并 stderr）')
}

// ---- MC-04：帧指纹 ----
{
  const first = await fakeAdapter({}, { uiDumpAttempts: 1 }).adapter.uiDump('dev-1')
  const same = await fakeAdapter({}, { uiDumpAttempts: 1 }).adapter.uiDump('dev-1')
  assert.equal(first.frameId, same.frameId, '同一帧的 frame_id 必须一致')

  const other = await fakeAdapter({ xml: XML('[0,0][1080,2000]') }, { uiDumpAttempts: 1 }).adapter.uiDump('dev-1')
  assert.notEqual(first.frameId, other.frameId, '翻页/滚动后 frame_id 必须变')
  console.log('ok frame_id 稳定且能反映变化')
}

// ---- MC-05：mCurrentFocus 拿不到时退回 Activity 栈 ----
{
  const { adapter } = fakeAdapter({ failFocus: true }, { uiDumpAttempts: 1 })
  const dump = await adapter.uiDump('dev-1')
  assert.equal(dump.focusSource, 'resumed')
  assert.equal(dump.foreground, 'com.ss.android.ugc.aweme/.main.MainActivity')
  console.log('ok 前台退回 Activity 栈')
}

// ---- 重试：第一次掉线，第二次成功 ----
{
  const test = makeDevice({
    onDump: (state) => {
      if (state.dumps === 1) throw new Error('error: device offline')
      return 'UI hierchary dumped to: x'
    },
  })
  const { adapter } = fakeAdapter(test, { uiDumpAttempts: 2 })
  const dump = await adapter.uiDump('dev-1')
  assert.equal(dump.attempts, 2)
  assert.equal(dump.nodes.length, 2)
  console.log('ok 失败重试')
}

// ---- 其它失败照常重试 ----
{
  const test = makeDevice({
    onDump: () => {
      throw new Error('error: device offline')
    },
  })
  const { adapter, state } = fakeAdapter(test, { uiDumpAttempts: 3 })
  await assert.rejects(
    () => adapter.uiDump('dev-1'),
    (error) => error.code === 'device_offline' && error.details.attempts === 3,
  )
  assert.equal(state.dumps, 3, '掉线这类瞬时错误应该重试满次数')
  console.log('ok 瞬时错误仍重试')
}

// ---- 空文件要报 xml_empty，而不是「没拿到 hierarchy」 ----
{
  const { adapter } = fakeAdapter({ xml: '' }, { uiDumpAttempts: 1 })
  await assert.rejects(
    () => adapter.uiDump('dev-1'),
    (error) => error.code === 'xml_empty' && error.details.xmlBytes === 0,
  )
  console.log('ok 空文件')
}

// ---- MC-11：队列太长直接回 busy，别让调用方排到工具超时 ----
{
  const adapter = new AndroidAdapter({ adbPath: 'adb', uiQueueLimit: 2 })
  const slow = () => new Promise((resolve) => setTimeout(() => resolve('done'), 50))
  const running = [adapter.exclusive('dev-1', slow), adapter.exclusive('dev-1', slow)]
  const busy = await adapter.exclusive('dev-1', slow).catch((error) => error)
  assert.match(busy.message, /\[busy\]/)
  assert.equal(await Promise.all(running).then((values) => values.join(',')), 'done,done')
  // 队列排空之后要能继续用
  assert.equal(await adapter.exclusive('dev-1', slow), 'done')
  console.log('ok 队列上限回 busy')
}

// ---- 坐标超出屏幕：直接拒绝，别静默点偏 ----
{
  const { adapter, state } = fakeAdapter({ wmSize: 'Physical size: 1080x2400\nOverride size: 1080x2310\n' })
  const screen = await adapter.screen('dev-1')
  assert.deepEqual(screen, {
    width: 1080,
    height: 2310,
    physical: { width: 1080, height: 2400 },
    override: true,
  })

  await assert.rejects(
    () => adapter.tap('dev-1', 540, 2350),
    (error) => {
      assert.match(error.message, /超出屏幕范围/)
      assert.match(error.message, /1080×2310/)
      return true
    },
  )
  assert.equal(state.taps, 0)

  await adapter.tap('dev-1', 540, 1062)
  assert.equal(state.taps, 1)
  console.log('ok 坐标范围校验')
}

// ---- 树的坐标空间和 wm size 不一致时要报出来（这就是「点偏」的可判定信号） ----
{
  const { adapter } = fakeAdapter(
    { wmSize: 'Physical size: 1080x2400\nOverride size: 1080x2310\n', xml: XML('[0,0][1080,2400]') },
    { uiDumpAttempts: 1 },
  )
  const dump = await adapter.uiDump('dev-1')
  assert.deepEqual(dump.spaceMismatch, {
    tree: { width: 1080, height: 2400 },
    screen: { width: 1080, height: 2310 },
  })
  console.log('ok 树比屏幕大 → 报坐标空间异常')
}

// ---- 树比屏幕小是正常的（树只覆盖前台窗口，不含导航栏），不能报异常 ----
{
  const { adapter } = fakeAdapter(
    { wmSize: 'Physical size: 1080x2340\n', xml: XML('[0,0][1080,2193]') },
    { uiDumpAttempts: 1 },
  )
  const dump = await adapter.uiDump('dev-1')
  assert.equal(dump.width, 1080)
  assert.equal(dump.height, 2193)
  assert.equal(dump.spaceMismatch, undefined, '树比屏幕小是前台窗口的正常裁剪')
  console.log('ok 树比屏幕小不算坐标异常')
}

// ---- 启动页：只有树几乎为空时才提示，别在正常页面误报 ----
{
  const sparseXml =
    '<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][1080,2340]">' +
    '<node class="android.widget.ImageView" content-desc="启动图" bounds="[0,0][1080,2340]"/></node></hierarchy>'
  const normalXml =
    '<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][1080,2340]">' +
    Array.from(
      { length: 6 },
      (_, index) =>
        `<node class="android.widget.TextView" text="条目${index}" bounds="[0,${index * 100}][1080,${index * 100 + 90}]" clickable="true"/>`,
    ).join('') +
    '</node></hierarchy>'

  const sparse = await fakeAdapter({ xml: sparseXml }, { uiDumpAttempts: 1 }).adapter.uiDump('dev-1')
  assert.equal(sparse.warning, 'splash')

  const normal = await fakeAdapter({ xml: normalXml }, { uiDumpAttempts: 1 }).adapter.uiDump('dev-1')
  assert.equal(normal.warning, undefined, '正常页面即使前台残留 SplashActivity 也不该提示')
  console.log('ok 启动页只在空树时提示')
}

// ---- MC-07：媒体键要记状态 ----
{
  const { adapter, state } = fakeAdapter({})
  await adapter.key('dev-1', 'mediaPause')
  assert.equal(adapter.mediaState('dev-1'), 'paused')
  await adapter.key('dev-1', 'mediaPlayPause')
  assert.equal(adapter.mediaState('dev-1'), 'unknown', '切换键不改变已知状态，清成 unknown')
  await adapter.key('dev-1', 'mediaPlay')
  assert.equal(adapter.mediaState('dev-1'), 'playing')
  await assert.rejects(() => adapter.key('dev-1', 'nosuchkey'), /不支持的按键/)
  assert.equal(state.keyevents, 3)
  console.log('ok 媒体键状态')
}

// ---- MC-10：非 ASCII 输入失败要报 ime_unsupported，不能静默输入空串 ----
{
  const { adapter } = fakeAdapter({
    onShell: undefined,
  })
  // yadb 推送失败：模拟设备不允许写 /data/local/tmp
  adapter.call = async (_deviceId, args) => {
    const command = String(args[1] ?? '')
    if (args[0] === 'push') throw new Error('adb: error: failed to copy')
    if (command.startsWith('[ -f')) return Buffer.from('no')
    throw new Error(`未预期的命令 ${args.join(' ')}`)
  }
  await assert.rejects(
    () => adapter.text('dev-1', '你好'),
    (error) => {
      assert.match(error.message, /ime_unsupported/)
      return true
    },
  )
  console.log('ok 中文输入失败分类')
}

// ---- MC-06：文字匹配先精确、再包含，绝不静默取第一个 ----
{
  const nodes = compactUiTree(
    '<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][1080,2090]">' +
      '<node class="android.widget.TextView" text="谢谢你们大家关注我" bounds="[100,600][900,680]"/>' +
      '<node class="android.widget.Button" text="关注" bounds="[950,1000][1060,1060]" clickable="true"/>' +
      '</node></hierarchy>',
  ).nodes
  const exact = matchNodes(nodes, '关注')
  assert.equal(exact.matched, 'exact')
  assert.equal(exact.candidates.length, 1)
  assert.equal(exact.candidates[0].text, '关注')

  const partial = matchNodes(nodes, '你们')
  assert.equal(partial.matched, 'partial')
  assert.equal(partial.candidates.length, 1)

  // 精确命中唯一时优先取它，不把「包含」命中混进候选（否则就会静默取第一个）
  assert.equal(matchNodes(nodes, '关注').candidates.length, 1)

  // 两个不同的「消息」：精确命中只有底部导航，取它，不猜那个 desc 里的长句
  const twoNodes = compactUiTree(
    '<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][1080,2090]">' +
      '<node class="android.widget.TextView" text="消息" bounds="[0,2000][200,2080]" clickable="true"/>' +
      '<node class="android.view.View" content-desc="侧边栏有1条未读消息" bounds="[900,100][1060,260]" clickable="true"/>' +
      '</node></hierarchy>',
  ).nodes
  const navHit = matchNodes(twoNodes, '消息')
  assert.equal(navHit.matched, 'exact')
  assert.equal(navHit.candidates.length, 1)

  // 没有任何精确命中、又有多个包含命中：两个候选都交出去，让上层报 ambiguous
  const fuzzyNodes = compactUiTree(
    '<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][1080,2090]">' +
      '<node class="android.widget.TextView" text="谢谢你们大家关注我" bounds="[100,600][900,680]"/>' +
      '<node class="android.widget.TextView" text="关注了3人" bounds="[100,900][900,980]"/>' +
      '</node></hierarchy>',
  ).nodes
  const both = matchNodes(fuzzyNodes, '关注')
  assert.equal(both.matched, 'partial')
  assert.equal(both.candidates.length, 2)

  // 父子同位置只算一个候选
  const nested = compactUiTree(
    '<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][1080,2090]">' +
      '<node class="android.widget.LinearLayout" bounds="[0,1000][1080,1200]" clickable="true">' +
      '<node class="android.widget.TextView" text="展开" bounds="[0,1000][1080,1200]" clickable="true"/>' +
      '</node></node></hierarchy>',
  ).nodes
  assert.equal(matchNodes(nested, '展开').candidates.length, 1)
  console.log('ok 文字匹配不猜')
}

// ---- MC-09：语义化滑动落在安全区，且真的能翻页 ----
{
  const tree = { origin: { x: 0, y: 0 }, width: 1080, height: 2090 }
  const down = scrollGeometry(tree, 'down', 0.6)
  assert.equal(down.fromX, 540)
  assert.ok(down.fromY < 2090 * 0.7, '起滑点必须避开底部芯片/操作栏')
  assert.ok(down.toY < down.fromY)
  assert.ok(down.fromY - down.toY > 2090 * 0.4, '一次要滑够半屏才有意义')

  const up = scrollGeometry(tree, 'up', 0.6)
  assert.ok(up.toY > up.fromY && up.toY <= 2090)

  const left = scrollGeometry(tree, 'left', 0.6)
  assert.equal(left.fromY, 1045)
  assert.ok(left.toX < left.fromX)
  console.log('ok 语义化滑动几何')
}

// ---- MC-08：verify 回执 ----
{
  const dumps = [
    { frameId: 'aaa', nodes: [{ text: '关注', desc: '', center: { x: 1, y: 1 } }] },
    { frameId: 'bbb', nodes: [{ text: '已关注', desc: '', center: { x: 1, y: 1 } }] },
  ]
  let index = 0
  const adapter = {
    async uiDump() {
      return dumps[Math.min(index++, dumps.length - 1)]
    },
  }
  const applied = await verifyAfter(adapter, 'dev-1', { verify_text: '已关注' }, dumps[0])
  assert.equal(applied.result, 'applied')
  assert.equal(applied.frame_id, 'bbb')

  // 界面完全没变 → unchanged
  index = 0
  const stuck = await verifyAfter(adapter, 'dev-1', { verify_text: '已关注', verify_timeout_ms: 0 }, dumps[0])
  assert.equal(stuck.result, 'unchanged')

  // 文字在点击前就已经在了：没法归因给这次点击
  index = 1
  const preexisting = await verifyAfter(adapter, 'dev-1', { verify_text: '已关注' }, dumps[1])
  assert.equal(preexisting.result, 'unchanged')
  assert.match(preexisting.note, /点击前就已经出现/)
  console.log('ok verify 回执')
}

// ---- MC-03：截图裁切与树坐标一致 ----
{
  const width = 8
  const height = 6
  const channels = 4
  const pixels = Buffer.alloc(width * height * channels)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels
      pixels[offset] = x * 8
      pixels[offset + 1] = y * 8
      pixels[offset + 2] = 128
      pixels[offset + 3] = 255
    }
  }
  const png = encodePng({ width, height, channels, pixels })
  const cropped = cropPng(png, { x: 2, y: 1, width: 4, height: 3 })
  const decoded = decodePng(cropped)
  assert.equal(decoded.width, 4)
  assert.equal(decoded.height, 3)
  assert.equal(decoded.colorType, 6)
  // 裁出来的 (0,0) 应该是原图 (2,1)
  assert.equal(decoded.pixels[0], 2 * 8)
  assert.equal(decoded.pixels[1], 1 * 8)
  assert.equal(decoded.pixels[2], 128)

  // 超出图片的部分贴边裁掉
  const clamped = decodePng(cropPng(png, { x: 6, y: 4, width: 100, height: 100 }))
  assert.equal(clamped.width, 2)
  assert.equal(clamped.height, 2)

  // 裁没了要报错，不能给空图
  assert.throws(() => cropPng(png, { x: 100, y: 100, width: 10, height: 10 }), /裁出来是空图/)
  console.log('ok 截图裁切')
}

// ---- MC-03：同一周期抓树 + 抓图，返回 offset 和裁切结果 ----
{
  const width = 1080
  const height = 2310
  const pixels = Buffer.alloc(width * height * 4, 0x7f)
  const png = encodePng({ width, height, channels: 4, pixels })
  const { adapter } = fakeAdapter(
    { png, xml: XML('[0,0][1080,2090]') },
    { uiDumpAttempts: 1 },
  )
  const snapshot = await adapter.uiSnapshot('dev-1', { crop: true })
  assert.deepEqual(snapshot.offset, { x: 0, y: 0 })
  assert.deepEqual(snapshot.treeRect, { x: 0, y: 0, width: 1080, height: 2090 })
  assert.equal(snapshot.cropped, true)
  assert.deepEqual(snapshot.fullSize, { width, height })
  const cropped = decodePng(snapshot.shot.data)
  assert.equal(cropped.width, 1080)
  assert.equal(cropped.height, 2090)
  console.log('ok 同帧抓树 + 抓图')
}

console.log('全部通过')