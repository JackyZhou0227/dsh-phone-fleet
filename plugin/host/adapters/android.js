import { createHash } from 'node:crypto'
import { run } from '../exec.js'
import { Provisioner } from '../provision.js'
import { cropPng, isPng } from '../png.js'
import { requireVendor } from '../vendor.js'

const KEY_CODES = {
  back: 4,
  home: 3,
  recents: 187,
  enter: 66,
  power: 26,
  volumeUp: 24,
  volumeDown: 25,
  // 127 是让「一直在播」的页面静下来的通用手段；但它是切换语义，用之前必须先确认状态。
  mediaPause: 127,
  mediaPlay: 126,
  mediaPlayPause: 85,
  delete: 67,
  tab: 61,
  escape: 111,
}
// 这些键会换页：之前记下的「媒体已暂停」不再可信，下次卡住时要重新发一次。
const NAVIGATION_KEYS = new Set([4, 3, 187])
const ASCII_ONLY = /^[\t\n\r\x20-\x7e]*$/
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const YADB_DEVICE_PATH = '/data/local/tmp/yadb'
const REMOTE_TMP = '/data/local/tmp'
// 每次 dump 用独立文件名：失败时不会读到上一轮（甚至上一次会话）留下的旧树。
let dumpSequence = 0
// 冷启动时前台可能还停在启动页；只在树明显为空时才提示，别把正常的启动页残留当成空树。
const SPLASH_PATTERN = /splash|welcome|guide|launchscreen|startup/i
// 树里节点少到这个程度，才值得怀疑「抓到的是启动页」。
const SPARSE_TREE_NODES = 3
const MAX_UI_LINES = 400

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 把 adb/run 抛出的各种原文归到固定几类，调用方才能按类型决定下一步。 */
export function classifyDumpFailure(message) {
  const text = String(message ?? '')
  if (/could not get idle state|idle state/i.test(text)) return 'idle_timeout'
  if (/device .*offline|no devices|device not found|unauthorized|offline/i.test(text)) return 'device_offline'
  if (/超时|timed out|timeout/i.test(text)) return 'dump_timeout'
  if (/no such file|not found/i.test(text)) return 'xml_missing'
  return 'dump_failed'
}

const DUMP_CODE_HINT = {
  idle_timeout:
    'uiautomator 等界面「空闲」超时（约 10s）。视频/直播这类页面的无障碍事件一直不停。' +
    '插件已经自动试过「发一次 127 暂停媒体再读」；如果还是失败，说明这页不是媒体在动' +
    '（加载骨架、进度条、广告倒计时等），也可能 127 把暂停的页面又切成了播放。' +
    '下一步：先 mobile_action key=mediaPause 把画面停住再读（能省掉 10s），' +
    '或换到静态页面；也可以用 mobile_screenshot 先看清是什么页面。',
  dump_timeout: 'uiautomator dump 在超时时间内没返回。',
  device_offline: 'adb 连不上设备：检查 USB 线、USB 调试授权，或运行 adb devices。',
  xml_missing: 'dump 没有生成文件（通常是 dump 失败，或被其他 uiautomator 进程打断）。',
  xml_empty: 'dump 生成了空文件，或内容不是 uiautomator 的 XML。',
  dump_failed: 'uiautomator dump 报错。',
}

/**
 * dump 失败时抛这个：带分类码和上下文，别再让调用方只看一句「没拿到 hierarchy」。
 * 上层工具会直接把 message 透给模型，所以 message 里要写清「是什么、为什么、下一步」。
 */
export class UiDumpError extends Error {
  constructor(code, info = {}) {
    const { detail = '', foreground, elapsedMs, attempts = 1, xmlBytes, mediaToggled } = info
    const context = [
      foreground ? `前台 ${foreground}` : '',
      Number.isFinite(elapsedMs) ? `耗时 ${elapsedMs}ms` : '',
      attempts > 1 ? `尝试 ${attempts} 次` : '',
      mediaToggled === true ? '已试过暂停媒体' : '',
      Number.isFinite(xmlBytes) ? `${xmlBytes} 字节` : '',
    ]
      .filter(Boolean)
      .join('，')
    const extra = detail ? ` 原始信息：${String(detail).trim().slice(0, 200)}` : ''
    super(
      `UI 树读取失败[${code}]：${DUMP_CODE_HINT[code] ?? DUMP_CODE_HINT.dump_failed}` +
        `${context ? `（${context}）` : ''}${extra}`,
    )
    this.name = 'UiDumpError'
    this.code = code
    this.details = { ...info }
  }
}

