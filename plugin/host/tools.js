const KEY_NAMES = [
  'back',
  'home',
  'recents',
  'enter',
  'power',
  'volumeUp',
  'volumeDown',
  'mediaPause',
  'mediaPlay',
  'mediaPlayPause',
  'delete',
  'tab',
  'escape',
]
const ACTIONS = ['tap', 'swipe', 'scroll', 'type', 'key', 'launch', 'stop']
const DIRECTIONS = ['up', 'down', 'left', 'right']
const DETAIL_FIELDS = [
  'index',
  'parentIndex',
  'class',
  'text',
  'desc',
  'resourceId',
  'bounds',
  'center',
  'clickable',
  'enabled',
  'scrollable',
  'checked',
]

function sessionIdOf(exec) {
  const id = exec?.agent?.id
  if (!id) throw new Error('这个工具只能在会话里调用。')
  return id
}

function asText(value, limit = 8000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text
}

function textOutput(schema, limit = 8000) {
  return { schema, render: (_args, value) => [{ type: 'text', text: asText(value, limit) }] }
}

/** 带分类码的错误：message 里也写一遍，上层只看 message 也不会丢类型。 */
function fail(code, message) {
  const error = new Error(`[${code}] ${message}`)
  error.code = code
  return error
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const DEVICE_ID = {
  type: 'string',
  description: '设备 id（adb serial）。省略时使用当前会话已认领的设备；若未认领且仅有一台空闲设备，则自动认领该设备。',
}

const PAUSE_ON_IDLE = {
  type: 'boolean',
  description: '读树遇到「等不到界面空闲」时，是否先发一次媒体暂停（keyevent 127）再试。默认 true。',
}

const PAUSE_FIRST = {
  type: 'boolean',
  description:
    '先发一次媒体暂停（keyevent 127）再读，省掉 10s 的空闲等待。已知当前是视频/直播页时用它。默认 false。',
}

/** 内部读树用的选项：默认把图标类可点节点也带上。 */
function dumpOptions(args = {}) {
  return {
    includeAllClickable: args.include_all_clickable !== false,
    compact: args.compact !== false,
    pauseOnIdle: args.pause_on_idle !== false,
    pauseFirst: args.pause_first === true,
  }
}

/** 坐标去重：同一个位置的父子节点只留一个，避免把「一个按钮」当成多个候选。 */
function dedupeByCenter(nodes) {
  const seen = new Set()
  const unique = []
  for (const node of nodes) {
    if (!node.center) continue
    const key = `${node.center.x},${node.center.y}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(node)
  }
  return unique
}

/**
 * 在 UI 树里按文字找节点。
 * 精确匹配优先；没有精确匹配时才用子串匹配（`exact` 时不做子串匹配）。不做「猜」。
 */
export function matchNodes(nodes, query, { exact = false } = {}) {
  const needle = String(query).trim().toLowerCase()
  const exactHits = []
  const partialHits = []
  for (const node of nodes) {
    const text = node.text.toLowerCase()
    const desc = node.desc.toLowerCase()
    if (text === needle || desc === needle) {
      exactHits.push(node)
      continue
    }
    if (exact) continue
    if ((text && text.includes(needle)) || (desc && desc.includes(needle))) partialHits.push(node)
  }
  const uniqueExact = dedupeByCenter(exactHits)
  if (uniqueExact.length > 0) return { candidates: uniqueExact, matched: 'exact' }
  const uniquePartial = dedupeByCenter(partialHits)
  return { candidates: uniquePartial, matched: uniquePartial.length > 0 ? 'partial' : 'none' }
}

function describeNode(node) {
  const label = node.text || node.desc || '(无文案)'
  return `(${node.center.x},${node.center.y}) ${node.class.split('.').pop()} ${JSON.stringify(label)} ${node.bounds}`
}

function ambiguousError(query, matched, candidates) {
  const lines = candidates.slice(0, 6).map((node, index) => `  ${index + 1}) ${describeNode(node)}`)
  if (candidates.length > 6) lines.push(`  …共 ${candidates.length} 个`)
  return fail(
    'ambiguous',
    `「${query}」命中 ${candidates.length} 个节点（${matched === 'exact' ? '完全相同' : '包含'}匹配），未执行点击：\n` +
      `${lines.join('\n')}\n` +
      '请改用候选里的 x/y 精确点击，或换一个更唯一的文字（exact: true 只做完全相同匹配）。',
  )
}

function assertFrame(expect, dump) {
  if (!expect) return
  if (expect === dump.frameId) return
  throw fail(
    'stale_frame',
    `界面已经变了（期望 frame_id ${expect}，实际 ${dump.frameId}），本次操作没有执行。` +
      '请重新调用 mobile_ui 读树后再操作——用旧坐标点新页面正是误进付费页/误关注的原因。',
  )
}

/** 树的指纹：主内容区（文案+坐标）变了就算翻页/滚动成功。 */
function treeSignature(dump) {
  return dump.nodes.map((node) => `${node.center.x},${node.center.y},${node.text},${node.desc}`).join('|')
}

export function scrollGeometry(tree, direction, ratio) {
  const x0 = tree.origin?.x ?? 0
  const y0 = tree.origin?.y ?? 0
  const width = tree.width > 0 ? tree.width : 1080
  const height = tree.height > 0 ? tree.height : 2310
  const vertical = direction === 'up' || direction === 'down'
  const span = vertical ? height : width
  const travel = Math.round(span * 0.9 * ratio)
  if (vertical) {
    const x = Math.round(x0 + width / 2)
    if (direction === 'down') {
      // 手指上滑（看下一屏）：从 65% 高度起，避开底部「相关搜索」芯片和右侧操作栏。
      const fromY = Math.round(y0 + height * 0.65)
      return { fromX: x, fromY, toX: x, toY: Math.max(Math.round(y0 + height * 0.06), fromY - travel) }
    }
    const fromY = Math.round(y0 + height * 0.35)
    return { fromX: x, fromY, toX: x, toY: Math.min(Math.round(y0 + height * 0.94), fromY + travel) }
  }
  const y = Math.round(y0 + height / 2)
  if (direction === 'left') {
    const fromX = Math.round(x0 + width * 0.85)
    return { fromX, fromY: y, toX: Math.max(Math.round(x0 + width * 0.06), fromX - travel), toY: y }
  }
  const fromX = Math.round(x0 + width * 0.15)
  return { fromX, fromY: y, toX: Math.min(Math.round(x0 + width * 0.94), fromX + travel), toY: y }
}

/** 动作后确认结果：不额外调用工具，tap 自己把「成没成」判定出来。 */
export async function verifyAfter(adapter, deviceId, args, beforeDump) {
  const wanted = typeof args.verify_text === 'string' ? args.verify_text.trim() : ''
  if (!wanted) return null
  const gone = args.verify_gone === true
  const timeout = Number.isFinite(args.verify_timeout_ms) ? args.verify_timeout_ms : 4000
  const needle = wanted.toLowerCase()
  const present = (dump) =>
    dump.nodes.some(
      (node) => node.text.toLowerCase().includes(needle) || node.desc.toLowerCase().includes(needle),
    )
  if (!gone && beforeDump && present(beforeDump)) {
    return {
      result: 'unchanged',
      note: `「${wanted}」在点击前就已经出现，无法判断是不是这次点击带来的。`,
      frame_id: beforeDump.frameId,
    }
  }
  const startedAt = Date.now()
  let last = null
  for (;;) {
    last = await adapter.uiDump(deviceId, dumpOptions(args))
    if (present(last) !== gone) {
      return { result: 'applied', waitedMs: Date.now() - startedAt, frame_id: last.frameId }
    }
    const spent = Date.now() - startedAt
    if (spent >= timeout) break
    await sleep(Math.min(800, Math.max(0, timeout - spent)))
  }
  const unchanged = Boolean(beforeDump) && last.frameId === beforeDump.frameId
  return {
    result: unchanged ? 'unchanged' : 'timeout',
    waitedMs: Date.now() - startedAt,
    frame_id: last.frameId,
    note: unchanged
      ? '界面完全没变：这个点击大概没生效（点在空白/不可点区域）。'
      : `界面变了，但「${wanted}」${gone ? '仍然存在' : '没有出现'}。`,
  }
}

function detailOf(node, fields) {
  const detail = {}
  for (const field of fields) detail[field] = node[field]
  return detail
}

export function registerTools(ctx, { registry }) {
  const tools = []

  tools.push({
    name: 'mobile_devices',
    description:
      '列出当前已连接的设备及占用状态。claimedBy 为 free 表示可认领，me 表示当前会话已占用，其它值表示由其他会话占用。',
    parameters: { type: 'object', properties: {} },
    output: textOutput({ type: 'object' }),
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      await registry.refresh(true)
      // 设备详情/租约字段可能是 undefined，而工具结果通道只收无损 JSON，会整条拒收。
      return JSON.parse(JSON.stringify(registry.view(sessionIdOf(exec))))
    },
  })

  tools.push({
    name: 'mobile_use',
    description:
      '将一台设备分配给当前会话。同一设备同一时间只能由一个会话操作。仅连接一台设备时可省略 deviceId。',
    parameters: {
      type: 'object',
      properties: { deviceId: DEVICE_ID },
    },
    output: textOutput({ type: 'object' }),
    async execute(args, exec) {
      const device = await registry.resolve(sessionIdOf(exec), args?.deviceId)
      return { ok: true, deviceId: device.id, platform: device.platform, model: device.model }
    },
  })

  tools.push({
    name: 'mobile_release',
    description: '释放当前会话占用的设备，使其他会话可以认领该设备。',
    parameters: { type: 'object', properties: {} },
    output: textOutput({ type: 'object' }),
    async execute(_args, exec) {
      const deviceId = registry.release(sessionIdOf(exec))
      return { ok: true, released: deviceId ?? null }
    },
  })

  tools.push({
    name: 'mobile_screenshot',
    description: [
      '截取并返回当前设备的屏幕图像。执行操作前后均应截图，以确认当前界面和操作结果。',
      'with_ui=true：同一周期内先读树再截图，一次拿到「图 + 节点文本 + frame_id」，消除「图旧树新」。',
      'crop_system_bars=true：把截图裁成 UI 树的覆盖范围（去掉底部系统导航栏），图上的像素和树坐标 1:1。',
      '不裁时返回 offset/screen/treeSpace：截图是整屏，树只覆盖前台窗口，两者原点相同、底部差系统栏高度。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        deviceId: DEVICE_ID,
        with_ui: { type: 'boolean', description: '同时读取 UI 树，一次返回图和节点文本。默认 false。' },
        crop_system_bars: {
          type: 'boolean',
          description: '把截图裁成 UI 树范围（去掉系统栏），让图像像素与树坐标一致。默认 false。',
        },
        pause_on_idle: PAUSE_ON_IDLE,
        pause_first: PAUSE_FIRST,
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const lines = [`设备 ${value.deviceId} 的屏幕截图（${value.width}×${value.height}）`]
        if (value.cropped) {
          lines.push(
            `已裁成 UI 树范围：原图 ${value.fullSize.width}×${value.fullSize.height}，` +
              `去掉系统栏 ${value.fullSize.height - value.height}px。图上坐标可直接当树坐标用。`,
          )
        } else if (value.treeSpace) {
          lines.push(
            `截图 ${value.width}×${value.height}；UI 树覆盖 ${value.treeSpace}，` +
              `offset=(${value.offset.x},${value.offset.y})：截图底部多出来的部分是系统导航栏，树里没有节点。` +
              '图上坐标与树坐标原点相同，可直接用。',
          )
        }
        if (value.cropError) lines.push(`裁切失败，已返回原图：${value.cropError}`)
        if (value.frame_id) lines.push(`frame_id=${value.frame_id}（可传给 mobile_action 的 expect_frame 防误点）`)
        if (value.text) lines.push('', value.text)
        return [
          { type: 'text', text: lines.join('\n') },
          { type: 'image', attachment: value.image },
        ]
      },
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const device = await registry.resolve(sessionIdOf(exec), args?.deviceId)
      const adapter = device.adapter
      const wantsTree = args?.with_ui === true
      const crop = args?.crop_system_bars === true
      const wantsSnapshot = (wantsTree || crop) && typeof adapter.uiSnapshot === 'function'

      let shot
      let dump = null
      let offset = null
      let treeRect = null
      let cropped = false
      let cropError = null
      let fullSize = null
      if (wantsSnapshot) {
        const snapshot = await adapter.uiSnapshot(device.id, {
          crop,
          pauseOnIdle: args?.pause_on_idle !== false,
          pauseFirst: args?.pause_first === true,
        })
        shot = snapshot.shot
        dump = snapshot.dump
        offset = snapshot.offset
        treeRect = snapshot.treeRect
        cropped = snapshot.cropped
        cropError = snapshot.cropError
        fullSize = snapshot.fullSize
      } else {
        shot = await adapter.screenshot(device.id)
        if (crop) cropError = '当前平台不支持裁切（目前只有 Android 会裁系统栏），已返回整屏图。'
      }

      const image = await ctx.attachments.saveImage({
        data: shot.data,
        mediaType: shot.mediaType,
        name: `${device.id}-${Date.now()}.png`,
      })
      const lastFrame = typeof adapter.lastFrame === 'function' ? adapter.lastFrame(device.id) : null
      return {
        ok: true,
        deviceId: device.id,
        width: image.width,
        height: image.height,
        cropped,
        ...(cropError ? { cropError } : {}),
        ...(fullSize ? { fullSize } : {}),
        screen: dump?.screen ?? null,
        treeSpace: dump ? `${dump.width}×${dump.height}` : lastFrame ? `${lastFrame.width}×${lastFrame.height}` : null,
        offset: offset ?? (lastFrame ? { x: lastFrame.origin.x, y: lastFrame.origin.y } : null),
        treeRect,
        // 树是本次同周期抓的，还是上一次成功读到的（附年龄，让上层决定信不信）。
        frame_id: dump?.frameId ?? lastFrame?.frameId ?? null,
        tree_age_ms: dump ? 0 : lastFrame?.ageMs ?? null,
        ...(dump ? { foreground: dump.foreground ?? null, activity: dump.activity ?? null } : {}),
        ...(dump ? { text: dump.text, nodes: dump.nodes.length } : {}),
        image,
      }
    },
  })

  tools.push({
    name: 'mobile_ui',
    description: [
      '读取当前界面的可操作节点列表（文本、描述和点击坐标），适合进行精确定位。',
      '返回的坐标与 mobile_action tap 使用同一坐标空间，可直接使用。',
      '默认包含「没有文案但可点」的节点（图标类 UI 靠它定位），文本里标 [可点]。',
      '返回 frame_id：把它传给 mobile_action 的 expect_frame，界面变了就不会照着旧坐标点。',
      '视频/直播这类动画页面，uiautomator 等不到空闲时会先自动暂停一次媒体再试；仍失败会返回带分类码的错误。',
      '已知当前是视频页时传 pause_first: true，可以省掉一次 10s 的空闲等待。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        deviceId: DEVICE_ID,
        include_all_clickable: {
          type: 'boolean',
          description: '包含无文案但可点的节点（图标/头像/列表项）。默认 true；只看有文案的节点时设 false。',
        },
        compact: {
          type: 'boolean',
          description: '剔除纯布局容器（无文案、不可点、无 id）。默认 true。',
        },
        fields: {
          type: 'array',
          items: { type: 'string', enum: DETAIL_FIELDS },
          description:
            '同时返回结构化的 nodes_detail，只带这些字段（例如 ["text","bounds","clickable"]）。字段越多越费 token。',
        },
        pause_on_idle: PAUSE_ON_IDLE,
        pause_first: PAUSE_FIRST,
      },
    },
    output: textOutput({ type: 'object' }, 16000),
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const device = await registry.resolve(sessionIdOf(exec), args?.deviceId)
      const adapter = device.adapter
      const fields = Array.isArray(args?.fields) ? args.fields : []
      const unknown = fields.filter((field) => !DETAIL_FIELDS.includes(field))
      if (unknown.length > 0) {
        throw fail('bad_field', `未知字段 ${unknown.join('、')}，可用：${DETAIL_FIELDS.join(' / ')}`)
      }

      const lastFrame = typeof adapter.lastFrame === 'function' ? adapter.lastFrame(device.id) : null
      // 失败时抛 UiDumpError，message 里已经带分类码/前台/耗时，直接透给调用方。
      const dump = await adapter.uiDump(device.id, dumpOptions(args))
      const clickable = dump.nodes.filter((node) => node.clickable).length
      return {
        ok: true,
        deviceId: device.id,
        frame_id: dump.frameId,
        // 本次之前，上一次成功读到的树是多久以前的（上层决定要不要用它兜底）。
        last_ok_ms_ago: lastFrame?.ageMs ?? null,
        foreground: dump.foreground ?? null,
        package: dump.foregroundPackage ?? dump.treePackage ?? null,
        activity: dump.activity ?? null,
        focus_source: dump.focusSource ?? null,
        // 树的覆盖范围（通常比屏幕小，不含导航栏）；bounds 仍是屏幕绝对坐标。
        treeSpace: dump.width && dump.height ? `${dump.width}×${dump.height}` : null,
        tree_origin: dump.origin,
        screen: dump.screen ? `${dump.screen.width}×${dump.screen.height}` : null,
        elapsedMs: dump.elapsedMs,
        attempts: dump.attempts,
        nodes: dump.nodes.length,
        clickable,
        xml_bytes: dump.bytes,
        media: { paused: dump.mediaPaused === true, state: dump.mediaState ?? 'unknown' },
        ...(dump.warning === 'splash'
          ? { warning: '当前前台还是启动页，节点可能不全；稍等一下再读一次。' }
          : {}),
        ...(dump.spaceMismatch
          ? {
              warning:
                `UI 树范围 ${dump.spaceMismatch.tree.width}×${dump.spaceMismatch.tree.height} ` +
                `比屏幕 ${dump.spaceMismatch.screen.width}×${dump.spaceMismatch.screen.height} 还大：` +
                '坐标空间可能被放大过，别直接点；先用 scripts/ui-probe.mjs 校准。',
            }
          : {}),
        ...(dump.nodes.length === 0 && dump.totalNodes > 0
          ? {
              warning:
                `树里有 ${dump.totalNodes} 个节点，但没有一个有文案或可点（纯视频/画布页面）。` +
                '坐标仍然可用：用 mobile_screenshot 看图，或用 scroll/swipe 换页。',
            }
          : {}),
        text: dump.text,
        ...(fields.length > 0
          ? { nodes_detail: dump.nodes.map((node) => detailOf(node, fields)) }
          : {}),
      }
    },
  })

  tools.push({
    name: 'mobile_action',
    description: [
      '操作手机。action 取值：',
      'tap（点按：x/y 坐标，或 text 按界面文本定位；命中多个候选时返回 ambiguous 不猜）、',
      'swipe（原始坐标：fromX/fromY/toX/toY，可选 durationMs）、',
      'scroll（语义化滑动：direction=up/down/left/right，ratio 默认 0.6，在安全区内起滑并返回 scrolled 是否真的翻页）、',
      'type（输入 text，需先聚焦输入框；非 ASCII 走 yadb）、',
      `key（提供 key，取值 ${KEY_NAMES.join('/')}）、`,
      'launch / stop（提供 target 包名，例如 com.android.settings）。',
      'tap 支持 expect_frame（界面变了就拒绝执行，防旧坐标误点）和 verify_text（点完自己确认结果，不用再读树）。',
      '操作完成后建议调用 mobile_screenshot 验证结果。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS },
        deviceId: DEVICE_ID,
        x: { type: 'number', description: 'tap 的横坐标' },
        y: { type: 'number', description: 'tap 的纵坐标' },
        text: { type: 'string', description: 'tap 时是要找的界面文字；type 时是要输入的内容' },
        fromX: { type: 'number' },
        fromY: { type: 'number' },
        toX: { type: 'number' },
        toY: { type: 'number' },
        durationMs: { type: 'number', description: 'swipe/scroll 持续时间，默认 300' },
        direction: { type: 'string', enum: DIRECTIONS, description: 'scroll 的方向，默认 down' },
        ratio: { type: 'number', description: 'scroll 的滑动幅度占屏高/屏宽的比例，默认 0.6' },
        key: { type: 'string', enum: KEY_NAMES },
        target: { type: 'string', description: 'launch / stop 的包名' },
        exact: { type: 'boolean', description: 'tap text 时只做完全相同匹配（默认允许包含匹配）。' },
        expect_frame: {
          type: 'string',
          description: 'mobile_ui/screenshot 返回的 frame_id。与当前界面不一致时拒绝执行并返回 stale_frame。',
        },
        verify_text: { type: 'string', description: 'tap 之后应出现的界面文字（或应消失的文字，配合 verify_gone）。' },
        verify_gone: { type: 'boolean', description: 'verify_text 是「应消失」时为 true。默认 false。' },
        verify_timeout_ms: { type: 'number', description: 'verify 的等待上限，默认 4000。' },
        pause_on_idle: PAUSE_ON_IDLE,
        pause_first: PAUSE_FIRST,
      },
      required: ['action'],
    },
    output: textOutput({ type: 'object' }),
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const action = args?.action
      if (!ACTIONS.includes(action)) throw new Error(`不支持的操作类型：${action}`)
      const device = await registry.resolve(sessionIdOf(exec), args?.deviceId)
      const adapter = device.adapter
      const expectFrame = typeof args.expect_frame === 'string' ? args.expect_frame : ''
      const directions = args.direction === undefined ? 'down' : args.direction
      if (action === 'scroll' && !DIRECTIONS.includes(directions)) {
        throw new Error(`scroll 的 direction 只能是 ${DIRECTIONS.join('/')}，当前值：${args.direction}`)
      }

      if (action === 'tap') {
        const hasPoint = Number.isFinite(args.x) && Number.isFinite(args.y)
        const hasText = typeof args.text === 'string' && args.text !== ''
        if (!hasPoint && !hasText) {
          throw new Error('tap 操作需要提供 x/y 坐标，或提供用于定位界面文本的 text。')
        }
        // 坐标定位只在校验 frame 时才读树；按文字定位本来就要读。
        const needsDump = hasText || Boolean(expectFrame)
        const before = needsDump ? await adapter.uiDump(device.id, dumpOptions(args)) : null
        if (before) assertFrame(expectFrame, before)

        let point = null
        let matched = null
        if (hasText) {
          const { candidates, matched: kind } = matchNodes(before.nodes, args.text, {
            exact: args.exact === true,
          })
          if (candidates.length === 0) {
            throw fail(
              'not_found',
              `界面中未找到「${args.text}」（前台 ${before.foreground ?? '未知'}，` +
                `${before.nodes.length} 个可定位节点，匹配方式 ${args.exact === true ? '完全相同' : '包含'}）。` +
                '请先调用 mobile_ui 获取节点列表。',
            )
          }
          if (candidates.length > 1) throw ambiguousError(args.text, kind, candidates)
          point = candidates[0].center
          matched = candidates[0].text || candidates[0].desc
        } else {
          point = { x: Math.round(args.x), y: Math.round(args.y) }
        }

        await adapter.tap(device.id, point.x, point.y)
        const verify = await verifyAfter(adapter, device.id, args, before)
        return {
          ok: true,
          deviceId: device.id,
          action,
          ...point,
          ...(matched ? { matched } : {}),
          ...(before ? { frame_was: before.frameId } : {}),
          ...(verify ? { verify } : {}),
        }
      }

      if (action === 'swipe') {
        const coords = [args.fromX, args.fromY, args.toX, args.toY]
        if (coords.some((value) => !Number.isFinite(value))) {
          throw new Error('swipe 操作需要提供 fromX、fromY、toX 和 toY。')
        }
        if (expectFrame) {
          const before = await adapter.uiDump(device.id, dumpOptions(args))
          assertFrame(expectFrame, before)
        }
        await adapter.swipe(device.id, args.fromX, args.fromY, args.toX, args.toY, args.durationMs ?? 300)
        const verify = await verifyAfter(adapter, device.id, args, null)
        return { ok: true, deviceId: device.id, action, ...(verify ? { verify } : {}) }
      }

      if (action === 'scroll') {
        const ratio = Math.min(0.95, Math.max(0.1, Number.isFinite(args.ratio) ? Number(args.ratio) : 0.6))
        const before = await adapter.uiDump(device.id, dumpOptions(args))
        assertFrame(expectFrame, before)
        const geometry = scrollGeometry(before, directions, ratio)
        await adapter.swipe(
          device.id,
          geometry.fromX,
          geometry.fromY,
          geometry.toX,
          geometry.toY,
          args.durationMs ?? 280,
        )
        const after = await adapter.uiDump(device.id, dumpOptions(args))
        return {
          ok: true,
          deviceId: device.id,
          action,
          direction: directions,
          ratio,
          ...geometry,
          // 前后树一样 = 这一下没翻动（滑到顶/底，或手势被浮层吃掉）。
          scrolled: treeSignature(before) !== treeSignature(after),
          before_frame: before.frameId,
          after_frame: after.frameId,
        }
      }

      // 只做「帧校验」的动作（type / key / launch / stop）：给了 expect_frame 就必须先对一下。
      const checkFrameOnly = async () => {
        if (!expectFrame) return
        const dump = await adapter.uiDump(device.id, dumpOptions(args))
        assertFrame(expectFrame, dump)
      }

      if (action === 'type') {
        if (typeof args.text !== 'string') throw new Error('type 操作需要提供 text。')
        await checkFrameOnly()
        const result = await adapter.text(device.id, args.text)
        return {
          ok: true,
          deviceId: device.id,
          action,
          length: args.text.length,
          ...(result ? { method: result.method } : {}),
        }
      }

      if (action === 'key') {
        if (!args.key) throw new Error(`key 操作需要提供 key，可选值为 ${KEY_NAMES.join('/')}。`)
        await checkFrameOnly()
        await adapter.key(device.id, args.key)
        return { ok: true, deviceId: device.id, action, key: args.key }
      }

      if (!args.target) throw new Error(`${action} 操作需要提供 target 包名。`)
      await checkFrameOnly()
      if (action === 'launch') await adapter.launch(device.id, args.target)
      else await adapter.stop(device.id, args.target)
      return { ok: true, deviceId: device.id, action, target: args.target }
    },
  })

  ctx.effect(() => {
    const disposers = tools.map((tool) => ctx.tools.register(tool))
    return () => disposers.forEach((dispose) => dispose())
  }, 'mobile-control: tools')
}