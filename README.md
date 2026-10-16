# mobile-cli-allinone

由 [xue-ding-e](https://github.com/xue-ding-e) 维护的移动设备自动化工具。以 **CLI 的 `run` / `eval` 为主要脚本入口**，提供原生界面操作、Android WebView CDP 调试和 JSON 流程重放；另提供 MCP 服务供支持 MCP 的客户端使用。

仓库已从 `mobile-mcp-allinone` 更名为 `mobile-cli-allinone`，多平台源码与线性历史已推送到本仓库；以下链接和克隆示例使用当前名称。npm 包名 `@xue-ding-e/mobile-mcp-allinone`、MCP registry ID `io.github.xue-ding-e/mobile-mcp-allinone` 和 `mcp-server-mobile` 命令暂保持兼容，不表示发布了新包。

不同平台有不同的驱动和能力，不能把 Android 命令直接套到其他平台。下表描述当前源码接入情况，不代表已在所有系统、设备和版本上完成真机验收。

## 平台支持与边界

| 目标 | CLI | MCP | 所需驱动与限制 |
| --- | --- | --- | --- |
| Android 真机 / 模拟器 | 已接入原生操作、脚本、流程、WebView | 已接入 | ADB；设备须在线并授权。WebView 需应用开启调试 |
| HarmonyOS / OpenHarmony HDC 目标 | 已接入原生操作、脚本、原生流程 | 已接入设备发现、原生操作和原生流程 | HDC、设备调试授权以及设备侧 UITest / bm / aa 等命令；不是 Android ADB |
| iOS 真机 | 已接入原生操作、脚本、原生流程（`--platform ios`） | 已接入 | go-ios、设备信任/开发配置、WebDriverAgent（WDA）；iOS 17+ 还需 tunnel |
| iOS Simulator | 已接入 Simctl / WDA（`--platform ios-simulator`） | 已接入 mobilecli / agent | macOS / Xcode / 已启动的模拟器；CLI 与 MCP 驱动不同，不能在 Windows / Linux 本机运行 simctl |

- Android 专属：`wv-*`、脚本 `wv`、WebView 流程和 CLI 录屏。没有 iOS Safari / WKWebView 或 HarmonyOS WebView CDP 接入。
- HarmonyOS 支持控件读取、点击/双击/长按/滑动、文字输入、截图、应用启动/停止、签名 HAP 安装/卸载、文件传输与电源操作。长按时长由 UITest 决定，不支持自定义 duration；`url`、设置方向、录屏尚不支持。读取方向根据截图尺寸判断。
- HDC `install` 仅接受 `.hap`，不会把 APK 当 HAP 安装。卓易通等兼容环境里的 APK 导入和手机端安装需要单独处理。
- iOS 真机 WDA 使用本机 `localhost:8100`，iOS 17+ tunnel 检查使用 `60105`。操作前必须确认该端口对应选定设备；固定端口也适用于 CLI 模拟器 WDA，不提供多台 iOS 设备/模拟器并发隔离保证。
- MCP 的设备发现隔离不同驱动的失败；Android / HarmonyOS / iOS 真机的原生操作不要求先安装模拟器用的 mobilecli。MCP 录屏和崩溃报告仍使用 mobilecli，HarmonyOS 不支持这些工具。
- CLI iOS 不支持 `connect`、`wake`、`power-state`、`keep-awake`、文件传输和录屏。WDA 按键仅支持 `HOME`、`VOLUME_UP`、`VOLUME_DOWN`、`ENTER`，不能照搬 Android 的 `BACK`。CLI 与 MCP 的模拟器驱动分别为 Simctl / WDA 与 mobilecli / agent。

## 从源码安装

使用 **Node.js 22 或更高版本**以及 npm。各平台工具需要另行准备，不随此仓库自动完成设备授权、WDA 签名或 Xcode 配置。

```sh
git clone https://github.com/xue-ding-e/mobile-cli-allinone.git
cd mobile-cli-allinone
npm ci
npm run build
node lib/cli.js help
```

以上是本仓库源码安装方式，不假定 npm 包已经发布。修改 TypeScript 源码后重新执行 `npm run build`。

构建后也可把本地 checkout 安装到一个独立目录，使用新 CLI 别名（不修改全局安装）：

```sh
npm install --prefix /path/to/local-install --ignore-scripts /path/to/mobile-cli-allinone
/path/to/local-install/node_modules/.bin/mobile-cli-allinone help
```

将路径替换成实际绝对路径；Windows 使用对应的 `.cmd` 垫片。此别名映射到 `lib/cli.js`；旧 `mcp-server-mobile` 仍映射到 `lib/index.js`。本地安装示例不表示新版已发布到 npm。

所有主机均可用 `node lib/cli.js` 启动 CLI。在 Windows PowerShell 中也可使用仓库垫片：

```powershell
.\mobile.ps1 help
.\mobile.ps1 devices --all
```

CLI 的目标平台由驱动决定；能启动 Node.js 不代表主机具备目标平台的完整工具链。

### 平台前置条件

- **Android**：安装 Android SDK Platform Tools，让 `adb` 可用，或设置 `ANDROID_HOME` 指向 SDK。手机开启调试并确认主机授权；模拟器先启动并确保出现在 `adb devices` 中。无线连接需要设备端预先配置，CLI 不代替配对和授权。
- **HarmonyOS**：安装适合主机的 HDC。可通过 `MOBILE_HDC_PATH` 指定可执行文件完整路径；未设置时，Windows 会尝试 HiSuite 的固定路径，随后回退到 PATH 中的 `hdc`。设备需支持相应 UITest 等命令并已授权。USB 标识和无线 `host:port` 是独立连接目标。
- **iOS 真机**：准备 go-ios，命令默认名为 `ios`，或以 `GO_IOS_PATH` 指定路径。先完成设备信任及所需开发配置、WDA 安装/运行、到本机 8100 的端口转发；iOS 17+ 还需运行 tunnel。程序检查这些前置状态，不会自动替你签名或部署 WDA。不同主机与 iOS 版本组合需自行验收。
- **iOS Simulator**：需要 macOS、Xcode 和已启动（Booted）的模拟器。CLI 用 `xcrun simctl` 发现和管理应用，UI 操作还需本机 8100 的 WDA；已安装 WDA runner 时会尝试启动，但不会自动安装/签名它。MCP 则使用 mobilewright 依赖提供的 mobilecli，可用 `MOBILECLI_PATH` 指定二进制路径，首次原生操作可能检测并安装模拟器 agent。不要将 mobilecli 的跨平台二进制名称理解为 Windows 可运行 iOS Simulator。

## CLI 快速开始

示例中的设备 ID 和包名必须替换为自己的目标。建议先查看设备和界面，再执行会改变应用状态的命令。

```sh
node lib/cli.js devices --platform android --all
node lib/cli.js use ANDROID_SERIAL --platform android --pkg com.example.app
node lib/cli.js state
node lib/cli.js screen-size
node lib/cli.js elements
node lib/cli.js shot ./screen.png
```

`capabilities --platform android|harmony|ios|ios-simulator` 可查看各平台静态能力和依赖（命令中选择一个平台值）；它不检查驱动安装、WDA 状态或设备是否就绪。

`use` 将默认设备、平台和包名写入当前用户的 `~/.mobile-cli/state.json`。命令行 `--device` / `--platform` / `--pkg` 可以覆盖默认值；自动选取唯一在线设备也会更新状态。多设备操作应显式传参，运行前用 `state` 核对旧状态。

HarmonyOS 示例：

```sh
node lib/cli.js devices --platform harmony --all
node lib/cli.js use HDC_TARGET --platform harmony
node lib/cli.js elements
node lib/cli.js launch com.example.app --ability EntryAbility
node lib/cli.js tap-text "设置"
node lib/cli.js shot ./harmony-screen.png
```

已配置无线调试的 HDC 目标可使用 `connect HOST:PORT --platform harmony`。`keep-awake 300`、`keep-awake restore` 以及 `file-send LOCAL REMOTE` / `file-recv REMOTE LOCAL` 是 HarmonyOS 专用扩展；`wake` / `power-state` 同时支持 Android 和 HarmonyOS。文件发送和电源设置会修改目标设备。

iOS 真机示例（已完成 go-ios / WDA / tunnel 前置配置）：

```sh
node lib/cli.js capabilities --platform ios
node lib/cli.js devices --platform ios
node lib/cli.js use IOS_UDID --platform ios
node lib/cli.js elements
node lib/cli.js shot ./ios-screen.png
```

iOS Simulator 示例（仅 macOS，已启动模拟器并配置 WDA）：

```sh
node lib/cli.js devices --platform ios-simulator --all
node lib/cli.js use SIMULATOR_UUID --platform ios-simulator
node lib/cli.js launch com.example.app
node lib/cli.js eval "return await robot.getScreenSize()"
```

`--all` 可显示未启动的模拟器，不代表它可以立即执行操作。CLI 不会自动创建/启动模拟器，也不会创建 iOS 无线连接或部署 WDA。模拟器安装使用适配模拟器的 `.app`，也支持顶层包含 `.app` 的 `.zip`；不能将真机 IPA 当作模拟器应用通用安装。

### 一次脚本完成多个步骤

`run <script.js>` 执行脚本文件；`eval "<js>"` 执行内联脚本。两者注入 `robot`、`device`、`platform`、`sleep`、`flows`、`wv`，以及平台专用的 `adb` / `hdc`。`robot` 的接口定义见 [src/robot.ts](src/robot.ts)。

```sh
node lib/cli.js eval "return await robot.getScreenSize()"
node lib/cli.js run ./inspect.js --platform android --device ANDROID_SERIAL
```

`inspect.js` 示例（脚本体可直接 `await` / `return`）：

```js
const size = await robot.getScreenSize();
const elements = await robot.getElementsOnScreen();
return { device, platform, size, elements: elements.slice(0, 10) };
```

脚本默认超时为 120 秒，可用 `--timeout 30` 调整。超时不是事务回滚，也不保证撤销已开始的设备动作。`run` / `eval` 在本机 Node.js 进程执行，不是安全沙箱；只运行你已审查、信任的脚本。

普通结果输出紧凑 JSON；`help` 输出文本，失败诊断输出到 stderr。截图命令将图片写入指定文件；自行编写脚本时，应显式保存二进制结果，不要依赖 JSON 输出携带图片。

### 原生命令与 Android WebView

常用原生命令：`apps`、`launch`、`stop`、`install`、`uninstall`、`tap`、`longpress`、`doubletap`、`tap-text`、`swipe`、`key`、`button`、`shot`、`elements`、`screen-size`、`orientation`。命令能否执行以平台支持矩阵为准；完整参数见 `help` 和 [src/cli.ts](src/cli.ts)。

WebView 只连接目标 Android 应用中已开启调试的页面，不会自动开启应用调试：

```sh
node lib/cli.js wv-pages --platform android --device ANDROID_SERIAL --pkg com.example.app
node lib/cli.js wv-outline --platform android --device ANDROID_SERIAL --pkg com.example.app
node lib/cli.js wv-style body --props color,font-size --platform android --device ANDROID_SERIAL --pkg com.example.app
node lib/cli.js wv-eval "document.title" --platform android --device ANDROID_SERIAL --pkg com.example.app
```

另有 `wv-tap-text`、`wv-shot`、`wv-net`。单命令自动连接并断开，脚本中的 `wv` 延迟到首次使用时连接。页面 JavaScript 受设备 WebView 引擎版本限制；老引擎可能不支持可选链等语法。网络记录、DOM、截图可能包含敏感信息。

### JSON 流程重放

流程是步骤数组，原生步骤复用当前平台的 Robot。下面只记录一条说明并截图：

```json
[
  { "op": "log", "note": "Capture current screen" },
  { "op": "screenshot", "saveTo": "./screen.png" }
]
```

将其保存为 `inspect.json` 后：

```sh
node lib/cli.js flow-run ./inspect.json --platform harmony --device HDC_TARGET
node lib/cli.js flow-list
node lib/cli.js flow-save inspect ./inspect.json
```

默认在失败步骤停止；`--keep-going` 会继续后续步骤，可能继续产生副作用，不等于回滚。支持步骤与参数见 [src/flows.ts](src/flows.ts)，WebView 步骤与断言仅适用于 Android。

具名流程默认存于仓库 `flows/`，也可通过 `MOBILEMCP_FLOWS_DIR` 指向个人目录。个人回放、截图和现场脚本建议放入已忽略的 `ignore/`；不要把私有账号、业务内容或凭据提交到公共流程。

## MCP：另一种调用入口

CLI 使用 `lib/cli.js`；MCP 使用 **`lib/index.js`**。两者不是同一启动命令。构建后，在 MCP 客户端配置中填入本机绝对路径：

```json
{
  "mcpServers": {
    "mobile-cli-allinone": {
      "command": "node",
      "args": ["/absolute/path/to/mobile-cli-allinone/lib/index.js"],
      "env": {
        "MOBILEMCP_DISABLE_TELEMETRY": "1"
      }
    }
  }
}
```

Windows 路径可写成 `D:/path/to/mobile-cli-allinone/lib/index.js`。默认使用 stdio。客户端可从 `mobile_list_available_devices` 开始，再按工具列表调用原生操作、截图、Android WebView 或流程工具；不要假定 CLI 与 MCP 的命令和驱动完全相同：MCP 没有 CLI 的 `run` / `eval` 命令，也没有独立的 HDC 文件传输、电源管理命令；原生流程可调用已支持的平台 Robot，WebView 流程仅 Android。

可选 HTTP **SSE** 模式：

```sh
node lib/index.js --listen localhost:3000
```

端点为 `http://localhost:3000/mcp`；这是 SSE transport，不是 Streamable HTTP。默认监听 localhost，当前实现仅允许一个活动 SSE 客户端。设置 `MOBILEMCP_AUTH` 后，客户端必须发送相应的 `Authorization: Bearer …`。未设置时没有认证；不要直接暴露到公网，也不要将 token 写进命令示例或仓库。

MCP 服务保留上游 PostHog 使用统计逻辑；设置 `MOBILEMCP_DISABLE_TELEMETRY=1` 可关闭，上述配置已关闭统计。

## 安全与验证范围

- 仅操作你有权控制的设备。安装/卸载、输入、点击、URL、脚本、流程和测试都可能改变应用状态、发送消息或触发交易；执行前核对设备、应用和步骤。
- 此工具不代替使用者或调用它的 agent 做授权判断。MCP 客户端应限制不受信任内容触发设备操作。
- 不提交设备截图、调试日志、令牌、签名文件或个人流程；调试工具及端口只开放给可信主机。更多见 [SECURITY.md](SECURITY.md)。
- 平台矩阵表示源码具备的接入路径。自动化测试、构建成功不等于真机验证；设备型号、OS 版本、中文输入、权限弹窗、应用兼容层、WDA 签名/tunnel 和无线连接需要在自己的环境单独验收。

开发检查：

```sh
npm run build
npm run lint
npx tsc --noEmit
npm run test:offline
```

`test:offline` 先构建，再仅运行 PNG、Harmony、ADB 安装结果、CLI iOS 路由、WDA 错误处理和 MCP 平台路由这六个解析/模拟执行器测试文件，不自动发现或操作设备。**不要在不了解测试内容时直接运行 `npm test`**：默认套件包含 Android / iOS / 模拟器测试，可能读取或改变已连接设备，部分测试在收集阶段就调用平台工具。

问题反馈：[Issues](https://github.com/xue-ding-e/mobile-cli-allinone/issues)。请附提交版本、主机系统、目标平台及脱敏复现信息，区分“源码已实现”“模拟测试通过”和“真机已验证”。

## 许可与来源

本项目基于 Mobile Next 的 mobile-mcp 开发，保留 Apache-2.0 许可证和适用的原始版权声明，详见 [LICENSE](LICENSE)。`CHANGELOG.md` 中早于本分支的版本记录属于上游历史。Android DeviceKit、mobilewright 等依赖保留各自的名称和来源。
