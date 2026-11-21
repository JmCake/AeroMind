# AeroMind｜智航纪元

AeroMind 是一堂可以操作的三维计算机视觉课。一架无人机送一件包裹到图书馆。学生用两处机载观测讲清一次配送：途中，挡板有多远？到了图书馆，模型从站牌上读出了什么？

## 启动

下载 Windows 课堂版，完整解压，双击 **AeroMind-3D.exe**。默认打开课堂，使用电脑上已有的 Edge 或 Chrome。模型和城市场景随包提供，可以断网讲课。[Windows 课堂版下载](https://github.com/JmCake/AeroMind/releases/download/v0.1.0-classroom.4/AeroMind-3D-Windows-x64.zip)

## 投影时怎么讲

1. 点 **起飞送货**。青色航线出现后，请学生预测，如果前方施工，无人机需要看到什么才会改变判断？
2. 点 **设置前方施工**。画面定格后，让学生在机载图像上指出挡板，再读出圆圈处的实测距离。图像给了什么线索？同一位置的深度观测又告诉了我们什么？
3. 点 **继续配送**。看无人机绕过挡板。到图书馆时，用机载原图找到站牌，指给学生看卷积网络实际读到的两张灰度图。请学生读出两次分类的结果，并预测第二帧若显示“占用”，无人机该怎样行动。返仓后两处观测会留在投影上。

原航线和挡板测距都会等待老师操作。讲站牌时也可以按“暂停飞行”。黑白方码用于识别站号，旁边的状态图案经透视校正后成为 40 × 40 的模型输入。指定站点连续两帧都判为“可交接”、每帧得分均达到 80%，并取得有效深度观测后，无人机才进站。要单独讲某个章节，可从右上角进入“课后实验”。

![图书馆进站实测，同屏展示无人机、机载相机拍到的站牌，以及连续两帧的分类输入和得分](evidence/classroom-station.png)

<details>
<summary>从源码启动与本机运行条件</summary>

当前 Windows 开发工作区可双击 **Start-AeroMind.cmd**。服务只监听回环地址。前台启动的服务可在其命令窗口按 Ctrl+C 停止。

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

默认地址为 [本机三维应用](http://127.0.0.1:8863)。重复启动会核实课堂版本和推理后端。正在讲旧版时，新版会使用另一个本机端口，双击程序会打开对应地址。通过 `--port` 可指定端口。

</details>

<details>
<summary>课后实验操作</summary>

- **下单与飞行**。选择图书馆或居民站。飞行器需要起飞、沿公开三维通道航行、读取指定站点面板，收到站台接触回执后返仓。右侧查看相机原图、距离、定位来源与延迟。
- **现场挑战**。在飞行前或飞行中加入施工障碍、绕固定塔身转动的吊臂、站台占用或限时禁飞体积。限飞规则是公开约束，普通施工事件经机载深度与视觉进入决策。可分别调整深度量程、测距噪声、相机丢帧、通信距离和二号机的起飞时刻。关闭 GPS 可观察视觉跟踪质量。选中“手动接管”后点击城市画面，使用 WASD 平移和 Q/E 升降。
- **认知与协作**。点击“认知”后，三维视图只绘制已观测体素、估计航迹与朝向。深色网格代表未知。可拖动旋转，查看测距射线发现的通路与占用。第五章启用两架无人机，协作面板可切换观测对象，时间轴记录占用消息、接收和航路变化。[认知地图实测截图](evidence/cognitive-map.png)
- **实验与证据**。可选择第 3、6 或 8 个仿真秒保存快照，系统复制飞行器、控制器、随机数、体素地图、事件队列、图像跟踪历史与视觉确认状态。两个分支从同一帧恢复，三秒后遇到相同的施工事件，各自采集新图像。可同步拖动关键帧回放，导出估计轨迹、独立真值样本、事件、投递与返仓的接触误差。
- **综合讲演**。在课后实验的订单下方展开“综合讲演”，选择课堂实速或三倍排练。七段依次进入城市开场、自动航线、GPS 中断、现场观察、状态分叉、双机共享与投递回放。完整排练按 7 分 30 秒墙钟时间推进，分叉和机群段使用界面标出的 3× 仿真速度，并等待实际结果。
- **双机条件**。可选两站配送或共用同一走廊，调节通信延迟、丢包与断连，或降低一号机初始电量。调度读取优先级、载重和往返电量预留。共用走廊使用公布的分层高度，进站需要独占预约。召回已装载的飞机后，包裹抵达仓位才会重新分配。

独立学生试演时，给未参与开发的同学一个任务：“送一件包裹，并在途中改变一个现场条件。”让同学自行操作，然后请其指向一帧观测或一条时间轴记录，用自己的话解释飞机为何改变行动。保存该次运行导出及匿名反馈，便于核对操作过程与理解情况。

</details>

<details>
<summary>感知、建图、美术与工程验证</summary>

项目的五阶段课程、技术路线和验收要求见 [PLAN.md](PLAN.md)。

课堂跟拍从机体旁取景，保持水平朝向。观众画面在已经完成的物理位置之间平滑移动，机载 RGB-D 相机按原采样时刻取帧。课堂验收记录包含镜头修复前后相邻画面的位移、机身重复画面比例，以及每趟试飞的挡板测距、站牌分类和配送结果。验收程序从原始数据复算距离、逐像素核对网络输入，并用训练时的 PyTorch 权重复算分类得分。[课堂试飞、镜头与模型复核](https://github.com/JmCake/AeroMind/releases/download/v0.1.0-classroom.4/AeroMind-Classroom-Check.json) · [可复算的机载原帧与对应投影](https://github.com/JmCake/AeroMind/releases/download/v0.1.0-classroom.4/AeroMind-Classroom-Frames.zip)

机载相机在固定仿真时刻渲染 320×180 RGB 和米制平面深度（厘米量化），旁观镜头及界面标记不进入取帧。本机服务矫正标牌后运行分类网络，同时从 RGB 分割站牌和施工构件。跟踪编号与短时运动预测来自连续机载帧，预测距离参与制动判断。稀疏光流、双向匹配和 RGB-D 对应估计位移，重访可用 ORB 关键帧和米制几何重新定位。课堂使用已知起始仓位、理想姿态和云台角度读数。三轴模拟加速度计带偏差与噪声，视觉位移修正惯性积分，跟踪不足时俯视寻找纹理并制动。体素保留观测时间和占用证据，并为局部距离场与观察选向提供输入。位姿真值用于误差评测与物理接触，模拟 GPS 开启时添加观测噪声。

本机课堂回归使用 1280×720 浏览器窗口、1 至 2 架无人机，预设门槛为平均画面帧率 ≥30 FPS、95 分位帧时间 ≤55 ms，取帧到决策 95 分位单机 ≤160 ms、双机 ≤220 ms。物理与控制 30 Hz，有效传感器频率 ≥7 Hz，正常场景要求零碰撞与请求失败。配送接触误差须小于 0.45 m，GPS 拒止课程定位 RMSE 目标为 ≤2 m。实速和加速排练分别记录，学生可理解性须经独立试演。

首个便携版 `classroom.1` 的实验界面在 Intel Arc 集显上完成了单机实速配送。Edge 以无头模式启用 D3D11 硬件渲染，1280×720 窗口内的三维画布在这次单机运行结束时为 963×578。平均 96.1 FPS，帧时间 P95 为 16.9 ms。472 个机载帧记录了两个墙钟终点，取帧到视觉结果返回 P95 为 104.3 ms，取帧到该帧首次控制指令 P95 为 107.7 ms。站台接触误差为 0.206 m，返仓接触误差为 0.312 m。另一趟关闭 GPS 的配送定位 RMSE 为 0.824 m，仍收到投递与返仓回执。[便携版验收数据](evidence/portable-acceptance.json)

同一版本连续运行十轮七段综合讲演，累计 75 分 6 秒。七十个阶段均无浏览器异常或传感器请求失败，双机段合计完成二十笔交付，每架飞机都收到返仓回执。双机段每轮平均 63.6–87.5 FPS，各轮帧时间 P95 为 16.9–33.4 ms，两机取帧到控制指令的 P95 为 49.4–82.2 ms。分叉实验中，关闭主动观察的分支到 95 仿真秒截止时仍受阻，开启观察的分支在 75.5 仿真秒完成返仓。首个便携版发布页附逐轮原始导出、机载关键帧和内存采样。独立学生理解度待现场试演。[十轮讲演与两分支结果](evidence/portable-acceptance.json)

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
node tools/verify_classroom.cjs http://127.0.0.1:8863 output/playwright/classroom 2
node tools/verify_camera.cjs http://127.0.0.1:8863 output/playwright/camera full
.venv/Scripts/python.exe -m tools.verify_station_frames output/playwright/classroom
node tools/verify_browser.cjs http://127.0.0.1:8863 fleet-share output/playwright/fleet
node tools/verify_browser.cjs http://127.0.0.1:8863 controls output/playwright/controls
node tools/verify_lecture.cjs http://127.0.0.1:8863 output/playwright/lecture 10 1
```

浏览器验收复用已安装的 Edge。导出的 JSON 含实际帧、模型摘要、实验共同帧、各分支指标和带时间戳的通信。完整导出保存在本机 `output/playwright/`。

逐像素复核应使用采集该次飞行的 OpenCV 版本。如果训练环境和便携版使用不同版本，可给 `tools.verify_station_frames` 加上 `--rectifier-python`，指定打包环境的 Python 路径。图像由该环境校正，再由训练环境复算模型得分。

连续试演期间可用 `tools/measure_windows.ps1` 采样指定测试会话的 Edge 私有内存与推理进程的内存。参数为运行 `verify_lecture.cjs` 的 Node 进程号、便携进程号和新 CSV 文件路径。本次 98 个采样点中，Edge 子进程私有内存合计最高 964.2 MiB，推理进程工作集最高 123.3 MiB。每轮导出另含 JavaScript 堆用量。

便携版使用 OpenCV DNN 在 CPU 上执行由同一批 PyTorch 权重导出的 ONNX。用独立的 72 帧核对导出，两个分割检查点各 1,036,800 个像素的类别与 PyTorch 一致。[运行时数值对照](evidence/portable-models.json)

重新打包时，在已安装 PyInstaller、OpenCV 与 NumPy 的 Windows Python 中运行 `python tools/packaging/build_windows.py`。只有重新导出权重才需要在训练环境安装 `onnx` 并运行 `python -m tools.export_models runs/city-images`。

如需重新制作美术，安装 `tools/art/requirements.txt` 后运行 `python -m tools.art.build_assets ContentSource` 及 `python -m aeromind.stations ContentSource/StationDisplays`。

</details>