/** 单引号包一层，内部单引号按 sh 规则断开再拼。 */
function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** 取属性值。必须带边界，否则 `clickable` 会先命中 `long-clickable`。 */
function attr(source, name) {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(source)?.[1] ?? ''
}

const BOUNDS = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/

/** `[x1,y1][x2,y2]` → 中心点。 */
function centerOf(bounds) {
  const match = BOUNDS.exec(bounds)
  if (!match) return undefined
  const [x1, y1, x2, y2] = match.slice(1, 5).map(Number)
  if (x2 <= x1 || y2 <= y1) return undefined // 零尺寸=不在屏幕上，点它等于点 (0,0)
  return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) }
}

/**
 * 把 uiautomator 的 XML 解析成扁平节点数组（带 parentIndex）。
 *
 * 用扫描器而不是「整段正则找节点」：要追踪父子关系，才能知道某个可点容器下面是否已经有可点子节点，
 * 否则同一次点击会在树里出现两遍。
 */
export function parseUiNodes(xml) {
  const nodes = []
  const stack = []
  let width = 0
  let height = 0
  let origin = { x: 0, y: 0 }
  let treePackage = ''
  const token = /<node\b([^>]*?)(\/?)>|<\/node>/g
  let match
  while ((match = token.exec(xml))) {
    if (match[0] === '</node>') {
      stack.pop()
      continue
    }
    const attrs = match[1]
    const rect = BOUNDS.exec(attr(attrs, 'bounds'))
    const geometry = rect
      ? {
          left: Number(rect[1]),
          top: Number(rect[2]),
          right: Number(rect[3]),
          bottom: Number(rect[4]),
        }
      : null
    const node = {
      index: nodes.length,
      parentIndex: stack.length > 0 ? stack[stack.length - 1] : -1,
      class: attr(attrs, 'class'),
      text: attr(attrs, 'text'),
      desc: attr(attrs, 'content-desc'),
      resourceId: attr(attrs, 'resource-id'),
      packageName: attr(attrs, 'package'),
      clickable: attr(attrs, 'clickable') === 'true',
      enabled: attr(attrs, 'enabled') !== 'false',
      scrollable: attr(attrs, 'scrollable') === 'true',
      checkable: attr(attrs, 'checkable') === 'true',
      checked: attr(attrs, 'checked') === 'true',
      selected: attr(attrs, 'selected') === 'true',
      password: attr(attrs, 'password') === 'true',
      bounds: attr(attrs, 'bounds'),
      rect: geometry ?? undefined,
      center: centerOf(attr(attrs, 'bounds')),
    }
    if (geometry) {
      width = Math.max(width, geometry.right)
      height = Math.max(height, geometry.bottom)
    }
    // 第一个（根）节点的左上角就是这棵树的坐标原点：截图裁切要用它换算。
    if (nodes.length === 0) {
      treePackage = node.packageName
      if (geometry) origin = { x: geometry.left, y: geometry.top }
    }
    nodes.push(node)
    if (match[2] !== '/') stack.push(nodes.length - 1)
  }
  return { nodes, width, height, origin, treePackage }
}

function shortClass(name) {
  return name.split('.').pop() || 'Node'
}

/**
 * 挑出要展示的节点，并压成「一行一个可点节点」的文本。
 *
 * includeAllClickable：把「没有文案但可点」的节点也带上（图标类 UI 只能靠它定位）。
 * compact：容器和它的可点子节点「完全同范围」时只保子节点（点父等于点子，列两遍只会让模型犹豫）。
 */
