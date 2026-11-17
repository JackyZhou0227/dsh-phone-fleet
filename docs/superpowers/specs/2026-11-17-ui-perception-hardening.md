# UI 感知与动作加固（PLUGIN-REQUESTS 落地）

**目标：** 按 `PLUGIN-REQUESTS.md` 的 12 条建议，把「看得见 / 点得准 / 知道成没成 / 出错能区分」这四件事补进插件，同时不把业务语义带进来。

**实测设备：** HUAWEI VCE-AL00（Android 10 / 1080×2310，USB），2026-11-17。

**Tech Stack：** Node.js ESM、adb shell、node:zlib（PNG 裁切）、断言式离线测试 + 真机脚本。

---

## 一、逐条结论

| 编号 | 结论 | 落点 |
| --- | --- | --- |
| MC-01 等不到空闲 | **无法从插件侧关掉** uiautomator 内置的 10s idle 等待（`DumpCommand` 里写死，`uiautomator dump` 没有对应开关，UiAutomator2 的 `waitForIdleTimeout` 需要额外 APK）。改为：失败时发一次 127 暂停媒体再试，成功就记住这个窗口「下次先暂停」；失败则再发一次还原，并返回分类错误。 | `android.js` `pauseMedia/resumeMedia/unstableWindows` |
| MC-02 只返回有文案的节点 | 解析器改成能追踪父子关系的扫描器；`include_all_clickable`（默认开）把无文案可点节点列进来，文本标 `[可点]`；`fields` 可返回结构化 `nodes_detail`。 | `parseUiNodes/compactUiTree` |
| MC-03 图树不同空间 | 树原点 = 根节点 bounds，截图与树原点相同、底部差系统导航栏高度；`offset/screen/treeSpace` 一并返回；`crop_system_bars` 用内置 PNG 裁切把图裁成树范围（像素与树坐标 1:1）；`with_ui` 在同一把设备锁里先抓树再抓图。 | `png.js`、`uiSnapshot` |
| MC-04 没有帧校验 | 每帧 `frame_id = sha1(xml)[0:12]`；`mobile_action` 的 `expect_frame` 不匹配即拒绝执行（`stale_frame`），不点。 | `frameIdOf`、`assertFrame` |
| MC-05 前台滞后 | 改为优先 `mCurrentFocus`，取不到退回 `mResumedActivity`，并返回 `package` / `activity` / `focus_source`。**实测抖音的窗口标题确实一直是 `SplashActivity`**：主界面就挂在启动页窗口里，不是插件读错；判页要看树内容而不是 Activity 名。 | `foregroundInfo` |
| MC-06 多命中静默取第一个 | 精确匹配优先，其次包含匹配；同一位置父子节点去重；仍多于一个就返回 `ambiguous` + 候选 bounds，不点。**「消息」这类有精确命中时取精确命中的那个**（底部导航），只有「全是包含命中」才报 ambiguous。 | `matchNodes/ambiguousError` |
| MC-07 按键太少 | 补 `mediaPause/mediaPlay/mediaPlayPause/delete/tab/escape`；媒体键同步更新暂停状态。 | `KEY_CODES`、`key()` |
| MC-08 动作没回执 | `tap` 支持 `verify_text` / `verify_gone` / `verify_timeout_ms`，返回 `applied` / `unchanged` / `timeout`；点击前文案就已存在时明确说明无法归因。 | `verifyAfter` |
| MC-09 滑动无语义 | 新增 `scroll(action, direction, ratio)`：在树高的 65% 处起滑、按比例位移、避开底部芯片区，返回 `scrolled`（比较前后树指纹）。 | `scrollGeometry` |
| MC-10 中文输入 | 非 ASCII 走 yadb；注入失败抛 `[ime_unsupported]`，不再静默输入空串。 | `text()` |
| MC-11 并发没排队 | 已有按设备串行锁，新增队列上限（`uiQueueLimit`），超出直接 `busy`，避免排到工具超时。 | `exclusive` |
| MC-12 用量读数 | 属 harness 而非插件：插件侧没有上下文/费用数据源。 | — |

## 二、接口变化

- `mobile_ui`：新增 `frame_id`、`last_ok_ms_ago`、`package`/`activity`/`focus_source`、`screen`、`tree_origin`、`clickable`、`xml_bytes`、`media`；参数 `include_all_clickable`、`compact`、`fields`、`pause_on_idle`。
- `mobile_action`：新增 `scroll` 动作与 `direction`/`ratio`；`tap` 新增 `exact`、`expect_frame`、`verify_text`、`verify_gone`、`verify_timeout_ms`；`key` 枚举扩到 13 个。
- `mobile_screenshot`：新增 `with_ui`、`crop_system_bars`，返回 `offset`/`screen`/`treeSpace`/`frame_id`/`tree_age_ms`。
- 错误统一带 `[code]` 前缀：`idle_timeout` / `device_offline` / `dump_timeout` / `xml_missing` / `xml_empty` / `stale_frame` / `ambiguous` / `not_found` / `bad_field` / `busy` / `ime_unsupported`。

## 三、实测数据（VCE-AL00）

| 项 | 结果 |
| --- | --- |
| 信息流页连续读树 10 次 | 10/10 成功，2.2–3.4s（原报告 10.9–15.5s 失败） |
| 直播页连续读树 5 次 | 5/5 成功，2.5–3.7s；本机未复现 idle 超时，救援逻辑由离线测试覆盖 |
| 节点数（信息流页，树内 302） | 72 个（47 有文案 + 25 无文案可点）；旧口径 66 个 |
| 截图 vs 树 | 原图 1080×2310，树 1080×2090，offset=(0,0)，裁后 1080×2090；裁切结果与 Pillow 的同区域裁切逐像素一致 |
| `expect_frame` 传旧 frame | 返回 `[stale_frame]`，未执行点击 |
| `tap text="搜索"` | 2 个候选 → `[ambiguous]`，未执行点击 |
| `scroll down ratio=0.6` | 1359→230，`scrolled=true` ×3，仍停在原 App |
| `verify_text` 见证文案 | `applied`（3862ms）；见证文案不存在 → `timeout`，不谎报 |
| 并发 3 次读树 | 全部成功、frame 一致、串行 12s |
| 中文输入（设置搜索「蓝牙」） | yadb 注入成功，界面文本出现 |

## 四、明确没做

- 内置「识别某类内容/账号」「固定坐标」「批量关注/私信」「判定规则/话术库」：按要求留在上层，插件只提供感知/动作/回执。
- 「每次 dump 前必发 127」：仍不做，只做失败后的一次性救援 + 状态记忆。
- harness 用量读数（MC-12）：不在插件职责内。