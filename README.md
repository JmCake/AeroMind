# AeroMind｜智航纪元

AeroMind 是面向计算机视觉课堂的本地三维配送应用。Three.js/WebGL2 渲染风格化近未来城市和独立机载相机，Python、OpenCV 与 CPU 版 PyTorch 处理实际像素。产品要求、五阶段课程及最终验收标准见 [PLAN.md](PLAN.md)。

## 启动

**课堂便携版**。从项目发布页下载 `AeroMind-3D-Windows-x64.zip`，解压整个文件夹，双击 `AeroMind-3D.exe`。应用自带本机视觉推理、模型和全部三维资源，使用已安装的 WebGL2 浏览器。课堂电脑可以断网运行。开发工作区生成的便携包位于 `dist/`。[Windows 课堂版下载](https://github.com/JmCake/AeroMind/releases)

当前 Windows 工作区双击 **Start-AeroMind.cmd**。浏览器打开本机服务后，选“图书馆 · 屋顶站台”，点击“开始配送”。服务只监听回环地址。前台启动的服务可以在其命令窗口按 Ctrl+C 停止。

从源码开发时需要 Python 3.11、Node.js/npm 和支持 WebGL2 的 Edge 或 Chrome。依赖、模型和三维资产就绪后可断网使用。仓库根目录执行以下命令。

```powershell
py -3.11 -m venv .venv
.venv/Scripts/python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cpu
.venv/Scripts/python.exe -m pip install -r requirements.txt
npm ci
.venv/Scripts/python.exe -m aeromind.app --open
```

| 安装分类 | 当前集显设备 |
| --- | --- |
| 必须 | 运行便携版需要 Windows x64 和 WebGL2 浏览器。源码开发使用 Python 与 npm 锁定的 Three.js。当前工作区已配置。 |
| 推荐 | 修改美术时使用 `tools/art/requirements.txt` 中的网格与预览工具。 |
| 本轮无需安装 | UE、Unity、Visual Studio、CUDA、ROS 2、PX4。专业仿真仅供独立对照。 |

默认地址为 [本机三维应用](http://127.0.0.1:8863)。重复启动会核实项目标识并打开现有服务。通过 `--port` 可指定其他端口。

## 课堂操作

- **下单与飞行**。选择图书馆或居民站。飞行器需要起飞、沿公开三维通道航行、读取指定站点面板，收到站台接触回执后返仓。右侧查看相机原图、距离、定位来源与延迟。
- **现场挑战**。在飞行前或飞行中加入施工障碍、绕固定塔身转动的吊臂、站台占用或限时禁飞体积。限飞规则是公开约束，普通施工事件经机载深度与视觉进入决策。可分别调整深度量程、测距噪声、相机丢帧、通信距离和二号机的起飞时刻。关闭 GPS 可观察视觉跟踪质量。选中“手动接管”后点击城市画面，使用 WASD 平移和 Q/E 升降。
- **认知与协作**。点击“认知”后，三维视图只绘制已观测体素、估计航迹与朝向。深色网格代表未知。可拖动旋转，查看测距射线发现的通路与占用。第五章启用两架无人机，协作面板可切换观测对象，时间轴记录占用消息、接收和航路变化。[认知地图实测截图](evidence/cognitive-map.png)
- **实验与证据**。可选择第 3、6 或 8 个仿真秒保存快照，系统复制飞行器、控制器、随机数、体素地图、事件队列、图像跟踪历史与视觉确认状态。两个分支从同一帧恢复，三秒后遇到相同的施工事件，各自采集新图像。可同步拖动关键帧回放，导出估计轨迹、独立真值样本、事件、投递与返仓的接触误差。
- **课堂讲演**。在订单下方展开“课堂讲演”，选择课堂实速或三倍排练。七段依次进入城市开场、自动航线、GPS 中断、现场观察、状态分叉、双机共享与投递回放。标准讲解按 7 分 30 秒墙钟时间推进，分叉和机群段使用界面标出的 3× 仿真速度，并等待实际结果。可以暂停讲解，重置会结束本次讲演。
- **双机条件**。可选两站配送或共用同一走廊，调节通信延迟、丢包与断连，或降低一号机初始电量。调度读取优先级、载重和往返电量预留。共用走廊使用公布的分层高度，进站需要独占预约。召回已装载的飞机后，包裹抵达仓位才会重新分配。

独立学生试演时，给未参与开发的同学一个任务：“送一件包裹，并在途中改变一个现场条件。”让同学自行操作，然后请其指向一帧观测或一条时间轴记录，用自己的话解释飞机为何改变行动。保存该次运行导出及匿名反馈，便于核对操作过程与理解情况。

## 感知、建图与美术

机载相机在固定仿真时刻渲染 320×180 RGB 和米制平面深度（厘米量化），旁观镜头及界面标记不进入取帧。本机服务矫正标牌后运行分类网络，同时从 RGB 分割站牌和施工构件。跟踪编号与短时运动预测来自连续机载帧，预测距离参与制动判断。稀疏光流、双向匹配和 RGB-D 对应估计位移，重访可用 ORB 关键帧和米制几何重新定位。课堂使用已知起始仓位、理想姿态和云台角度读数。三轴模拟加速度计带偏差与噪声，视觉位移修正惯性积分，跟踪不足时俯视寻找纹理并制动。体素保留观测时间和占用证据，并为局部距离场与观察选向提供输入。位姿真值用于误差评测与物理接触，模拟 GPS 开启时添加观测噪声。

本机课堂回归使用 1280×720 浏览器窗口、1 至 2 架无人机，预设门槛为平均画面帧率 ≥30 FPS、95 分位帧时间 ≤55 ms，取帧到决策 95 分位单机 ≤160 ms、双机 ≤220 ms。物理与控制 30 Hz，有效传感器频率 ≥7 Hz，正常场景要求零碰撞与请求失败。配送接触误差须小于 0.45 m，GPS 拒止课程定位 RMSE 目标为 ≤2 m。实速和加速排练分别记录，学生可理解性须经独立试演。

从发布 ZIP 解压运行的便携版在 Intel Arc 集显上完成了单机实速配送。Edge 以无头模式启用 D3D11 硬件渲染，1280×720 窗口内的三维画布在这次单机运行结束时为 963×578。平均 96.1 FPS，帧时间 P95 为 16.9 ms。472 个机载帧记录了两个墙钟终点，取帧到视觉结果返回 P95 为 104.3 ms，取帧到该帧首次控制指令 P95 为 107.7 ms。站台接触误差为 0.206 m，返仓接触误差为 0.312 m。另一趟关闭 GPS 的配送定位 RMSE 为 0.824 m，仍收到投递与返仓回执。[便携版验收数据](evidence/portable-acceptance.json)

同一浏览器标签页连续运行十轮标准讲演，累计 75 分 6 秒。七十个阶段均无浏览器异常或传感器请求失败，双机段合计完成二十笔交付，每架飞机都收到返仓回执。双机段每轮平均 63.6–87.5 FPS，各轮帧时间 P95 为 16.9–33.4 ms，两机取帧到控制指令的 P95 为 49.4–82.2 ms。分叉实验中，关闭主动观察的分支到 95 仿真秒截止时仍受阻，开启观察的分支在 75.5 仿真秒完成返仓。发布页附逐轮原始导出、机载关键帧和内存采样。独立学生理解度待现场试演。[十轮讲演与两分支结果](evidence/portable-acceptance.json)

专项运行另覆盖不同天气、站台占用、链路断连、低电量、学习策略和模型检查点。这些历史导出的延迟统计终点为视觉结果返回。[专项实测记录](evidence/classroom-runs.json)

![云港学区的真实运行画面与机载站台识别](evidence/classroom.png)

城市、站点及无人机使用原创 glTF 模型。暖白陶板、铜色遮阳片和蓝绿玻璃构成统一材质语言。四个旋翼分别保留枢轴，近景可见云台、机臂、载荷和起落架。按街区合批，渲染分辨率和传感器频率各自控制。当前验收设备是 Core Ultra 5 125H、Intel Arc 集显、约 32 GB 内存。

```powershell
.venv/Scripts/python.exe -m aeromind.train runs/train-01
.venv/Scripts/python.exe -m aeromind.lesson runs/lesson-01
.venv/Scripts/python.exe -m unittest discover -s tests -v
npm test
```

训练会创建新的实验目录，保存输入清单、逐轮指标和权重。验证与测试使用独立的材质和照明组合，随仓库提供的分类器在 84 张程序生成的独立测试图中判对 80 张。[站台分类评估](evidence/parcel-display-v1.json)

分割网络用独立渲染的 RGB 和带遮挡的像素标注训练。288 张训练图、72 张验证图、72 张独立测试图按站区和天气组合分组。保留第 1 轮与验证集最佳的第 22 轮检查点，课堂中可以切换同一快照的模型。留出测试的站牌 IoU 为 0.807，施工构件 IoU 为 0.605。[城市分割评估](evidence/campus-segments-v1.json)

可选的表格 Q 学习在校园局部栅格、巡航速度和连续订单三个简化环境中训练，每项 6,000 局。每项使用 600 局留出条件与规则比较，观察与巡航回报较高，调度回报为 18.61，低于规则的 19.32。默认采用规则策略，切换“校园 Q 学习”可在三维任务中运行已训练的动作评分。公开航路、最低电量、载重、制动和站台容量约束始终执行。[学习策略和基线](evidence/classroom-policy.json)

运行应用后，在另一命令窗口可以复现训练和浏览器实测。

```powershell
node tools/art/capture_corpus.cjs http://127.0.0.1:8863 runs/city-images
.venv/Scripts/python.exe -m aeromind.segments runs/city-images runs/segments-01
node tools/train_policy.mjs runs/policy-01
node tools/verify_browser.cjs http://127.0.0.1:8863 fleet-share output/playwright/fleet
node tools/verify_browser.cjs http://127.0.0.1:8863 controls output/playwright/controls
node tools/verify_lecture.cjs http://127.0.0.1:8863 output/playwright/lecture 10 1
```

浏览器验收复用已安装的 Edge。导出的 JSON 含实际帧、模型摘要、实验共同帧、各分支指标和带时间戳的通信。完整导出保存在本机 `output/playwright/`。

连续试演期间可用 `tools/measure_windows.ps1` 采样指定测试会话的 Edge 私有内存与推理进程的内存。参数为运行 `verify_lecture.cjs` 的 Node 进程号、便携进程号和新 CSV 文件路径。本次 98 个采样点中，Edge 子进程私有内存合计最高 964.2 MiB，推理进程工作集最高 123.3 MiB。每轮导出另含 JavaScript 堆用量。

便携版使用 OpenCV DNN 在 CPU 上执行由同一批 PyTorch 权重导出的 ONNX。用独立的 72 帧核对导出，两个分割检查点各 1,036,800 个像素的类别与 PyTorch 一致。[运行时数值对照](evidence/portable-models.json)

重新打包时，在已安装 PyInstaller、OpenCV 与 NumPy 的 Windows Python 中运行 `python tools/packaging/build_windows.py`。只有重新导出权重才需要在训练环境安装 `onnx` 并运行 `python -m tools.export_models runs/city-images`。

如需重新制作美术，安装 `tools/art/requirements.txt` 后运行 `python -m tools.art.build_assets ContentSource` 及 `python -m aeromind.stations ContentSource/StationDisplays`。