export function compactUiTree(xml, options = {}) {
  const includeAllClickable = options.includeAllClickable === true
  const compact = options.compact !== false
  const maxLines = options.maxLines ?? MAX_UI_LINES
  const parsed = parseUiNodes(xml)
  const { nodes } = parsed
  // 与可点子节点完全同范围的容器：保留子节点就够了，父节点点下去是同一块区域。
  const sameRectAsClickableChild = new Uint8Array(nodes.length)
  for (const node of nodes) {
    if (!node.clickable || !node.rect) continue
    let parent = node.parentIndex
    while (parent >= 0) {
      const ancestor = nodes[parent]
      if (
        ancestor.clickable &&
        ancestor.rect &&
        ancestor.rect.left === node.rect.left &&
        ancestor.rect.top === node.rect.top &&
        ancestor.rect.right === node.rect.right &&
        ancestor.rect.bottom === node.rect.bottom
      ) {
        sameRectAsClickableChild[parent] = 1
      }
      parent = ancestor.parentIndex
    }
  }

  const selected = []
  let truncated = false
  for (const node of nodes) {
    if (!node.center) continue
    const labeled = Boolean(node.text || node.desc)
    if (!labeled) {
      if (!node.clickable) continue
      // 旧行为：带 resource-id 的可点节点一直都列；新行为再放开「所有可点节点」。
      if (!includeAllClickable && !node.resourceId) continue
      if (compact && sameRectAsClickableChild[node.index]) continue
    }
    if (selected.length >= maxLines) {
      truncated = true
      continue
    }
    selected.push(node)
  }

  const lines = selected.map((node) => {
    const parts = [`[${node.center.x},${node.center.y}]`, shortClass(node.class)]
    if (node.text) parts.push(JSON.stringify(node.text))
    if (node.desc) parts.push(`desc=${JSON.stringify(node.desc)}`)
    if (node.resourceId) parts.push(`id=${node.resourceId}`)
    if (node.clickable && !node.text && !node.desc) parts.push('[可点]')
    if (node.scrollable) parts.push('[可滚]')
    return parts.join(' ')
  })
  if (truncated) lines.push('…（节点过多，已截断）')
  return {
    text: lines.join('\n'),
    nodes: selected,
    totalNodes: nodes.length,
    width: parsed.width,
    height: parsed.height,
    origin: parsed.origin,
    treePackage: parsed.treePackage,
  }
}

/** 树的指纹：同一帧的 frame_id 相同，翻页/弹层/滚动都会变。 */
function frameIdOf(xml) {
  return createHash('sha1').update(xml).digest('hex').slice(0, 12)
}

export class AndroidAdapter {
  constructor(config, provision) {
    this.platform = 'android'
    this.provision = provision ?? new Provisioner(config)
    this.uiDumpTimeoutMs = config.uiDumpTimeoutMs ?? 20000
    this.uiDumpAttempts = Math.max(1, config.uiDumpAttempts ?? 2)
    this.pauseOnIdle = config.pauseOnIdle !== false
    this.yadbReady = new Set()
    this.adbPath = null
    // uiautomator 是进程级单例：同一台机上并发 dump 会互相打断，这里按设备串行。
    this.locks = new Map()
    this.queues = new Map()
    this.maxQueue = Math.max(1, config.uiQueueLimit ?? 6)
    // 每台设备最近一次成功的树：frame_id、树空间、时间戳。用于 frame_id 校验和「上次成功多久前」。
    this.frames = new Map()
    // 媒体暂停状态：127 是切换语义，必须自己记，否则每两次读失败一次。
    this.media = new Map()
  }

  /**
   * 同一设备的操作排队执行。dump 之间会互相打断；点在 dump 中间也会让树和真实界面对不上。
   * 队列太长直接回 busy：排队排到工具超时，调用方只会看到一句「超时」，分不清是自己排太久还是设备卡住。
   */
  exclusive(deviceId, task) {
    const waiting = this.queues.get(deviceId) ?? 0
    if (waiting >= this.maxQueue) {
      return Promise.reject(
        new Error(
          `[busy] 设备 ${deviceId} 上已经有 ${waiting} 个操作在排队（上限 ${this.maxQueue}）。` +
            'uiautomator 是单例，同一台机只能串行；等前面的调用返回后再试，别并发堆操作。',
        ),
      )
    }
    this.queues.set(deviceId, waiting + 1)
    const previous = this.locks.get(deviceId) ?? Promise.resolve()
    const current = previous.then(task, task)
    const settled = current.catch(() => {})
    this.locks.set(deviceId, settled)
    const release = () => {
      if (this.locks.get(deviceId) === settled) this.locks.delete(deviceId)
      const left = (this.queues.get(deviceId) ?? 1) - 1
      if (left <= 0) this.queues.delete(deviceId)
      else this.queues.set(deviceId, left)
    }
    return current.finally(release)
  }

