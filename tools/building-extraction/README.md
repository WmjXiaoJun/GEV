# 独立建筑提取工具 / Standalone building extraction

这些脚本调用本地 YOLO 服务，适用于自备航拍或卫星图像。它们不调用浏览器里的多模态轮廓精修流程，也不关联 OSM 属性。建筑专用权重需自行安装，参见[本地视觉服务](../../scripts/local-vision/README.md)。

These tools call the local YOLO service for your own aerial or satellite images. They do not run the browser's multimodal refinement pipeline or join OSM attributes. Install building-specific weights separately; see the [local vision guide](../../scripts/local-vision/README.md).

## 使用 / Usage

以下命令从仓库根目录运行。先配置并启动视觉服务，再安装 CLI 依赖。

Run these commands from the repository root. Configure and start local vision, then install the CLI dependencies.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/local-vision/setup.ps1
powershell -ExecutionPolicy Bypass -File scripts/local-vision/start.ps1
.venv-vision/Scripts/python.exe -m pip install -r tools/building-extraction/requirements.txt
.venv-vision/Scripts/python.exe tools/building-extraction/scripts/building_detector.py --health
.venv-vision/Scripts/python.exe tools/building-extraction/scripts/building_detector.py image.jpg --format json
.venv-vision/Scripts/python.exe tools/building-extraction/scripts/building_detector.py image.jpg --bounds 116.3,39.9,116.4,40.0 --format geojson
.venv-vision/Scripts/python.exe tools/building-extraction/scripts/batch_extractor.py large_image.png --tile-size 1024 --overlap 128 --format json
```

其他平台使用已安装 `requests` 和 `Pillow` 的 Python 环境；服务启动方法见视觉服务文档。

On other platforms, use a Python environment with `requests` and `Pillow`. Follow the local vision guide to start the service.

| 文件 / File | 用途 / Purpose |
| --- | --- |
| `scripts/building_detector.py` | 单图检测，JSON / GeoJSON / CSV 导出；single-image detection and export |
| `scripts/batch_extractor.py` | 顺序分块、坐标合并、边界框 NMS 去重；sequential tiles, coordinate merging, bounding-box NMS |
| `examples.py` | 交互式 Python 调用示例；interactive Python examples |
| `visualization/building_viewer.html` | 在浏览器加载 GeoJSON 并查看轮廓；load GeoJSON and inspect outlines in a browser |

## 精度与限制 / Accuracy and limits

- GeoJSON / CSV 需要提供 `--bounds minLon,minLat,maxLon,maxLat`。坐标按影像边界线性映射，不自动读取 GeoTIFF 坐标系或重投影。GeoJSON / CSV require geographic bounds; mapping is linear and does not interpret GeoTIFF projections.
- 面积统计是边界框像素面积，不是平方米。Area statistics use bounding-box pixels, not square metres.
- 默认使用 `buildings-seg`。通用 `detect` 结果可能没有多边形，不能直接用于多边形统计与导出。Use `buildings-seg`; generic detections may lack polygons required for polygon statistics and export.
- 批处理使用边界框 NMS，CLI 的 `--iou-threshold` 当前尚未传入处理流程，实际默认值为 0.5。Batch processing uses bounding-box NMS; the CLI `--iou-threshold` option is currently not wired into processing, which uses 0.5.
- 分块失败会记录错误并继续，结果可能不完整。需要结合原图人工复核。Failed tiles are logged and skipped, so results may be incomplete and require visual review.
- 模型权重、输入影像和运行结果不随仓库提供。Weights, input imagery, and generated results are not bundled.

## 测试 / Tests

```powershell
.venv-vision/Scripts/python.exe -m unittest discover -s tools/building-extraction/tests -v
```

测试使用合成图像和模拟服务，验证临时文件隔离及无效分块参数处理，不要求下载模型。

Tests use synthetic images and a mocked service to verify temporary-file isolation and invalid tile parameters; no model download is required.
