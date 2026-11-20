# AeroMind｜智航纪元

AeroMind 是面向计算机视觉课堂的本地三维配送应用。Three.js/WebGL2 渲染风格化近未来城市和独立机载相机，Python、OpenCV 与 CPU 版 PyTorch 处理实际像素。产品要求、五阶段课程及最终验收标准见 [PLAN.md](PLAN.md)。

## 启动

当前 Windows 工作区双击 **Start-AeroMind.cmd**。浏览器打开本机服务后，选“图书馆 · 屋顶站台”，点击“开始配送”。服务只监听回环地址。关闭启动器命令窗口即可停止服务。

新机器首次安装时需要 Python 3.11、Node.js/npm 和支持 WebGL2 的 Edge 或 Chrome。依赖、模型和三维资产就绪后可断网使用。仓库根目录执行以下命令。

```powershell
py -3.11 -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
npm ci
.venv/Scripts/python.exe -m aeromind.app --open
```

| 安装分类 | 当前集显设备 |
| --- | --- |
| 必须 | WebGL2 浏览器、本地视觉服务和 npm 锁定的 Three.js。当前工作区已配置。 |
| 推荐 | 修改美术时使用 `tools/art/requirements.txt` 中的网格与预览工具。 |
| 本轮无需安装 | UE、Unity、Visual Studio、CUDA、ROS 2、PX4。专业仿真仅供独立对照。 |

只保留一个服务进程。如果已有服务运行，可直接访问 [本机应用](http://127.0.0.1:8765)。通过 `--port` 可指定其他端口。

## 课堂操作

- **下单与飞行**。选择图书馆或居民站。飞行器需要起飞、沿公开三维通道航行、读取指定站点面板，收到站台接触回执后返仓。右侧查看相机原图、距离、定位来源与延迟。
- **现场挑战**。在飞行前或飞行中加入施工障碍、摆动吊臂、站台占用或通道限飞。限飞规则是公开约束，普通施工事件只能经机载深度与视觉进入决策。关闭 GPS 可观察视觉跟踪质量。手动接管时使用 WASD 平移和 Q/E 升降。
- **认知与协作**。点击“认知”检查已观测体素与估计轨迹，第五章启用两架无人机。协作面板可切换观测对象，时间轴记录占用消息、接收和航路变化。
- **实验与证据**。比较主动观察开关时，两次运行采用相同初始位置、随机种子和施工时间，各自重新拍摄画面。导出的 JSON 包含运行环境、真实关键帧、估计轨迹、事件、等待和配送指标。

## 感知、建图与美术

机载相机在固定仿真时刻渲染 320×180 RGB 和米制平面深度（厘米量化），旁观镜头及界面标记不进入取帧。局部服务矫正标牌后运行卷积网络，使用稀疏光流、双向匹配和 RGB-D 对应估计位移。视觉几何与模拟惯性朝向对齐。体素保留观测时间和占用证据。位姿真值用于误差评测与物理接触，模拟 GPS 开启时添加观测噪声。

城市、站点及无人机使用原创 glTF 模型。暖白陶板、铜色遮阳片和蓝绿玻璃构成统一材质语言。四个旋翼分别保留枢轴，近景可见云台、机臂、载荷和起落架。按街区合批，渲染分辨率和传感器频率各自控制。当前验收设备是 Core Ultra 5 125H、Intel Arc 集显、约 32 GB 内存。

```powershell
.venv/Scripts/python.exe -m aeromind.train runs/train-01
.venv/Scripts/python.exe -m aeromind.lesson runs/lesson-01
.venv/Scripts/python.exe -m unittest discover -s tests -v
npm test
```

训练会创建新的实验目录，保存输入清单、逐轮指标和权重。验证与测试使用独立的材质和照明组合，随仓库提供的分类器在 84 张程序生成的独立测试图中判对 80 张。[模型评估](evidence/parcel-display-v1.json)

如需重新制作美术，安装 `tools/art/requirements.txt` 后运行 `python -m tools.art.build_assets ContentSource` 及 `python -m aeromind.stations ContentSource/StationDisplays`。