  /** adb 第一次真要用时才定下来：缺了就按需下载，之后复用。 */
  async adb() {
    if (!this.adbPath) this.adbPath = await this.provision.ensureAdb()
    return this.adbPath
  }

  async call(deviceId, args, timeout) {
    const adb = await this.adb()
    return run(adb, ['-s', deviceId, ...args], { timeout })
  }

  async list() {
    const adb = await this.adb()
    const output = (await run(adb, ['devices', '-l'], { timeout: 10000 })).toString('utf8')
    const devices = []
    for (const line of output.split(/\r?\n/)) {
      const match = /^(\S+)\s+(\S+)(.*)$/.exec(line.trim())
      if (!match || match[1] === 'List') continue
      const [, id, state, rest] = match
      devices.push({
        id,
        platform: 'android',
        model: /model:(\S+)/.exec(rest)?.[1] ?? id,
        state: state === 'device' ? 'online' : state,
      })
    }
    return devices
  }

  /** 设备详情：型号之外的系统、分辨率、连接方式。变化很慢，由 registry 缓存。 */
  async details(deviceId) {
    const raw = (
      await this.call(
        deviceId,
        [
          'shell',
          [
            'getprop ro.product.brand',
            'getprop ro.build.version.release',
            'getprop ro.build.version.sdk',
            'wm size',
            'wm density',
          ].join('; '),
        ],
        15000,
      )
    )
      .toString('utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    const brand = raw[0] || undefined
    const version = raw[1] || undefined
    const sdk = Number(raw[2]) || undefined
    const sizeLine = raw.find((line) => /Override size:/i.test(line)) ?? raw.find((line) => /size:/i.test(line))
    const densityLine = raw.find((line) => /density:/i.test(line))
    const size = sizeLine ? /(\d+)\s*x\s*(\d+)/.exec(sizeLine) : null
    const density = densityLine ? /(\d+)/.exec(densityLine.split(':')[1] ?? '') : null

    return {
      os: 'Android',
      osVersion: version,
      brand,
      sdk,
      width: size ? Number(size[1]) : undefined,
      height: size ? Number(size[2]) : undefined,
      density: density ? Number(density[1]) : undefined,
      connection: deviceId.includes(':') ? 'wifi' : 'usb',
    }
  }

  async screenshot(deviceId) {
    const direct = await this.call(deviceId, ['exec-out', 'screencap', '-p'])
    if (direct.subarray(0, 4).equals(PNG_MAGIC)) {
      return { data: direct, mediaType: 'image/png' }
    }

    // 部分老设备 exec-out 会改写字节，退回文件 + cat。
    const remote = `${REMOTE_TMP}/dsh-mobile-shot.png`
    await this.call(deviceId, ['shell', `screencap -p ${remote}`])
    const viaFile = await this.call(deviceId, ['exec-out', `cat ${remote}`])
    this.call(deviceId, ['shell', `rm -f ${remote}`]).catch(() => {})
    if (!viaFile.subarray(0, 4).equals(PNG_MAGIC)) throw new Error('截图失败：返回的不是 PNG 数据')
    return { data: viaFile, mediaType: 'image/png' }
  }

  /** 当前屏幕的坐标空间（wm size 的 Override 优先，就是输入事件用的那套）。 */
  async screen(deviceId) {
    const raw = (await this.call(deviceId, ['shell', 'wm size'], 10000)).toString('utf8')
    const physical = /Physical size:\s*(\d+)\s*x\s*(\d+)/i.exec(raw)
    const override = /Override size:\s*(\d+)\s*x\s*(\d+)/i.exec(raw)
    const current = override ?? physical
    if (!current) return null
    return {
      width: Number(current[1]),
      height: Number(current[2]),
      physical: physical ? { width: Number(physical[1]), height: Number(physical[2]) } : null,
      override: Boolean(override),
    }
  }

  /**
   * 前台窗口是哪个。
   *
   * `mCurrentFocus` 比 `mResumedActivity` 更新得快（弹层、同 App 内跳页会立刻反映），
   * 拿不到再退回 Activity 栈。两个都拿不到就返回 undefined —— 前台未知不等于 dump 失败。
   */
  async foregroundInfo(deviceId) {
    try {
      const output = (
        await this.call(
          deviceId,
          ['shell', "dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -4"],
          10000,
        )
      ).toString('utf8')
      const focus = /mCurrentFocus=Window\{\S+ \S+ ([A-Za-z][\w.]*)\/([\w.$]+)\}/.exec(output)
      if (focus) {
        return { package: focus[1], activity: focus[2], source: 'focus' }
      }
    } catch {
      // 老机型没有 grep、或 dumpsys 被限权：继续走 Activity 栈。
    }
    try {
      const output = (
        await this.call(deviceId, ['shell', 'dumpsys activity activities | grep -m1 mResumedActivity'], 10000)
      ).toString('utf8')
      const match = /mResumedActivity:.*?([A-Za-z][\w.]*)\/([\w.$]+)/.exec(output)
      if (match) return { package: match[1], activity: match[2], source: 'resumed' }
    } catch {
      // 同上。
    }
    return undefined
  }

  /** 兼容旧调用点：`包名/类名` 字符串。 */
  async foreground(deviceId) {
    const info = await this.foregroundInfo(deviceId)
    return info ? `${info.package}/${info.activity}` : undefined
  }

  /** 冷启动可能还停在启动页。只作为提示，不阻塞 dump（抖音等应用会长期挂着 SplashActivity）。 */
  isSplashLike(foreground) {
    return Boolean(foreground && SPLASH_PATTERN.test(foreground.split('/')[1] ?? ''))
  }

  /** 每台设备最近一次成功的树（含 age），给上层判断「能不能先用旧的」。 */
  lastFrame(deviceId) {
    const frame = this.frames.get(deviceId)
    if (!frame) return null
    return { ...frame, ageMs: Date.now() - frame.at }
  }

  mediaState(deviceId) {
    return this.media.get(deviceId) ?? 'unknown'
  }

  /** 换页之后「已暂停」不再可信：下次卡住要重新发一次 127。 */
  noteNavigation(deviceId) {
    this.media.delete(deviceId)
  }

  /**
   * 让页面上的媒体静止。
   *
   * 127 在短视频类 App 上是「切换」语义（暂停后再发会恢复播放，导致每两次读失败一次），
   * 所以只在自认为「还没暂停」时发一次，并记住状态。
   */
  async pauseMedia(deviceId) {
    if (this.media.get(deviceId) === 'paused') return { sent: false, state: 'paused' }
    await this.call(deviceId, ['shell', 'input keyevent 127'], 15000)
    this.media.set(deviceId, 'paused')
    return { sent: true, state: 'paused' }
  }

  /** 恢复播放（同上：只在自认为「没在播」时发）。 */
  async resumeMedia(deviceId) {
    if (this.media.get(deviceId) === 'playing') return { sent: false, state: 'playing' }
    await this.call(deviceId, ['shell', 'input keyevent 127'], 15000)
    this.media.set(deviceId, 'playing')
    return { sent: true, state: 'playing' }
  }

  async tap(deviceId, x, y) {
    const px = Math.round(Number(x))
    const py = Math.round(Number(y))
    if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error('tap 坐标必须是数字')
    const screen = await this.screen(deviceId).catch(() => null)
    // 坐标超出屏幕就别点了：静默点偏正是「误赞/误回复」的来源。
    if (screen && (px < 0 || py < 0 || px > screen.width || py > screen.height)) {
      throw new Error(
        `tap 坐标 (${px}, ${py}) 超出屏幕范围 ${screen.width}×${screen.height}。` +
          'mobile_ui 返回的坐标可以直接用；如果手动换算过，注意别重复换算。',
      )
    }
    await this.exclusive(deviceId, () =>
      this.call(deviceId, ['shell', `input tap ${px} ${py}`], 15000),
    )
    this.noteNavigation(deviceId)
  }

  async swipe(deviceId, fromX, fromY, toX, toY, durationMs = 300) {
    const points = [fromX, fromY, toX, toY].map((value) => Math.round(Number(value)))
    if (points.some((value) => !Number.isFinite(value))) throw new Error('swipe 坐标必须是数字')
    const screen = await this.screen(deviceId).catch(() => null)
    if (screen) {
      const outside = points.some((value, index) =>
        index % 2 === 0 ? value < 0 || value > screen.width : value < 0 || value > screen.height,
      )
      if (outside) {
        throw new Error(
          `swipe 坐标超出屏幕范围 ${screen.width}×${screen.height}：${points.join(', ')}。`,
        )
      }
    }
    await this.exclusive(deviceId, () =>
      this.call(deviceId, [
        'shell',
        `input swipe ${points[0]} ${points[1]} ${points[2]} ${points[3]} ${Math.round(Number(durationMs) || 300)}`,
      ], 15000),
    )
    this.noteNavigation(deviceId)
  }

  async text(deviceId, value) {
    if (typeof value !== 'string' || value === '') throw new Error('要输入的文字不能为空')
    if (ASCII_ONLY.test(value)) {
      await this.call(deviceId, ['shell', `input text ${quote(value)}`])
      return { method: 'input' }
    }
    // `input text` 只认 ASCII，中文/emoji 走 yadb 注入。
    try {
      await this.ensureYadb(deviceId)
      const payload = quote(value.replace(/\n/g, '\\n'))
      await this.call(deviceId, [
        'shell',
        `app_process -Djava.class.path=${YADB_DEVICE_PATH} /data/local/tmp com.ysbing.yadb.Main -keyboard ${payload}`,
      ])
      return { method: 'yadb' }
    } catch (error) {
      // 静默输入空串最危险：上层以为输入了，实际什么都没进去。
      throw new Error(
        `[ime_unsupported] 这段文字含非 ASCII 字符，需要 yadb 注入，但注入失败：${error.message}。` +
          '先确认设备已授权、/data/local/tmp 可写；也可以改成只输入 ASCII 文字。',
      )
    }
  }

  async ensureYadb(deviceId) {
    if (this.yadbReady.has(deviceId)) return
    const present = (
      await this.call(deviceId, ['shell', `[ -f ${YADB_DEVICE_PATH} ] && echo yes || echo no`])
    )
      .toString('utf8')
      .includes('yes')
    if (!present) {
      await this.call(deviceId, ['push', requireVendor('yadb'), YADB_DEVICE_PATH], 60000)
    }
    this.yadbReady.add(deviceId)
  }

  async key(deviceId, name) {
    const code = KEY_CODES[name]
    if (code === undefined) {
      throw new Error(`不支持的按键 ${name}，可用：${Object.keys(KEY_CODES).join(' / ')}`)
    }
    await this.call(deviceId, ['shell', `input keyevent ${code}`])
    // 媒体键同样要记状态，别让「暂停/播放」和 dump 的救援逻辑互相踩。
    if (name === 'mediaPause') this.media.set(deviceId, 'paused')
    else if (name === 'mediaPlay') this.media.set(deviceId, 'playing')
    else if (name === 'mediaPlayPause') this.media.delete(deviceId)
    else if (NAVIGATION_KEYS.has(code)) this.noteNavigation(deviceId)
    return { key: name, code }
  }

  async launch(deviceId, target) {
    if (!/^[A-Za-z][\w.]*$/.test(target)) {
      throw new Error(`launch 操作需要应用包名（例如 com.android.settings），当前值为：${target}`)
    }
    await this.call(deviceId, [
      'shell',
      `monkey -p ${target} -c android.intent.category.LAUNCHER 1`,
    ])
    this.noteNavigation(deviceId)
  }

  async stop(deviceId, target) {
    if (!/^[A-Za-z][\w.]*$/.test(target)) {
      throw new Error(`stop 操作需要应用包名，当前值为：${target}`)
    }
    await this.call(deviceId, ['shell', `am force-stop ${target}`])
    this.noteNavigation(deviceId)
  }

  /**
   * 读一次界面树。
   *
   * 四件事必须做对，否则会静默给出错坐标：
   * 1. 每次用独立文件、并且先删再 dump —— 失败时绝不把旧树当本次结果；
   * 2. 失败要分类（idle / 掉线 / 空文件 / 超时），别统一报「没拿到 hierarchy」；
   * 3. dump 串行化 —— uiautomator 是单例，并发会互相打断；
   * 4. 空闲超时就发一次 127（媒体暂停）重读一次；成功后如实记状态，失败再发一次还原。
   *    「上次已暂停」的记忆不能拦住救援：App 会自己恢复播放。
   */
  async uiDump(deviceId, options = {}) {
    const attempts = Math.max(1, options.attempts ?? this.uiDumpAttempts)
    return this.exclusive(deviceId, () => this.dumpWithRetry(deviceId, attempts, options))
  }

  async dumpWithRetry(deviceId, attempts, options = {}) {
    const startedAt = Date.now()
    const info = await this.foregroundInfo(deviceId)
    const foreground = info ? `${info.package}/${info.activity}` : undefined
    const allowPause = (options.pauseOnIdle ?? this.pauseOnIdle) !== false
    // 127 是「切换」语义：一次读树最多动它一次，而且**不受「上次已暂停」的记忆阻挡**。
    // 记忆只说明上一帧停过；App 自己恢复播放（翻页自动播、视频循环、用户点了播放）之后照样会卡住，
    // 之前就是被这条假记忆挡住救援，才会一直报 idle_timeout 且一次 127 都没发。
    let mediaToggled = false
    if (allowPause && options.pauseFirst === true) {
      // 调用方已经知道这是视频页：先暂停，省掉一次 10s 白等。
      const paused = await this.pauseMedia(deviceId)
      mediaToggled = paused.sent
    }

    let lastError = null
    let attemptsMade = 0
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      attemptsMade = attempt
      try {
        const tree = await this.dumpOnce(deviceId, options)
        const screen = await this.screen(deviceId).catch(() => null)
        // 注意：树只覆盖前台窗口，通常不含导航栏，所以「比屏幕小」是正常的。
        // 只有「比屏幕还大」才说明坐标空间被放大过，这时绝不能直接点。
        const oversized =
          screen && (tree.width > screen.width || tree.height > screen.height) ? screen : null
        const splashLike = this.isSplashLike(foreground)
        const frame = {
          frameId: tree.frameId,
          at: Date.now(),
          width: tree.width,
          height: tree.height,
          origin: tree.origin,
          treePackage: tree.treePackage,
          nodes: tree.nodes.length,
          totalNodes: tree.totalNodes,
          foreground,
        }
        this.frames.set(deviceId, frame)
        // 靠暂停才读出来的这一帧：媒体现在确实是停的，如实记下来。
        if (mediaToggled) this.media.set(deviceId, 'paused')
        return {
          ...tree,
          screen,
          foreground,
          activity: info?.activity,
          foregroundPackage: info?.package,
          focusSource: info?.source,
          attempts: attempt,
          elapsedMs: Date.now() - startedAt,
          mediaPaused: this.mediaState(deviceId) === 'paused',
          mediaState: this.mediaState(deviceId),
          warning: splashLike && tree.totalNodes <= SPARSE_TREE_NODES ? 'splash' : undefined,
          spaceMismatch: oversized
            ? {
                tree: { width: tree.width, height: tree.height },
                screen: { width: oversized.width, height: oversized.height },
              }
            : undefined,
        }
      } catch (error) {
        if (!(error instanceof UiDumpError)) throw error
        lastError = error
        if (error.code === 'idle_timeout') {
          if (allowPause && !mediaToggled) {
            // 再试一次：先发 127。短视频/直播页暂停后通常就能读到。
            mediaToggled = true
            this.media.delete(deviceId)
            await this.call(deviceId, ['shell', 'input keyevent 127'], 15000)
            continue
          }
          if (allowPause && mediaToggled) {
            // 暂停了也读不出来：这页不是媒体在动。把 127 再发一次还原成调用前的状态，
            // 别把用户的视频一直停着；状态清掉，下一轮重新判断。
            this.media.delete(deviceId)
            await this.call(deviceId, ['shell', 'input keyevent 127'], 15000).catch(() => {})
          }
          // 空闲超时是确定性的：同一页面状态重复等只会再白等 10s（实测重试全部失败）。
          break
        }
        if (attempt < attempts) await sleep(600)
      }
    }
    throw new UiDumpError(lastError.code, {
      ...lastError.details,
      foreground,
      attempts: attemptsMade,
      elapsedMs: Date.now() - startedAt,
      mediaToggled,
    })
  }

  /**
   * 同一周期内「抓树 + 抓图」：先树后图，中间不放任何点击，消除「图旧树新」。
   * 需要裁系统栏时顺手把截图裁成和树一致的那块。
   */
  async uiSnapshot(deviceId, options = {}) {
    const attempts = Math.max(1, options.attempts ?? this.uiDumpAttempts)
    return this.exclusive(deviceId, async () => {
      const dump = await this.dumpWithRetry(deviceId, attempts, options)
      const shot = await this.screenshot(deviceId)
      const offset = { x: dump.origin?.x ?? 0, y: dump.origin?.y ?? 0 }
      const rect = { ...offset, width: dump.width, height: dump.height }
      let data = shot.data
      let cropped = false
      let cropError = null
      if (options.crop === true) {
        if (!isPng(shot.data)) {
          cropError = '截图不是 PNG，无法裁切'
        } else {
          try {
            data = cropPng(shot.data, rect)
            cropped = true
          } catch (error) {
            cropError = error.message
          }
        }
      }
      return {
        dump,
        shot: { data, mediaType: shot.mediaType },
        offset,
        treeRect: rect,
        cropped,
        cropError,
        fullSize: isPng(shot.data)
          ? { width: shot.data.readUInt32BE(16), height: shot.data.readUInt32BE(20) }
          : null,
      }
    })
  }

  async dumpOnce(deviceId, options = {}) {
    const remote = `${REMOTE_TMP}/dsh-ui-${process.pid}-${(++dumpSequence).toString(36)}.xml`
    try {
      await this.call(deviceId, ['shell', `rm -f ${remote}`], 10000).catch(() => {})
      let output = ''
      try {
        // `2>&1` 不能省：uiautomator 的 ERROR 走 stderr，不合并就会把 idle 超时误判成空文件。
        output = (
          await this.call(deviceId, ['shell', `uiautomator dump ${remote} 2>&1`], this.uiDumpTimeoutMs)
        ).toString('utf8')
      } catch (error) {
        throw new UiDumpError(classifyDumpFailure(error.message), { detail: error.message })
      }
      // uiautomator 失败时通常仍然退出码 0，只在输出里留一句 ERROR。
      if (/could not get idle state/i.test(output)) {
        throw new UiDumpError('idle_timeout', { detail: output })
      }
      if (/\bERROR\b/.test(output)) {
        throw new UiDumpError(classifyDumpFailure(output), { detail: output })
      }

      let xml = ''
      try {
        xml = (await this.call(deviceId, ['exec-out', `cat ${remote}`], 20000)).toString('utf8')
      } catch (error) {
        throw new UiDumpError('xml_missing', { detail: error.message })
      }
      if (!xml.trim()) throw new UiDumpError('xml_empty', { detail: 'dump 文件为空', xmlBytes: 0 })
      if (!xml.includes('<hierarchy')) {
        throw new UiDumpError('xml_empty', { detail: '内容不是 hierarchy', xmlBytes: xml.length })
      }
      const tree = compactUiTree(xml, {
        includeAllClickable: options.includeAllClickable !== false,
        compact: options.compact !== false,
        maxLines: options.maxLines,
      })
      return { ...tree, frameId: frameIdOf(xml), bytes: xml.length }
    } finally {
      // 文件名唯一，这里不用等它完成，也不会误删下一轮的文件。
      this.call(deviceId, ['shell', `rm -f ${remote}`]).catch(() => {})
    }
  }
}